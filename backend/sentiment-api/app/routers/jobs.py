"""Trabajos de análisis.

La API encola y cambia el estado; quien ejecuta es el worker. Aquí no se
procesa nada: un endpoint HTTP no es el sitio para un lote de miles de
inferencias.
"""

from __future__ import annotations

import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status

from app.core.auth import ROLE_ANALYST, ROLE_STRATEGIST, require_min_role
from app.core.context import Ctx
from app.core.sql import assert_campaign_visible, fetch_all, fetch_one, not_found
from app.schemas.jobs import Job, JobCreate, JobPatch

router = APIRouter(tags=["trabajos"])

CampaignCode = Annotated[str, Path(min_length=1, max_length=40)]

_JOB_COLUMNS = """
    id, seq, campaign_id, campaign_code, job_type, status_code, status_label,
    is_terminal, status_color, priority, model_name, progress_pct,
    total_items, processed_items, failed_items, skipped_items, total_cost_usd,
    attempt, max_attempts, error_message, stats, scheduled_at, started_at,
    completed_at, duration_seconds, created_at
"""


@router.get(
    "/campaigns/{code}/jobs",
    response_model=list[Job],
    summary="Trabajos de la campaña",
)
async def list_jobs(
    ctx: Ctx,
    code: CampaignCode,
    job_status: Annotated[str | None, Query(alias="status")] = None,
    job_type: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[Job]:
    clauses = ["campaign_code = :code"]
    params: dict[str, Any] = {"code": code, "limit": limit, "offset": offset}

    if job_status:
        clauses.append("status_code = :job_status")
        params["job_status"] = job_status
    if job_type:
        clauses.append("job_type = :job_type")
        params["job_type"] = job_type

    rows = await fetch_all(
        ctx.session,
        f"""
        SELECT {_JOB_COLUMNS}
        FROM   civic_api.jobs
        WHERE  {' AND '.join(clauses)}
        ORDER  BY created_at DESC
        LIMIT  :limit OFFSET :offset
        """,
        params,
    )
    return [Job.model_validate(r, from_attributes=True) for r in rows]


@router.get("/jobs/{job_id}", response_model=Job, summary="Detalle de un trabajo")
async def get_job(ctx: Ctx, job_id: UUID) -> Job:
    row = await fetch_one(
        ctx.session,
        f"SELECT {_JOB_COLUMNS} FROM civic_api.jobs WHERE id = :id",
        {"id": str(job_id)},
    )
    if row is None:
        raise not_found("Trabajo no encontrado.")
    return Job.model_validate(row, from_attributes=True)


@router.post(
    "/campaigns/{code}/jobs",
    response_model=Job,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_min_role(ROLE_ANALYST))],
    summary="Encola un trabajo de análisis",
)
async def create_job(ctx: Ctx, code: CampaignCode, body: JobCreate) -> Job:
    campaign = await assert_campaign_visible(ctx.session, code)

    row = await fetch_one(
        ctx.session,
        """
        INSERT INTO civic.analysis_jobs (
            organization_id, campaign_id, campaign_code, source_id, model_id,
            prompt_version_id, job_type, priority, status_code, scheduled_at,
            max_attempts, config, created_by
        ) VALUES (
            :organization_id, :campaign_id, :campaign_code, :source_id::uuid,
            :model_id::uuid, :prompt_version_id::uuid, :job_type, :priority,
            'queued', COALESCE(:scheduled_at, NOW()), :max_attempts,
            :config::jsonb, :created_by
        )
        RETURNING id
        """,
        {
            "organization_id": str(ctx.user.organization_id),
            "campaign_id": campaign.id,
            "campaign_code": code,
            "source_id": str(body.source_id) if body.source_id else None,
            "model_id": str(body.model_id) if body.model_id else None,
            "prompt_version_id": str(body.prompt_version_id) if body.prompt_version_id else None,
            "job_type": body.job_type,
            "priority": body.priority,
            "scheduled_at": body.scheduled_at,
            "max_attempts": body.max_attempts,
            "config": json.dumps(body.config),
            "created_by": ctx.user.sub,
        },
    )

    created = await fetch_one(
        ctx.session,
        f"SELECT {_JOB_COLUMNS} FROM civic_api.jobs WHERE id = :id",
        {"id": row.id},
    )
    return Job.model_validate(created, from_attributes=True)


# Fragmentos SET admitidos. El progreso no está: lo reporta el worker.
_JOB_PATCH_FIELDS: dict[str, str] = {
    "status_code": "status_code = :status_code::civic.slug_code",
    "priority": "priority = :priority",
    "scheduled_at": "scheduled_at = :scheduled_at",
    "error_message": "error_message = :error_message",
}


@router.patch(
    "/jobs/{job_id}",
    response_model=Job,
    dependencies=[Depends(require_min_role(ROLE_STRATEGIST))],
    summary="Pausa, reanuda, cancela o reprograma un trabajo",
)
async def patch_job(ctx: Ctx, job_id: UUID, body: JobPatch) -> Job:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="El cuerpo no cambia nada."
        )

    sets = ["updated_at = NOW()"]
    params: dict[str, Any] = {"id": str(job_id)}
    for field, value in changes.items():
        fragment = _JOB_PATCH_FIELDS.get(field)
        if fragment is None:
            continue
        sets.append(fragment)
        params[field] = value

    if changes.get("status_code") in ("completed", "failed", "cancelled", "partial"):
        sets.append("completed_at = COALESCE(completed_at, NOW())")

    row = await fetch_one(
        ctx.session,
        f"UPDATE civic.analysis_jobs SET {', '.join(sets)} WHERE id = :id RETURNING id",
        params,
    )
    if row is None:
        raise not_found("Trabajo no encontrado.")

    updated = await fetch_one(
        ctx.session,
        f"SELECT {_JOB_COLUMNS} FROM civic_api.jobs WHERE id = :id",
        {"id": row.id},
    )
    return Job.model_validate(updated, from_attributes=True)
