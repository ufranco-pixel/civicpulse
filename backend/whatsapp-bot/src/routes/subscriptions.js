'use strict';

/**
 * Suscripciones a alertas (civic.alert_subscriptions).
 *
 * El consentimiento no es un campo más. La tabla tiene el trigger
 * civic.enforce_subscription_consent, que lanza SQLSTATE 23514 si se intenta
 * activar una suscripción de WhatsApp o correo sin consent_given_at. Aquí se
 * captura ese código y se devuelve un 422 que dice exactamente qué falta: el
 * mensaje genérico del manejador de errores ("viola una restricción de
 * integridad") deja al operador adivinando.
 *
 * La baja NO borra la fila. Se marca opted_out_at y el propio trigger pone
 * is_active = FALSE. Borrar el registro perdería la prueba de que hubo
 * consentimiento y de cuándo se retiró, que es justo lo que hay que conservar.
 */

const express = require('express');
const { z } = require('zod');

const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

const uuid = z.string().uuid('Debe ser un UUID');
const CHANNELS = ['email', 'whatsapp', 'webhook', 'slack'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const CONSENT_REQUIRED_CHANNELS = new Set(['whatsapp', 'email']);

const COLUMNS = `
  id, organization_id, campaign_id, campaign_code, channel, destination,
  display_name, min_severity, alert_types, consent_given_at, consent_source,
  opted_out_at, is_active, created_at, updated_at
`;

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

/**
 * Traduce el 23514 del trigger de consentimiento.
 * Cualquier otro error se relanza tal cual: el manejador central sabe qué
 * hacer con él y tragárselo aquí ocultaría fallos distintos.
 */
function rethrowConsent(err, channel) {
  if (err && err.code === '23514') {
    throw httpError(
      `La suscripción por ${channel} exige consentimiento expreso: envíe consent_given_at `
      + '(fecha ISO en que la persona aceptó) y consent_source (dónde consta).',
      422, 'CONSENT_REQUIRED',
    );
  }
  throw err;
}

const createBody = z.object({
  campaignCode: z.string().min(1).max(64),
  channel: z.enum(CHANNELS),
  destination: z.string().min(3).max(400),
  displayName: z.string().max(200).nullish(),
  minSeverity: z.enum(SEVERITIES).default('medium'),
  // Vacío = todos los tipos.
  alertTypes: z.array(z.string().max(64)).max(50).default([]),
  consentGivenAt: z.coerce.date().nullish(),
  consentSource: z.string().max(400).nullish(),
}).strict();

const updateBody = z.object({
  displayName: z.string().max(200).nullish(),
  minSeverity: z.enum(SEVERITIES),
  alertTypes: z.array(z.string().max(64)).max(50),
  consentGivenAt: z.coerce.date().nullish(),
  consentSource: z.string().max(400).nullish(),
  isActive: z.boolean(),
}).partial().strict().refine((v) => Object.keys(v).length > 0, {
  message: 'No hay nada que actualizar.',
});

// ── GET /subscriptions ──────────────────────────────────────────────────────
router.get(
  '/',
  authenticate(),
  requireRole(),
  validate({
    query: z.object({
      campaign_code: z.string().max(64).optional(),
      channel: z.enum(CHANNELS).optional(),
      active: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const data = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COLUMNS}
           FROM civic.alert_subscriptions
          WHERE ($1::text IS NULL OR campaign_code = $1)
            AND ($2::text IS NULL OR channel = $2)
            AND ($3::boolean IS NULL OR is_active = $3)
          ORDER BY campaign_code, channel, created_at
          LIMIT $4 OFFSET $5`,
        [q.campaign_code ?? null, q.channel ?? null, q.active ?? null, q.limit, q.offset],
      );
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS total
           FROM civic.alert_subscriptions
          WHERE ($1::text IS NULL OR campaign_code = $1)
            AND ($2::text IS NULL OR channel = $2)
            AND ($3::boolean IS NULL OR is_active = $3)`,
        [q.campaign_code ?? null, q.channel ?? null, q.active ?? null],
      );
      return { rows, total: countRows[0].total };
    });
    res.json({
      data: data.rows,
      pagination: { limit: q.limit, offset: q.offset, total: data.total, returned: data.rows.length },
    });
  }),
);

// ── GET /subscriptions/:id ──────────────────────────────────────────────────
router.get(
  '/:id',
  authenticate(),
  requireRole(),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const row = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM civic.alert_subscriptions WHERE id = $1`, [req.params.id],
      );
      return rows[0] || null;
    });
    if (!row) throw httpError('Suscripción no encontrada', 404, 'SUBSCRIPTION_NOT_FOUND');
    res.json({ data: row });
  }),
);

// ── POST /subscriptions ─────────────────────────────────────────────────────
router.post(
  '/',
  authenticate(),
  requireRole('whatsapp:admin', 'alerts:write', 'admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;

    // Aviso temprano: se podría dejar que fallara el trigger, pero decirlo
    // antes de tocar la base da un mensaje mucho más claro.
    if (CONSENT_REQUIRED_CHANNELS.has(b.channel) && !b.consentGivenAt) {
      throw httpError(
        `El canal ${b.channel} exige consent_given_at: no se puede suscribir a nadie sin su consentimiento expreso.`,
        422, 'CONSENT_REQUIRED',
      );
    }

    try {
      const created = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
        const { rows: campaignRows } = await client.query(
          'SELECT id, code FROM civic_api.campaigns WHERE code = $1', [b.campaignCode],
        );
        const campaign = campaignRows[0];
        if (!campaign) throw httpError(`No existe la campaña ${b.campaignCode} en esta organización`, 404, 'CAMPAIGN_NOT_FOUND');

        const { rows } = await client.query(
          `INSERT INTO civic.alert_subscriptions
              (organization_id, campaign_id, campaign_code, channel, destination,
               display_name, min_severity, alert_types, consent_given_at, consent_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::civic.slug_code[], $9, $10)
           RETURNING ${COLUMNS}`,
          [
            req.auth.organizationId, campaign.id, campaign.code, b.channel, b.destination,
            b.displayName ?? null, b.minSeverity, b.alertTypes,
            b.consentGivenAt ?? null, b.consentSource ?? null,
          ],
        );
        return rows[0];
      });
      req.log.info('suscripción creada', { channel: created.channel, campaign_code: created.campaign_code });
      res.status(201).json({ data: created });
    } catch (err) {
      rethrowConsent(err, b.channel);
    }
  }),
);

// ── PATCH /subscriptions/:id ────────────────────────────────────────────────
router.patch(
  '/:id',
  authenticate(),
  requireRole('whatsapp:admin', 'alerts:write', 'admin'),
  validate({ params: z.object({ id: uuid }), body: updateBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    let channel = 'el canal';
    try {
      const updated = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
        // COALESCE por columna: el SQL es fijo y ningún nombre de columna
        // procede de la petición.
        const { rows } = await client.query(
          `UPDATE civic.alert_subscriptions
              SET display_name     = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
                  min_severity     = COALESCE($4::civic.slug_code, min_severity),
                  alert_types      = COALESCE($5::civic.slug_code[], alert_types),
                  consent_given_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE consent_given_at END,
                  consent_source   = CASE WHEN $8::boolean THEN $9 ELSE consent_source END,
                  is_active        = COALESCE($10::boolean, is_active)
            WHERE id = $1
            RETURNING ${COLUMNS}`,
          [
            req.params.id,
            Object.hasOwn(b, 'displayName'), b.displayName ?? null,
            b.minSeverity ?? null,
            b.alertTypes ?? null,
            Object.hasOwn(b, 'consentGivenAt'), b.consentGivenAt ?? null,
            Object.hasOwn(b, 'consentSource'), b.consentSource ?? null,
            b.isActive ?? null,
          ],
        );
        return rows[0] || null;
      });
      if (!updated) throw httpError('Suscripción no encontrada', 404, 'SUBSCRIPTION_NOT_FOUND');
      channel = updated.channel;
      req.log.info('suscripción actualizada', { id: updated.id });
      res.json({ data: updated });
    } catch (err) {
      rethrowConsent(err, channel);
    }
  }),
);

// ── POST /subscriptions/:id/opt-out ─────────────────────────────────────────
router.post(
  '/:id/opt-out',
  authenticate(),
  requireRole('whatsapp:admin', 'alerts:write', 'admin'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ reason: z.string().max(400).optional() }).strict().optional(),
  }),
  asyncHandler(async (req, res) => {
    const updated = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      // El trigger pone is_active = FALSE al ver opted_out_at; no hace falta
      // tocarlo aquí y hacerlo duplicaría la regla en dos sitios.
      const { rows } = await client.query(
        `UPDATE civic.alert_subscriptions
            SET opted_out_at = COALESCE(opted_out_at, NOW())
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [req.params.id],
      );
      return rows[0] || null;
    });
    if (!updated) throw httpError('Suscripción no encontrada', 404, 'SUBSCRIPTION_NOT_FOUND');
    req.log.info('baja registrada', {
      id: updated.id, channel: updated.channel, reason: req.body?.reason ?? null,
    });
    res.json({ data: updated, message: 'Baja registrada. La fila se conserva como prueba del consentimiento retirado.' });
  }),
);

// ── DELETE /subscriptions/:id ───────────────────────────────────────────────
// Borrado real. Reservado a administración: sólo para datos capturados por
// error. Para dejar de enviar, use /opt-out.
router.delete(
  '/:id',
  authenticate(),
  requireRole('admin'),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const removed = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM civic.alert_subscriptions WHERE id = $1', [req.params.id],
      );
      return rowCount > 0;
    });
    if (!removed) throw httpError('Suscripción no encontrada', 404, 'SUBSCRIPTION_NOT_FOUND');
    req.log.warn('suscripción eliminada', { id: req.params.id, by: req.auth.username });
    res.status(204).end();
  }),
);

module.exports = router;
