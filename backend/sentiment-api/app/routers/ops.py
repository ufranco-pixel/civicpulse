"""Operación: salud, disponibilidad, cumplimiento y refresco de indicadores."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.core.auth import (
    ROLE_ADMIN,
    ROLE_AUDITOR,
    ROLE_OWNER,
    require_min_role,
    require_roles,
)
from app.core.context import Ctx
from app.core.database import get_db
from app.core.logging import get_logger
from app.core.sql import fetch_all, fetch_scalar
from app.schemas.common import ApiModel, HealthResponse, ReadyResponse

log = get_logger(__name__)

# /health y /ready se montan fuera del prefijo de versión: son contratos del
# orquestador, no de la API pública, y no deben moverse con la versión.
public_router = APIRouter(tags=["operación"])
router = APIRouter(prefix="/ops", tags=["operación"])


class ComplianceStatus(ApiModel):
    """Fila de `civic_ops.v_compliance_status`.

    Todos los contadores deben ser 0 en operación normal.
    """

    organization_id: str
    organization: str
    pii_policy: str
    data_retention_days: int
    has_dpo_contact: bool
    sources_missing_legal_basis: int
    contents_past_retention: int
    contents_with_author_identity: int
    stale_raw_payloads: int
    subscriptions_without_consent: int
    risk_flags_pending_review: int
    active_providers_without_no_training_clause: int


class RefreshResult(ApiModel):
    view_name: str
    duration_ms: int | None = None
    rows: int | None = None
    ok: bool
    err: str | None = None


@public_router.get("/health", response_model=HealthResponse, summary="Vivacidad")
async def health() -> HealthResponse:
    """No toca la base: responde si el proceso está vivo.

    Mezclar vivacidad con disponibilidad hace que el orquestador reinicie el
    servicio cada vez que la base parpadea, que es justo lo contrario de lo que
    conviene.
    """
    return HealthResponse(status="ok", version=__version__)


@public_router.get("/ready", response_model=ReadyResponse, summary="Disponibilidad")
async def ready(db: Annotated[AsyncSession, Depends(get_db)]) -> ReadyResponse:
    try:
        await fetch_scalar(db, "SELECT 1")
    except Exception as exc:
        log.error("ready.database_unreachable", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="La base de datos no responde.",
        ) from exc

    return ReadyResponse(
        status="ready", database="ok", checked_at=datetime.now(timezone.utc)
    )


@router.get(
    "/compliance",
    response_model=list[ComplianceStatus],
    dependencies=[Depends(require_roles(ROLE_AUDITOR, ROLE_ADMIN, ROLE_OWNER))],
    summary="Panel de cumplimiento de la organización",
)
async def compliance(ctx: Ctx) -> list[ComplianceStatus]:
    # La vista recorre todas las organizaciones activas, pero sus subconsultas
    # atraviesan tablas con RLS, así que sólo se materializa la del token.
    rows = await fetch_all(
        ctx.session,
        """
        SELECT organization_id::text AS organization_id, organization,
               pii_policy, data_retention_days, has_dpo_contact,
               sources_missing_legal_basis, contents_past_retention,
               contents_with_author_identity, stale_raw_payloads,
               subscriptions_without_consent, risk_flags_pending_review,
               active_providers_without_no_training_clause
        FROM   civic_ops.v_compliance_status
        WHERE  organization_id = CAST(:org_id AS uuid)
        """,
        {"org_id": str(ctx.user.organization_id)},
    )
    return [ComplianceStatus.model_validate(r, from_attributes=True) for r in rows]


@router.post(
    "/refresh-kpis",
    response_model=list[RefreshResult],
    dependencies=[Depends(require_min_role(ROLE_ADMIN))],
    summary="Refresca las vistas materializadas de indicadores",
)
async def refresh_kpis(ctx: Ctx) -> list[RefreshResult]:
    """Refresco concurrente: no bloquea las lecturas del tablero.

    Es una operación cara (minutos con volumen alto). Lo normal es dejarla en
    pg_cron; este endpoint existe para forzarla tras una carga masiva.
    """
    rows = await fetch_all(
        ctx.session,
        "SELECT view_name, duration_ms, rows, ok, err FROM civic_kpi.refresh_all(TRUE)",
    )
    results: list[Any] = [RefreshResult.model_validate(r, from_attributes=True) for r in rows]

    failed = [r.view_name for r in results if not r.ok]
    if failed:
        log.warning("refresh_kpis.partial_failure", views=failed)
    return results
