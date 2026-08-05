/**
 * Alertas y reglas.
 *
 * Reparto de responsabilidades entre servicios: alerts-api (8003) es el que
 * manda para el listado, el detalle con entregas, las estadisticas y el CRUD
 * de reglas, porque es quien las evalua y difunde. Se conservan tambien las
 * rutas equivalentes de sentiment-api para el modo degradado en el que
 * alerts-api no esta desplegado.
 */
import { alertsApi, sentimentApi } from './index.js';

// ── Alertas (alerts-api) ────────────────────────────────────────────────────
/**
 * @param {object} params campaign_code, status[], severity[], severity_min,
 *   alert_type, rule_id, contender_id, unread_only, since, until, limit,
 *   offset, order, dir
 * @returns {Promise<{data: object[], pagination: object}>}
 */
export const listAlerts = (params = {}, options) => alertsApi.get('/alerts', params, options);

export const getAlertStats = (params = {}, options) =>
  alertsApi.get('/alerts/stats', { campaign_code: params.campaign_code, days: params.days ?? 30 }, options);

export const getAlert = (id, options) => alertsApi.get(`/alerts/${id}`, undefined, options);

/**
 * Acciones admitidas por el backend: acknowledge, start, resolve, dismiss,
 * reopen, mark_read, mark_unread. Resolver exige nota; sin ella la regla no se
 * puede recalibrar y el servicio devuelve 422.
 */
export const patchAlert = (id, body, options) => alertsApi.patch(`/alerts/${id}`, body, options);

export const acknowledgeAlert = (id, options) => patchAlert(id, { action: 'acknowledge' }, options);
export const startAlert = (id, options) => patchAlert(id, { action: 'start' }, options);
export const resolveAlert = (id, resolutionNote, wasFalsePositive = false, options) =>
  patchAlert(id, { action: 'resolve', resolution_note: resolutionNote, was_false_positive: wasFalsePositive }, options);
export const dismissAlert = (id, resolutionNote, options) =>
  patchAlert(id, { action: 'dismiss', resolution_note: resolutionNote }, options);
export const markAlertRead = (id, read = true, options) =>
  patchAlert(id, { action: read ? 'mark_read' : 'mark_unread' }, options);

// ── Reglas (alerts-api) ─────────────────────────────────────────────────────
export const listRules = (params = {}, options) => alertsApi.get('/rules', params, options);
export const getRule = (id, options) => alertsApi.get(`/rules/${id}`, undefined, options);
export const createRule = (body, options) => alertsApi.post('/rules', body, options);
export const updateRule = (id, body, options) => alertsApi.put(`/rules/${id}`, body, options);
export const setRuleEnabled = (id, isEnabled, options) =>
  alertsApi.patch(`/rules/${id}/enabled`, { is_enabled: isEnabled }, options);
export const deleteRule = (id, options) => alertsApi.del(`/rules/${id}`, options);

/**
 * Prueba en seco de una regla: evalua la condicion ahora y explica que
 * pasaria, sin crear alerta ni tocar cooldown ni racha.
 */
export const testRule = (id, overrides = {}, options) =>
  alertsApi.post(`/rules/${id}/test`, overrides, options);

export const runEngine = (dryRun = true, options) =>
  alertsApi.post(`/engine/run?dry_run=${dryRun ? 'true' : 'false'}`, undefined, options);

export const getEngineStatus = (options) => alertsApi.get('/engine/status', undefined, options);

// ── Equivalentes en sentiment-api ───────────────────────────────────────────
export const listAlertsFromSentiment = (code, params = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/alerts`, params, options);

export const listRulesFromSentiment = (code, params = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/alert-rules`, params, options);

/** Evalua las reglas de la campana. dry_run=false exige rol admin. */
export const evaluateRules = (code, dryRun = true, options) =>
  sentimentApi.post(
    `/campaigns/${encodeURIComponent(code)}/evaluate-rules?dry_run=${dryRun ? 'true' : 'false'}`,
    undefined,
    options,
  );

export default {
  listAlerts, getAlertStats, getAlert, patchAlert, acknowledgeAlert, startAlert,
  resolveAlert, dismissAlert, markAlertRead, listRules, getRule, createRule,
  updateRule, setRuleEnabled, deleteRule, testRule, runEngine, getEngineStatus,
  evaluateRules,
};
