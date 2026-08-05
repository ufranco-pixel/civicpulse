"""Evaluación de modelos y prompts.

Nada se promueve a producción sin pasar por aquí: una corrida contra un
conjunto congelado, sus métricas por corte y la puerta de promoción.

Aviso de aislamiento: `eval_items`, `eval_predictions`, `eval_metrics` y
`eval_confusion` no llevan RLS propia (cuelgan del dataset y de la corrida).
Por eso toda ruta que las toque valida primero que el dataset o la corrida sean
visibles a través de `civic.eval_datasets` / `civic.eval_runs`, que sí la
tienen.
"""

from __future__ import annotations

import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import ROLE_ANALYST, ROLE_STRATEGIST, require_min_role
from app.core.context import Ctx
from app.core.sql import execute, fetch_all, fetch_one, fetch_scalar, not_found
from app.schemas.evaluation import (
    BulkResult,
    ComputeMetricsResult,
    ConfusionCell,
    EvalDataset,
    EvalDatasetCreate,
    EvalItemsBulk,
    EvalMetric,
    EvalRun,
    EvalRunCreate,
    MetricComparison,
    PredictionError,
    PromotionGate,
)

router = APIRouter(prefix="/evaluation", tags=["evaluación"])

_DATASET_COLUMNS = """
    id, organization_id, campaign_id, code, name, description, split,
    task_codes, languages, sampling_method, sampling_notes, random_seed,
    item_count, annotators_per_item, inter_annotator_agreement, is_frozen,
    frozen_at, version, created_at, created_by
"""

_RUN_COLUMNS = """
    r.id, r.organization_id, r.dataset_id, d.code AS dataset_code, r.model_id,
    m.name AS model_name, r.prompt_version_id, r.name, r.baseline_run_id,
    r.status_code, r.tasks_evaluated, r.items_total, r.items_predicted,
    r.items_failed, r.schema_violations, r.total_cost_usd, r.avg_latency_ms,
    r.p95_latency_ms, r.verdict, r.verdict_reason, r.started_at,
    r.completed_at, r.config, r.notes, r.created_at, r.created_by
"""

_RUN_FROM = """
FROM      civic.eval_runs     r
JOIN      civic.eval_datasets d ON d.id = r.dataset_id
LEFT JOIN civic.ai_models     m ON m.id = r.model_id
"""


async def _assert_dataset_visible(session: AsyncSession, dataset_id: UUID) -> Any:
    row = await fetch_one(
        session,
        "SELECT id, is_frozen, item_count FROM civic.eval_datasets WHERE id = :id",
        {"id": str(dataset_id)},
    )
    if row is None:
        raise not_found("Conjunto de evaluación no encontrado.")
    return row


async def _assert_run_visible(session: AsyncSession, run_id: UUID) -> Any:
    row = await fetch_one(
        session,
        "SELECT id, dataset_id, baseline_run_id FROM civic.eval_runs WHERE id = :id",
        {"id": str(run_id)},
    )
    if row is None:
        raise not_found("Corrida de evaluación no encontrada.")
    return row


# =============================================================================
# Conjuntos
# =============================================================================
@router.get("/datasets", response_model=list[EvalDataset], summary="Conjuntos de evaluación")
async def list_datasets(
    ctx: Ctx,
    split: str | None = None,
    campaign_id: UUID | None = None,
) -> list[EvalDataset]:
    sql = f"SELECT {_DATASET_COLUMNS} FROM civic.eval_datasets"
    clauses: list[str] = []
    params: dict[str, Any] = {}

    if split:
        clauses.append("split = :split")
        params["split"] = split
    if campaign_id:
        clauses.append("campaign_id = :campaign_id::uuid")
        params["campaign_id"] = str(campaign_id)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC"

    rows = await fetch_all(ctx.session, sql, params)
    return [EvalDataset.model_validate(r, from_attributes=True) for r in rows]


@router.post(
    "/datasets",
    response_model=EvalDataset,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Crea un conjunto de evaluación",
)
async def create_dataset(ctx: Ctx, body: EvalDatasetCreate) -> EvalDataset:
    row = await fetch_one(
        ctx.session,
        f"""
        INSERT INTO civic.eval_datasets (
            organization_id, campaign_id, code, name, description, split,
            task_codes, languages, sampling_method, sampling_notes,
            random_seed, annotators_per_item, inter_annotator_agreement,
            version, created_by
        ) VALUES (
            :organization_id, :campaign_id::uuid, :code::civic.slug_code, :name,
            :description, :split, :task_codes::civic.slug_code[],
            :languages::civic.lang_code[], :sampling_method, :sampling_notes,
            :random_seed, :annotators_per_item, :inter_annotator_agreement,
            :version, :created_by
        )
        RETURNING {_DATASET_COLUMNS}
        """,
        {
            "organization_id": str(ctx.user.organization_id),
            "campaign_id": str(body.campaign_id) if body.campaign_id else None,
            "code": body.code,
            "name": body.name,
            "description": body.description,
            "split": body.split,
            "task_codes": body.task_codes,
            "languages": body.languages,
            "sampling_method": body.sampling_method,
            "sampling_notes": body.sampling_notes,
            "random_seed": body.random_seed,
            "annotators_per_item": body.annotators_per_item,
            "inter_annotator_agreement": body.inter_annotator_agreement,
            "version": body.version,
            "created_by": ctx.user.sub,
        },
    )
    return EvalDataset.model_validate(row, from_attributes=True)


@router.post(
    "/datasets/{dataset_id}/freeze",
    response_model=EvalDataset,
    dependencies=[Depends(require_min_role(ROLE_STRATEGIST))],
    summary="Congela el conjunto (irreversible)",
)
async def freeze_dataset(ctx: Ctx, dataset_id: UUID) -> EvalDataset:
    dataset = await _assert_dataset_visible(ctx.session, dataset_id)
    if dataset.is_frozen:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="El conjunto ya está congelado."
        )
    if dataset.item_count == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No se puede congelar un conjunto sin casos.",
        )

    # Comparar corridas contra un conjunto que cambia entre ellas no significa
    # nada: congelar es lo que vuelve reproducible la evaluación.
    row = await fetch_one(
        ctx.session,
        f"""
        UPDATE civic.eval_datasets
           SET is_frozen = TRUE, frozen_at = NOW(), updated_at = NOW()
         WHERE id = :id
        RETURNING {_DATASET_COLUMNS}
        """,
        {"id": str(dataset_id)},
    )
    return EvalDataset.model_validate(row, from_attributes=True)


@router.post(
    "/datasets/{dataset_id}/items",
    response_model=BulkResult,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Carga masiva de casos dorados",
)
async def bulk_add_items(ctx: Ctx, dataset_id: UUID, body: EvalItemsBulk) -> BulkResult:
    dataset = await _assert_dataset_visible(ctx.session, dataset_id)
    if dataset.is_frozen:
        # El trigger de la base también lo impide; se comprueba antes para
        # devolver un error claro en vez de un 25006 crudo.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="El conjunto está congelado: cree una versión nueva.",
        )

    payload = [
        {
            "dataset_id": str(dataset_id),
            "content_id": str(i.content_id) if i.content_id else None,
            "content_published_at": i.content_published_at,
            "text": i.text,
            "language_code": i.language_code,
            "source_type": i.source_type,
            "gold_sentiment": i.gold_sentiment,
            "gold_stance": i.gold_stance,
            "gold_stance_target": str(i.gold_stance_target) if i.gold_stance_target else None,
            "gold_intent": i.gold_intent,
            "gold_emotions": i.gold_emotions,
            "gold_topics": i.gold_topics,
            "gold_risk_flags": i.gold_risk_flags,
            "gold_entities": json.dumps(i.gold_entities),
            "difficulty": i.difficulty,
            "phenomena": i.phenomena,
            "is_contested": i.is_contested,
            "annotator_notes": i.annotator_notes,
        }
        for i in body.items
    ]

    # executemany en una sola ida a la base: cargar 2 000 casos con 2 000
    # round-trips tarda minutos.
    await ctx.session.execute(
        text(
            """
            INSERT INTO civic.eval_items (
                dataset_id, content_id, content_published_at, text,
                language_code, source_type, gold_sentiment, gold_stance,
                gold_stance_target, gold_intent, gold_emotions, gold_topics,
                gold_risk_flags, gold_entities, difficulty, phenomena,
                is_contested, annotator_notes
            ) VALUES (
                :dataset_id::uuid, :content_id::uuid, :content_published_at,
                :text, :language_code::civic.lang_code,
                :source_type::civic.slug_code,
                :gold_sentiment::civic.slug_code, :gold_stance::civic.slug_code,
                :gold_stance_target::uuid, :gold_intent::civic.slug_code,
                :gold_emotions::civic.slug_code[], :gold_topics::civic.slug_code[],
                :gold_risk_flags::civic.slug_code[], :gold_entities::jsonb,
                :difficulty, :phenomena::text[], :is_contested, :annotator_notes
            )
            """
        ),
        payload,
    )

    item_count = await fetch_scalar(
        ctx.session,
        "SELECT item_count FROM civic.eval_datasets WHERE id = :id",
        {"id": str(dataset_id)},
    )
    return BulkResult(
        inserted=len(payload), dataset_id=dataset_id, item_count=int(item_count or 0)
    )


# =============================================================================
# Corridas
# =============================================================================
@router.get("/runs", response_model=list[EvalRun], summary="Corridas de evaluación")
async def list_runs(
    ctx: Ctx,
    dataset_id: UUID | None = None,
    model_id: UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[EvalRun]:
    clauses: list[str] = []
    params: dict[str, Any] = {"limit": limit}

    if dataset_id:
        clauses.append("r.dataset_id = :dataset_id::uuid")
        params["dataset_id"] = str(dataset_id)
    if model_id:
        clauses.append("r.model_id = :model_id::uuid")
        params["model_id"] = str(model_id)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = await fetch_all(
        ctx.session,
        f"SELECT {_RUN_COLUMNS} {_RUN_FROM} {where} ORDER BY r.created_at DESC LIMIT :limit",
        params,
    )
    return [EvalRun.model_validate(r, from_attributes=True) for r in rows]


@router.post(
    "/runs",
    response_model=EvalRun,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Encola una corrida de evaluación",
)
async def create_run(ctx: Ctx, body: EvalRunCreate) -> EvalRun:
    dataset = await _assert_dataset_visible(ctx.session, body.dataset_id)
    if not dataset.is_frozen:
        # Sin congelar, la corrida no es comparable con ninguna otra.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El conjunto debe estar congelado antes de evaluarlo.",
        )

    run_id = await fetch_scalar(
        ctx.session,
        """
        INSERT INTO civic.eval_runs (
            organization_id, dataset_id, model_id, prompt_version_id, name,
            baseline_run_id, status_code, tasks_evaluated, items_total,
            config, notes, created_by
        ) VALUES (
            :organization_id, :dataset_id::uuid, :model_id::uuid,
            :prompt_version_id::uuid, :name, :baseline_run_id::uuid,
            'queued', :tasks::civic.slug_code[], :items_total,
            :config::jsonb, :notes, :created_by
        )
        RETURNING id
        """,
        {
            "organization_id": str(ctx.user.organization_id),
            "dataset_id": str(body.dataset_id),
            "model_id": str(body.model_id),
            "prompt_version_id": str(body.prompt_version_id) if body.prompt_version_id else None,
            "name": body.name,
            "baseline_run_id": str(body.baseline_run_id) if body.baseline_run_id else None,
            "tasks": body.tasks_evaluated,
            "items_total": dataset.item_count,
            "config": json.dumps(body.config),
            "notes": body.notes,
            "created_by": ctx.user.sub,
        },
    )

    row = await fetch_one(
        ctx.session, f"SELECT {_RUN_COLUMNS} {_RUN_FROM} WHERE r.id = :id", {"id": str(run_id)}
    )
    return EvalRun.model_validate(row, from_attributes=True)


@router.get("/runs/{run_id}", response_model=EvalRun, summary="Detalle de una corrida")
async def get_run(ctx: Ctx, run_id: UUID) -> EvalRun:
    row = await fetch_one(
        ctx.session, f"SELECT {_RUN_COLUMNS} {_RUN_FROM} WHERE r.id = :id", {"id": str(run_id)}
    )
    if row is None:
        raise not_found("Corrida de evaluación no encontrada.")
    return EvalRun.model_validate(row, from_attributes=True)


@router.post(
    "/runs/{run_id}/compute-metrics",
    response_model=list[ComputeMetricsResult],
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Calcula métricas y matriz de confusión de la corrida",
)
async def compute_metrics(ctx: Ctx, run_id: UUID) -> list[ComputeMetricsResult]:
    await _assert_run_visible(ctx.session, run_id)

    rows = await fetch_all(
        ctx.session,
        """
        SELECT task, slice, metric, value
        FROM   civic_kpi.compute_eval_metrics(:run_id::uuid)
        """,
        {"run_id": str(run_id)},
    )
    return [ComputeMetricsResult.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/runs/{run_id}/metrics",
    response_model=list[EvalMetric],
    summary="Métricas por tarea, clase y corte",
)
async def get_metrics(
    ctx: Ctx,
    run_id: UUID,
    slice_filter: Annotated[str | None, Query(alias="slice")] = None,
    task: str | None = None,
) -> list[EvalMetric]:
    await _assert_run_visible(ctx.session, run_id)

    clauses = ["run_id = :run_id::uuid"]
    params: dict[str, Any] = {"run_id": str(run_id)}
    if slice_filter:
        clauses.append("slice = :slice")
        params["slice"] = slice_filter
    if task:
        clauses.append("task_code = :task::civic.slug_code")
        params["task"] = task

    rows = await fetch_all(
        ctx.session,
        f"""
        SELECT task_code, class_code, slice, metric_name, metric_value,
               support, ci_lower, ci_upper, computed_at
        FROM   civic.eval_metrics
        WHERE  {' AND '.join(clauses)}
        ORDER  BY task_code, slice, metric_name, class_code
        """,
        params,
    )
    return [EvalMetric.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/runs/{run_id}/confusion",
    response_model=list[ConfusionCell],
    summary="Matriz de confusión",
)
async def get_confusion(
    ctx: Ctx,
    run_id: UUID,
    task: str = "sentiment",
    slice_filter: Annotated[str, Query(alias="slice")] = "all",
) -> list[ConfusionCell]:
    await _assert_run_visible(ctx.session, run_id)

    rows = await fetch_all(
        ctx.session,
        """
        SELECT task_code, slice, gold_class, pred_class, count
        FROM   civic.eval_confusion
        WHERE  run_id = :run_id::uuid
          AND  task_code = :task::civic.slug_code
          AND  slice = :slice
        ORDER  BY gold_class, pred_class
        """,
        {"run_id": str(run_id), "task": task, "slice": slice_filter},
    )
    return [ConfusionCell.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/runs/{run_id}/compare",
    response_model=list[MetricComparison],
    summary="Compara la corrida contra su línea base",
)
async def compare_runs(
    ctx: Ctx, run_id: UUID, baseline_run_id: UUID | None = None
) -> list[MetricComparison]:
    run = await _assert_run_visible(ctx.session, run_id)

    baseline = baseline_run_id or run.baseline_run_id
    if baseline is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indique baseline_run_id: la corrida no declara línea base.",
        )
    await _assert_run_visible(ctx.session, UUID(str(baseline)))

    rows = await fetch_all(
        ctx.session,
        """
        SELECT task, slice, metric, baseline, candidate, delta, delta_pct, verdict
        FROM   civic_kpi.compare_eval_runs(:run_id::uuid, :baseline_id::uuid)
        """,
        {"run_id": str(run_id), "baseline_id": str(baseline)},
    )
    return [MetricComparison.model_validate(r, from_attributes=True) for r in rows]


@router.get(
    "/runs/{run_id}/gate",
    response_model=PromotionGate,
    summary="Puerta de promoción: ¿puede pasar a producción?",
)
async def promotion_gate(
    ctx: Ctx,
    run_id: UUID,
    min_f1_macro: Annotated[float, Query(ge=0, le=1)] = 0.70,
    min_schema_rate: Annotated[float, Query(ge=0, le=1)] = 0.98,
    max_calibration: Annotated[float, Query(ge=0, le=1)] = 0.15,
    max_slice_drop: Annotated[float, Query(ge=0, le=1)] = 0.15,
) -> PromotionGate:
    await _assert_run_visible(ctx.session, run_id)

    row = await fetch_one(
        ctx.session,
        """
        SELECT passed, reason
        FROM   civic_kpi.evaluate_promotion_gate(
                   :run_id::uuid, :min_f1, :min_schema, :max_calib, :max_drop)
        """,
        {
            "run_id": str(run_id),
            "min_f1": min_f1_macro,
            "min_schema": min_schema_rate,
            "max_calib": max_calibration,
            "max_drop": max_slice_drop,
        },
    )
    if row is None:
        raise not_found("La corrida no tiene métricas calculadas.")
    return PromotionGate.model_validate(row, from_attributes=True)


@router.get(
    "/runs/{run_id}/errors",
    response_model=list[PredictionError],
    summary="Casos fallidos para el análisis de errores",
)
async def get_errors(
    ctx: Ctx,
    run_id: UUID,
    task: Annotated[str, Query(description="sentiment, stance o intent")] = "sentiment",
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    only_schema_violations: bool = False,
) -> list[PredictionError]:
    await _assert_run_visible(ctx.session, run_id)

    # El filtro depende de la tarea, así que se elige entre fragmentos fijos:
    # el nombre de columna nunca se interpola desde la petición.
    task_filter = {
        "sentiment": "NOT sentiment_correct",
        "stance": "NOT stance_correct",
        "intent": "NOT intent_correct",
    }.get(task)
    if task_filter is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="task debe ser sentiment, stance o intent.",
        )

    condition = "NOT schema_valid" if only_schema_violations else f"({task_filter} OR NOT schema_valid)"

    rows = await fetch_all(
        ctx.session,
        f"""
        SELECT prediction_id, item_id, text, language_code, source_type,
               difficulty, phenomena, is_contested, gold_sentiment,
               pred_sentiment, sentiment_correct, gold_stance, pred_stance,
               stance_correct, gold_intent, pred_intent, intent_correct,
               emotions_jaccard, topics_jaccard, confidence, schema_valid,
               latency_ms, error_message
        FROM   civic_kpi.v_eval_prediction_detail
        WHERE  run_id = :run_id::uuid
          AND  {condition}
        ORDER  BY is_contested, confidence DESC NULLS LAST
        LIMIT  :limit
        """,
        {"run_id": str(run_id), "limit": limit},
    )
    return [PredictionError.model_validate(r, from_attributes=True) for r in rows]
