'use strict';

/**
 * Entregas de alertas (civic.alert_deliveries).
 *
 * Lo consume el worker de notificaciones: pide las pendientes, intenta el
 * envío y marca el resultado. Registrar cada intento es lo que permite
 * responder "¿el equipo se enteró?", que no es la misma pregunta que "¿se
 * generó la alerta?".
 *
 * Las entregas no llevan organization_id propio; cuelgan de la alerta, que sí
 * lo lleva. Todas las consultas van unidas a civic.alerts para que la RLS
 * aplique sobre la alerta padre.
 */

const express = require('express');
const { z } = require('zod');
const { withOrgContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

const CHANNELS = ['sse', 'email', 'whatsapp', 'webhook', 'slack'];
const uuid = z.string().uuid('Debe ser un UUID');

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

// ── GET /deliveries/pending ─────────────────────────────────────────────────
router.get(
  '/pending',
  authenticate(),
  requireRole('notifications:worker', 'alerts:write', 'admin'),
  validate({
    query: z.object({
      channel: z.enum(CHANNELS).optional(),
      campaign_code: z.string().max(64).optional(),
      // Reintentos: incluye las fallidas que aún no agotaron intentos.
      include_failed: z.coerce.boolean().default(false),
      max_attempts: z.coerce.number().int().min(1).max(10).default(3),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const data = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.alert_id, d.channel, d.recipient, d.status, d.attempt,
                d.error_message, d.created_at,
                a.campaign_code, a.title, a.message, a.severity_code,
                a.alert_type_code, a.during_blackout,
                -- La advertencia del indicador viaja con la entrega: ningún
                -- canal debe mandar un número sin su contexto.
                mr.caveat AS metric_caveat, mr.label_es AS metric_label, mr.unit AS metric_unit
           FROM civic.alert_deliveries d
           JOIN civic.alerts a ON a.id = d.alert_id
           LEFT JOIN civic_kpi.metric_registry mr ON mr.code = a.metric
          WHERE (d.status = 'pending'
                 OR ($1::boolean AND d.status = 'failed' AND d.attempt < $2))
            AND ($3::text IS NULL OR d.channel = $3)
            AND ($4::text IS NULL OR a.campaign_code = $4)
          ORDER BY d.created_at
          LIMIT $5`,
        [q.include_failed, q.max_attempts, q.channel ?? null, q.campaign_code ?? null, q.limit],
      );
      return rows;
    });
    res.json({ data, count: data.length });
  }),
);

// ── GET /deliveries ─────────────────────────────────────────────────────────
router.get(
  '/',
  authenticate(),
  requireRole(),
  validate({
    query: z.object({
      alert_id: uuid.optional(),
      campaign_code: z.string().max(64).optional(),
      channel: z.enum(CHANNELS).optional(),
      status: z.enum(['pending', 'sent', 'delivered', 'read', 'failed', 'suppressed']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const data = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT d.*, a.campaign_code, a.title, a.severity_code
           FROM civic.alert_deliveries d
           JOIN civic.alerts a ON a.id = d.alert_id
          WHERE ($1::uuid IS NULL OR d.alert_id = $1)
            AND ($2::text IS NULL OR a.campaign_code = $2)
            AND ($3::text IS NULL OR d.channel = $3)
            AND ($4::text IS NULL OR d.status = $4)
          ORDER BY d.created_at DESC
          LIMIT $5 OFFSET $6`,
        [q.alert_id ?? null, q.campaign_code ?? null, q.channel ?? null, q.status ?? null, q.limit, q.offset],
      );
      return rows;
    });
    res.json({ data, pagination: { limit: q.limit, offset: q.offset, returned: data.length } });
  }),
);

// ── POST /deliveries ────────────────────────────────────────────────────────
// Encola una entrega. El planificador crea las alertas; encolar la entrega es
// decisión del canal, no de la evaluación.
router.post(
  '/',
  authenticate(),
  requireRole('notifications:worker', 'alerts:write', 'admin'),
  validate({
    body: z.object({
      alert_id: uuid,
      channel: z.enum(CHANNELS),
      recipient: z.string().max(400).nullish(),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const { alert_id: alertId, channel, recipient } = req.body;
    const created = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      // El JOIN implícito con la RLS: si la alerta no es de esta organización
      // el SELECT no la ve y no se inserta nada.
      const { rows: alertRows } = await client.query('SELECT id FROM civic.alerts WHERE id = $1', [alertId]);
      if (!alertRows[0]) throw httpError('Alerta no encontrada', 404, 'ALERT_NOT_FOUND');
      const { rows } = await client.query(
        `INSERT INTO civic.alert_deliveries (alert_id, channel, recipient, status)
         VALUES ($1,$2,$3,'pending') RETURNING *`,
        [alertId, channel, recipient ?? null],
      );
      return rows[0];
    });
    res.status(201).json({ data: created });
  }),
);

// ── PATCH /deliveries/:id ───────────────────────────────────────────────────
const patchBody = z.object({
  status: z.enum(['sent', 'delivered', 'read', 'failed', 'suppressed']),
  provider_ref: z.string().max(200).nullish(),
  error_message: z.string().max(2000).nullish(),
  suppression_reason: z.string().max(400).nullish(),
}).strict().refine(
  (b) => b.status !== 'failed' || Boolean(b.error_message),
  { path: ['error_message'], message: 'Marcar como fallida exige error_message: sin motivo no se puede depurar.' },
).refine(
  (b) => b.status !== 'suppressed' || Boolean(b.suppression_reason),
  { path: ['suppression_reason'], message: 'Marcar como suprimida exige suppression_reason (veda, horario silencioso...).' },
);

router.patch(
  '/:id',
  authenticate(),
  requireRole('notifications:worker', 'alerts:write', 'admin'),
  validate({ params: z.object({ id: uuid }), body: patchBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const updated = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `UPDATE civic.alert_deliveries d
            SET status             = $2,
                provider_ref       = COALESCE($3, d.provider_ref),
                error_message      = CASE WHEN $2 = 'failed' THEN $4 ELSE NULL END,
                suppression_reason = COALESCE($5, d.suppression_reason),
                -- attempt sólo sube en los intentos reales de envío; una
                -- supresión no consume reintento.
                attempt            = d.attempt + CASE WHEN $2 IN ('sent','failed') THEN 1 ELSE 0 END,
                sent_at            = CASE WHEN $2 = 'sent'      THEN NOW() ELSE d.sent_at END,
                delivered_at       = CASE WHEN $2 IN ('delivered','read') THEN NOW() ELSE d.delivered_at END
          FROM civic.alerts a
          WHERE d.id = $1 AND a.id = d.alert_id
          RETURNING d.*`,
        [req.params.id, b.status, b.provider_ref ?? null, b.error_message ?? null, b.suppression_reason ?? null],
      );
      return rows[0] || null;
    });

    if (!updated) throw httpError('Entrega no encontrada', 404, 'DELIVERY_NOT_FOUND');
    req.log.info('entrega actualizada', {
      delivery_id: updated.id, alert_id: updated.alert_id, channel: updated.channel, status: updated.status,
    });
    res.json({ data: updated });
  }),
);

module.exports = router;
