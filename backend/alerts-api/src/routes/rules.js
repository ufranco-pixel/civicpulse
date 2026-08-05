'use strict';

/**
 * CRUD de reglas de alerta sobre civic.alert_rules.
 *
 * La validación de `metric` se hace CONSULTANDO civic_kpi.metric_registry, no
 * contra una lista escrita en el código. El registro de indicadores es la
 * fuente de verdad: si se añade una métrica en SQL debe poder usarse sin
 * redesplegar este servicio, y si se desactiva no debe poder crearse una regla
 * nueva sobre ella.
 *
 * Además se exige que la métrica esté marcada is_alertable. Hay indicadores
 * perfectamente válidos para el tablero que no sirven para disparar alertas
 * (por ejemplo los que necesitan 14 días de historia).
 */

const express = require('express');
const { z } = require('zod');
const { withOrgContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

const OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const CHANNELS = ['sse', 'email', 'whatsapp', 'webhook', 'slack'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

const uuid = z.string().uuid('Debe ser un UUID');

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

const ruleShape = {
  campaign_code: z.string().min(1).max(64),
  name: z.string().min(3).max(200),
  alert_type_code: z.string().min(1).max(64),
  severity_code: z.enum(SEVERITIES),
  metric: z.string().min(1).max(64),
  operator: z.enum(OPERATORS, {
    errorMap: () => ({ message: `Operador no válido. Admitidos: ${OPERATORS.join(', ')}` }),
  }),
  threshold: z.coerce.number().finite(),
  window_minutes: z.coerce.number().int().min(1).max(43200).default(60),
  min_sample_size: z.coerce.number().int().min(0).default(30),
  contender_id: uuid.nullish(),
  source_id: uuid.nullish(),
  topic_category: z.string().max(64).nullish(),
  geo_area_id: uuid.nullish(),
  cooldown_minutes: z.coerce.number().int().min(0).max(10080).default(120),
  consecutive_hits: z.coerce.number().int().min(1).max(32).default(1),
  max_per_day: z.coerce.number().int().min(1).max(32767).default(12),
  respect_blackout: z.coerce.boolean().default(true),
  quiet_hours_start: z.coerce.number().int().min(0).max(23).nullish(),
  quiet_hours_end: z.coerce.number().int().min(0).max(23).nullish(),
  channels: z.array(z.enum(CHANNELS)).min(1).default(['sse']),
  recipients: z.array(z.record(z.any())).default([]),
  message_template: z.string().max(4000).nullish(),
  is_enabled: z.coerce.boolean().default(true),
};

const createBody = z.object(ruleShape).strict();
// En la actualización todo es opcional salvo que no se puede mover de campaña:
// cambiar campaign_id dejaría el histórico de alertas apuntando a otra cosa.
const updateBody = z.object(ruleShape).omit({ campaign_code: true }).partial().strict();

/** Comprueba la métrica contra el registro y devuelve su ficha. */
async function loadMetric(client, code) {
  const { rows } = await client.query(
    `SELECT code, label_es, unit, family, min_sample_size, caveat, is_alertable, is_active,
            range_min, range_max, higher_is_better, definition
       FROM civic_kpi.metric_registry WHERE code = $1`,
    [code],
  );
  const metric = rows[0];
  if (!metric || !metric.is_active) {
    throw httpError(
      `La métrica "${code}" no existe en civic_kpi.metric_registry o está inactiva.`,
      422, 'UNKNOWN_METRIC',
    );
  }
  if (!metric.is_alertable) {
    throw httpError(
      `La métrica "${code}" no es alertable (is_alertable = false en el registro de indicadores).`,
      422, 'METRIC_NOT_ALERTABLE',
    );
  }
  return metric;
}

async function resolveCampaign(client, code) {
  const { rows } = await client.query('SELECT id, code, name FROM civic_api.campaigns WHERE code = $1', [code]);
  if (!rows[0]) throw httpError(`No existe la campaña ${code} en esta organización`, 404, 'CAMPAIGN_NOT_FOUND');
  return rows[0];
}

// ── GET /rules ──────────────────────────────────────────────────────────────
router.get(
  '/',
  authenticate(),
  requireRole(),
  validate({
    query: z.object({
      campaign_code: z.string().max(64).optional(),
      enabled: z.coerce.boolean().optional(),
      metric: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const data = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT r.*, mr.label_es AS metric_label, mr.unit AS metric_unit, mr.caveat AS metric_caveat,
                c.name AS campaign_name,
                -- Telemetría de calidad de la regla: una regla que nunca ha
                -- disparado en 30 días o que dispara cada corrida está mal
                -- calibrada, y esto es lo que permite verlo.
                (SELECT count(*)::int FROM civic.alerts a
                  WHERE a.rule_id = r.id AND a.created_at > NOW() - INTERVAL '30 days') AS triggers_30d,
                (SELECT count(*)::int FROM civic.alerts a
                  WHERE a.rule_id = r.id AND a.was_false_positive) AS false_positives
           FROM civic.alert_rules r
           JOIN civic.campaigns c ON c.id = r.campaign_id
           LEFT JOIN civic_kpi.metric_registry mr ON mr.code = r.metric
          WHERE ($1::text IS NULL OR r.campaign_code = $1)
            AND ($2::boolean IS NULL OR r.is_enabled = $2)
            AND ($3::text IS NULL OR r.metric = $3)
          ORDER BY r.created_at DESC
          LIMIT $4 OFFSET $5`,
        [q.campaign_code ?? null, q.enabled ?? null, q.metric ?? null, q.limit, q.offset],
      );
      return rows;
    });
    res.json({ data, pagination: { limit: q.limit, offset: q.offset, returned: data.length } });
  }),
);

// ── GET /rules/:id ──────────────────────────────────────────────────────────
router.get(
  '/:id',
  authenticate(),
  requireRole(),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const rule = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        `SELECT r.*, mr.label_es AS metric_label, mr.unit AS metric_unit, mr.caveat AS metric_caveat
           FROM civic.alert_rules r
           LEFT JOIN civic_kpi.metric_registry mr ON mr.code = r.metric
          WHERE r.id = $1`,
        [req.params.id],
      );
      return rows[0] || null;
    });
    if (!rule) throw httpError('Regla no encontrada', 404, 'RULE_NOT_FOUND');
    res.json({ data: rule });
  }),
);

// ── POST /rules ─────────────────────────────────────────────────────────────
router.post(
  '/',
  authenticate(),
  requireRole('alerts:write', 'campaign:manager', 'admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const created = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const campaign = await resolveCampaign(client, b.campaign_code);
      const metric = await loadMetric(client, b.metric);

      // Aviso, no bloqueo: si la muestra mínima de la regla queda por debajo
      // de la del registro, la alerta puede dispararse sobre datos que el
      // propio indicador considera no publicables.
      const weakSample = b.min_sample_size < metric.min_sample_size;

      const { rows } = await client.query(
        `INSERT INTO civic.alert_rules (
            organization_id, campaign_id, campaign_code, name, alert_type_code, severity_code,
            metric, operator, threshold, window_minutes, min_sample_size,
            contender_id, source_id, topic_category, geo_area_id,
            cooldown_minutes, consecutive_hits, max_per_day, respect_blackout,
            quiet_hours_start, quiet_hours_end, channels, recipients, message_template,
            is_enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 $22::text[], $23::jsonb, $24, $25, $26)
         RETURNING *`,
        [
          req.auth.organizationId, campaign.id, campaign.code, b.name, b.alert_type_code, b.severity_code,
          b.metric, b.operator, b.threshold, b.window_minutes, b.min_sample_size,
          b.contender_id ?? null, b.source_id ?? null, b.topic_category ?? null, b.geo_area_id ?? null,
          b.cooldown_minutes, b.consecutive_hits, b.max_per_day, b.respect_blackout,
          b.quiet_hours_start ?? null, b.quiet_hours_end ?? null,
          b.channels, JSON.stringify(b.recipients), b.message_template ?? null,
          b.is_enabled, req.auth.username,
        ],
      );
      return { rule: rows[0], metric, weakSample };
    });

    req.log.info('regla de alerta creada', {
      rule_id: created.rule.id, campaign_code: created.rule.campaign_code, metric: created.rule.metric,
    });

    res.status(201).json({
      data: created.rule,
      metric: {
        code: created.metric.code,
        label: created.metric.label_es,
        unit: created.metric.unit,
        caveat: created.metric.caveat,
        registry_min_sample_size: created.metric.min_sample_size,
      },
      warnings: created.weakSample
        ? [`min_sample_size (${created.rule.min_sample_size}) es menor que el mínimo del registro para "${created.metric.code}" (${created.metric.min_sample_size}). La regla puede disparar sobre muestras no publicables.`]
        : [],
    });
  }),
);

// ── PUT /rules/:id ──────────────────────────────────────────────────────────
router.put(
  '/:id',
  authenticate(),
  requireRole('alerts:write', 'campaign:manager', 'admin'),
  validate({ params: z.object({ id: uuid }), body: updateBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (Object.keys(b).length === 0) throw httpError('No se envió ningún campo a modificar', 422, 'EMPTY_UPDATE');

    const updated = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      if (b.metric) await loadMetric(client, b.metric);

      // SET dinámico pero con nombres de columna de una lista cerrada (las
      // claves de ruleShape validadas por zod .strict()): el cliente nunca
      // puede inyectar un nombre de columna arbitrario.
      const sets = [];
      const params = [req.params.id];
      for (const [key, value] of Object.entries(b)) {
        if (!Object.prototype.hasOwnProperty.call(ruleShape, key)) continue;
        params.push(key === 'recipients' ? JSON.stringify(value) : value);
        const cast = key === 'recipients' ? '::jsonb' : (key === 'channels' ? '::text[]' : '');
        sets.push(`${key} = $${params.length}${cast}`);
      }
      if (sets.length === 0) return null;
      // Si cambia la definición se reinicia la racha: la histéresis acumulada
      // se calculó con el umbral viejo y ya no significa nada.
      const resetStreak = ['metric', 'operator', 'threshold', 'window_minutes'].some((k) => k in b);
      if (resetStreak) sets.push('current_streak = 0');

      const { rows } = await client.query(
        `UPDATE civic.alert_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      );
      return rows[0] || null;
    });

    if (!updated) throw httpError('Regla no encontrada', 404, 'RULE_NOT_FOUND');
    req.log.info('regla de alerta actualizada', { rule_id: updated.id, fields: Object.keys(b) });
    res.json({ data: updated });
  }),
);

// ── PATCH /rules/:id/enabled ────────────────────────────────────────────────
// Atajo para el interruptor del tablero, que no debe enviar la regla entera.
router.patch(
  '/:id/enabled',
  authenticate(),
  requireRole('alerts:write', 'campaign:manager', 'admin'),
  validate({ params: z.object({ id: uuid }), body: z.object({ is_enabled: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const updated = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows } = await client.query(
        'UPDATE civic.alert_rules SET is_enabled = $2, current_streak = 0 WHERE id = $1 RETURNING *',
        [req.params.id, req.body.is_enabled],
      );
      return rows[0] || null;
    });
    if (!updated) throw httpError('Regla no encontrada', 404, 'RULE_NOT_FOUND');
    res.json({ data: updated });
  }),
);

// ── DELETE /rules/:id ───────────────────────────────────────────────────────
router.delete(
  '/:id',
  authenticate(),
  requireRole('alerts:write', 'campaign:manager', 'admin'),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const deleted = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      // Las alertas ya emitidas NO se borran (rule_id queda en NULL por la FK
      // ON DELETE SET NULL). Borrar el histórico de alertas al borrar la regla
      // destruiría la auditoría de lo que se notificó durante la campaña.
      const { rows } = await client.query('DELETE FROM civic.alert_rules WHERE id = $1 RETURNING id, name', [req.params.id]);
      return rows[0] || null;
    });
    if (!deleted) throw httpError('Regla no encontrada', 404, 'RULE_NOT_FOUND');
    req.log.warn('regla de alerta eliminada', { rule_id: deleted.id, name: deleted.name });
    res.status(204).end();
  }),
);

// ── POST /rules/:id/test ────────────────────────────────────────────────────
//
// Evalúa la condición AHORA con civic_kpi.metric_value y explica qué pasaría,
// sin crear alerta ni tocar cooldown ni racha. Es la única forma honesta de
// calibrar un umbral: probar en producción y ver si llueven notificaciones no
// lo es.
router.post(
  '/:id/test',
  authenticate(),
  requireRole(),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      // Permite tantear otros valores sin guardarlos.
      threshold: z.coerce.number().finite().optional(),
      operator: z.enum(OPERATORS).optional(),
      window_minutes: z.coerce.number().int().min(1).max(43200).optional(),
    }).partial().default({}),
  }),
  asyncHandler(async (req, res) => {
    const override = req.body || {};

    const result = await withOrgContext(req.auth.organizationId, req.auth, async (client) => {
      const { rows: ruleRows } = await client.query('SELECT * FROM civic.alert_rules WHERE id = $1', [req.params.id]);
      const rule = ruleRows[0];
      if (!rule) throw httpError('Regla no encontrada', 404, 'RULE_NOT_FOUND');

      const metric = await loadMetric(client, rule.metric);
      const operator = override.operator || rule.operator;
      const threshold = override.threshold ?? Number(rule.threshold);
      const windowMinutes = override.window_minutes || rule.window_minutes;

      const { rows: valueRows } = await client.query(
        'SELECT value, sample_size FROM civic_kpi.metric_value($1,$2,$3,$4,$5,$6)',
        [rule.campaign_id, rule.metric, windowMinutes, rule.contender_id, rule.source_id, rule.topic_category],
      );
      const observed = valueRows[0]?.value === null || valueRows[0]?.value === undefined
        ? null : Number(valueRows[0].value);
      const sampleSize = Number(valueRows[0]?.sample_size ?? 0);

      // Se replica aquí la comparación (y sólo la comparación) porque la
      // función SQL no expone un modo "explica esta regla". El resto de las
      // condiciones se consulta, no se recalcula.
      const conditionMet = observed === null ? false : ({
        gt: observed > threshold,
        gte: observed >= threshold,
        lt: observed < threshold,
        lte: observed <= threshold,
        eq: observed === threshold,
        neq: observed !== threshold,
      })[operator];

      const { rows: campaignRows } = await client.query(
        'SELECT in_blackout, timezone FROM civic_api.campaigns WHERE id = $1', [rule.campaign_id],
      );
      const campaign = campaignRows[0] || {};

      const { rows: todayRows } = await client.query(
        `SELECT count(*)::int AS n,
                max(created_at)  AS last_at
           FROM civic.alerts
          WHERE rule_id = $1 AND created_at > date_trunc('day', NOW())`,
        [rule.id],
      );
      const firedToday = todayRows[0]?.n ?? 0;
      const lastAt = rule.last_triggered_at;
      const inCooldown = Boolean(lastAt)
        && (Date.now() - new Date(lastAt).getTime()) < rule.cooldown_minutes * 60000;

      // Motivos por los que NO dispararía, en el mismo orden en que los
      // aplica civic.evaluate_alert_rules.
      const blockers = [];
      if (!rule.is_enabled) blockers.push('la regla está deshabilitada');
      if (!conditionMet) blockers.push('la condición no se cumple con el valor actual');
      if (sampleSize < rule.min_sample_size) {
        blockers.push(`muestra insuficiente (${sampleSize} < ${rule.min_sample_size})`);
      }
      if (conditionMet && rule.current_streak + 1 < rule.consecutive_hits) {
        blockers.push(`racha ${rule.current_streak + 1} de ${rule.consecutive_hits} requeridas`);
      }
      if (inCooldown) blockers.push(`en periodo de silencio (${rule.cooldown_minutes} min)`);
      if (firedToday >= rule.max_per_day) blockers.push(`tope diario alcanzado (${rule.max_per_day})`);

      const notifyBlockers = [];
      if (rule.respect_blackout && campaign.in_blackout) {
        notifyBlockers.push('veda electoral: la alerta se registraría sin notificar');
      }

      return {
        rule: {
          id: rule.id, name: rule.name, campaign_code: rule.campaign_code,
          metric: rule.metric, operator, threshold, window_minutes: windowMinutes,
          min_sample_size: rule.min_sample_size, consecutive_hits: rule.consecutive_hits,
          current_streak: rule.current_streak, cooldown_minutes: rule.cooldown_minutes,
          max_per_day: rule.max_per_day, is_enabled: rule.is_enabled,
        },
        overrides_applied: Object.keys(override).length ? override : null,
        evaluation: {
          observed_value: observed,
          sample_size: sampleSize,
          condition_met: conditionMet,
          would_fire: blockers.length === 0,
          would_notify: blockers.length === 0 && notifyBlockers.length === 0,
          blockers,
          notify_blockers: notifyBlockers,
          fired_today: firedToday,
          in_cooldown: inCooldown,
          in_blackout: campaign.in_blackout ?? null,
          evaluated_at: new Date().toISOString(),
        },
        metric: {
          code: metric.code, label: metric.label_es, unit: metric.unit,
          definition: metric.definition, range: [metric.range_min, metric.range_max],
          registry_min_sample_size: metric.min_sample_size,
          // La advertencia acompaña siempre al número, también en las pruebas.
          caveat: metric.caveat,
        },
        reliable: sampleSize >= metric.min_sample_size,
      };
    });

    res.json(result);
  }),
);

module.exports = router;
