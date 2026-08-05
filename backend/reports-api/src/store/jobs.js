'use strict';

/**
 * Persistencia de los trabajos de informe en civic.analysis_jobs.
 *
 * El sistema base guardaba los trabajos en un Map en memoria: al reiniciar el
 * contenedor —o al balancear hacia otra réplica— el usuario recibía "trabajo
 * no encontrado" para un informe que sí se había generado. Aquí el estado vive
 * en PostgreSQL con job_type = 'report', de modo que cualquier réplica puede
 * responder por cualquier trabajo.
 *
 * Lo único que NO va a la base es el binario del PDF: no hay tabla para
 * adjuntos y varios MB de bytea por informe inflarían analysis_jobs, que se
 * consulta a cada rato. El archivo va a REPORTS_STORAGE_DIR y su nombre,
 * tamaño y checksum quedan en la columna stats.
 */

const { withOrgContext } = require('../db');

// Códigos de civic_cat.job_statuses.
const STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

/**
 * Crea el trabajo en estado 'queued'.
 *
 * total_items se fija al número de secciones solicitadas: el trigger
 * civic.job_denormalize calcula progress_pct a partir de
 * processed_items/total_items, así que basta con ir subiendo processed_items
 * y el porcentaje se mantiene solo.
 */
async function createJob(auth, { campaignCode, periodDays, sections, format }) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows: campaignRows } = await client.query(
      'SELECT id, code, name, in_blackout FROM civic_api.campaigns WHERE code = $1',
      [campaignCode],
    );
    const campaign = campaignRows[0];
    if (!campaign) throw httpError(`No existe la campaña ${campaignCode} en esta organización`, 404, 'CAMPAIGN_NOT_FOUND');

    const { rows } = await client.query(
      `INSERT INTO civic.analysis_jobs
          (organization_id, campaign_id, campaign_code, job_type, status_code,
           priority, config, total_items, created_by)
       VALUES ($1, $2, $3, 'report', $4, 'normal', $5::jsonb, $6, $7)
       RETURNING id, campaign_code, status_code, config, created_at`,
      [
        auth.organizationId, campaign.id, campaign.code, STATUS.QUEUED,
        JSON.stringify({
          period_days: periodDays,
          sections,
          format,
          requested_by: auth.username,
          requested_at: new Date().toISOString(),
          // Se guarda si la campaña estaba en veda al pedirlo; el informe lo
          // vuelve a comprobar al generarse, pero la petición queda auditada.
          in_blackout_at_request: campaign.in_blackout,
        }),
        sections.length,
        auth.username,
      ],
    );
    return { job: rows[0], campaign };
  });
}

/** Marca el inicio. Devuelve null si otro proceso ya lo tomó (carrera entre réplicas). */
async function markRunning(auth, jobId) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    // La condición sobre status_code es el bloqueo optimista: sólo una réplica
    // consigue pasar de 'queued' a 'running'.
    const { rows } = await client.query(
      `UPDATE civic.analysis_jobs
          SET status_code = $2, started_at = NOW(), attempt = attempt + 1
        WHERE id = $1 AND job_type = 'report' AND status_code = $3
        RETURNING id, campaign_code, campaign_id, config`,
      [jobId, STATUS.RUNNING, STATUS.QUEUED],
    );
    return rows[0] || null;
  });
}

/** Avance parcial: suma secciones ya escritas y deja una traza en job_events. */
async function markProgress(auth, jobId, processedItems, message) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    await client.query(
      'UPDATE civic.analysis_jobs SET processed_items = $2 WHERE id = $1',
      [jobId, processedItems],
    );
    if (message) {
      await client.query(
        'INSERT INTO civic.job_events (job_id, level, message) VALUES ($1, $2, $3)',
        [jobId, 'info', message],
      );
    }
  });
}

async function markCompleted(auth, jobId, artifact) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `UPDATE civic.analysis_jobs
          SET status_code     = $2,
              completed_at    = NOW(),
              processed_items = total_items,
              stats           = stats || $3::jsonb
        WHERE id = $1
        RETURNING id, status_code, stats, started_at, completed_at`,
      [jobId, STATUS.COMPLETED, JSON.stringify(artifact)],
    );
    await client.query(
      'INSERT INTO civic.job_events (job_id, level, message, context) VALUES ($1,$2,$3,$4::jsonb)',
      [jobId, 'info', 'Informe generado', JSON.stringify(artifact)],
    );
    return rows[0];
  });
}

async function markFailed(auth, jobId, err) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `UPDATE civic.analysis_jobs
          SET status_code = $2, completed_at = NOW(), error_message = $3
        WHERE id = $1
        RETURNING id, status_code, error_message`,
      [jobId, STATUS.FAILED, String(err?.message || err).slice(0, 2000)],
    );
    await client.query(
      'INSERT INTO civic.job_events (job_id, level, message, context) VALUES ($1,$2,$3,$4::jsonb)',
      [jobId, 'error', 'Fallo al generar el informe', JSON.stringify({ error: String(err?.message || err) })],
    );
    return rows[0];
  });
}

async function getJob(auth, jobId) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `SELECT j.id, j.campaign_code, j.campaign_id, j.job_type, j.status_code,
              js.label_es AS status_label, js.is_terminal,
              j.progress_pct, j.total_items, j.processed_items,
              j.config, j.stats, j.error_message, j.attempt,
              j.created_by, j.created_at, j.started_at, j.completed_at,
              c.name AS campaign_name,
              CASE WHEN j.started_at IS NOT NULL
                   THEN round(EXTRACT(EPOCH FROM (COALESCE(j.completed_at, NOW()) - j.started_at)))::int
              END AS duration_seconds
         FROM civic.analysis_jobs j
         JOIN civic_cat.job_statuses js ON js.code = j.status_code
         JOIN civic.campaigns c ON c.id = j.campaign_id
        WHERE j.id = $1 AND j.job_type = 'report'`,
      [jobId],
    );
    return rows[0] || null;
  });
}

async function listJobs(auth, { campaignCode, status, limit, offset }) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `SELECT j.id, j.campaign_code, j.status_code, js.label_es AS status_label,
              j.progress_pct, j.config, j.stats, j.error_message,
              j.created_by, j.created_at, j.started_at, j.completed_at,
              c.name AS campaign_name
         FROM civic.analysis_jobs j
         JOIN civic_cat.job_statuses js ON js.code = j.status_code
         JOIN civic.campaigns c ON c.id = j.campaign_id
        WHERE j.job_type = 'report'
          AND ($1::text IS NULL OR j.campaign_code = $1)
          AND ($2::text IS NULL OR j.status_code = $2)
        ORDER BY j.created_at DESC
        LIMIT $3 OFFSET $4`,
      [campaignCode ?? null, status ?? null, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT count(*)::int AS total FROM civic.analysis_jobs j
        WHERE j.job_type = 'report'
          AND ($1::text IS NULL OR j.campaign_code = $1)
          AND ($2::text IS NULL OR j.status_code = $2)`,
      [campaignCode ?? null, status ?? null],
    );
    return { rows, total: countRows[0].total };
  });
}

/** Trabajos terminados cuyo PDF ya puede borrarse por retención. */
async function listExpiredArtifacts(auth, retentionDays) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `SELECT id, stats->>'filename' AS filename
         FROM civic.analysis_jobs
        WHERE job_type = 'report'
          AND status_code = 'completed'
          AND stats ? 'filename'
          AND NOT COALESCE((stats->>'purged')::boolean, FALSE)
          AND completed_at < NOW() - ($1 || ' days')::interval`,
      [retentionDays],
    );
    return rows;
  });
}

async function markPurged(auth, jobId) {
  return withOrgContext(auth.organizationId, auth, async (client) => {
    await client.query(
      `UPDATE civic.analysis_jobs
          SET stats = stats || jsonb_build_object('purged', TRUE, 'purged_at', NOW())
        WHERE id = $1`,
      [jobId],
    );
  });
}

module.exports = {
  STATUS,
  createJob,
  markRunning,
  markProgress,
  markCompleted,
  markFailed,
  getJob,
  listJobs,
  listExpiredArtifacts,
  markPurged,
  httpError,
};
