"""Registro manual de un comentario, con su clasificación y su alerta.

Existe para una necesidad concreta: poder demostrar el circuito completo
—comentario → clasificación → alerta → WhatsApp— sin esperar a que la ingesta
recoja algo negativo por su cuenta.

Restringido a `admin`. No es una restricción decorativa: quien use esto está
inyectando a mano una observación que después alimenta indicadores públicos.
Cada fila queda marcada con `pipeline='human'` y con el usuario que la creó,
para que un comentario inventado nunca se confunda con uno recogido de una
fuente real.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, status
from pydantic import BaseModel, Field

from app.core.auth import ROLE_ADMIN, require_min_role
from app.core.context import Ctx
from app.core.sql import fetch_all, fetch_one, not_found

router = APIRouter(tags=["registro manual"])

# Misma forma que en los demás routers, que declaran el suyo localmente.
CampaignCode = Annotated[str, Path(min_length=1, max_length=40)]


class ManualCommentIn(BaseModel):
    """Comentario que se registra a mano."""

    body: str = Field(min_length=3, max_length=4000)
    sentiment: Literal["negative", "neutral", "positive"] = "negative"
    author_display: str | None = Field(default=None, max_length=120)
    source_id: UUID | None = Field(
        default=None,
        description="Fuente a la que se atribuye. Si se omite, se usa la primera activa.",
    )
    notify: bool = Field(
        default=True,
        description="Si es falso, se registra la clasificación pero no se genera alerta.",
    )


class ManualCommentOut(BaseModel):
    content_id: UUID
    inference_id: UUID
    sentiment: str
    sentiment_score: float
    alert_id: UUID | None = None
    deliveries: int = 0
    deliveries_detail: list[dict] = Field(default_factory=list)


# La puntuación es fija por etiqueta y deliberadamente no la escribe quien
# llama: es un registro manual, no una medición, y dejar elegir el número
# invitaría a fabricar una intensidad concreta para mover un indicador.
_SCORE = {"negative": -0.85, "neutral": 0.0, "positive": 0.85}


@router.post(
    "/campaigns/{code}/manual-comments",
    response_model=ManualCommentOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_min_role(ROLE_ADMIN))],
    summary="Registra un comentario a mano y dispara su alerta",
)
async def create_manual_comment(
    ctx: Ctx,
    code: CampaignCode,
    payload: ManualCommentIn,
) -> ManualCommentOut:
    campaign = await fetch_one(
        ctx.session,
        "SELECT id, organization_id, name FROM civic_api.campaigns WHERE code = :code",
        {"code": code},
    )
    if campaign is None:
        not_found(f"No existe la campaña {code}.")

    source_id = payload.source_id
    if source_id is None:
        row = await fetch_one(
            ctx.session,
            """
            SELECT id FROM civic.sources
            WHERE  campaign_id = CAST(:cid AS uuid) AND status = 'active'
            ORDER  BY created_at LIMIT 1
            """,
            {"cid": str(campaign.id)},
        )
        if row is None:
            not_found(
                "La campaña no tiene ninguna fuente activa. Cree una antes de "
                "registrar comentarios a mano."
            )
        source_id = row.id

    score = _SCORE[payload.sentiment]

    # `fingerprint` se calcula con sha256 del texto normalizado, igual que en la
    # ingesta: así el detector de duplicados trata este comentario como
    # cualquier otro y registrar dos veces el mismo texto no infla los conteos.
    content = await fetch_one(
        ctx.session,
        """
        INSERT INTO civic.contents (
            published_at, organization_id, campaign_id, source_id,
            content_type_code, body, author_display, language_code,
            fingerprint, external_id
        )
        VALUES (
            NOW(), CAST(:org AS uuid), CAST(:cid AS uuid), CAST(:src AS uuid),
            'comment', :body, :autor, 'es',
            sha256(convert_to(civic_ops.normalize_text(:body), 'UTF8')),
            'manual-' || gen_random_uuid()::text
        )
        RETURNING id, published_at
        """,
        {
            "org": str(campaign.organization_id),
            "cid": str(campaign.id),
            "src": str(source_id),
            "body": payload.body,
            "autor": payload.author_display,
        },
    )

    model = await fetch_one(
        ctx.session,
        "SELECT id FROM civic.ai_models WHERE code = 'rule-baseline' LIMIT 1",
        {},
    )
    if model is None:
        not_found("Falta el modelo rule-baseline. Ejecute sql/05_ai_models.sql.")

    inference = await fetch_one(
        ctx.session,
        """
        INSERT INTO civic.inferences (
            organization_id, campaign_id, source_id, content_id, published_at,
            analyzed_at, model_id, model_name_snapshot, model_version_snapshot,
            pipeline, sentiment_code, sentiment_score, sentiment_confidence,
            overall_confidence, needs_review, review_status
        )
        VALUES (
            CAST(:org AS uuid), CAST(:cid AS uuid), CAST(:src AS uuid),
            CAST(:content AS uuid), :pub,
            NOW(), CAST(:model AS uuid), :snapshot, '1.0',
            'human', CAST(:sent AS civic.slug_code), :score, 1.0,
            1.0, TRUE, 'pending'
        )
        RETURNING id
        """,
        {
            "org": str(campaign.organization_id),
            "cid": str(campaign.id),
            "src": str(source_id),
            "content": str(content.id),
            "pub": content.published_at,
            "model": str(model.id),
            "sent": payload.sentiment,
            "score": score,
            # La tabla no tiene columna de notas, así que la autoría queda en
            # el nombre del modelo. Es lo que se ve en la tabla de Contenidos y
            # en la cola de revisión, que es justo donde importa distinguirlo.
            "snapshot": f"Registro manual · {ctx.user.username or ctx.user.sub}",
        },
    )

    alert_id: UUID | None = None
    detail: list[dict] = []

    # La alerta solo para comentarios negativos: avisar por WhatsApp de que
    # alguien felicitó a la campaña convierte el canal en ruido, y el canal
    # ruidoso se acaba silenciando justo antes de la alerta que sí importaba.
    if payload.notify and payload.sentiment == "negative":
        alert = await fetch_one(
            ctx.session,
            """
            INSERT INTO civic.alerts (
                organization_id, campaign_id, campaign_code, alert_type_code,
                severity_code, title, message, metric, observed_value,
                threshold_value, sample_size, window_start, window_end,
                source_id, evidence, context
            )
            VALUES (
                CAST(:org AS uuid), CAST(:cid AS uuid), :code,
                'negative_spike', 'high',
                'Comentario negativo registrado',
                :mensaje,
                'negative_pct', 100, 0, 1,
                NOW(), NOW(), CAST(:src AS uuid),
                -- Los CAST explícitos son necesarios: jsonb_build_object
                -- acepta "any", así que asyncpg no puede deducir el tipo del
                -- parámetro y falla con «could not determine data type».
                jsonb_build_array(jsonb_build_object(
                    'content_id', CAST(:content AS text),
                    'texto', left(CAST(:body AS text), 500))),
                jsonb_build_object('origen', 'registro_manual',
                                   'usuario', CAST(:usuario AS text))
            )
            RETURNING id
            """,
            {
                "org": str(campaign.organization_id),
                "cid": str(campaign.id),
                "code": code,
                "src": str(source_id),
                "content": str(content.id),
                "body": payload.body,
                "usuario": ctx.user.username or ctx.user.sub,
                "mensaje": (
                    f'Se registró un comentario negativo en «{campaign.name}»: '
                    f'"{payload.body[:300]}"'
                ),
            },
        )
        alert_id = alert.id

        # El reparto a suscriptores lo hace el disparador tg_alerts_fanout al
        # insertar. Aquí solo se leen las entregas que produjo, para poder
        # decirle a quien registró el comentario si de verdad va a salir un
        # mensaje o si no hay nadie dado de alta. Un 201 silencioso sobre una
        # lista vacía de destinatarios es el peor resultado posible: parece
        # que funcionó.
        rows = await fetch_all(
            ctx.session,
            """
            SELECT recipient, status, suppression_reason
            FROM   civic.alert_deliveries
            WHERE  alert_id = CAST(:aid AS uuid) AND channel = 'whatsapp'
            """,
            {"aid": str(alert_id)},
        )
        detail = [
            {
                "recipient": r.recipient,
                "status": r.status,
                "suppression_reason": r.suppression_reason,
            }
            for r in rows
        ]

    return ManualCommentOut(
        content_id=content.id,
        inference_id=inference.id,
        sentiment=payload.sentiment,
        sentiment_score=score,
        alert_id=alert_id,
        deliveries=len(detail),
        deliveries_detail=detail,
    )


@router.get(
    "/campaigns/{code}/whatsapp-recipients",
    dependencies=[Depends(require_min_role(ROLE_ADMIN))],
    summary="Quién recibiría hoy una alerta por WhatsApp",
)
async def list_recipients(
    ctx: Ctx,
    code: CampaignCode,
    severity: Annotated[str, Query()] = "high",
) -> dict:
    """Muestra los destinatarios efectivos para una severidad dada.

    Responde a la pregunta que se hace justo antes de pulsar el botón: «¿esto
    a quién le va a llegar?». Aplica los mismos filtros que
    `civic.fanout_alert_deliveries`, así que si aquí sale vacío, el envío
    también saldrá vacío.
    """
    rows = await fetch_all(
        ctx.session,
        """
        SELECT sub.destination, sub.display_name, sub.min_severity,
               sub.consent_given_at IS NOT NULL AS has_consent,
               sub.is_active
        FROM   civic.alert_subscriptions sub
        JOIN   civic_cat.severity_levels smin ON smin.code = sub.min_severity
        JOIN   civic_cat.severity_levels salr ON salr.code = CAST(:sev AS civic.slug_code)
        WHERE  sub.campaign_code = :code
          AND  sub.channel = 'whatsapp'
          AND  sub.is_active
          AND  sub.opted_out_at IS NULL
          AND  sub.consent_given_at IS NOT NULL
          AND  salr.rank >= smin.rank
        ORDER  BY sub.display_name NULLS LAST, sub.destination
        """,
        {"code": code, "sev": severity},
    )
    return {
        "data": [
            {
                "destination": r.destination,
                "display_name": r.display_name,
                "min_severity": r.min_severity,
            }
            for r in rows
        ],
        "count": len(rows),
        "severity": severity,
    }
