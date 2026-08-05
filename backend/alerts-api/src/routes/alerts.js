'use strict';

/**
 * Rutas de alertas.
 *
 * GET  /alerts/stream   SSE autenticado, con filtros por query
 * GET  /alerts          listado desde civic_api.alerts
 * GET  /alerts/:id      detalle
 * PATCH /alerts/:id     ack / resolve / dismiss
 * GET  /alerts/stats    conteos por severidad, tipo y estado
 */

const express = require('express');
const { z } = require('zod');
const { withOrgContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');
const { sseManager } = require('../sse/manager');

const router = express.Router();

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'dismissed', 'expired'];

const uuid = z.string().uuid('Debe ser un UUID');
const campaignCode = z.string().min(1).max(64);

/** Convierte "a,b,c" en arreglo. Los filtros del tablero llegan así. */
const csvArray = (values) => z.string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
  .refine((arr) => arr.every((v) => values.includes(v)), {
    message: `Valores admitidos: ${values.join(', ')}`,
  });

// ── GET /alerts/stream ──────────────────────────────────────────────────────
//
// El token se acepta por cabecera Authorization o por ?token=, porque
// EventSource no permite cabeceras personalizadas. En los dos casos pasa por
// el MISMO authenticate() y se verifica firma, emisor y expiración: el sistema
// base dejaba este endpoint abierto, que era una fuga de datos de campaña a
// cualquiera que conociera la URL.
//
// Advertencia operativa: un token en la query aparece en los logs de acceso de
// los proxies. Emita para el stream un token de vida corta y alcance reducido.
const streamQuery = z.object({
  token: z.string().optional(),
  campaign_code: campaignCode.optional(),
  severity_min: z.enum(SEVERITIES).optional(),
  alert_types: csvArray([
    'negative_spike', 'volume_spike', 'sentiment_drop', 'toxicity', 'threat_detected',
    'disinformation', 'coordinated', 'share_of_voice', 'topic_emergence',
    'competitor_surge', 'ingestion_failure', 'model_drift', 'job_failed',
  ]).optional(),
}).passthrough();

router.get(
  '/stream',
  validate({ query: streamQuery }),
  authenticate({ allowQueryToken: true }),
  requireRole(),
  asyncHandler(async (req, res) => {
    const { campaign_code: code, severity_min: severityMin, alert_types: alertTypes } = req.query;

    // Si el cliente filtra por campaña se comprueba que exista dentro de SU
    // organización. Así un código de otra organización devuelve 404 y no un
    // stream mudo que el usuario interpretaría como "no hay alertas".
    if (code) {
      const exists = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM civic_api.campaigns WHERE code = $1', [code]);
        return rows.length > 0;
      });
      if (!exists) {
        const err = new Error(`No existe la campaña ${code} en esta organización`);
        err.status = 404;
        err.code = 'CAMPAIGN_NOT_FOUND';
        err.expose = true;
        throw err;
      }
    }

    // El orgId sale del token verificado, nunca de la query.
    sseManager.add(req, res, {
      orgId: req.auth.organizationId,
      sub: req.auth.sub,
      campaignCode: code || null,
      severityMin: severityMin || null,
      alertTypes: alertTypes || null,
    });
    // No se llama a next() ni se cierra: la respuesta queda abierta.
  }),
);

// ── GET /alerts/stats ───────────────────────────────────────────────────────
// Va antes de /:id para que "stats" no se interprete como un identificador.
const statsQuery = z.object({
  campaign_code: campaignCode.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

router.get(
  '/stats',
  authenticate(),
  requireRole(),
  validate({ query: statsQuery }),
  asyncHandler(async (req, res) => {
    const { campaign_code: code, days } = req.query;

    const data = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const params = [days, code || null];
      const where = `WHERE created_at >= NOW() - ($1 || ' days')::interval
                       AND ($2::text IS NULL OR campaign_code = $2)`;

      const totals = await client.query(
        `SELECT count(*)::int                                                   AS total,
                count(*) FILTER (WHERE status = 'open')::int                    AS open,
                count(*) FILTER (WHERE status = 'acknowledged')::int            AS acknowledged,
                count(*) FILTER (WHERE status = 'in_progress')::int             AS in_progress,
                count(*) FILTER (WHERE status = 'resolved')::int                AS resolved,
                count(*) FILTER (WHERE status = 'dismissed')::int               AS dismissed,
                count(*) FILTER (WHERE NOT is_read)::int                        AS unread,
                count(*) FILTER (WHERE during_blackout)::int                    AS during_blackout,
                count(*) FILTER (WHERE was_false_positive)::int                 AS false_positives,
                count(*) FILTER (WHERE sla_overdue_minutes > 0)::int            AS sla_breached
           FROM civic_api.alerts ${where}`,
        params,
      );

      const bySeverity = await client.query(
        `SELECT severity_code, severity_label, severity_rank, count(*)::int AS n
           FROM civic_api.alerts ${where}
          GROUP BY severity_code, severity_label, severity_rank
          ORDER BY severity_rank DESC`,
        params,
      );

      const byType = await client.query(
        `SELECT alert_type_code, alert_type_label, count(*)::int AS n
           FROM civic_api.alerts ${where}
          GROUP BY alert_type_code, alert_type_label
          ORDER BY n DESC`,
        params,
      );

      const byDay = await client.query(
        `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS n
           FROM civic_api.alerts ${where}
          GROUP BY 1 ORDER BY 1`,
        params,
      );

      return {
        totals: totals.rows[0],
        by_severity: bySeverity.rows,
        by_type: byType.rows,
        by_day: byDay.rows,
      };
    });

    res.json({
      period_days: days,
      campaign_code: code || null,
      ...data,
      // Útil para depurar por qué el tablero de alguien no recibe eventos.
      sse: sseManager.statsFor(req.auth.organizationId),
    });
  }),
);

// ── GET /alerts ─────────────────────────────────────────────────────────────
const listQuery = z.object({
  campaign_code: campaignCode.optional(),
  status: csvArray(STATUSES).optional(),
  severity: csvArray(SEVERITIES).optional(),
  severity_min: z.enum(SEVERITIES).optional(),
  alert_type: z.string().max(64).optional(),
  rule_id: uuid.optional(),
  contender_id: uuid.optional(),
  unread_only: z.coerce.boolean().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(['created_at', 'severity_rank', 'sla_overdue_minutes']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

router.get(
  '/',
  authenticate(),
  requireRole(),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query;

    // Cada filtro añade su parámetro; nunca se interpola valor alguno.
    // El ORDER BY se toma de un enum cerrado, no de la cadena del cliente.
    const params = [];
    const conds = [];
    const push = (value) => { params.push(value); return `$${params.length}`; };

    if (q.campaign_code) conds.push(`campaign_code = ${push(q.campaign_code)}`);
    if (q.status) conds.push(`status = ANY(${push(q.status)}::text[])`);
    if (q.severity) conds.push(`severity_code = ANY(${push(q.severity)}::text[])`);
    if (q.severity_min) {
      conds.push(`severity_rank >= (SELECT rank FROM civic_cat.severity_levels WHERE code = ${push(q.severity_min)})`);
    }
    if (q.alert_type) conds.push(`alert_type_code = ${push(q.alert_type)}`);
    if (q.rule_id) conds.push(`rule_id = ${push(q.rule_id)}::uuid`);
    if (q.contender_id) conds.push(`contender_id = ${push(q.contender_id)}::uuid`);
    if (q.unread_only) conds.push('is_read = FALSE');
    if (q.since) conds.push(`created_at >= ${push(q.since.toISOString())}::timestamptz`);
    if (q.until) conds.push(`created_at <= ${push(q.until.toISOString())}::timestamptz`);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const orderSql = `ORDER BY ${q.order} ${q.dir.toUpperCase()} NULLS LAST, seq DESC`;

    const result = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM civic_api.alerts ${where} ${orderSql} LIMIT ${push(q.limit)} OFFSET ${push(q.offset)}`,
        params,
      );
      // El total se calcula aparte para poder paginar en el tablero. Se
      // reutilizan los parámetros de filtro (sin limit/offset).
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS total FROM civic_api.alerts ${where}`,
        params.slice(0, params.length - 2),
      );
      return { rows, total: countRows[0].total };
    });

    res.json({
      data: result.rows,
      pagination: { total: result.total, limit: q.limit, offset: q.offset },
    });
  }),
);

// ── GET /alerts/:id ─────────────────────────────────────────────────────────
router.get(
  '/:id',
  authenticate(),
  requireRole(),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const alert = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query('SELECT * FROM civic_api.alerts WHERE id = $1', [req.params.id]);
      if (!rows[0]) return null;
      // Las entregas dicen si alguien se enteró, que no es lo mismo que si se
      // generó la alerta. Es la primera pregunta tras un incidente.
      const { rows: deliveries } = await client.query(
        `SELECT id, channel, recipient, status, suppression_reason, attempt,
                error_message, provider_ref, sent_at, delivered_at, created_at
           FROM civic.alert_deliveries WHERE alert_id = $1 ORDER BY created_at`,
        [req.params.id],
      );
      return { ...rows[0], deliveries };
    });

    if (!alert) {
      // 404 y no 403: no se revela si el UUID existe en otra organización.
      const err = new Error('Alerta no encontrada');
      err.status = 404;
      err.code = 'ALERT_NOT_FOUND';
      err.expose = true;
      throw err;
    }
    res.json({ data: alert });
  }),
);

// ── PATCH /alerts/:id ───────────────────────────────────────────────────────
const patchBody = z.object({
  action: z.enum(['acknowledge', 'start', 'resolve', 'dismiss', 'reopen', 'mark_read', 'mark_unread']),
  resolution_note: z.string().max(2000).optional(),
  was_false_positive: z.boolean().optional(),
}).refine(
  (b) => b.action !== 'resolve' || (b.resolution_note && b.resolution_note.trim().length > 0),
  { path: ['resolution_note'], message: 'Resolver exige una nota: sin ella no se puede recalibrar la regla.' },
);

router.patch(
  '/:id',
  authenticate(),
  requireRole('alerts:write', 'campaign:manager', 'admin'),
  validate({ params: z.object({ id: uuid }), body: patchBody }),
  asyncHandler(async (req, res) => {
    const { action, resolution_note: note, was_false_positive: falsePositive } = req.body;
    const actor = req.auth.username;

    // Un SET por acción. Se escribe en civic.alerts (la vista es de lectura).
    const SETS = {
      acknowledge: 'status = \'acknowledged\', acknowledged_by = $2, acknowledged_at = NOW(), is_read = TRUE',
      start: 'status = \'in_progress\', acknowledged_by = COALESCE(acknowledged_by, $2), acknowledged_at = COALESCE(acknowledged_at, NOW()), is_read = TRUE',
      // resolved_at es obligatorio por ck_alert_resolved.
      resolve: 'status = \'resolved\', resolved_by = $2, resolved_at = NOW(), resolution_note = $3, was_false_positive = COALESCE($4, was_false_positive), is_read = TRUE',
      dismiss: 'status = \'dismissed\', resolved_by = $2, resolved_at = NOW(), resolution_note = COALESCE($3, resolution_note), was_false_positive = COALESCE($4, was_false_positive), is_read = TRUE',
      reopen: 'status = \'open\', resolved_by = NULL, resolved_at = NULL, resolution_note = NULL',
      mark_read: 'is_read = TRUE',
      mark_unread: 'is_read = FALSE',
    };

    const updated = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `UPDATE civic.alerts SET ${SETS[action]} WHERE id = $1 RETURNING id`,
        [req.params.id, actor, note ?? null, falsePositive ?? null],
      );
      if (!rows[0]) return null;
      const { rows: fresh } = await client.query('SELECT * FROM civic_api.alerts WHERE id = $1', [req.params.id]);
      return fresh[0];
    });

    if (!updated) {
      const err = new Error('Alerta no encontrada');
      err.status = 404;
      err.code = 'ALERT_NOT_FOUND';
      err.expose = true;
      throw err;
    }

    req.log.info('alerta actualizada', { alert_id: updated.id, action, status: updated.status });

    // Se avisa a los tableros abiertos para que el cambio de estado se refleje
    // sin recargar. Va como evento propio, no como 'alert', para que el
    // frontend no lo trate como una alerta nueva y vuelva a sonar.
    sseManager.broadcastSystem(req.auth.organizationId, 'alert_updated', {
      id: updated.id,
      campaign_code: updated.campaign_code,
      status: updated.status,
      is_read: updated.is_read,
      updated_by: actor,
    });

    res.json({ data: updated });
  }),
);

module.exports = router;
