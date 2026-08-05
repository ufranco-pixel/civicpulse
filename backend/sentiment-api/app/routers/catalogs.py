"""Catálogos y registro de indicadores.

La interfaz pide esto una vez al arrancar y deja de llevar etiquetas, colores y
advertencias codificados: la verdad vive en la base.
"""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter

from app.core.context import Ctx
from app.core.sql import fetch_all
from app.schemas.common import CatalogEntry, MetricDefinition

router = APIRouter(tags=["catálogos"])

_CATALOGS_SQL = """
SELECT catalog, code, label_es, label_en, color_token, sort_order, extra
FROM   civic_api.catalogs
ORDER  BY catalog, sort_order, code
"""

_METRICS_SQL = """
SELECT code, label_es, label_en, family, definition, formula, unit,
       range_min, range_max, higher_is_better, min_sample_size, caveat,
       is_alertable, sort_order
FROM   civic_api.metrics
"""


@router.get(
    "/catalogs",
    response_model=dict[str, list[CatalogEntry]],
    summary="Todos los catálogos agrupados por nombre",
)
async def list_catalogs(ctx: Ctx) -> dict[str, list[CatalogEntry]]:
    rows = await fetch_all(ctx.session, _CATALOGS_SQL)

    grouped: dict[str, list[CatalogEntry]] = defaultdict(list)
    for row in rows:
        grouped[row.catalog].append(
            CatalogEntry(
                code=row.code,
                label_es=row.label_es,
                label_en=row.label_en,
                color_token=row.color_token,
                sort_order=row.sort_order,
                extra=row.extra or {},
            )
        )
    return dict(grouped)


@router.get(
    "/metrics",
    response_model=list[MetricDefinition],
    summary="Registro de indicadores con definición, unidad y advertencia",
)
async def list_metrics(ctx: Ctx) -> list[MetricDefinition]:
    rows = await fetch_all(ctx.session, _METRICS_SQL)
    return [MetricDefinition.model_validate(r, from_attributes=True) for r in rows]
