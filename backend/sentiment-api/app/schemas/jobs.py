"""Modelos de trabajos de análisis."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.common import ApiModel

JobType = Literal["batch", "stream", "backfill", "reprocess", "evaluation", "shadow"]
JobPriority = Literal["low", "normal", "high", "urgent"]
JobStatus = Literal[
    "queued", "running", "paused", "completed", "partial", "failed", "cancelled"
]


class Job(ApiModel):
    """Fila de `civic_api.jobs`."""

    id: UUID
    seq: int
    campaign_id: UUID
    campaign_code: str
    job_type: str
    status_code: str
    status_label: str | None = None
    is_terminal: bool = False
    status_color: str | None = None
    priority: str
    model_name: str | None = None
    progress_pct: int
    total_items: int
    processed_items: int
    failed_items: int
    skipped_items: int
    total_cost_usd: float
    attempt: int
    max_attempts: int
    error_message: str | None = None
    stats: dict[str, Any] = Field(default_factory=dict)
    scheduled_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: int | None = None
    created_at: datetime


class JobCreate(ApiModel):
    """Encolado de trabajo. El worker es quien lo ejecuta; la API sólo lo apunta."""

    job_type: JobType = "batch"
    priority: JobPriority = "normal"
    source_id: UUID | None = None
    model_id: UUID | None = None
    prompt_version_id: UUID | None = None
    scheduled_at: datetime | None = None
    max_attempts: int = Field(default=3, gt=0, le=10)
    config: dict[str, Any] = Field(default_factory=dict)


class JobPatch(ApiModel):
    """Cambios que la API admite sobre un trabajo ya encolado.

    El progreso lo reporta el worker por su propia vía; desde la API sólo tiene
    sentido pausar, reanudar o cancelar.
    """

    status_code: JobStatus | None = None
    priority: JobPriority | None = None
    scheduled_at: datetime | None = None
    error_message: str | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> "JobPatch":
        if all(
            getattr(self, f) is None
            for f in ("status_code", "priority", "scheduled_at", "error_message")
        ):
            raise ValueError("El cuerpo no cambia nada.")
        return self
