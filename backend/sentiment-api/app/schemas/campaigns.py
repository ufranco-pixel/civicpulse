"""Modelos de campaña, KPIs y fuentes."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import Field

from app.schemas.common import ApiModel


class CampaignSummary(ApiModel):
    """Fila de `civic_api.campaigns`."""

    id: UUID
    code: str
    name: str
    slug: str
    objective: str | None = None
    campaign_kind: str | None = None
    contest_label: str | None = None
    status: str
    default_language: str
    languages: list[str] = Field(default_factory=list)
    timezone: str
    starts_on: date | None = None
    ends_on: date | None = None
    election_date: date | None = None
    days_to_election: int | None = None
    blackout_starts_on: date | None = None
    blackout_ends_on: date | None = None
    # La veda ya viene calculada por la vista: la interfaz no debe recalcularla
    # con la fecha del navegador, que puede estar en otra zona horaria.
    in_blackout: bool = False
    thresholds: dict[str, Any] = Field(default_factory=dict)
    organization_id: UUID
    organization_name: str
    organization_slug: str
    geo_area_name: str | None = None
    contender_count: int = 0
    active_source_count: int = 0
    created_at: datetime
    updated_at: datetime


class CampaignOverview(ApiModel):
    """Salida de `civic_kpi.campaign_overview`."""

    campaign_code: str
    campaign_name: str
    period_start: date
    period_end: date
    days_to_election: int | None = None
    total_mentions: int
    unique_authors: int
    total_reach: int
    positive_count: int
    neutral_count: int
    negative_count: int
    mixed_count: int
    positive_pct: float | None = None
    neutral_pct: float | None = None
    negative_pct: float | None = None
    net_sentiment: float | None = None
    avg_sentiment_score: float | None = None
    sentiment_momentum: float | None = None
    polarization_index: float | None = None
    avg_toxicity: float | None = None
    avg_confidence: float | None = None
    open_alerts: int
    critical_alerts: int
    review_backlog: int
    sources_healthy: int
    sources_total: int
    # FALSE = volumen por debajo del mínimo publicable. La interfaz debe
    # atenuar el tablero, no mostrar los porcentajes como si fueran sólidos.
    is_reliable: bool
    last_updated: datetime | None = None


class TimeseriesPoint(ApiModel):
    """Punto de `civic_kpi.sentiment_timeseries`."""

    period: date
    total_count: int
    positive_count: int
    neutral_count: int
    negative_count: int
    mixed_count: int
    positive_pct: float | None = None
    negative_pct: float | None = None
    net_sentiment: float | None = None
    avg_score: float | None = None
    rolling_avg_7: float | None = None
    volume_zscore: float | None = None
    is_spike: bool = False
    is_reliable: bool = False


class ContenderScore(ApiModel):
    """Fila de `civic_kpi.contender_scoreboard`."""

    contender_id: UUID
    contender_name: str
    is_own: bool
    mentions: int
    share_of_voice: float | None = None
    unique_authors: int
    total_reach: int
    attention_share: float | None = None
    favor_count: int
    against_count: int
    neutral_count: int
    undecided_count: int
    net_support: float | None = None
    # Cota inferior de Wilson: es la que debe ordenar el ranking, porque castiga
    # a quien tiene un porcentaje alto con muy pocas menciones.
    support_wilson_lb: float | None = None
    avg_stance_score: float | None = None
    avg_text_sentiment: float | None = None
    prev_net_support: float | None = None
    competitive_momentum: float | None = None
    baseline_support_pct: float | None = None
    model_attribution_ratio: float | None = None
    is_reliable: bool
    rank_by_wilson: int | None = None


class TopicAgendaItem(ApiModel):
    """Fila de `civic_kpi.topic_agenda`."""

    category_code: str
    label_es: str
    dimension: str | None = None
    mentions: int
    topic_share: float | None = None
    avg_sentiment: float | None = None
    negative_pct: float | None = None
    unique_authors: int
    prev_mentions: int | None = None
    topic_growth: float | None = None
    is_emerging: bool = False
    is_owned_issue: bool = False
    is_reliable: bool = False


class CrisisRisk(ApiModel):
    """Salida de `civic_kpi.crisis_risk`."""

    risk_index: float | None = None
    risk_level: str
    volume_component: float | None = None
    sentiment_component: float | None = None
    toxicity_component: float | None = None
    flags_component: float | None = None
    sample_size: int
    is_reliable: bool
    explanation: str | None = None


class CoordinationSignal(ApiModel):
    """Fila de `civic_kpi.coordination_signals`.

    Indicio, no prueba: las consignas legítimas de campaña también se replican
    palabra por palabra.
    """

    fingerprint_hex: str
    sample_text: str
    copies: int
    distinct_authors: int
    first_seen: datetime
    last_seen: datetime
    spread_minutes: float | None = None
    sources: list[str] = Field(default_factory=list)
    burst_rate: float | None = None


class EntityFrequency(ApiModel):
    """Agregado de `civic_kpi.mv_entity_frequency`."""

    entity_text: str
    entity_type_code: str
    frequency: int
    document_count: int
    avg_sentiment: float | None = None
    negative_count: int
    positive_count: int


class EmotionAggregate(ApiModel):
    """Agregado de `civic_kpi.mv_emotion_daily`."""

    emotion_code: str
    # Los dos NO son del mismo tipo, aunque el nombre invite a pensarlo:
    # valence es smallint (-1/0/1) y arousal es texto ('low'/'high'). Con
    # `str` en valence, /emotions devolvía 500 con «Input should be a valid
    # string, input_value=-1».
    valence: int | None = None
    arousal: str | None = None
    occurrences: int
    dominant_count: int
    avg_intensity: float | None = None
    max_intensity: float | None = None
    share_pct: float | None = None


class SourceHealth(ApiModel):
    """Fila de `civic_api.sources`.

    `health` es lo primero que hay que mirar ante una caída de sentimiento:
    suele ser una fuente que dejó de reportar, no un cambio de opinión.
    """

    id: UUID
    campaign_id: UUID
    campaign_code: str
    type_code: str
    type_label: str
    type_family: str | None = None
    icon: str | None = None
    color_token: str | None = None
    is_public_data: bool | None = None
    name: str
    slug: str
    status: str
    collection_mode: str | None = None
    collection_schedule: str | None = None
    legal_basis: str | None = None
    last_collected_at: datetime | None = None
    last_success_at: datetime | None = None
    consecutive_errors: int = 0
    last_error: str | None = None
    total_collected: int = 0
    volume_24h: int = 0
    volume_7d: int = 0
    avg_daily_7d: float | None = None
    lag_minutes: float | None = None
    health: str = "unknown"
    created_at: datetime
