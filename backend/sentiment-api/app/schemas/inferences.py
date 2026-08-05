"""Modelos de inferencias, cola de revisión y anotación humana."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.schemas.common import ApiModel


class InferenceListItem(ApiModel):
    """Fila de `civic_api.inferences` para la tabla de contenidos."""

    id: UUID
    seq: int
    campaign_code: str
    content_id: UUID
    published_at: datetime
    analyzed_at: datetime

    text: str
    title: str | None = None
    url: str | None = None
    language_code: str | None = None

    source_id: UUID
    source_name: str
    source_type: str
    source_label: str | None = None
    source_color: str | None = None

    sentiment_code: str
    sentiment_label: str | None = None
    sentiment_color: str | None = None
    sentiment_score: float
    sentiment_confidence: float

    intent_code: str | None = None
    intent_label: str | None = None
    intent_actionable: bool | None = None

    toxicity_score: float | None = None
    # Ironía alta invalida la lectura literal del sentimiento: la interfaz debe
    # marcar estos registros en lugar de promediarlos sin avisar.
    sarcasm_score: float | None = None
    overall_confidence: float
    needs_review: bool
    review_status: str

    reach_estimate: int | None = None
    likes_count: int | None = None
    shares_count: int | None = None

    emotions: list[dict[str, Any]] = Field(default_factory=list)
    stances: list[dict[str, Any]] = Field(default_factory=list)
    topics: list[dict[str, Any]] = Field(default_factory=list)
    risk_flags: list[dict[str, Any]] = Field(default_factory=list)


class InferenceDetail(InferenceListItem):
    """Detalle: añade lo que no cabe en la tabla."""

    campaign_id: UUID
    content_type_code: str | None = None
    replies_count: int | None = None
    views_count: int | None = None
    author_verified: bool | None = None
    author_followers: int | None = None
    author_bot_score: float | None = None
    has_media: bool = False
    subjectivity_score: float | None = None
    sentiment_probs: dict[str, Any] | None = None
    summary: str | None = None
    model_name: str | None = None
    pipeline: str | None = None
    prompt_version_id: UUID | None = None
    entities: list[dict[str, Any]] = Field(default_factory=list)


class ReviewQueueItem(ApiModel):
    """Fila de `civic_api.review_queue`, ordenada por `review_priority`."""

    inference_id: UUID
    campaign_code: str
    content_id: UUID
    published_at: datetime
    analyzed_at: datetime
    text: str
    url: str | None = None
    source_type: str
    sentiment_code: str
    sentiment_score: float
    overall_confidence: float
    sarcasm_score: float | None = None
    toxicity_score: float | None = None
    review_status: str
    review_priority: int
    reach_estimate: int | None = None


class AnnotationCreate(ApiModel):
    """Corrección humana de una inferencia.

    Al menos una etiqueta debe venir informada: una anotación vacía marcaría la
    inferencia como reemplazada sin aportar verdad de referencia.
    """

    sentiment_code: str | None = None
    stance_code: str | None = None
    stance_target_id: UUID | None = None
    intent_code: str | None = None
    emotion_codes: list[str] = Field(default_factory=list)
    topic_codes: list[str] = Field(default_factory=list)
    risk_flag_codes: list[str] = Field(default_factory=list)
    notes: str | None = None
    annotator_confidence: float | None = Field(default=None, ge=0, le=1)
    # Marca la anotación como apta para el conjunto dorado de evaluación.
    is_gold: bool = False

    @field_validator("stance_code")
    @classmethod
    def _stance_needs_target(cls, v: str | None, info: Any) -> str | None:
        if v and not info.data.get("stance_target_id"):
            raise ValueError("stance_code exige stance_target_id: la postura es hacia alguien.")
        return v


class AnnotationResult(ApiModel):
    annotation_id: UUID
    inference_id: UUID
    content_id: UUID
    review_status: str
    superseded: bool


class ReviewPatch(ApiModel):
    """Confirmación sin corrección."""

    review_status: Literal["confirmed", "in_review", "rejected"] = "confirmed"
    notes: str | None = None


class ReviewResult(ApiModel):
    inference_id: UUID
    review_status: str
    reviewed_by: str
    reviewed_at: datetime


class ClassifyRequest(ApiModel):
    """Clasificación bajo demanda de un contenido ya almacenado."""

    content_id: UUID
    published_at: datetime
    task_code: str = "sentiment"
    # Por defecto NO persiste: el endpoint sirve sobre todo para depurar un
    # prompt sin ensuciar la serie histórica con inferencias de prueba.
    persist: bool = False
