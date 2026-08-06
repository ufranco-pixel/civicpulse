'use strict';

/**
 * Informes de campaña.
 *
 * La generación es asíncrona a propósito: agregar 30 días de conversación y
 * componer el PDF tarda segundos, y una petición HTTP que se cuelga ese rato
 * agota el pool del balanceador antes que el del servicio. El cliente recibe
 * 202 con el jobId y consulta /status hasta que el trabajo es terminal.
 *
 * El estado del trabajo vive en civic.analysis_jobs (ver store/jobs.js); en
 * disco sólo queda el binario. Cualquier réplica puede responder por cualquier
 * trabajo, pero el PDF sólo existe en la que lo generó: en despliegue con
 * varias réplicas, REPORTS_STORAGE_DIR debe ser un volumen compartido.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const { z } = require('zod');

const { logger } = require('../logger');
const jobs = require('../store/jobs');
const { collectReportData, SECTIONS } = require('../generators/campaign-report');
const { renderCampaignReport } = require('../generators/pdf');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

const STORAGE_DIR = process.env.REPORTS_STORAGE_DIR || '/var/lib/oeste-sentimientos/reports';
const MAX_PERIOD_DAYS = Number.parseInt(process.env.REPORTS_MAX_PERIOD_DAYS || '365', 10);
const MAX_CONCURRENT = Number.parseInt(process.env.REPORTS_MAX_CONCURRENT || '2', 10);

const uuid = z.string().uuid('Debe ser un UUID');

const generateBody = z.object({
  campaignCode: z.string().min(1).max(64),
  periodDays: z.coerce.number().int().min(1).max(MAX_PERIOD_DAYS).default(30),
  // Por defecto todas: pedir un informe sin secciones no es un caso de uso.
  sections: z.array(z.enum(SECTIONS)).min(1).default([...SECTIONS]),
  // Sólo PDF. Se acepta el campo para no romper el contrato del cliente
  // cuando aparezca otro formato, pero hoy cualquier otro valor es un error.
  format: z.enum(['pdf']).default('pdf'),
}).strict();

/** Ruta del artefacto. El nombre lo pone el servicio (UUID), nunca el cliente. */
function artifactPath(jobId) {
  return path.join(STORAGE_DIR, `${jobId}.pdf`);
}

// ── Cola de generación ──────────────────────────────────────────────────────
// Un semáforo tonto en memoria. Cada trabajo agrega varios días de datos: más
// paralelismo satura el pool de PostgreSQL mucho antes que la CPU. Los que no
// caben esperan en 'queued', que es exactamente lo que /status ya reporta.
let running = 0;
const pending = [];

function pump() {
  while (running < MAX_CONCURRENT && pending.length > 0) {
    const task = pending.shift();
    running += 1;
    task().finally(() => {
      running -= 1;
      pump();
    });
  }
}

function enqueue(task) {
  pending.push(task);
  pump();
}

/**
 * Genera el PDF y deja el trabajo en estado terminal.
 *
 * Recibe el principal del token porque toda consulta debe ir con el contexto
 * de RLS de quien pidió el informe; no hay "usuario del sistema" que pueda
 * leer datos de una organización ajena.
 */
async function runJob(auth, jobId, log) {
  const claimed = await jobs.markRunning(auth, jobId);
  if (!claimed) {
    // Otra réplica lo tomó antes, o ya no está en 'queued'. No es un error.
    log.info('el trabajo ya no estaba en cola; se omite', { job_id: jobId });
    return;
  }

  const config = claimed.config || {};
  const params = {
    campaignCode: claimed.campaign_code,
    periodDays: Number(config.period_days) || 30,
    sections: Array.isArray(config.sections) ? config.sections : [...SECTIONS],
  };

  const target = artifactPath(jobId);
  try {
    const data = await collectReportData(auth, params, async (processed, message) => {
      await jobs.markProgress(auth, jobId, processed, message);
    });
    // pdf.js decide qué secciones compone a partir de este campo; sin él pinta
    // todo lo que haya en data.sections e ignora lo que pidió el usuario.
    data.requested_sections = params.sections;

    await fsp.mkdir(STORAGE_DIR, { recursive: true });
    // Se escribe primero a un temporal y se renombra al final: así /download
    // nunca encuentra un PDF a medio escribir si el proceso muere.
    const tmp = `${target}.partial`;
    const stream = fs.createWriteStream(tmp, { mode: 0o640 });
    await renderCampaignReport(data, stream);
    await fsp.rename(tmp, target);

    const stat = await fsp.stat(target);
    const checksum = await sha256(target);
    await jobs.markCompleted(auth, jobId, {
      filename: path.basename(target),
      format: 'pdf',
      bytes: stat.size,
      checksum_sha256: checksum,
      sections: params.sections,
      period_days: params.periodDays,
      warnings: data.warnings || [],
    });
    log.info('informe generado', { job_id: jobId, bytes: stat.size });
  } catch (err) {
    // El temporal se borra siempre: un .partial huérfano se acumula en el
    // volumen y nadie lo reclama, porque el trabajo quedó en 'failed'.
    await fsp.rm(`${target}.partial`, { force: true }).catch(() => {});
    log.error('fallo al generar el informe', { job_id: jobId, err });
    await jobs.markFailed(auth, jobId, err).catch((markErr) => {
      log.error('además falló el registro del fallo', { job_id: jobId, err: markErr });
    });
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ── POST /reports/generate ──────────────────────────────────────────────────
router.post(
  '/generate',
  authenticate(),
  requireRole('reports:write', 'reports:generate', 'admin'),
  validate({ body: generateBody }),
  asyncHandler(async (req, res) => {
    const { campaignCode, periodDays, sections, format } = req.body;

    // createJob valida la campaña contra civic_api.campaigns con RLS: si no es
    // de esta organización, responde 404 y no se encola nada.
    const { job, campaign } = await jobs.createJob(req.auth, {
      campaignCode, periodDays, sections, format,
    });

    const log = req.log.child({ job_id: job.id, campaign_code: campaign.code });
    // Se responde ANTES de generar. El principal se captura por valor: para
    // cuando el trabajo arranque, la petición ya se cerró.
    const auth = req.auth;
    enqueue(() => runJob(auth, job.id, log));

    log.info('informe encolado', { period_days: periodDays, sections });
    res.status(202).json({
      jobId: job.id,
      status: job.status_code,
      campaign: { code: campaign.code, name: campaign.name },
      statusUrl: `/reports/${job.id}/status`,
      downloadUrl: `/reports/${job.id}/download`,
    });
  }),
);

// ── GET /reports/:id/status ─────────────────────────────────────────────────
router.get(
  '/:id/status',
  authenticate(),
  requireRole(),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const job = await jobs.getJob(req.auth, req.params.id);
    if (!job) throw jobs.httpError('Trabajo de informe no encontrado', 404, 'JOB_NOT_FOUND');

    res.json({
      data: {
        jobId: job.id,
        status: job.status_code,
        statusLabel: job.status_label,
        isTerminal: job.is_terminal,
        progressPct: job.progress_pct,
        totalItems: job.total_items,
        processedItems: job.processed_items,
        campaign: { code: job.campaign_code, name: job.campaign_name },
        config: job.config,
        artifact: job.stats && job.stats.filename
          ? {
            bytes: job.stats.bytes,
            checksumSha256: job.stats.checksum_sha256,
            purged: Boolean(job.stats.purged),
            warnings: job.stats.warnings || [],
          }
          : null,
        error: job.error_message,
        createdBy: job.created_by,
        createdAt: job.created_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        durationSeconds: job.duration_seconds,
      },
    });
  }),
);

// ── GET /reports/:id/download ───────────────────────────────────────────────
router.get(
  '/:id/download',
  authenticate(),
  requireRole(),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const job = await jobs.getJob(req.auth, req.params.id);
    if (!job) throw jobs.httpError('Trabajo de informe no encontrado', 404, 'JOB_NOT_FOUND');

    if (job.status_code === jobs.STATUS.FAILED) {
      throw jobs.httpError(
        `El informe falló: ${job.error_message || 'sin detalle'}`, 409, 'REPORT_FAILED',
      );
    }
    if (job.status_code === jobs.STATUS.CANCELLED) {
      throw jobs.httpError('El informe fue cancelado', 409, 'REPORT_CANCELLED');
    }
    if (job.status_code !== jobs.STATUS.COMPLETED) {
      // 202 y no 404: el recurso existe, todavía no está listo. Un 404 haría
      // que el cliente dejara de reintentar.
      return res.status(202).json({
        jobId: job.id,
        status: job.status_code,
        progressPct: job.progress_pct,
        message: 'El informe aún se está generando.',
        retryAfterSeconds: 5,
      });
    }
    if (job.stats && job.stats.purged) {
      throw jobs.httpError(
        'El PDF fue borrado por la política de retención; vuelva a generarlo.',
        410, 'ARTIFACT_PURGED',
      );
    }

    const file = artifactPath(job.id);
    try {
      await fsp.access(file, fs.constants.R_OK);
    } catch {
      // El registro dice 'completed' pero el archivo no está: réplica distinta
      // o volumen no persistente. Se dice cuál es el problema, no un 500 mudo.
      throw jobs.httpError(
        'El registro del informe existe pero su archivo no está disponible en esta réplica.',
        410, 'ARTIFACT_MISSING',
      );
    }

    const filename = `oeste-sentimientos-${job.campaign_code}-${job.id.slice(0, 8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (job.stats && job.stats.bytes) res.setHeader('Content-Length', String(job.stats.bytes));
    // Un informe es una foto de un periodo: no debe quedar en caché de proxies
    // compartidos, porque su contenido es datos de una sola organización.
    res.setHeader('Cache-Control', 'private, no-store');

    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      req.log.error('error al transmitir el PDF', { job_id: job.id, err });
      // Las cabeceras ya salieron; sólo queda cortar. errorHandler lo detecta.
      res.destroy(err);
    });
    return stream.pipe(res);
  }),
);

// ── GET /reports ────────────────────────────────────────────────────────────
router.get(
  '/',
  authenticate(),
  requireRole(),
  validate({
    query: z.object({
      campaign_code: z.string().max(64).optional(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows, total } = await jobs.listJobs(req.auth, {
      campaignCode: q.campaign_code,
      status: q.status,
      limit: q.limit,
      offset: q.offset,
    });

    res.json({
      data: rows.map((job) => ({
        jobId: job.id,
        status: job.status_code,
        statusLabel: job.status_label,
        progressPct: job.progress_pct,
        campaign: { code: job.campaign_code, name: job.campaign_name },
        periodDays: job.config ? job.config.period_days : null,
        sections: job.config ? job.config.sections : null,
        bytes: job.stats ? job.stats.bytes : null,
        purged: Boolean(job.stats && job.stats.purged),
        error: job.error_message,
        createdBy: job.created_by,
        createdAt: job.created_at,
        completedAt: job.completed_at,
      })),
      pagination: { limit: q.limit, offset: q.offset, total, returned: rows.length },
    });
  }),
);

/** Estado de la cola en memoria. Lo usa /ready. */
function queueStatus() {
  return { running, pending: pending.length, max_concurrent: MAX_CONCURRENT };
}

/** Crea REPORTS_STORAGE_DIR si no existe. Se llama al arrancar. */
async function ensureStorageDir() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  // Comprobación temprana de escritura: fallar aquí es mucho más barato que
  // descubrirlo con el primer informe, ya encolado y a medio generar.
  await fsp.access(STORAGE_DIR, fs.constants.W_OK);
  logger.info('directorio de informes listo', { dir: STORAGE_DIR });
}

module.exports = router;
module.exports.router = router;
module.exports.queueStatus = queueStatus;
module.exports.ensureStorageDir = ensureStorageDir;
module.exports.STORAGE_DIR = STORAGE_DIR;
