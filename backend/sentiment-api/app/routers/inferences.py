"""Inferencias, cola de revisión y corrección humana.

Regla que atraviesa todo el módulo: cualquier consulta a `civic_api.inferences`
lleva `campaign_code` y rango de `published_at`. La tabla subyacente está
particionada por fecha; sin el rango no hay poda de particiones y la consulta
recorre el histórico completo.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, status

from app.core.auth import ROLE_ANALYST, require_min_role
from app.core.context import Ctx
from app.core.sql import (
    MAX_ALL_TIME_DAYS,
    campaign_data_start,
    execute,
    fetch_all,
    fetch_one,
    fetch_scalar,
    not_found,
    resolve_window,
)
from app.schemas.common import Page
from app.schemas.inferences import (
    AnnotationCreate,
    AnnotationResult,
    InferenceDetail,
    InferenceListItem,
    ReviewPatch,
    ReviewQueueItem,
    ReviewResult,
)

router = APIRouter(tags=["inferencias"])

CampaignCode = Annotated[str, Path(min_length=1, max_length=40)]

_LIST_COLUMNS = """
    id, seq, campaign_code, content_id, published_at, analyzed_at,
    text, title, url, language_code,
    source_id, source_name, source_type, source_label, source_color,
    sentiment_code, sentiment_label, sentiment_color, sentiment_score,
    sentiment_confidence, intent_code, intent_label, intent_actionable,
    toxicity_score, sarcasm_score, overall_confidence, needs_review,
    review_status, reach_estimate, likes_count, shares_count,
    emotions, stances, topics, risk_flags
"""

_DETAIL_COLUMNS = (
    _LIST_COLUMNS
    + """,
    campaign_id, content_type_code, replies_count, views_count,
    author_verified, author_followers, author_bot_score, has_media,
    subjectivity_score, sentiment_probs, summary, model_name, pipeline,
    prompt_version_id, entities
"""
)


def _build_filters(
    sentiment: str | None,
    intent: str | None,
    source_type: str | None,
    contender_id: UUID | None,
    topic: str | None,
    min_confidence: float | None,
    needs_review: bool | None,
    q: str | None,
) -> tuple[list[str], dict[str, Any]]:
    """Fragmentos WHERE fijos + sus parámetros.

    Sólo se concatenan cadenas literales escritas aquí; ningún valor de la
    petición entra en el SQL: todos viajan como parámetros nombrados.
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}

    if sentiment:
        clauses.append("sentiment_code = :sentiment")
        params["sentiment"] = sentiment
    if intent:
        clauses.append("intent_code = :intent")
        params["intent"] = intent
    if source_type:
        clauses.append("source_type = :source_type")
        params["source_type"] = source_type
    if contender_id:
        # Las posturas vienen agregadas en JSON dentro de la vista; el
        # operador de contención aprovecha el índice GIN si se define sobre él.
        clauses.append(
            "stances @> jsonb_build_array(jsonb_build_object('contender_id', :contender_id))"
        )
        params["contender_id"] = str(contender_id)
    if topic:
        clauses.append(
            "topics @> jsonb_build_array(jsonb_build_object('category', :topic))"
        )
        params["topic"] = topic
    if min_confidence is not None:
        clauses.append("overall_confidence >= :min_confidence")
        params["min_confidence"] = min_confidence
    if needs_review is not None:
        clauses.append("needs_review = :needs_review")
        params["needs_review"] = needs_review
    if q:
        # Configuración 'simple': sin lematización. En español político el
        # stemmer castellano confunde apellidos con verbos con demasiada
        # frecuencia; se prefiere coincidencia literal por palabra.
        clauses.append(
            "to_tsvector('simple', text) @@ plainto_tsquery('simple', :q)"
        )
        params["q"] = q

    return clauses, params


@router.get(
    "/campaigns/{code}/inferences",
    response_model=Page[InferenceListItem],
    tags=["inferencias"],
    summary="Contenidos analizados, paginados y filtrados",
)
async def list_inferences(
    ctx: Ctx,
    code: CampaignCode,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
    sentiment: str | None = None,
    intent: str | None = None,
    source_type: str | None = None,
    contender_id: UUID | None = None,
    topic: str | None = None,
    min_confidence: Annotated[float | None, Query(ge=0, le=1)] = None,
    needs_review: bool | None = None,
    q: Annotated[str | None, Query(max_length=200, description="Búsqueda de texto completo")] = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> Page[InferenceListItem]:
    # Sin `date_from` explícito el listado cubre TODO el periodo de la campaña.
    #
    # Antes caía en una ventana de 30 días y eso confundía de verdad: con 70
    # comentarios cargados a lo largo de varios meses, la tabla mostraba 32 y
    # el total decía 32. No parecía un filtro, parecía que faltaban datos.
    #
    # El arranque sale del contenido más antiguo de la campaña, no de una
    # constante: la ventana se ajusta a los datos y las particiones se siguen
    # podando. Si la campaña aún no tiene nada, `campaign_data_start` devuelve
    # None y `resolve_window` vuelve a su comportamiento normal.
    if date_from is None:
        date_from = await campaign_data_start(ctx.session, code)

    start, end = resolve_window(
        date_from, date_to, default_days=30, max_days=MAX_ALL_TIME_DAYS
    )

    clauses, params = _build_filters(
        sentiment, intent, source_type, contender_id, topic, min_confidence, needs_review, q
    )
    params.update({"code": code, "start": start, "end": end})

    where = " AND ".join(
        ["campaign_code = :code", "published_at >= :start", "published_at < :end", *clauses]
    )

    total = await fetch_scalar(
        ctx.session,
        f"SELECT count(*) FROM civic_api.inferences WHERE {where}",
        params,
    )

    params.update({"limit": page_size, "offset": (page - 1) * page_size})
    rows = await fetch_all(
        ctx.session,
        f"""
        SELECT {_LIST_COLUMNS}
        FROM   civic_api.inferences
        WHERE  {where}
        ORDER  BY published_at DESC, id
        LIMIT  :limit OFFSET :offset
        """,
        params,
    )

    return Page[InferenceListItem](
        total=int(total or 0),
        page=page,
        page_size=page_size,
        items=[InferenceListItem.model_validate(r, from_attributes=True) for r in rows],
    )


@router.get(
    "/inferences/{inference_id}",
    response_model=InferenceDetail,
    summary="Detalle de una inferencia",
)
async def get_inference(ctx: Ctx, inference_id: UUID) -> InferenceDetail:
    # Sin acotar published_at: es una búsqueda por clave primaria y el índice
    # global sobre id resuelve sin barrer particiones.
    row = await fetch_one(
        ctx.session,
        f"SELECT {_DETAIL_COLUMNS} FROM civic_api.inferences WHERE id = :id",
        {"id": str(inference_id)},
    )
    if row is None:
        raise not_found("Inferencia no encontrada.")
    return InferenceDetail.model_validate(row, from_attributes=True)


@router.get(
    "/campaigns/{code}/review-queue",
    response_model=list[ReviewQueueItem],
    summary="Cola de revisión ordenada por prioridad",
)
async def get_review_queue(
    ctx: Ctx,
    code: CampaignCode,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[ReviewQueueItem]:
    rows = await fetch_all(
        ctx.session,
        """
        SELECT inference_id, campaign_code, content_id, published_at,
               analyzed_at, text, url, source_type, sentiment_code,
               sentiment_score, overall_confidence, sarcasm_score,
               toxicity_score, review_status, review_priority, reach_estimate
        FROM   civic_api.review_queue
        WHERE  campaign_code = :code
        ORDER  BY review_priority DESC, published_at DESC
        LIMIT  :limit
        """,
        {"code": code, "limit": limit},
    )
    return [ReviewQueueItem.model_validate(r, from_attributes=True) for r in rows]


# =============================================================================
# Escritura: anotación y revisión
# =============================================================================
_LOCATE_INFERENCE = """
SELECT id, analyzed_at, campaign_id, content_id, published_at, review_status
FROM   civic_api.inferences
WHERE  id = :id
"""


@router.post(
    "/inferences/{inference_id}/annotate",
    response_model=AnnotationResult,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Corrige una inferencia con etiquetas humanas",
)
async def annotate_inference(
    ctx: Ctx, inference_id: UUID, body: AnnotationCreate
) -> AnnotationResult:
    inference = await fetch_one(ctx.session, _LOCATE_INFERENCE, {"id": str(inference_id)})
    if inference is None:
        raise not_found("Inferencia no encontrada o ya reemplazada.")

    # UNIQUE (content_id, annotator_sub, stance_target_id): un mismo analista
    # reanota su propio juicio en lugar de acumular filas contradictorias. Con
    # stance_target_id NULL la restricción no aplica (NULL nunca colisiona en
    # PostgreSQL), de modo que las anotaciones sin objetivo sí se acumulan.
    annotation_id = await fetch_scalar(
        ctx.session,
        """
        INSERT INTO civic.content_annotations (
            organization_id, campaign_id, content_id, content_published_at,
            annotator_sub, sentiment_code, stance_code, stance_target_id,
            intent_code, emotion_codes, topic_codes, risk_flag_codes,
            annotator_confidence, is_gold, notes
        ) VALUES (
            :organization_id, :campaign_id, :content_id, :content_published_at,
            :annotator_sub,
            CAST(:sentiment_code AS civic.slug_code),
            CAST(:stance_code AS civic.slug_code),
            CAST(:stance_target_id AS uuid),
            CAST(:intent_code AS civic.slug_code),
            CAST(:emotion_codes AS civic.slug_code[]),
            CAST(:topic_codes AS civic.slug_code[]),
            CAST(:risk_flag_codes AS civic.slug_code[]),
            CAST(:annotator_confidence AS civic.unit_score),
            :is_gold, :notes
        )
        ON CONFLICT (content_id, annotator_sub, stance_target_id) DO UPDATE SET
            sentiment_code       = EXCLUDED.sentiment_code,
            stance_code          = EXCLUDED.stance_code,
            intent_code          = EXCLUDED.intent_code,
            emotion_codes        = EXCLUDED.emotion_codes,
            topic_codes          = EXCLUDED.topic_codes,
            risk_flag_codes      = EXCLUDED.risk_flag_codes,
            annotator_confidence = EXCLUDED.annotator_confidence,
            is_gold              = EXCLUDED.is_gold,
            notes                = EXCLUDED.notes,
            updated_at           = NOW()
        RETURNING id
        """,
        {
            "organization_id": str(ctx.user.organization_id),
            "campaign_id": inference.campaign_id,
            "content_id": inference.content_id,
            "content_published_at": inference.published_at,
            "annotator_sub": ctx.user.sub,
            "sentiment_code": body.sentiment_code,
            "stance_code": body.stance_code,
            "stance_target_id": str(body.stance_target_id) if body.stance_target_id else None,
            "intent_code": body.intent_code,
            "emotion_codes": body.emotion_codes,
            "topic_codes": body.topic_codes,
            "risk_flag_codes": body.risk_flag_codes,
            "annotator_confidence": body.annotator_confidence,
            "is_gold": body.is_gold,
            "notes": body.notes,
        },
    )

    # La inferencia del modelo queda reemplazada: los KPIs excluyen
    # is_superseded, así que el tablero refleja la corrección de inmediato.
    await execute(
        ctx.session,
        """
        UPDATE civic.inferences
           SET is_superseded = TRUE,
               review_status = 'corrected',
               reviewed_by   = :reviewer,
               reviewed_at   = NOW()
         WHERE id = :id AND analyzed_at = :analyzed_at
        """,
        {
            "id": inference.id,
            "analyzed_at": inference.analyzed_at,
            "reviewer": ctx.user.sub,
        },
    )

    return AnnotationResult(
        annotation_id=annotation_id,
        inference_id=inference.id,
        content_id=inference.content_id,
        review_status="corrected",
        superseded=True,
    )


@router.patch(
    "/inferences/{inference_id}/review",
    response_model=ReviewResult,
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Confirma una inferencia sin corregirla",
)
async def review_inference(
    ctx: Ctx, inference_id: UUID, body: ReviewPatch
) -> ReviewResult:
    inference = await fetch_one(ctx.session, _LOCATE_INFERENCE, {"id": str(inference_id)})
    if inference is None:
        raise not_found("Inferencia no encontrada o ya reemplazada.")

    # Confirmar NO marca is_superseded: la etiqueta del modelo era correcta y
    # debe seguir contando en los agregados.
    row = await fetch_one(
        ctx.session,
        """
        UPDATE civic.inferences
           SET review_status = :review_status,
               reviewed_by   = :reviewer,
               reviewed_at   = NOW(),
               needs_review  = (:review_status = 'in_review')
         WHERE id = :id AND analyzed_at = :analyzed_at
        RETURNING id, review_status, reviewed_by, reviewed_at
        """,
        {
            "id": inference.id,
            "analyzed_at": inference.analyzed_at,
            "review_status": body.review_status,
            "reviewer": ctx.user.sub,
        },
    )
    if row is None:
        raise not_found("Inferencia no encontrada.")

    return ReviewResult(
        inference_id=row.id,
        review_status=row.review_status,
        reviewed_by=row.reviewed_by,
        reviewed_at=row.reviewed_at,
    )
