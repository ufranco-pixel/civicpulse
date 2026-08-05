"""Modelos de evaluación: conjuntos, casos dorados, corridas y métricas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field

from app.schemas.common import ApiModel

DatasetSplit = Literal["train", "dev", "test", "holdout", "adversarial"]
SamplingMethod = Literal[
    "random", "stratified", "uncertainty", "disagreement", "manual", "adversarial"
]


class EvalDataset(ApiModel):
    id: UUID
    organization_id: UUID
    campaign_id: UUID | None = None
    code: str
    name: str
    description: str | None = None
    split: str
    task_codes: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    sampling_method: str | None = None
    sampling_notes: str | None = None
    random_seed: int | None = None
    item_count: int
    annotators_per_item: int
    # Techo realista del modelo: nadie supera de forma fiable el acuerdo humano.
    inter_annotator_agreement: float | None = None
    is_frozen: bool
    frozen_at: datetime | None = None
    version: str
    created_at: datetime
    created_by: str | None = None


class EvalDatasetCreate(ApiModel):
    code: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1)
    description: str | None = None
    campaign_id: UUID | None = None
    split: DatasetSplit = "test"
    task_codes: list[str] = Field(default_factory=lambda: ["sentiment"])
    languages: list[str] = Field(default_factory=lambda: ["es"])
    sampling_method: SamplingMethod | None = None
    sampling_notes: str | None = None
    random_seed: int | None = None
    annotators_per_item: int = Field(default=1, ge=1)
    inter_annotator_agreement: float | None = Field(default=None, ge=-1, le=1)
    version: str = "v1"


class EvalItemCreate(ApiModel):
    """Caso dorado. `text` se copia para que sobreviva a la purga por retención."""

    text: str = Field(min_length=1)
    language_code: str = "es"
    source_type: str | None = None
    content_id: UUID | None = None
    content_published_at: datetime | None = None
    gold_sentiment: str | None = None
    gold_stance: str | None = None
    gold_stance_target: UUID | None = None
    gold_intent: str | None = None
    gold_emotions: list[str] = Field(default_factory=list)
    gold_topics: list[str] = Field(default_factory=list)
    gold_risk_flags: list[str] = Field(default_factory=list)
    gold_entities: list[dict[str, Any]] = Field(default_factory=list)
    difficulty: Literal["easy", "medium", "hard"] | None = None
    # sarcasm, negation, code_switching, local_slang, quoted_speech...
    phenomena: list[str] = Field(default_factory=list)
    is_contested: bool = False
    annotator_notes: str | None = None


class EvalItemsBulk(ApiModel):
    items: list[EvalItemCreate] = Field(min_length=1, max_length=5000)


class BulkResult(ApiModel):
    inserted: int
    dataset_id: UUID
    item_count: int


class EvalRun(ApiModel):
    id: UUID
    organization_id: UUID
    dataset_id: UUID
    dataset_code: str | None = None
    model_id: UUID
    model_name: str | None = None
    prompt_version_id: UUID | None = None
    name: str | None = None
    baseline_run_id: UUID | None = None
    status_code: str
    tasks_evaluated: list[str] = Field(default_factory=list)
    items_total: int
    items_predicted: int
    items_failed: int
    # Un prompt exacto que rompe el formato el 5 % de las veces es inservible.
    schema_violations: int
    total_cost_usd: float
    avg_latency_ms: int | None = None
    p95_latency_ms: int | None = None
    verdict: str | None = None
    verdict_reason: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None
    created_at: datetime
    created_by: str | None = None


class EvalRunCreate(ApiModel):
    dataset_id: UUID
    model_id: UUID
    prompt_version_id: UUID | None = None
    name: str | None = None
    baseline_run_id: UUID | None = None
    tasks_evaluated: list[str] = Field(default_factory=lambda: ["sentiment"])
    config: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None


class EvalMetric(ApiModel):
    task_code: str
    class_code: str
    # 'all', 'lang:es', 'source:x_twitter', 'phenom:sarcasm'...
    slice: str
    metric_name: str
    metric_value: float
    support: int | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None
    computed_at: datetime


class ConfusionCell(ApiModel):
    task_code: str
    slice: str
    gold_class: str
    pred_class: str
    count: int


class MetricComparison(ApiModel):
    """Fila de `civic_kpi.compare_eval_runs`."""

    task: str
    slice: str
    metric: str
    baseline: float
    candidate: float
    delta: float
    delta_pct: float | None = None
    verdict: str


class PromotionGate(ApiModel):
    """Salida de `civic_kpi.evaluate_promotion_gate`."""

    passed: bool
    reason: str


class ComputeMetricsResult(ApiModel):
    task: str
    slice: str
    metric: str
    value: float


class PredictionError(ApiModel):
    """Caso fallido de `civic_kpi.v_eval_prediction_detail`."""

    prediction_id: UUID
    item_id: UUID
    text: str
    language_code: str
    source_type: str | None = None
    difficulty: str | None = None
    phenomena: list[str] = Field(default_factory=list)
    is_contested: bool
    gold_sentiment: str | None = None
    pred_sentiment: str | None = None
    sentiment_correct: bool | None = None
    gold_stance: str | None = None
    pred_stance: str | None = None
    stance_correct: bool | None = None
    gold_intent: str | None = None
    pred_intent: str | None = None
    intent_correct: bool | None = None
    emotions_jaccard: float | None = None
    topics_jaccard: float | None = None
    confidence: float | None = None
    schema_valid: bool
    latency_ms: int | None = None
    error_message: str | None = None
