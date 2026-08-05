"""Carga y caché de la configuración de clasificación por campaña y tarea.

Una plantilla de prompt es un clasificador: cambia el resultado tanto como
cambiar de modelo. Por eso se resuelve desde la base (`campaign_pipeline` +
`prompt_versions`) y no desde un archivo del repositorio, y por eso cada
inferencia guarda el `prompt_version_id` con el que se produjo.

La caché tiene TTL corto: promover una versión nueva en la base debe surtir
efecto sin reiniciar el servicio, pero sin pagar dos consultas por cada
comentario clasificado.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.sql import fetch_one

log = get_logger(__name__)

CACHE_TTL_SECONDS = 300

# {{variable}} con espacios opcionales.
_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


class PromptNotConfigured(RuntimeError):
    """La campaña no tiene pipeline habilitado para esa tarea."""


@dataclass(slots=True)
class ModelSpec:
    """Modelo con lo necesario para invocarlo y para costearlo."""

    model_id: UUID
    name: str
    identifier: str
    provider_code: str
    base_url: str | None
    credentials_ref: str | None
    supports_json_mode: bool
    max_tokens: int | None
    parameters: dict[str, Any] = field(default_factory=dict)
    cost_per_1k_input: float | None = None
    cost_per_1k_output: float | None = None
    timeout_ms: int = 30_000


@dataclass(slots=True)
class PromptBundle:
    """Todo lo que hace falta para clasificar un texto de esta campaña."""

    campaign_id: UUID
    task_code: str
    model: ModelSpec
    fallback_model: ModelSpec | None
    prompt_version_id: UUID | None
    system_prompt: str
    user_template: str
    output_schema: dict[str, Any] | None
    few_shot: list[dict[str, Any]]
    variables: list[str]
    temperature: float
    max_tokens: int | None
    # Por debajo de min_confidence la inferencia se marca para revisión humana.
    min_confidence: float
    # Por debajo de fallback_threshold se reintenta con el modelo de respaldo.
    fallback_threshold: float
    settings: dict[str, Any] = field(default_factory=dict)

    def render(self, variables: dict[str, Any]) -> str:
        """Sustituye los marcadores `{{variable}}` del `user_template`.

        Se exige que estén todas las declaradas: un marcador sin sustituir
        llegaría literal al modelo y envenenaría la salida en silencio.
        """
        missing = [v for v in self.variables if v not in variables]
        if missing:
            raise PromptNotConfigured(
                f"Faltan variables del prompt: {', '.join(sorted(missing))}"
            )

        def _replace(match: re.Match[str]) -> str:
            key = match.group(1)
            return str(variables.get(key, match.group(0)))

        return _PLACEHOLDER.sub(_replace, self.user_template)


_PIPELINE_SQL = """
SELECT
    p.min_confidence,
    p.fallback_threshold,
    p.settings,

    m.id                    AS model_id,
    m.name                  AS model_name,
    m.model_identifier      AS model_identifier,
    m.supports_json_mode    AS model_json_mode,
    m.max_tokens            AS model_max_tokens,
    m.parameters            AS model_parameters,
    m.cost_per_1k_input     AS model_cost_in,
    m.cost_per_1k_output    AS model_cost_out,
    pr.code                 AS provider_code,
    pr.base_url             AS provider_base_url,
    pr.credentials_ref      AS provider_credentials_ref,
    pr.default_timeout_ms   AS provider_timeout_ms,

    fm.id                   AS fb_model_id,
    fm.name                 AS fb_model_name,
    fm.model_identifier     AS fb_model_identifier,
    fm.supports_json_mode   AS fb_json_mode,
    fm.max_tokens           AS fb_max_tokens,
    fm.parameters           AS fb_parameters,
    fm.cost_per_1k_input    AS fb_cost_in,
    fm.cost_per_1k_output   AS fb_cost_out,
    fpr.code                AS fb_provider_code,
    fpr.base_url            AS fb_provider_base_url,
    fpr.credentials_ref     AS fb_credentials_ref,
    fpr.default_timeout_ms  AS fb_timeout_ms,

    pv.id                   AS prompt_version_id,
    pv.system_prompt,
    pv.user_template,
    pv.output_schema,
    pv.few_shot,
    pv.variables,
    pv.temperature,
    pv.max_tokens           AS prompt_max_tokens
FROM      civic.campaign_pipeline p
JOIN      civic.ai_models         m   ON m.id  = p.model_id
JOIN      civic.model_providers   pr  ON pr.id = m.provider_id
LEFT JOIN civic.ai_models         fm  ON fm.id = p.fallback_model_id
LEFT JOIN civic.model_providers   fpr ON fpr.id = fm.provider_id
LEFT JOIN civic.prompt_versions   pv  ON pv.id = p.prompt_version_id
WHERE     p.campaign_id = :campaign_id::uuid
  AND     p.task_code   = :task_code::civic.slug_code
  AND     p.is_enabled
"""

# Respaldo cuando el pipeline no fija una versión concreta: la versión activa
# de la plantilla de la organización y, si no hay, la global.
_ACTIVE_PROMPT_SQL = """
SELECT pv.id AS prompt_version_id, pv.system_prompt, pv.user_template,
       pv.output_schema, pv.few_shot, pv.variables, pv.temperature,
       pv.max_tokens AS prompt_max_tokens
FROM   civic.prompt_versions  pv
JOIN   civic.prompt_templates t ON t.id = pv.template_id
WHERE  pv.status = 'active'
  AND  t.is_active
  AND  t.purpose = 'classification'
  AND  :task_code::civic.slug_code = ANY (t.task_codes)
ORDER  BY (t.organization_id IS NULL)
LIMIT  1
"""


class PromptRegistry:
    """Caché por (campaign_id, task_code) con expiración."""

    def __init__(self, ttl_seconds: int = CACHE_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._cache: dict[tuple[str, str], tuple[float, PromptBundle]] = {}

    def invalidate(self, campaign_id: UUID | None = None) -> None:
        if campaign_id is None:
            self._cache.clear()
            return
        key_prefix = str(campaign_id)
        for key in [k for k in self._cache if k[0] == key_prefix]:
            del self._cache[key]

    async def get(
        self, session: AsyncSession, campaign_id: UUID, task_code: str = "sentiment"
    ) -> PromptBundle:
        key = (str(campaign_id), task_code)
        cached = self._cache.get(key)
        if cached and (time.monotonic() - cached[0]) < self._ttl:
            return cached[1]

        bundle = await self._load(session, campaign_id, task_code)
        self._cache[key] = (time.monotonic(), bundle)
        return bundle

    async def _load(
        self, session: AsyncSession, campaign_id: UUID, task_code: str
    ) -> PromptBundle:
        row = await fetch_one(
            session,
            _PIPELINE_SQL,
            {"campaign_id": str(campaign_id), "task_code": task_code},
        )
        if row is None:
            raise PromptNotConfigured(
                f"La campaña no tiene pipeline habilitado para la tarea '{task_code}'."
            )

        prompt = row
        if row.prompt_version_id is None:
            prompt = await fetch_one(session, _ACTIVE_PROMPT_SQL, {"task_code": task_code})
            if prompt is None:
                raise PromptNotConfigured(
                    f"No hay versión de prompt activa para la tarea '{task_code}'."
                )

        model = ModelSpec(
            model_id=row.model_id,
            name=row.model_name,
            identifier=row.model_identifier,
            provider_code=row.provider_code,
            base_url=row.provider_base_url,
            credentials_ref=row.provider_credentials_ref,
            supports_json_mode=bool(row.model_json_mode),
            max_tokens=row.model_max_tokens,
            parameters=row.model_parameters or {},
            cost_per_1k_input=float(row.model_cost_in) if row.model_cost_in else None,
            cost_per_1k_output=float(row.model_cost_out) if row.model_cost_out else None,
            timeout_ms=row.provider_timeout_ms or 30_000,
        )

        fallback: ModelSpec | None = None
        if row.fb_model_id is not None:
            fallback = ModelSpec(
                model_id=row.fb_model_id,
                name=row.fb_model_name,
                identifier=row.fb_model_identifier,
                provider_code=row.fb_provider_code,
                base_url=row.fb_provider_base_url,
                credentials_ref=row.fb_credentials_ref,
                supports_json_mode=bool(row.fb_json_mode),
                max_tokens=row.fb_max_tokens,
                parameters=row.fb_parameters or {},
                cost_per_1k_input=float(row.fb_cost_in) if row.fb_cost_in else None,
                cost_per_1k_output=float(row.fb_cost_out) if row.fb_cost_out else None,
                timeout_ms=row.fb_timeout_ms or 30_000,
            )

        bundle = PromptBundle(
            campaign_id=campaign_id,
            task_code=task_code,
            model=model,
            fallback_model=fallback,
            prompt_version_id=prompt.prompt_version_id,
            system_prompt=prompt.system_prompt,
            user_template=prompt.user_template,
            output_schema=prompt.output_schema,
            few_shot=list(prompt.few_shot or []),
            variables=list(prompt.variables or []),
            temperature=float(prompt.temperature),
            max_tokens=prompt.prompt_max_tokens or model.max_tokens,
            min_confidence=float(row.min_confidence),
            fallback_threshold=float(row.fallback_threshold),
            settings=row.settings or {},
        )

        log.info(
            "prompt.loaded",
            campaign_id=str(campaign_id),
            task_code=task_code,
            model=model.name,
            prompt_version_id=str(bundle.prompt_version_id),
            has_fallback=fallback is not None,
        )
        return bundle


prompt_registry = PromptRegistry()
