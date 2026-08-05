"""Modelos de alertas, reglas y evaluación de reglas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.common import ApiModel

AlertStatus = Literal["open", "acknowledged", "in_progress", "resolved", "dismissed", "expired"]
RuleOperator = Literal["gt", "gte", "lt", "lte", "eq", "neq"]
RuleChannel = Literal["sse", "email", "whatsapp", "webhook", "slack"]


class Alert(ApiModel):
    """Fila de `civic_api.alerts`."""

    id: UUID
    seq: int
    campaign_id: UUID
    campaign_code: str
    rule_id: UUID | None = None
    rule_name: str | None = None
    alert_type_code: str
    alert_type_label: str | None = None
    severity_code: str
    severity_label: str | None = None
    severity_rank: int | None = None
    severity_color: str | None = None
    sla_minutes: int | None = None
    title: str
    message: str
    metric: str | None = None
    metric_label: str | None = None
    metric_unit: str | None = None
    # La advertencia del indicador viaja con la alerta: quien la atiende debe
    # leer el número sabiendo cómo interpretarlo.
    metric_caveat: str | None = None
    observed_value: float | None = None
    threshold_value: float | None = None
    sample_size: int | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None
    contender_id: UUID | None = None
    contender_name: str | None = None
    source_id: UUID | None = None
    source_name: str | None = None
    topic_category: str | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)
    status: str
    is_read: bool
    acknowledged_by: str | None = None
    acknowledged_at: datetime | None = None
    resolved_by: str | None = None
    resolved_at: datetime | None = None
    resolution_note: str | None = None
    was_false_positive: bool | None = None
    during_blackout: bool = False
    sla_overdue_minutes: int | None = None
    created_at: datetime
    updated_at: datetime


class AlertPatch(ApiModel):
    """Cambio de estado de una alerta.

    `was_false_positive` no es cosmético: alimenta la recalibración de las
    reglas que disparan de más.
    """

    status: AlertStatus | None = None
    is_read: bool | None = None
    resolution_note: str | None = None
    was_false_positive: bool | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> "AlertPatch":
        if all(
            getattr(self, f) is None
            for f in ("status", "is_read", "resolution_note", "was_false_positive")
        ):
            raise ValueError("El cuerpo no cambia nada.")
        return self


class AlertRule(ApiModel):
    """Regla de alerta tal como se devuelve a la interfaz."""

    id: UUID
    campaign_id: UUID
    campaign_code: str
    name: str
    alert_type_code: str
    severity_code: str
    metric: str
    operator: str
    threshold: float
    window_minutes: int
    min_sample_size: int
    contender_id: UUID | None = None
    source_id: UUID | None = None
    topic_category: str | None = None
    geo_area_id: UUID | None = None
    cooldown_minutes: int
    consecutive_hits: int
    max_per_day: int
    respect_blackout: bool
    quiet_hours_start: int | None = None
    quiet_hours_end: int | None = None
    channels: list[str] = Field(default_factory=list)
    recipients: list[dict[str, Any]] = Field(default_factory=list)
    message_template: str | None = None
    is_enabled: bool
    current_streak: int
    last_evaluated_at: datetime | None = None
    last_triggered_at: datetime | None = None
    trigger_count: int
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None


class AlertRuleCreate(ApiModel):
    """Alta de regla. Los valores por defecto replican los de la tabla."""

    name: str = Field(min_length=1, max_length=200)
    alert_type_code: str
    severity_code: str
    metric: str
    operator: RuleOperator
    threshold: float
    window_minutes: int = Field(default=60, gt=0)
    # Salvaguarda contra la alerta falsa por muestra diminuta: 2 comentarios
    # negativos de 2 dan 100 % de negatividad.
    min_sample_size: int = Field(default=30, ge=0)
    contender_id: UUID | None = None
    source_id: UUID | None = None
    topic_category: str | None = None
    geo_area_id: UUID | None = None
    cooldown_minutes: int = Field(default=120, ge=0)
    consecutive_hits: int = Field(default=1, ge=1)
    max_per_day: int = Field(default=12, gt=0)
    respect_blackout: bool = True
    quiet_hours_start: int | None = Field(default=None, ge=0, le=23)
    quiet_hours_end: int | None = Field(default=None, ge=0, le=23)
    channels: list[RuleChannel] = Field(default_factory=lambda: ["sse"])
    recipients: list[dict[str, Any]] = Field(default_factory=list)
    message_template: str | None = None
    is_enabled: bool = True


class AlertRulePatch(ApiModel):
    """Actualización parcial: sólo se tocan los campos presentes."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    severity_code: str | None = None
    metric: str | None = None
    operator: RuleOperator | None = None
    threshold: float | None = None
    window_minutes: int | None = Field(default=None, gt=0)
    min_sample_size: int | None = Field(default=None, ge=0)
    cooldown_minutes: int | None = Field(default=None, ge=0)
    consecutive_hits: int | None = Field(default=None, ge=1)
    max_per_day: int | None = Field(default=None, gt=0)
    respect_blackout: bool | None = None
    quiet_hours_start: int | None = Field(default=None, ge=0, le=23)
    quiet_hours_end: int | None = Field(default=None, ge=0, le=23)
    channels: list[RuleChannel] | None = None
    recipients: list[dict[str, Any]] | None = None
    message_template: str | None = None
    is_enabled: bool | None = None


class RuleEvaluation(ApiModel):
    """Fila de `civic.evaluate_alert_rules`."""

    rule_id: UUID
    rule_name: str
    metric: str
    observed: float | None = None
    threshold: float | None = None
    sample_size: int | None = None
    condition_met: bool
    fired: bool
    skip_reason: str | None = None
    alert_id: UUID | None = None
