"""Alertas, reglas de alerta y evaluación de reglas.

Las alertas se leen de `civic_api.alerts`. Las reglas se leen y escriben en
`civic.alert_rules`: no hay vista de contrato para ellas porque son
configuración, no analítica.
"""

from __future__ import annotations

import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status

from app.core.auth import (
    ROLE_ADMIN,
    ROLE_STRATEGIST,
    AuthenticatedUser,
    require_min_role,
)
from app.core.context import Ctx
from app.core.sql import (
    assert_campaign_visible,
    execute,
    fetch_all,
    fetch_one,
    not_found,
)
from app.schemas.alerts import (
    Alert,
    AlertPatch,
    AlertRule,
    AlertRuleCreate,
    AlertRulePatch,
    RuleEvaluation,
)

router = APIRouter(tags=["alertas"])

CampaignCode = Annotated[str, Path(min_length=1, max_length=40)]

_ALERT_COLUMNS = """
    id, seq, campaign_id, campaign_code, rule_id, rule_name, alert_type_code,
    alert_type_label, severity_code, severity_label, severity_rank,
    severity_color, sla_minutes, title, message, metric, metric_label,
    metric_unit, metric_caveat, observed_value, threshold_value, sample_size,
    window_start, window_end, contender_id, contender_name, source_id,
    source_name, topic_category, evidence, context, status, is_read,
    acknowledged_by, acknowledged_at, resolved_by, resolved_at,
    resolution_note, was_false_positive, during_blackout,
    sla_overdue_minutes, created_at, updated_at
"""

_RULE_COLUMNS = """
    id, campaign_id, campaign_code, name, alert_type_code, severity_code,
    metric, operator, threshold, window_minutes, min_sample_size,
    contender_id, source_id, topic_category, geo_area_id, cooldown_minutes,
    consecutive_hits, max_per_day, respect_blackout, quiet_hours_start,
    quiet_hours_end, channels, recipients, message_template, is_enabled,
    current_streak, last_evaluated_at, last_triggered_at, trigger_count,
    created_at, updated_at, created_by
"""


# =============================================================================
# Alertas
# =============================================================================
@router.get(
    "/campaigns/{code}/alerts",
    response_model=list[Alert],
    summary="Alertas de la campaña",
)
async def list_alerts(
    ctx: Ctx,
    code: CampaignCode,
    severity: str | None = None,
    alert_status: Annotated[str | None, Query(alias="status")] = None,
    is_read: bool | None = None,
    alert_type: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[Alert]:
    clauses: list[str] = ["campaign_code = :code"]
    params: dict[str, Any] = {"code": code, "limit": limit, "offset": offset}

    if severity:
        clauses.append("severity_code = :severity")
        params["severity"] = severity
    if alert_status:
        clauses.append("status = :alert_status")
        params["alert_status"] = alert_status
    if is_read is not None:
        clauses.append("is_read = :is_read")
        params["is_read"] = is_read
    if alert_type:
        clauses.append("alert_type_code = :alert_type")
        params["alert_type"] = alert_type

    rows = await fetch_all(
        ctx.session,
        f"""
        SELECT {_ALERT_COLUMNS}
        FROM   civic_api.alerts
        WHERE  {' AND '.join(clauses)}
        ORDER  BY severity_rank DESC, created_at DESC
        LIMIT  :limit OFFSET :offset
        """,
        params,
    )
    return [Alert.model_validate(r, from_attributes=True) for r in rows]


@router.patch(
    "/alerts/{alert_id}",
    response_model=Alert,
    summary="Acusa recibo, resuelve, descarta o marca como leída",
)
async def patch_alert(ctx: Ctx, alert_id: UUID, body: AlertPatch) -> Alert:
    sets: list[str] = ["updated_at = NOW()"]
    params: dict[str, Any] = {"id": str(alert_id), "actor": ctx.user.sub}

    if body.is_read is not None:
        sets.append("is_read = :is_read")
        params["is_read"] = body.is_read

    if body.status is not None:
        sets.append("status = :new_status")
        params["new_status"] = body.status

        # La autoría no se acepta del cuerpo: sale del token. Es lo que hace
        # auditable quién atendió cada alerta.
        if body.status in ("acknowledged", "in_progress"):
            sets.append("acknowledged_by = :actor")
            sets.append("acknowledged_at = COALESCE(acknowledged_at, NOW())")
        elif body.status in ("resolved", "dismissed"):
            sets.append("resolved_by = :actor")
            # El CHECK ck_alert_resolved exige resolved_at cuando status='resolved'.
            sets.append("resolved_at = NOW()")
            sets.append("acknowledged_at = COALESCE(acknowledged_at, NOW())")
            sets.append("acknowledged_by = COALESCE(acknowledged_by, :actor)")

    if body.resolution_note is not None:
        sets.append("resolution_note = :resolution_note")
        params["resolution_note"] = body.resolution_note

    if body.was_false_positive is not None:
        sets.append("was_false_positive = :was_false_positive")
        params["was_false_positive"] = body.was_false_positive

    updated = await execute(
        ctx.session,
        f"UPDATE civic.alerts SET {', '.join(sets)} WHERE id = :id",
        params,
    )
    if updated == 0:
        raise not_found("Alerta no encontrada.")

    row = await fetch_one(
        ctx.session,
        f"SELECT {_ALERT_COLUMNS} FROM civic_api.alerts WHERE id = :id",
        {"id": str(alert_id)},
    )
    if row is None:
        raise not_found("Alerta no encontrada.")
    return Alert.model_validate(row, from_attributes=True)


# =============================================================================
# Reglas
# =============================================================================
@router.get(
    "/campaigns/{code}/alert-rules",
    response_model=list[AlertRule],
    summary="Reglas configuradas para la campaña",
)
async def list_rules(
    ctx: Ctx,
    code: CampaignCode,
    enabled_only: bool = False,
) -> list[AlertRule]:
    sql = f"SELECT {_RULE_COLUMNS} FROM civic.alert_rules WHERE campaign_code = :code"
    if enabled_only:
        sql += " AND is_enabled"
    sql += " ORDER BY name"

    rows = await fetch_all(ctx.session, sql, {"code": code})
    return [AlertRule.model_validate(r, from_attributes=True) for r in rows]


@router.post(
    "/campaigns/{code}/alert-rules",
    response_model=AlertRule,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_min_role(ROLE_STRATEGIST))],
    summary="Crea una regla de alerta",
)
async def create_rule(ctx: Ctx, code: CampaignCode, body: AlertRuleCreate) -> AlertRule:
    campaign = await assert_campaign_visible(ctx.session, code)

    row = await fetch_one(
        ctx.session,
        f"""
        INSERT INTO civic.alert_rules (
            organization_id, campaign_id, campaign_code, name, alert_type_code,
            severity_code, metric, operator, threshold, window_minutes,
            min_sample_size, contender_id, source_id, topic_category,
            geo_area_id, cooldown_minutes, consecutive_hits, max_per_day,
            respect_blackout, quiet_hours_start, quiet_hours_end, channels,
            recipients, message_template, is_enabled, created_by
        ) VALUES (
            :organization_id, :campaign_id, :campaign_code, :name,
            :alert_type_code::civic.slug_code, :severity_code::civic.slug_code,
            :metric, :operator, :threshold, :window_minutes, :min_sample_size,
            :contender_id::uuid, :source_id::uuid,
            :topic_category::civic.slug_code, :geo_area_id::uuid,
            :cooldown_minutes, :consecutive_hits, :max_per_day,
            :respect_blackout, :quiet_hours_start, :quiet_hours_end,
            :channels::text[], :recipients::jsonb, :message_template,
            :is_enabled, :created_by
        )
        RETURNING {_RULE_COLUMNS}
        """,
        {
            "organization_id": str(ctx.user.organization_id),
            "campaign_id": campaign.id,
            "campaign_code": code,
            "name": body.name,
            "alert_type_code": body.alert_type_code,
            "severity_code": body.severity_code,
            "metric": body.metric,
            "operator": body.operator,
            "threshold": body.threshold,
            "window_minutes": body.window_minutes,
            "min_sample_size": body.min_sample_size,
            "contender_id": str(body.contender_id) if body.contender_id else None,
            "source_id": str(body.source_id) if body.source_id else None,
            "topic_category": body.topic_category,
            "geo_area_id": str(body.geo_area_id) if body.geo_area_id else None,
            "cooldown_minutes": body.cooldown_minutes,
            "consecutive_hits": body.consecutive_hits,
            "max_per_day": body.max_per_day,
            "respect_blackout": body.respect_blackout,
            "quiet_hours_start": body.quiet_hours_start,
            "quiet_hours_end": body.quiet_hours_end,
            "channels": list(body.channels),
            "recipients": json.dumps(body.recipients),
            "message_template": body.message_template,
            "is_enabled": body.is_enabled,
            "created_by": ctx.user.sub,
        },
    )
    return AlertRule.model_validate(row, from_attributes=True)


# Mapa campo → fragmento SET. Las claves son las únicas cadenas que llegan al
# SQL; los valores del cuerpo siempre viajan como parámetros.
_RULE_PATCH_FIELDS: dict[str, str] = {
    "name": "name = :name",
    "severity_code": "severity_code = :severity_code::civic.slug_code",
    "metric": "metric = :metric",
    "operator": "operator = :operator",
    "threshold": "threshold = :threshold",
    "window_minutes": "window_minutes = :window_minutes",
    "min_sample_size": "min_sample_size = :min_sample_size",
    "cooldown_minutes": "cooldown_minutes = :cooldown_minutes",
    "consecutive_hits": "consecutive_hits = :consecutive_hits",
    "max_per_day": "max_per_day = :max_per_day",
    "respect_blackout": "respect_blackout = :respect_blackout",
    "quiet_hours_start": "quiet_hours_start = :quiet_hours_start",
    "quiet_hours_end": "quiet_hours_end = :quiet_hours_end",
    "channels": "channels = :channels::text[]",
    "recipients": "recipients = :recipients::jsonb",
    "message_template": "message_template = :message_template",
    "is_enabled": "is_enabled = :is_enabled",
}


@router.patch(
    "/alert-rules/{rule_id}",
    response_model=AlertRule,
    dependencies=[Depends(require_min_role(ROLE_STRATEGIST))],
    summary="Modifica una regla",
)
async def patch_rule(ctx: Ctx, rule_id: UUID, body: AlertRulePatch) -> AlertRule:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="El cuerpo no cambia nada."
        )

    sets = ["updated_at = NOW()"]
    params: dict[str, Any] = {"id": str(rule_id)}
    for field, value in changes.items():
        fragment = _RULE_PATCH_FIELDS.get(field)
        if fragment is None:
            continue
        sets.append(fragment)
        if field == "recipients":
            params[field] = json.dumps(value)
        else:
            params[field] = value

    row = await fetch_one(
        ctx.session,
        f"""
        UPDATE civic.alert_rules
           SET {', '.join(sets)}
         WHERE id = :id
        RETURNING {_RULE_COLUMNS}
        """,
        params,
    )
    if row is None:
        raise not_found("Regla no encontrada.")
    return AlertRule.model_validate(row, from_attributes=True)


@router.delete(
    "/alert-rules/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_min_role(ROLE_STRATEGIST))],
    summary="Da de baja una regla (baja lógica)",
)
async def delete_rule(ctx: Ctx, rule_id: UUID) -> None:
    # Baja lógica y no DELETE físico: las alertas ya emitidas apuntan a la regla
    # y el informe posterior debe poder explicar por qué se dispararon. Además
    # el rol de la aplicación sólo tiene SELECT/INSERT/UPDATE sobre esta tabla.
    updated = await execute(
        ctx.session,
        """
        UPDATE civic.alert_rules
           SET is_enabled = FALSE, updated_at = NOW()
         WHERE id = :id AND is_enabled
        """,
        {"id": str(rule_id)},
    )
    if updated == 0:
        raise not_found("Regla no encontrada o ya deshabilitada.")


@router.post(
    "/campaigns/{code}/evaluate-rules",
    response_model=list[RuleEvaluation],
    summary="Evalúa las reglas de la campaña",
)
async def evaluate_rules(
    ctx: Ctx,
    code: CampaignCode,
    user: Annotated[AuthenticatedUser, Depends(require_min_role(ROLE_STRATEGIST))],
    dry_run: bool = True,
) -> list[RuleEvaluation]:
    """Con `dry_run=true` sólo calcula; con `false` crea alertas de verdad.

    Disparar alertas reales notifica al equipo y consume la cuota diaria de
    cada regla, así que se exige rol admin.
    """
    if not dry_run and ROLE_ADMIN not in user.roles and "owner" not in user.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Evaluar con dry_run=false requiere rol admin.",
        )

    await assert_campaign_visible(ctx.session, code)

    rows = await fetch_all(
        ctx.session,
        """
        SELECT rule_id, rule_name, metric, observed, threshold, sample_size,
               condition_met, fired, skip_reason, alert_id
        FROM   civic.evaluate_alert_rules(:code::civic.public_code, :dry_run)
        """,
        {"code": code, "dry_run": dry_run},
    )
    return [RuleEvaluation.model_validate(r, from_attributes=True) for r in rows]
