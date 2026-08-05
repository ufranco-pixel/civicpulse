'use strict';

/**
 * Envío de mensajes.
 *
 * Dos reglas gobiernan este archivo y ninguna es negociable:
 *
 * 1. VEDA ELECTORAL. Si la campaña está en veda (civic_api.campaigns.in_blackout)
 *    no se envía nada salvo severidad 'critical'. La supresión NO es un
 *    silencio: se registra en civic.alert_deliveries con status='suppressed' y
 *    suppression_reason, para que después pueda demostrarse qué se dejó de
 *    enviar y por qué. El sistema base enviaba igual, que es exactamente el
 *    fallo que se corrige.
 *
 * 2. CONSENTIMIENTO. Sólo se manda a destinos con consent_given_at y sin
 *    opted_out_at. El filtro se aplica en la consulta, no en el código.
 *
 * El envío por WhatsApp se hace FUERA de la transacción: una llamada de red de
 * varios segundos por destinatario dentro de un BEGIN retiene una conexión del
 * pool y puede disparar el statement_timeout de toda la operación.
 */

const express = require('express');
const { z } = require('zod');

const db = require('../db');
const bot = require('../bot/client');
const templates = require('../store/templates');
const { formatChatId, formatAlert, formatDigest, truncate, METHODOLOGY_NOTE } = require('../utils/formatters');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

const uuid = z.string().uuid('Debe ser un UUID');
const destination = z.string().min(8).max(64);
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

const BLACKOUT_REASON = 'veda_electoral';

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

const ALERT_COLUMNS = `
  id, campaign_id, campaign_code, alert_type_code, alert_type_label,
  severity_code, severity_label, severity_rank, title, message,
  metric, metric_label, metric_unit, metric_caveat,
  observed_value, threshold_value, sample_size, window_start, window_end,
  contender_name, source_name, topic_category, status, during_blackout, created_at
`;

/** Campaña con su bandera de veda. Devuelve null si no es visible (RLS). */
async function loadCampaign(client, campaignCode) {
  const { rows } = await client.query(
    'SELECT id, code, name, in_blackout, blackout_starts_on, blackout_ends_on FROM civic_api.campaigns WHERE code = $1',
    [campaignCode],
  );
  return rows[0] || null;
}

/**
 * ¿Se puede enviar durante la veda?
 * Sólo lo crítico atraviesa: una crisis en curso es información de interés
 * público, un resumen diario no.
 */
function blockedByBlackout(campaign, severityCode) {
  return Boolean(campaign && campaign.in_blackout) && severityCode !== 'critical';
}

/** Destinatarios suscritos a una alerta, ya filtrados por consentimiento y severidad. */
async function subscribersFor(client, alert) {
  const { rows } = await client.query(
    `SELECT s.id, s.destination, s.display_name, s.min_severity
       FROM civic.alert_subscriptions s
       JOIN civic_cat.severity_levels sv ON sv.code = s.min_severity
      WHERE s.campaign_code = $1
        AND s.channel = 'whatsapp'
        AND s.is_active
        AND s.opted_out_at IS NULL
        -- Sin consentimiento no se envía. El trigger de la tabla ya lo impide
        -- al escribir; aquí se repite al leer por si una fila es anterior.
        AND s.consent_given_at IS NOT NULL
        AND sv.rank <= $2
        AND (cardinality(s.alert_types) = 0 OR $3::civic.slug_code = ANY(s.alert_types))
      ORDER BY s.created_at`,
    [alert.campaign_code, alert.severity_rank, alert.alert_type_code],
  );
  return rows;
}

/** Deja constancia del intento (o de la supresión) en civic.alert_deliveries. */
async function recordDelivery(client, { alertId, recipient, status, suppressionReason, providerRef, errorMessage }) {
  const { rows } = await client.query(
    `INSERT INTO civic.alert_deliveries
        (alert_id, channel, recipient, status, suppression_reason, provider_ref,
         error_message, attempt, sent_at)
     VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, status, suppression_reason, created_at`,
    [
      alertId, recipient, status, suppressionReason ?? null, providerRef ?? null,
      errorMessage ?? null,
      status === 'suppressed' ? 0 : 1,
      status === 'sent' ? new Date() : null,
    ],
  );
  return rows[0];
}

// ── POST /messages/send ─────────────────────────────────────────────────────
// Texto libre. Si se indica campaña, la veda aplica igual: un mensaje
// "manual" durante la veda sigue siendo propaganda.
router.post(
  '/send',
  authenticate(),
  requireRole('whatsapp:send', 'notifications:worker', 'admin'),
  validate({
    body: z.object({
      to: destination,
      text: z.string().min(1).max(4000),
      campaignCode: z.string().min(1).max(64).optional(),
      // Declarar la severidad es lo que permite que algo crítico salga durante
      // la veda. Por defecto 'info': lo que no se declara, no pasa.
      severity: z.enum(SEVERITIES).default('info'),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const { to, text, campaignCode, severity } = req.body;
    const chatId = formatChatId(to);

    if (campaignCode) {
      const campaign = await db.withOrgContext(req.auth.organizationId, req.auth,
        (client) => loadCampaign(client, campaignCode));
      if (!campaign) throw httpError(`No existe la campaña ${campaignCode} en esta organización`, 404, 'CAMPAIGN_NOT_FOUND');
      if (blockedByBlackout(campaign, severity)) {
        req.log.warn('envío bloqueado por veda electoral', { campaign_code: campaignCode, severity });
        throw httpError(
          `La campaña ${campaignCode} está en veda electoral: sólo se envían mensajes de severidad 'critical'.`,
          409, 'ELECTORAL_BLACKOUT',
        );
      }
    }

    const sent = await bot.sendMessage(chatId, truncate(text));
    req.log.info('mensaje enviado', { to: chatId, campaign_code: campaignCode ?? null });
    res.status(201).json({ data: { ...sent, severity } });
  }),
);

// ── POST /messages/template ─────────────────────────────────────────────────
router.post(
  '/template',
  authenticate(),
  requireRole('whatsapp:send', 'notifications:worker', 'admin'),
  validate({
    body: z.object({
      to: destination,
      code: z.string().min(1).max(64),
      variables: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
      campaignCode: z.string().min(1).max(64).optional(),
      severity: z.enum(SEVERITIES).default('info'),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const { to, code, variables, campaignCode, severity } = req.body;
    const chatId = formatChatId(to);

    if (campaignCode) {
      const campaign = await db.withOrgContext(req.auth.organizationId, req.auth,
        (client) => loadCampaign(client, campaignCode));
      if (!campaign) throw httpError(`No existe la campaña ${campaignCode} en esta organización`, 404, 'CAMPAIGN_NOT_FOUND');
      if (blockedByBlackout(campaign, severity)) {
        throw httpError(
          `La campaña ${campaignCode} está en veda electoral: sólo se envían mensajes de severidad 'critical'.`,
          409, 'ELECTORAL_BLACKOUT',
        );
      }
    }

    const { template, text } = await templates.render(req.auth, code, variables);
    const sent = await bot.sendMessage(chatId, truncate(text));
    req.log.info('plantilla enviada', { to: chatId, template: template.code });
    res.status(201).json({ data: { ...sent, template: template.code } });
  }),
);

// ── POST /messages/alert ────────────────────────────────────────────────────
// Envía una alerta ya existente. El texto lo compone el servicio a partir de
// civic_api.alerts: el cliente no puede reescribir el contenido de una alerta
// ni, sobre todo, quitarle la advertencia metodológica.
router.post(
  '/alert',
  authenticate(),
  requireRole('whatsapp:send', 'notifications:worker', 'alerts:write', 'admin'),
  validate({
    body: z.object({
      alertId: uuid,
      // Sin `to` se resuelven los suscriptores de la campaña.
      to: z.array(destination).max(200).optional(),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const { alertId, to } = req.body;

    // ── Fase 1 (transaccional): leer alerta, decidir y anotar las supresiones.
    const plan = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT ${ALERT_COLUMNS} FROM civic_api.alerts WHERE id = $1`, [alertId],
      );
      const alert = rows[0];
      if (!alert) throw httpError('Alerta no encontrada', 404, 'ALERT_NOT_FOUND');

      const campaign = await loadCampaign(client, alert.campaign_code);
      const recipients = to && to.length
        ? to.map((d) => ({ destination: d, display_name: null, id: null }))
        : await subscribersFor(client, alert);

      const suppressed = [];
      const pending = [];

      if (blockedByBlackout(campaign, alert.severity_code)) {
        // Se anota una entrega suprimida por destinatario, no una global: la
        // pregunta que hay que poder responder es "¿a quién no le llegó?".
        for (const r of recipients) {
          const delivery = await recordDelivery(client, {
            alertId,
            recipient: r.destination,
            status: 'suppressed',
            suppressionReason: `${BLACKOUT_REASON}: campaña ${alert.campaign_code} en veda y severidad '${alert.severity_code}' no es 'critical'`,
          });
          suppressed.push({ ...delivery, recipient: r.destination });
        }
      } else {
        for (const r of recipients) {
          const delivery = await recordDelivery(client, {
            alertId, recipient: r.destination, status: 'pending',
          });
          pending.push({ deliveryId: delivery.id, recipient: r.destination });
        }
      }

      return { alert, campaign, suppressed, pending };
    });

    if (plan.suppressed.length) {
      req.log.warn('alerta suprimida por veda electoral', {
        alert_id: alertId,
        campaign_code: plan.alert.campaign_code,
        severity: plan.alert.severity_code,
        suppressed: plan.suppressed.length,
      });
      return res.status(202).json({
        data: {
          alertId,
          sent: [],
          suppressed: plan.suppressed.map((s) => ({ recipient: s.recipient, reason: s.suppression_reason })),
        },
        message: 'Campaña en veda electoral: no se envió y la supresión quedó registrada.',
      });
    }

    // ── Fase 2 (fuera de la transacción): enviar.
    const text = formatAlert(plan.alert);
    const results = [];
    for (const item of plan.pending) {
      try {
        const chatId = formatChatId(item.recipient);
        const sent = await bot.sendMessage(chatId, text);
        results.push({ recipient: item.recipient, status: 'sent', providerRef: sent.id, deliveryId: item.deliveryId });
      } catch (err) {
        results.push({ recipient: item.recipient, status: 'failed', error: err.message, deliveryId: item.deliveryId });
      }
    }

    // ── Fase 3: cerrar el registro de cada entrega.
    await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      for (const r of results) {
        await client.query(
          `UPDATE civic.alert_deliveries
              SET status = $2, provider_ref = $3, error_message = $4,
                  sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
            WHERE id = $1`,
          [r.deliveryId, r.status, r.providerRef ?? null, r.error ?? null],
        );
      }
    });

    const failed = results.filter((r) => r.status === 'failed');
    req.log.info('alerta distribuida', {
      alert_id: alertId, sent: results.length - failed.length, failed: failed.length,
    });
    // 207 cuando parte falló: un 200 escondería que la mitad no llegó.
    return res.status(failed.length && failed.length < results.length ? 207 : 201).json({
      data: { alertId, results, suppressed: [] },
    });
  }),
);

// ── POST /messages/digest ───────────────────────────────────────────────────
// Resumen diario de una campaña. Nunca es crítico, así que la veda lo bloquea
// siempre.
router.post(
  '/digest',
  authenticate(),
  requireRole('whatsapp:send', 'notifications:worker', 'admin'),
  validate({
    body: z.object({
      campaignCode: z.string().min(1).max(64),
      to: z.union([destination, z.array(destination).min(1).max(200)]),
      days: z.coerce.number().int().min(1).max(90).default(1),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const { campaignCode, days } = req.body;
    const recipients = Array.isArray(req.body.to) ? req.body.to : [req.body.to];

    const campaign = await db.withOrgContext(req.auth.organizationId, req.auth,
      (client) => loadCampaign(client, campaignCode));
    if (!campaign) throw httpError(`No existe la campaña ${campaignCode} en esta organización`, 404, 'CAMPAIGN_NOT_FOUND');
    if (campaign.in_blackout) {
      throw httpError(
        `La campaña ${campaignCode} está en veda electoral: un resumen periódico nunca es de severidad 'critical'.`,
        409, 'ELECTORAL_BLACKOUT',
      );
    }

    // Las mismas consultas que el comando !resumen del chat, pero con la
    // organización del TOKEN. handlers.campaignDigest usa WA_ORGANIZATION_ID,
    // que sirve para quien escribe sin token y no vale aquí.
    const data = await db.withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows: overviewRows } = await client.query(
        `SELECT campaign_code, campaign_name, period_start, period_end, days_to_election,
                total_mentions, unique_authors, total_reach,
                positive_pct, neutral_pct, negative_pct, net_sentiment,
                sentiment_momentum, polarization_index, avg_toxicity, avg_confidence,
                open_alerts, critical_alerts, review_backlog,
                sources_healthy, sources_total, is_reliable, last_updated
           FROM civic_kpi.campaign_overview($1, $2)`,
        [campaignCode, days],
      );
      const { rows: scoreboard } = await client.query(
        `SELECT contender_name, is_own, share_of_voice, net_support,
                support_wilson_lb, is_reliable
           FROM civic_kpi.contender_scoreboard($1, $2)
          ORDER BY rank_by_wilson
          LIMIT 5`,
        [campaignCode, days],
      );
      return { overview: overviewRows[0] || null, scoreboard };
    });

    const text = formatDigest(data.overview, data.scoreboard);
    const results = [];
    for (const recipient of recipients) {
      try {
        const sent = await bot.sendMessage(formatChatId(recipient), text);
        results.push({ recipient, status: 'sent', providerRef: sent.id });
      } catch (err) {
        results.push({ recipient, status: 'failed', error: err.message });
      }
    }

    const failed = results.filter((r) => r.status === 'failed');
    req.log.info('resumen enviado', { campaign_code: campaignCode, sent: results.length - failed.length, failed: failed.length });
    res.status(failed.length && failed.length < results.length ? 207 : 201).json({
      data: { campaignCode, days, results, caveat: METHODOLOGY_NOTE },
    });
  }),
);

module.exports = router;
module.exports.blockedByBlackout = blockedByBlackout;
