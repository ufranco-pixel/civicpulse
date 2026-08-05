"""Modelos del motor de clasificación."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import Field

from app.schemas.common import ApiModel


class EmotionOut(ApiModel):
    code: str
    score: float
    is_dominant: bool = False


class StanceOut(ApiModel):
    contender_id: UUID
    stance_code: str
    stance_score: float
    confidence: float
    match_method: str = "model"
    evidence_span: str | None = None


class TopicOut(ApiModel):
    category_code: str
    relevance: float
    topic_sentiment: float | None = None
    is_primary: bool = False


class EntityOut(ApiModel):
    entity_type_code: str
    entity_text: str
    entity_norm: str
    entity_sentiment: float | None = None
    confidence: float | None = None
    mention_count: int = 1
    contender_id: UUID | None = None


class RiskFlagOut(ApiModel):
    flag_code: str
    score: float
    target_contender_id: UUID | None = None


class ClassificationResult(ApiModel):
    """Resultado normalizado, independiente del proveedor de LLM."""

    sentiment_code: str
    sentiment_score: float
    sentiment_confidence: float
    sentiment_probs: dict[str, float] | None = None
    intent_code: str | None = None
    intent_confidence: float | None = None
    toxicity_score: float | None = None
    sarcasm_score: float | None = None
    subjectivity_score: float | None = None
    detected_language: str | None = None
    summary: str | None = None
    overall_confidence: float

    emotions: list[EmotionOut] = Field(default_factory=list)
    stances: list[StanceOut] = Field(default_factory=list)
    topics: list[TopicOut] = Field(default_factory=list)
    entities: list[EntityOut] = Field(default_factory=list)
    risk_flags: list[RiskFlagOut] = Field(default_factory=list)

    # ── Trazabilidad ─────────────────────────────────────────────────────────
    model_name: str
    model_id: UUID | None = None
    prompt_version_id: UUID | None = None
    # FALSE cuando la salida no cumplió el `output_schema` ni tras el reintento.
    schema_valid: bool = True
    used_fallback: bool = False
    latency_ms: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    raw_output: dict[str, Any] | None = None
    inference_id: UUID | None = None
    persisted: bool = False
