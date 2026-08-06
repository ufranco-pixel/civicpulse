"""Campañas e indicadores.

Todo lo que devuelve este módulo sale de `civic_api.*` o de `civic_kpi.*`.

Aviso metodológico que la interfaz debe repetir: estos indicadores miden
CONVERSACIÓN PÚBLICA DIGITAL, no intención de voto. Quien publica no es una
muestra representativa del electorado.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Path, Query

from app.core.context import Ctx
from app.core.sql import assert_campaign_visible, fetch_all, fetch_one, not_found
from app.schemas.campaigns import (
    CampaignOverview,
    CampaignSummary,
    ContenderScore,
    CoordinationSignal,
    CrisisRisk,
    EmotionAggregate,
    EntityFrequency,
    SourceHealth,
    TimeseriesPoint,
    TopicAgendaItem,
)

router = APIRouter(prefix="/campaigns", tags=["campañas"])

CampaignCode = Annotated[str, Path(min_length=1, max_length=40, description="Código público de la campaña")]

_CAMPAIGN_COLUMNS = """
    id, code, name, slug, objective, campaign_kind, contest_label, status,
    default_language, languages, timezone, starts_on, ends_on, election_date,
    days_to_election, blackout_starts_on, blackout_ends_on, in_blackout,
    thresholds, organization_id, organization_name, organization_slug,
    geo_area_name, contender_count, active_source_count, created_at, updated_at
"""


# =============================================================================
# Campañas
# =============================================================================
@router.get("", response_model=list[CampaignSummary], summary="Campañas de la organización")
async def list_campaigns(
    ctx: Ctx,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> list[CampaignSummary]:
    # La RLS ya limita el resultado a la organización del token; aquí sólo se
    # filtra por estado.
    sql = f"SELECT {_CAMPAIGN_COLUMNS} FROM civic_api.campaigns"
    params: dict[str, object] = {}
    if status_filter:
        sql += " WHERE status = :status"
        params["status"] = status_filter
    sql += " ORDER BY created_at DESC"

    rows = await fetch_all(ctx.session, sql, params)
    return [CampaignSummary.model_validate(r, from_attributes=True) for r in rows]


@router.get("/{code}", response_model=CampaignSummary, summary="Detalle de una campaña")
async def get_campaign(ctx: Ctx, code: CampaignCode) -> CampaignSummary:
    row = await fetch_one(
        ctx.session,
        f"SELECT {_CAMPAIGN_COLUMNS} FROM civic_api.campaigns WHERE code = :code",
        {"code": code},
    )
    if row is None:
        raise not_found(f"Campaña '{code}' no encontrada.")
    return CampaignSummary.model_validate(row, from_attributes=True)


# =============================================================================
# Indicadores
# =============================================================================
@router.get(
    "/{code}/overview",
    response_model=CampaignOverview,
    summary="Resumen de campaña en una sola llamada",
)
async def get_overview(
    ctx: Ctx,
    code: CampaignCode,
    days: Annotated[int, Query(ge=1, le=365)] = 30,
) -> CampaignOverview:
    row = await fetch_one(
        ctx.session,
        """
        SELECT campaign_code, campaign_name, period_start, period_end,
               days_to_election, total_mentions, unique_authors, total_reach,
               positive_count, neutral_count, negative_count, mixed_count,
               positive_pct, neutral_pct, negative_pct, net_sentiment,
               avg_sentiment_score, sentiment_momentum, polarization_index,
               avg_toxicity, avg_confidence, open_alerts, critical_alerts,
               review_backlog, sources_healthy, sources_total, is_reliable,
               last_updated
        FROM   civic_kpi.campaign_overview(CAST(:code AS civic.public_code), :days)
        """,
        {"code": code, "days": days},
    )
    if row is None:
        raise not_found(f"Campaña '{code}' no encontrada.")
    return CampaignOverview.model_validate(row, from_attributes=True)


@router.get(
    "/{code}/timeseries",
    response_model=list[TimeseriesPoint],
    summary="Serie temporal de sentimiento",
)
async def get_timeseries(
    ctx: Ctx,
    code: CampaignCode,
    days: Annotated[int, Query(ge=1, le=365)] = 30,
    granularity: Literal["day", "week", "month"] = "day",
    source_id: UUID | None = None,
) -> list[TimeseriesPoint]:
    rows = await fetch_all(
        ctx.session,
        """
        SELECT period, total_count, positive_count, neutral_count,
               negative_count, mixed_count, positive_pct, negative_pct,
               net_sentiment, avg_score, rolling_avg_7, volume_zscore,
               is_spike, is_reliable
        FROM   civic_kpi.sentiment_timeseries(
                   CAST(:code AS civic.public_code), :days, :granularity, CAST(:source_id AS uuid))
        ORDER  BY period
        """,
        {
            "code": code,
            "days": days,
            "granularity": granularity,
            "source_id": str(source_id) if source_id else None,
        },
    )
    return [TimeseriesPoint.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/{code}/contenders",
    response_model=list[ContenderScore],
    summary="Tablero competitivo por contendiente",
)
async def get_contenders(
    ctx: Ctx,
    code: CampaignCode,
    days: Annotated[int, Query(ge=1, le=365)] = 14,
) -> list[ContenderScore]:
    rows = await fetch_all(
        ctx.session,
        """
        SELECT contender_id, contender_name, is_own, mentions, share_of_voice,
               unique_authors, total_reach, attention_share, favor_count,
               against_count, neutral_count, undecided_count, net_support,
               support_wilson_lb, avg_stance_score, avg_text_sentiment,
               prev_net_support, competitive_momentum, baseline_support_pct,
               model_attribution_ratio, is_reliable, rank_by_wilson
        FROM   civic_kpi.contender_scoreboard(CAST(:code AS civic.public_code), :days)
        ORDER  BY rank_by_wilson NULLS LAST
        """,
        {"code": code, "days": days},
    )
    return [ContenderScore.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/{code}/topics",
    response_model=list[TopicAgendaItem],
    summary="Agenda temática",
)
async def get_topics(
    ctx: Ctx,
    code: CampaignCode,
    days: Annotated[int, Query(ge=1, le=365)] = 14,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[TopicAgendaItem]:
    rows = await fetch_all(
        ctx.session,
        """
        SELECT category_code, label_es, dimension, mentions, topic_share,
               avg_sentiment, negative_pct, unique_authors, prev_mentions,
               topic_growth, is_emerging, is_owned_issue, is_reliable
        FROM   civic_kpi.topic_agenda(CAST(:code AS civic.public_code), :days, :limit)
        """,
        {"code": code, "days": days, "limit": limit},
    )
    return [TopicAgendaItem.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/{code}/crisis",
    response_model=CrisisRisk,
    summary="Índice de riesgo de crisis con sus componentes",
)
async def get_crisis(
    ctx: Ctx,
    code: CampaignCode,
    hours: Annotated[int, Query(ge=1, le=336)] = 24,
) -> CrisisRisk:
    row = await fetch_one(
        ctx.session,
        """
        SELECT risk_index, risk_level, volume_component, sentiment_component,
               toxicity_component, flags_component, sample_size, is_reliable,
               explanation
        FROM   civic_kpi.crisis_risk(CAST(:code AS civic.public_code), :hours)
        """,
        {"code": code, "hours": hours},
    )
    if row is None:
        raise not_found(f"Campaña '{code}' no encontrada.")
    return CrisisRisk.model_validate(row, from_attributes=True)


@router.get(
    "/{code}/coordination",
    response_model=list[CoordinationSignal],
    summary="Textos replicados por autores distintos",
)
async def get_coordination(
    ctx: Ctx,
    code: CampaignCode,
    hours: Annotated[int, Query(ge=1, le=336)] = 24,
    min_authors: Annotated[int, Query(ge=2, le=100)] = 3,
) -> list[CoordinationSignal]:
    rows = await fetch_all(
        ctx.session,
        """
        SELECT fingerprint_hex, sample_text, copies, distinct_authors,
               first_seen, last_seen, spread_minutes, sources, burst_rate
        FROM   civic_kpi.coordination_signals(
                   CAST(:code AS civic.public_code), :hours, :min_authors)
        """,
        {"code": code, "hours": hours, "min_authors": min_authors},
    )
    return [CoordinationSignal.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/{code}/entities",
    response_model=list[EntityFrequency],
    summary="Entidades más mencionadas",
)
async def get_entities(
    ctx: Ctx,
    code: CampaignCode,
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
    entity_type: str | None = None,
    months: Annotated[int, Query(ge=1, le=36, description="Meses hacia atrás a agregar")] = 6,
) -> list[EntityFrequency]:
    # Las vistas materializadas se calculan con los privilegios de su dueño, así
    # que NO heredan la RLS. El aislamiento aquí lo da el campaign_id, que se
    # obtiene de civic_api.campaigns, que sí la respeta.
    campaign = await assert_campaign_visible(ctx.session, code)

    sql = """
        SELECT entity_text,
               entity_type_code,
               sum(frequency)::bigint                        AS frequency,
               sum(document_count)::bigint                   AS document_count,
               round(sum(avg_sentiment * frequency)
                     / NULLIF(sum(frequency), 0), 5)         AS avg_sentiment,
               sum(negative_count)::bigint                   AS negative_count,
               sum(positive_count)::bigint                   AS positive_count
        FROM   civic_kpi.mv_entity_frequency
        WHERE  campaign_id = :campaign_id
          AND  month >= date_trunc('month', CURRENT_DATE)::date
                        - make_interval(months => :months)
    """
    params: dict[str, object] = {
        "campaign_id": campaign.id,
        "months": months,
        "limit": limit,
    }
    if entity_type:
        sql += " AND entity_type_code = :entity_type"
        params["entity_type"] = entity_type

    sql += """
        GROUP  BY entity_text, entity_type_code
        ORDER  BY frequency DESC
        LIMIT  :limit
    """
    rows = await fetch_all(ctx.session, sql, params)
    return [EntityFrequency.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/{code}/emotions",
    response_model=list[EmotionAggregate],
    summary="Distribución de emociones del periodo",
)
async def get_emotions(
    ctx: Ctx,
    code: CampaignCode,
    days: Annotated[int, Query(ge=1, le=365)] = 14,
) -> list[EmotionAggregate]:
    campaign = await assert_campaign_visible(ctx.session, code)

    rows = await fetch_all(
        ctx.session,
        """
        WITH agg AS (
            SELECT emotion_code,
                   max(valence)                                  AS valence,
                   max(arousal)                                  AS arousal,
                   sum(occurrences)::bigint                      AS occurrences,
                   sum(dominant_count)::bigint                   AS dominant_count,
                   round(sum(avg_intensity * occurrences)
                         / NULLIF(sum(occurrences), 0), 5)       AS avg_intensity,
                   max(max_intensity)                            AS max_intensity
            FROM   civic_kpi.mv_emotion_daily
            WHERE  campaign_id = :campaign_id
              AND  day >= CURRENT_DATE - make_interval(days => :days)
            GROUP  BY emotion_code
        )
        SELECT emotion_code, valence, arousal, occurrences, dominant_count,
               avg_intensity, max_intensity,
               round(100.0 * occurrences
                     / NULLIF(sum(occurrences) OVER (), 0), 2)   AS share_pct
        FROM   agg
        ORDER  BY occurrences DESC
        """,
        {"campaign_id": campaign.id, "days": days},
    )
    return [EmotionAggregate.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/{code}/sources",
    response_model=list[SourceHealth],
    summary="Fuentes de la campaña con su salud",
)
async def get_sources(
    ctx: Ctx,
    code: CampaignCode,
    health: Annotated[str | None, Query(description="healthy, stale, failing, inactive…")] = None,
) -> list[SourceHealth]:
    sql = """
        SELECT id, campaign_id, campaign_code, type_code, type_label,
               type_family, icon, color_token, is_public_data, name, slug,
               status, collection_mode, collection_schedule, legal_basis,
               last_collected_at, last_success_at, consecutive_errors,
               last_error, total_collected, volume_24h, volume_7d,
               avg_daily_7d, lag_minutes, health, created_at
        FROM   civic_api.sources
        WHERE  campaign_code = :code
    """
    params: dict[str, object] = {"code": code}
    if health:
        sql += " AND health = :health"
        params["health"] = health
    sql += " ORDER BY name"

    rows = await fetch_all(ctx.session, sql, params)
    return [SourceHealth.model_validate(r, from_attributes=True) for r in rows]
