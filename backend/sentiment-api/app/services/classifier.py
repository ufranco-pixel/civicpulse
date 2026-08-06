"""Motor de clasificación LLM con respaldo.

Decisiones de diseño:

* Agnóstico de proveedor. Anthropic (Messages) y OpenAI (chat/completions) se
  cubren con dos adaptadores mínimos; el resto del flujo es idéntico. Cambiar
  de proveedor no debe obligar a tocar la lógica de negocio.
* La salida se valida contra el `output_schema` de la versión de prompt. Si no
  cumple, se reintenta UNA vez con el error de validación en el mensaje; si
  vuelve a fallar, se registra `schema_valid = false` en lugar de descartar el
  caso: la tasa de violaciones de esquema es un indicador de calidad del prompt
  tan importante como la exactitud.
* Si la confianza no alcanza `campaign_pipeline.fallback_threshold`, se
  reintenta con el modelo de respaldo y se conserva el resultado más confiado.
* La persistencia (inferencia + emociones + posturas + temas + entidades +
  banderas) ocurre en una sola transacción: media inferencia guardada es peor
  que ninguna, porque los agregados la contarían incompleta.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from jsonschema import Draft202012Validator
from jsonschema import ValidationError as SchemaValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser
from app.core.config import settings
from app.core.logging import get_logger
from app.core.sql import fetch_all, fetch_one, not_found
from app.schemas.classifier import (
    ClassificationResult,
    EmotionOut,
    EntityOut,
    RiskFlagOut,
    StanceOut,
    TopicOut,
)
from app.services.prompts import ModelSpec, PromptBundle, PromptNotConfigured, prompt_registry

log = get_logger(__name__)

# Etiquetas admitidas por civic_cat.sentiment_types.
_VALID_SENTIMENT = {"positive", "neutral", "negative", "mixed"}

_CODE_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.MULTILINE)
_FIRST_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


class LlmCallError(RuntimeError):
    """El proveedor no devolvió una respuesta utilizable."""


class _LlmResponse:
    __slots__ = ("raw_text", "input_tokens", "output_tokens")

    def __init__(self, raw_text: str, input_tokens: int | None, output_tokens: int | None):
        self.raw_text = raw_text
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


# =============================================================================
# Utilidades
# =============================================================================
def _resolve_api_key(credentials_ref: str | None, provider: str | None = None) -> str:
    """Resuelve la clave del proveedor.

    Nunca se guarda la clave en la base: `model_providers.credentials_ref` sólo
    apunta al gestor de secretos. En ejecución se admite `env:NOMBRE`,
    `vault://…` (el sidecar deja el valor en LLM_API_KEY) o el valor literal.

    Gemini tiene atajo propio: GEMINI_API_KEY, que es como viene la clave de
    Google AI Studio y evita tener que duplicarla en LLM_API_KEY_REF.
    """
    if provider == "gemini" and settings.GEMINI_API_KEY:
        return settings.GEMINI_API_KEY

    for candidate in (credentials_ref, settings.LLM_API_KEY_REF):
        if not candidate:
            continue
        if candidate.startswith("env:"):
            value = os.environ.get(candidate[4:], "")
            if value:
                return value
        elif candidate.startswith("vault://"):
            # El sidecar del gestor de secretos deja el valor en el entorno.
            value = os.environ.get("LLM_API_KEY", "")
            if value:
                return value
        else:
            return candidate

    hint = "GEMINI_API_KEY" if provider == "gemini" else "LLM_API_KEY_REF"
    raise LlmCallError(f"No hay credencial disponible para {provider or 'el proveedor'}. Configure {hint}.")


def _gemini_response_schema(schema: dict[str, Any] | None) -> dict[str, Any] | None:
    """Adapta el esquema JSON al subconjunto que acepta Gemini.

    `responseSchema` no admite `additionalProperties`, `$schema`, `$id`,
    `pattern`, `format`, `const` ni `oneOf`. Enviar el esquema completo devuelve
    400 y tumba toda la corrida, así que se poda antes.

    Aun así la validación local con jsonschema sigue siendo la que manda:
    responseSchema mejora mucho la tasa de acierto de formato, pero no la
    garantiza al 100 %.
    """
    if not schema:
        return None

    # El objeto Schema de Gemini es un subconjunto de OpenAPI 3.0. Sólo admite
    # type, format, description, nullable, enum, items, properties, required,
    # propertyOrdering, minItems y maxItems. Todo lo demás provoca un 400.
    _KEEP = {
        "type", "nullable", "enum", "items", "properties", "required",
        "minItems", "maxItems", "propertyOrdering",
    }

    def prune(node: Any) -> Any:
        if isinstance(node, list):
            return [prune(x) for x in node]
        if not isinstance(node, dict):
            return node

        out: dict[str, Any] = {}
        nullable = False

        for key, value in node.items():
            if key == "type":
                if isinstance(value, list):
                    # Gemini no admite tipos unión. Se toma el primero no nulo y
                    # el «null» se traduce a la bandera nullable.
                    non_null = [t for t in value if t != "null"]
                    nullable = len(non_null) < len(value)
                    out["type"] = (non_null[0] if non_null else "string").upper()
                else:
                    out["type"] = str(value).upper()
            elif key == "enum":
                out["enum"] = [str(v) for v in value]
            elif key == "properties" and isinstance(value, dict):
                # `properties` es un mapa nombre→esquema. Sus claves son nombres
                # de campo, no palabras del vocabulario del esquema: hay que
                # podar los valores, nunca las claves.
                out["properties"] = {name: prune(sub) for name, sub in value.items()}
            elif key == "required" and isinstance(value, list):
                out["required"] = list(value)
            elif key in _KEEP:
                out[key] = prune(value)
            # El resto se descarta: minimum, maximum, pattern, format,
            # additionalProperties, $schema, description… Los rangos numéricos
            # los sigue validando jsonschema en local, que es donde importan.

        if nullable:
            out["nullable"] = True
        # Un enum sin type explícito es rechazado por la API.
        if "enum" in out and "type" not in out:
            out["type"] = "STRING"
        return out

    pruned = prune(schema)

    # Gemini exige que todo lo listado en `required` esté en `properties`.
    def fix_required(node: Any) -> None:
        if isinstance(node, list):
            for x in node:
                fix_required(x)
            return
        if not isinstance(node, dict):
            return
        props = node.get("properties")
        if isinstance(props, dict) and isinstance(node.get("required"), list):
            node["required"] = [r for r in node["required"] if r in props]
        for value in node.values():
            fix_required(value)

    fix_required(pruned)
    return pruned


def _extract_json(raw: str) -> dict[str, Any]:
    """Parsea la respuesta tolerando texto alrededor del JSON.

    Los modelos sin modo JSON estricto envuelven la salida en explicaciones o
    en un bloque de código. Rechazar esas respuestas dispararía la tasa de
    violaciones de esquema sin que el contenido esté realmente mal.
    """
    cleaned = _CODE_FENCE.sub("", raw).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = _FIRST_OBJECT.search(cleaned)
        if match is None:
            raise LlmCallError("La respuesta del modelo no contiene JSON.")
        return json.loads(match.group(0))


def _as_float(value: Any, default: float | None = None) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: float | None, low: float, high: float) -> float | None:
    if value is None:
        return None
    return max(low, min(high, value))


def _normalize_entity(value: str) -> str:
    """Forma canónica para agrupar variantes: minúsculas y sin acentos."""
    import unicodedata

    decomposed = unicodedata.normalize("NFKD", value.strip().lower())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


# =============================================================================
# Servicio
# =============================================================================
class ClassifierService:
    """Cliente de clasificación reutilizable durante toda la vida del proceso."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    # ── Ciclo de vida ────────────────────────────────────────────────────────
    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            # Un solo cliente: reaprovecha conexiones TLS, que es la mitad del
            # coste de latencia contra una API de LLM.
            self._client = httpx.AsyncClient(timeout=settings.llm_timeout_seconds)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @staticmethod
    def ensure_enabled() -> None:
        """503 si el clasificador está apagado.

        El servicio arranca igual con CLASSIFIER_ENABLED=false: la parte
        analítica no depende del LLM y no tiene por qué caerse con él.
        """
        if not settings.CLASSIFIER_ENABLED:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="El clasificador está deshabilitado (CLASSIFIER_ENABLED=false).",
            )

    # ── Adaptadores de proveedor ─────────────────────────────────────────────
    async def _call_gemini(
        self, model: ModelSpec, system: str, user_message: str, bundle: PromptBundle
    ) -> _LlmResponse:
        """Google Gemini vía la API de Generative Language.

        Dos particularidades que condicionan la implementación:

        1. `responseMimeType: application/json` fuerza la salida a JSON. Es la
           diferencia entre una tasa de esquema válido del 96 % y del 99,9 %, y
           `schema_valid_rate` es criterio de la puerta de promoción.

        2. Los filtros de seguridad bloquean discurso político agresivo. Este
           sistema existe justamente para clasificar ese contenido, así que un
           bloqueo NO es un caso raro: es lo esperado en insultos y amenazas.
           Se detecta y se reporta como error explícito en lugar de dejar pasar
           una respuesta vacía, porque descartar en silencio los comentarios
           más hostiles desplazaría todo el tablero hacia lo positivo.
        """
        base = (model.base_url or settings.GEMINI_BASE_URL).rstrip("/")
        version = settings.GEMINI_API_VERSION
        identifier = model.identifier or settings.GEMINI_MODEL

        generation: dict[str, Any] = {
            "temperature": bundle.temperature,
            "maxOutputTokens": bundle.max_tokens or model.max_tokens or 2048,
            # candidateCount=1 explícito: más de uno multiplica el costo sin
            # aportar nada con temperatura 0.
            "candidateCount": 1,
        }

        if model.supports_json_mode:
            generation["responseMimeType"] = "application/json"
            response_schema = _gemini_response_schema(bundle.output_schema)
            if response_schema:
                generation["responseSchema"] = response_schema

        payload: dict[str, Any] = {
            # systemInstruction va aparte del turno de usuario: el modelo le da
            # más peso que a un preámbulo dentro del mensaje.
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user_message}]}],
            "generationConfig": generation,
            "safetySettings": settings.gemini_safety_settings,
        }

        response = await self.client.post(
            f"{base}/{version}/models/{identifier}:generateContent",
            headers={
                # Cabecera en lugar de ?key=: evita que la clave acabe en los
                # registros de acceso de cualquier proxy intermedio.
                "x-goog-api-key": _resolve_api_key(model.credentials_ref, "gemini"),
                "content-type": "application/json",
            },
            json=payload,
            timeout=model.timeout_ms / 1000.0,
        )
        response.raise_for_status()
        data = response.json()

        # El prompt completo fue rechazado antes de generar nada.
        block_reason = (data.get("promptFeedback") or {}).get("blockReason")
        if block_reason:
            raise LlmCallError(
                f"Gemini bloqueó la petición ({block_reason}). "
                f"Revise GEMINI_SAFETY_THRESHOLD: con el umbral por defecto se rechaza "
                f"el discurso agresivo que este sistema necesita clasificar."
            )

        candidates = data.get("candidates") or []
        if not candidates:
            raise LlmCallError("Gemini no devolvió ningún candidato.")

        candidate = candidates[0]
        finish = candidate.get("finishReason")
        if finish == "SAFETY":
            ratings = candidate.get("safetyRatings") or []
            triggered = ", ".join(
                r.get("category", "?") for r in ratings if r.get("blocked")
            ) or "sin detalle"
            raise LlmCallError(f"Gemini bloqueó la respuesta por seguridad ({triggered}).")
        if finish == "MAX_TOKENS":
            # El JSON queda truncado y no parsea. Falla claro en vez de dejar
            # que _extract_json devuelva algo a medias.
            raise LlmCallError(
                "Gemini truncó la respuesta por maxOutputTokens. "
                "Suba max_tokens en la versión del prompt o recorte el texto de entrada."
            )
        if finish == "RECITATION":
            raise LlmCallError("Gemini rechazó la respuesta por recitación de material protegido.")

        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts)
        if not text.strip():
            raise LlmCallError(f"Gemini devolvió contenido vacío (finishReason={finish}).")

        usage = data.get("usageMetadata") or {}
        return _LlmResponse(
            raw_text=text,
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
        )

    async def _call_anthropic(
        self, model: ModelSpec, system: str, user_message: str, bundle: PromptBundle
    ) -> _LlmResponse:
        base = (model.base_url or settings.LLM_BASE_URL).rstrip("/")
        payload: dict[str, Any] = {
            "model": model.identifier,
            "max_tokens": bundle.max_tokens or model.max_tokens or 2048,
            "temperature": bundle.temperature,
            "system": system,
            "messages": [{"role": "user", "content": user_message}],
        }

        response = await self.client.post(
            f"{base}/v1/messages",
            headers={
                "x-api-key": _resolve_api_key(model.credentials_ref),
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=model.timeout_ms / 1000.0,
        )
        response.raise_for_status()
        data = response.json()

        blocks = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
        usage = data.get("usage", {})
        return _LlmResponse(
            raw_text="".join(blocks),
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
        )

    async def _call_openai(
        self, model: ModelSpec, system: str, user_message: str, bundle: PromptBundle
    ) -> _LlmResponse:
        base = (model.base_url or settings.LLM_BASE_URL).rstrip("/")
        payload: dict[str, Any] = {
            "model": model.identifier,
            "temperature": bundle.temperature,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_message},
            ],
        }
        if bundle.max_tokens or model.max_tokens:
            payload["max_tokens"] = bundle.max_tokens or model.max_tokens
        if model.supports_json_mode:
            payload["response_format"] = {"type": "json_object"}

        response = await self.client.post(
            f"{base}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {_resolve_api_key(model.credentials_ref)}",
                "content-type": "application/json",
            },
            json=payload,
            timeout=model.timeout_ms / 1000.0,
        )
        response.raise_for_status()
        data = response.json()

        choices = data.get("choices") or []
        if not choices:
            raise LlmCallError("El proveedor no devolvió ninguna opción.")
        usage = data.get("usage", {})
        return _LlmResponse(
            raw_text=choices[0].get("message", {}).get("content", "") or "",
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )

    async def _invoke(
        self, model: ModelSpec, system: str, user_message: str, bundle: PromptBundle
    ) -> _LlmResponse:
        provider = model.provider_code or settings.LLM_PROVIDER
        try:
            if provider in ("gemini", "google", "google_ai"):
                return await self._call_gemini(model, system, user_message, bundle)
            if provider in ("anthropic",):
                return await self._call_anthropic(model, system, user_message, bundle)
            if provider in ("openai", "azure_openai", "vllm_local"):
                # vLLM expone la API de OpenAI; el adaptador sirve tal cual.
                return await self._call_openai(model, system, user_message, bundle)
        except httpx.HTTPStatusError as exc:
            raise LlmCallError(
                f"{provider} respondió {exc.response.status_code}: {exc.response.text[:200]}"
            ) from exc
        except httpx.HTTPError as exc:
            raise LlmCallError(f"Fallo de red con {provider}: {exc}") from exc

        raise LlmCallError(f"Proveedor no soportado por este servicio: {provider}")

    # ── Validación de esquema ────────────────────────────────────────────────
    @staticmethod
    def _validate(payload: dict[str, Any], schema: dict[str, Any] | None) -> str | None:
        """Devuelve el mensaje de error, o None si la salida cumple."""
        if not schema:
            return None
        try:
            Draft202012Validator(schema).validate(payload)
        except SchemaValidationError as exc:
            path = "/".join(str(p) for p in exc.absolute_path) or "(raíz)"
            return f"{path}: {exc.message}"
        return None

    async def _call_with_schema_retry(
        self, model: ModelSpec, bundle: PromptBundle, system: str, user_message: str
    ) -> tuple[dict[str, Any], _LlmResponse, bool]:
        """Invoca el modelo y reintenta una vez si la salida no cumple el esquema."""
        response = await self._invoke(model, system, user_message, bundle)
        try:
            payload = _extract_json(response.raw_text)
            error = self._validate(payload, bundle.output_schema)
        except (LlmCallError, json.JSONDecodeError) as exc:
            payload, error = {}, str(exc)

        if error is None:
            return payload, response, True

        log.warning("classifier.schema_violation", model=model.name, error=error)

        # Reintento único con el error como corrección. Más reintentos no
        # mejoran la tasa de acierto y multiplican el costo.
        corrective = (
            f"{user_message}\n\n"
            "La respuesta anterior no cumplió el esquema de salida exigido "
            f"({error}). Responde ÚNICAMENTE con el objeto JSON válido, sin "
            "texto adicional ni bloques de código."
        )
        retry = await self._invoke(model, system, corrective, bundle)
        try:
            payload = _extract_json(retry.raw_text)
            error = self._validate(payload, bundle.output_schema)
        except (LlmCallError, json.JSONDecodeError) as exc:
            payload, error = {}, str(exc)

        return payload, retry, error is None

    # ── Normalización ────────────────────────────────────────────────────────
    @staticmethod
    def _normalize(
        payload: dict[str, Any],
        model: ModelSpec,
        bundle: PromptBundle,
        contenders: dict[str, UUID],
    ) -> ClassificationResult:
        """Traduce la salida del modelo al modelo de datos de Análisis de Sentimientos."""
        sentiment = str(payload.get("sentiment") or payload.get("sentiment_code") or "neutral")
        if sentiment not in _VALID_SENTIMENT:
            sentiment = "neutral"

        score = _clamp(_as_float(payload.get("sentiment_score"), 0.0), -1.0, 1.0) or 0.0
        confidence = _clamp(_as_float(payload.get("confidence"), 0.5), 0.0, 1.0) or 0.5

        emotions = [
            EmotionOut(
                code=str(e.get("code") or e.get("emotion")),
                score=_clamp(_as_float(e.get("score"), 0.0), 0.0, 1.0) or 0.0,
                is_dominant=bool(e.get("dominant") or e.get("is_dominant")),
            )
            for e in payload.get("emotions", [])
            if isinstance(e, dict) and (e.get("code") or e.get("emotion"))
        ]
        # Si el modelo no señala la dominante, se marca la de mayor intensidad.
        if emotions and not any(e.is_dominant for e in emotions):
            top = max(emotions, key=lambda e: e.score)
            top.is_dominant = True

        stances: list[StanceOut] = []
        for s in payload.get("stances", []):
            if not isinstance(s, dict):
                continue
            contender_id = _resolve_contender(s, contenders)
            if contender_id is None:
                # Postura hacia alguien que no está registrado en la campaña:
                # se descarta en lugar de inventar un actor.
                continue
            stances.append(
                StanceOut(
                    contender_id=contender_id,
                    stance_code=str(s.get("stance") or s.get("stance_code") or "neutral"),
                    stance_score=_clamp(_as_float(s.get("score"), 0.0), -1.0, 1.0) or 0.0,
                    confidence=_clamp(_as_float(s.get("confidence"), confidence), 0.0, 1.0)
                    or confidence,
                    match_method="model",
                    evidence_span=s.get("evidence") or s.get("evidence_span"),
                )
            )

        topics = [
            TopicOut(
                category_code=str(t.get("category") or t.get("category_code")),
                relevance=_clamp(_as_float(t.get("relevance"), 0.5), 0.0, 1.0) or 0.5,
                topic_sentiment=_clamp(_as_float(t.get("sentiment")), -1.0, 1.0),
                is_primary=bool(t.get("primary") or t.get("is_primary")),
            )
            for t in payload.get("topics", [])
            if isinstance(t, dict) and (t.get("category") or t.get("category_code"))
        ]
        if topics and not any(t.is_primary for t in topics):
            max(topics, key=lambda t: t.relevance).is_primary = True

        entities = []
        for e in payload.get("entities", []):
            if not isinstance(e, dict):
                continue
            raw_text = str(e.get("text") or e.get("entity_text") or "").strip()
            if not raw_text:
                continue
            entities.append(
                EntityOut(
                    entity_type_code=str(e.get("type") or e.get("entity_type_code") or "other"),
                    entity_text=raw_text,
                    entity_norm=_normalize_entity(raw_text),
                    entity_sentiment=_clamp(_as_float(e.get("sentiment")), -1.0, 1.0),
                    confidence=_clamp(_as_float(e.get("confidence")), 0.0, 1.0),
                    mention_count=int(e.get("mention_count") or 1),
                    contender_id=_resolve_contender(e, contenders),
                )
            )

        risk_flags = [
            RiskFlagOut(
                flag_code=str(f.get("code") or f.get("flag_code")),
                score=_clamp(_as_float(f.get("score"), 0.5), 0.0, 1.0) or 0.5,
                target_contender_id=_resolve_contender(f, contenders),
            )
            for f in payload.get("risk_flags", [])
            if isinstance(f, dict) and (f.get("code") or f.get("flag_code"))
        ]

        probs = payload.get("sentiment_probs")
        return ClassificationResult(
            sentiment_code=sentiment,
            sentiment_score=score,
            sentiment_confidence=confidence,
            sentiment_probs={k: float(v) for k, v in probs.items()}
            if isinstance(probs, dict)
            else None,
            intent_code=payload.get("intent") or payload.get("intent_code"),
            intent_confidence=_clamp(_as_float(payload.get("intent_confidence")), 0.0, 1.0),
            toxicity_score=_clamp(_as_float(payload.get("toxicity")), 0.0, 1.0),
            sarcasm_score=_clamp(_as_float(payload.get("sarcasm")), 0.0, 1.0),
            subjectivity_score=_clamp(_as_float(payload.get("subjectivity")), 0.0, 1.0),
            detected_language=payload.get("language") or payload.get("detected_language"),
            summary=payload.get("summary"),
            overall_confidence=_clamp(
                _as_float(payload.get("overall_confidence"), confidence), 0.0, 1.0
            )
            or confidence,
            emotions=emotions,
            stances=stances,
            topics=topics,
            entities=entities,
            risk_flags=risk_flags,
            model_name=model.name,
            model_id=model.model_id,
            prompt_version_id=bundle.prompt_version_id,
            raw_output=payload,
        )

    # ── Flujo principal ──────────────────────────────────────────────────────
    async def classify_content(
        self,
        session: AsyncSession,
        user: AuthenticatedUser,
        content_id: UUID,
        published_at: datetime,
        task_code: str = "sentiment",
        persist: bool = False,
    ) -> ClassificationResult:
        """Clasifica un contenido ya almacenado y, si se pide, lo persiste."""
        self.ensure_enabled()

        content = await fetch_one(
            session,
            """
            SELECT c.id, c.published_at, c.campaign_id, c.organization_id,
                   c.source_id, c.body, c.title, c.language_code,
                   cm.code AS campaign_code, cm.name AS campaign_name,
                   st.code AS source_type
            FROM   civic.contents c
            JOIN   civic.campaigns cm ON cm.id = c.campaign_id
            JOIN   civic.sources    s ON s.id = c.source_id
            JOIN   civic_cat.source_types st ON st.code = s.type_code
            WHERE  c.id = CAST(:content_id AS uuid) AND c.published_at = :published_at
            """,
            {"content_id": str(content_id), "published_at": published_at},
        )
        if content is None:
            raise not_found("Contenido no encontrado en la ventana indicada.")

        try:
            bundle = await prompt_registry.get(session, content.campaign_id, task_code)
        except PromptNotConfigured as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(exc)
            ) from exc

        contenders = await _load_contenders(session, content.campaign_id)

        variables = {
            "text": content.body,
            "title": content.title or "",
            "language": content.language_code,
            "source_type": content.source_type,
            "campaign": content.campaign_name,
            "campaign_code": content.campaign_code,
            "published_at": content.published_at.isoformat(),
            "contenders": ", ".join(sorted(contenders.keys())),
        }
        user_message = bundle.render(variables)
        if bundle.few_shot:
            # Los ejemplos van en el mensaje y no en el sistema: así se pueden
            # medir por separado su aporte y su costo en tokens.
            user_message = (
                "Ejemplos de referencia:\n"
                + json.dumps(bundle.few_shot, ensure_ascii=False)
                + "\n\n"
                + user_message
            )

        started = time.perf_counter()
        payload, response, schema_valid = await self._call_with_schema_retry(
            bundle.model, bundle, bundle.system_prompt, user_message
        )
        result = self._normalize(payload, bundle.model, bundle, contenders)
        result.schema_valid = schema_valid

        # Respaldo por baja confianza: se conserva el resultado más confiado.
        if (
            bundle.fallback_model is not None
            and result.overall_confidence < bundle.fallback_threshold
        ):
            log.info(
                "classifier.fallback",
                confidence=result.overall_confidence,
                threshold=bundle.fallback_threshold,
                fallback_model=bundle.fallback_model.name,
            )
            try:
                fb_payload, fb_response, fb_valid = await self._call_with_schema_retry(
                    bundle.fallback_model, bundle, bundle.system_prompt, user_message
                )
                fb_result = self._normalize(
                    fb_payload, bundle.fallback_model, bundle, contenders
                )
                fb_result.schema_valid = fb_valid
                if fb_result.overall_confidence > result.overall_confidence:
                    result, response = fb_result, fb_response
                    result.used_fallback = True
            except LlmCallError as exc:
                # Que falle el respaldo no invalida el resultado del primario.
                log.warning("classifier.fallback_failed", error=str(exc))

        result.latency_ms = int((time.perf_counter() - started) * 1000)
        result.input_tokens = response.input_tokens
        result.output_tokens = response.output_tokens
        result.cost_usd = _estimate_cost(
            bundle.model, response.input_tokens, response.output_tokens
        )

        log.info(
            "classifier.completed",
            content_id=str(content_id),
            model=result.model_name,
            sentiment=result.sentiment_code,
            confidence=result.overall_confidence,
            schema_valid=result.schema_valid,
            latency_ms=result.latency_ms,
            cost_usd=result.cost_usd,
        )

        if persist:
            await self._persist(session, content, bundle, result, user)
            result.persisted = True

        return result

    # ── Persistencia ─────────────────────────────────────────────────────────
    @staticmethod
    async def _persist(
        session: AsyncSession,
        content: Any,
        bundle: PromptBundle,
        result: ClassificationResult,
        user: AuthenticatedUser,
    ) -> None:
        """Inferencia y sus cinco ejes, en la misma transacción de la petición."""
        # Marcado para revisión: baja confianza, ironía alta o bandera de riesgo.
        needs_review = (
            result.overall_confidence < bundle.min_confidence
            or (result.sarcasm_score or 0) > 0.6
            or bool(result.risk_flags)
        )

        row = await fetch_one(
            session,
            """
            INSERT INTO civic.inferences (
                organization_id, campaign_id, source_id, content_id,
                published_at, model_id, prompt_version_id,
                model_name_snapshot, pipeline, sentiment_code, sentiment_score,
                sentiment_confidence, sentiment_probs, intent_code,
                intent_confidence, toxicity_score, sarcasm_score,
                subjectivity_score, detected_language, summary,
                overall_confidence, needs_review, review_status, raw_output,
                latency_ms, input_tokens, output_tokens, cost_usd
            ) VALUES (
                CAST(:organization_id AS uuid), CAST(:campaign_id AS uuid), CAST(:source_id AS uuid),
                CAST(:content_id AS uuid), :published_at, CAST(:model_id AS uuid),
                CAST(:prompt_version_id AS uuid), :model_name, 'llm',
                CAST(:sentiment_code AS civic.slug_code), :sentiment_score,
                :sentiment_confidence, CAST(:sentiment_probs AS jsonb),
                CAST(:intent_code AS civic.slug_code), :intent_confidence,
                :toxicity_score, :sarcasm_score, :subjectivity_score,
                CAST(:detected_language AS civic.lang_code), :summary,
                :overall_confidence, :needs_review,
                CASE WHEN :needs_review THEN 'pending' ELSE 'not_required' END,
                CAST(:raw_output AS jsonb), :latency_ms, :input_tokens, :output_tokens,
                :cost_usd
            )
            RETURNING id, analyzed_at
            """,
            {
                "organization_id": str(user.organization_id),
                "campaign_id": content.campaign_id,
                "source_id": content.source_id,
                "content_id": content.id,
                "published_at": content.published_at,
                "model_id": str(result.model_id) if result.model_id else None,
                "prompt_version_id": str(bundle.prompt_version_id)
                if bundle.prompt_version_id
                else None,
                "model_name": result.model_name,
                "sentiment_code": result.sentiment_code,
                "sentiment_score": result.sentiment_score,
                "sentiment_confidence": result.sentiment_confidence,
                "sentiment_probs": json.dumps(result.sentiment_probs)
                if result.sentiment_probs
                else None,
                "intent_code": result.intent_code,
                "intent_confidence": result.intent_confidence,
                "toxicity_score": result.toxicity_score,
                "sarcasm_score": result.sarcasm_score,
                "subjectivity_score": result.subjectivity_score,
                "detected_language": result.detected_language,
                "summary": result.summary,
                "overall_confidence": result.overall_confidence,
                "needs_review": needs_review,
                "raw_output": json.dumps(result.raw_output or {}),
                "latency_ms": result.latency_ms,
                "input_tokens": result.input_tokens,
                "output_tokens": result.output_tokens,
                "cost_usd": result.cost_usd,
            },
        )
        inference_id, analyzed_at = row.id, row.analyzed_at
        result.inference_id = inference_id

        common = {
            "inference_id": inference_id,
            "analyzed_at": analyzed_at,
            "campaign_id": content.campaign_id,
            "published_at": content.published_at,
        }

        if result.emotions:
            await session.execute(
                text(
                    """
                    INSERT INTO civic.inference_emotions (
                        inference_id, analyzed_at, campaign_id, published_at,
                        emotion_code, score, is_dominant
                    ) VALUES (
                        :inference_id, :analyzed_at, :campaign_id, :published_at,
                        CAST(:emotion_code AS civic.slug_code), :score, :is_dominant
                    )
                    ON CONFLICT DO NOTHING
                    """
                ),
                [
                    {**common, "emotion_code": e.code, "score": e.score, "is_dominant": e.is_dominant}
                    for e in result.emotions
                ],
            )

        if result.stances:
            await session.execute(
                text(
                    """
                    INSERT INTO civic.inference_stances (
                        inference_id, analyzed_at, campaign_id, published_at,
                        contender_id, stance_code, stance_score, confidence,
                        match_method, evidence_span
                    ) VALUES (
                        :inference_id, :analyzed_at, :campaign_id, :published_at,
                        CAST(:contender_id AS uuid), CAST(:stance_code AS civic.slug_code),
                        :stance_score, :confidence, :match_method, :evidence_span
                    )
                    ON CONFLICT DO NOTHING
                    """
                ),
                [
                    {
                        **common,
                        "contender_id": str(s.contender_id),
                        "stance_code": s.stance_code,
                        "stance_score": s.stance_score,
                        "confidence": s.confidence,
                        "match_method": s.match_method,
                        "evidence_span": s.evidence_span,
                    }
                    for s in result.stances
                ],
            )

        if result.topics:
            await session.execute(
                text(
                    """
                    INSERT INTO civic.inference_topics (
                        inference_id, analyzed_at, campaign_id, published_at,
                        category_code, relevance, topic_sentiment, is_primary
                    ) VALUES (
                        :inference_id, :analyzed_at, :campaign_id, :published_at,
                        CAST(:category_code AS civic.slug_code), :relevance,
                        :topic_sentiment, :is_primary
                    )
                    ON CONFLICT DO NOTHING
                    """
                ),
                [
                    {
                        **common,
                        "category_code": t.category_code,
                        "relevance": t.relevance,
                        "topic_sentiment": t.topic_sentiment,
                        "is_primary": t.is_primary,
                    }
                    for t in result.topics
                ],
            )

        if result.entities:
            await session.execute(
                text(
                    """
                    INSERT INTO civic.inference_entities (
                        inference_id, analyzed_at, campaign_id, published_at,
                        entity_type_code, entity_text, entity_norm,
                        contender_id, entity_sentiment, confidence, mention_count
                    ) VALUES (
                        :inference_id, :analyzed_at, :campaign_id, :published_at,
                        :entity_type_code, :entity_text, :entity_norm,
                        CAST(:contender_id AS uuid), :entity_sentiment, :confidence,
                        :mention_count
                    )
                    """
                ),
                [
                    {
                        **common,
                        "entity_type_code": e.entity_type_code,
                        "entity_text": e.entity_text,
                        "entity_norm": e.entity_norm,
                        "contender_id": str(e.contender_id) if e.contender_id else None,
                        "entity_sentiment": e.entity_sentiment,
                        "confidence": e.confidence,
                        "mention_count": e.mention_count,
                    }
                    for e in result.entities
                ],
            )

        if result.risk_flags:
            await session.execute(
                text(
                    """
                    INSERT INTO civic.inference_risk_flags (
                        inference_id, analyzed_at, campaign_id, published_at,
                        flag_code, score, target_contender_id
                    ) VALUES (
                        :inference_id, :analyzed_at, :campaign_id, :published_at,
                        CAST(:flag_code AS civic.slug_code), :score,
                        CAST(:target_contender_id AS uuid)
                    )
                    ON CONFLICT DO NOTHING
                    """
                ),
                [
                    {
                        **common,
                        "flag_code": f.flag_code,
                        "score": f.score,
                        "target_contender_id": str(f.target_contender_id)
                        if f.target_contender_id
                        else None,
                    }
                    for f in result.risk_flags
                ],
            )


# =============================================================================
# Apoyos
# =============================================================================
async def _load_contenders(session: AsyncSession, campaign_id: UUID) -> dict[str, UUID]:
    """Índice nombre/alias → id para resolver las posturas que devuelve el modelo."""
    rows = await fetch_all(
        session,
        """
        SELECT id, name, short_name, aliases
        FROM   civic.contenders
        WHERE  campaign_id = CAST(:campaign_id AS uuid) AND status = 'active'
        """,
        {"campaign_id": str(campaign_id)},
    )

    index: dict[str, UUID] = {}
    for row in rows:
        for label in [row.name, row.short_name, *(row.aliases or [])]:
            if label:
                index[str(label).strip().lower()] = row.id
    return index


def _resolve_contender(item: dict[str, Any], contenders: dict[str, UUID]) -> UUID | None:
    """Acepta un UUID explícito o resuelve por nombre/alias registrado."""
    raw_id = item.get("contender_id") or item.get("target_contender_id")
    if raw_id:
        try:
            return UUID(str(raw_id))
        except ValueError:
            pass

    for key in ("contender", "target", "name", "text", "entity_text"):
        label = item.get(key)
        if label:
            found = contenders.get(str(label).strip().lower())
            if found:
                return found
    return None


def _estimate_cost(
    model: ModelSpec, input_tokens: int | None, output_tokens: int | None
) -> float | None:
    """Costo de la llamada según la tarifa registrada del modelo."""
    if model.cost_per_1k_input is None and model.cost_per_1k_output is None:
        return None
    cost = 0.0
    if input_tokens and model.cost_per_1k_input:
        cost += (input_tokens / 1000.0) * model.cost_per_1k_input
    if output_tokens and model.cost_per_1k_output:
        cost += (output_tokens / 1000.0) * model.cost_per_1k_output
    return round(cost, 6)


classifier_service = ClassifierService()
