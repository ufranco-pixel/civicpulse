"""Modelos compartidos.

Nota sobre `metadata`: es un atributo reservado de `BaseModel`, así que el campo
se llama `meta` en Python y se expone como `metadata` en el JSON mediante alias.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ApiModel(BaseModel):
    """Base de todos los modelos de salida."""

    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        ser_json_timedelta="float",
    )


class MetaModel(ApiModel):
    """Para respuestas que arrastran un bloque JSON libre del sistema base."""

    meta: dict[str, Any] = Field(default_factory=dict, alias="metadata")


class MetricEnvelope(ApiModel):
    """Un número nunca viaja solo.

    La base publica `civic_kpi.metric_registry` con unidad, muestra mínima y
    advertencia de interpretación de cada indicador. Ese contexto tiene que
    llegar hasta la interfaz: un `net_sentiment = -12` sobre 8 comentarios y uno
    sobre 8 000 se pintan igual si sólo se manda el valor.
    """

    value: float | None = None
    unit: str | None = None
    sample_size: int | None = None
    is_reliable: bool = True
    caveat: str | None = None
    label: str | None = None


class Page(ApiModel, Generic[T]):
    """Página de resultados con el total para el paginador de la interfaz."""

    total: int
    page: int
    page_size: int
    items: list[T]


class MetricDefinition(ApiModel):
    """Fila de `civic_api.metrics`: el registro de indicadores."""

    code: str
    label_es: str
    label_en: str
    family: str
    definition: str
    formula: str | None = None
    unit: str
    range_min: float | None = None
    range_max: float | None = None
    higher_is_better: bool | None = None
    min_sample_size: int
    caveat: str | None = None
    is_alertable: bool
    sort_order: int


class CatalogEntry(ApiModel):
    """Fila de `civic_api.catalogs` ya sin el nombre del catálogo."""

    code: str
    label_es: str
    label_en: str
    color_token: str | None = None
    sort_order: int | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class HealthResponse(ApiModel):
    status: str
    service: str = "sentiment-api"
    version: str


class ReadyResponse(ApiModel):
    status: str
    database: str
    checked_at: datetime


class ErrorResponse(ApiModel):
    """Forma única de error. `code` permite reaccionar sin leer el texto."""

    detail: str
    code: str | None = None
    request_id: str | None = None
