/**
 * Campanas, indicadores y catalogos (sentiment-api).
 *
 * Los nombres de parametro son los del router: `days`, `granularity`,
 * `source_id`, `min_authors`, `entity_type`, `months`, `health`. No se
 * traducen a camelCase: cualquier renombre aqui es una fuente de errores
 * silenciosos cuando el backend cambie.
 */
import { sentimentApi } from './index.js';

// ── Campanas ────────────────────────────────────────────────────────────────
export const listCampaigns = (params = {}, options) =>
  sentimentApi.get('/campaigns', { status: params.status }, options);

export const getCampaign = (code, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}`, undefined, options);

// ── Indicadores ─────────────────────────────────────────────────────────────
export const getOverview = (code, { days = 30 } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/overview`, { days }, options);

export const getTimeseries = (code, { days = 30, granularity = 'day', source_id } = {}, options) =>
  sentimentApi.get(
    `/campaigns/${encodeURIComponent(code)}/timeseries`,
    { days, granularity, source_id },
    options,
  );

export const getContenders = (code, { days = 14 } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/contenders`, { days }, options);

export const getTopics = (code, { days = 14, limit = 20 } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/topics`, { days, limit }, options);

export const getCrisis = (code, { hours = 24 } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/crisis`, { hours }, options);

export const getCoordination = (code, { hours = 24, min_authors = 3 } = {}, options) =>
  sentimentApi.get(
    `/campaigns/${encodeURIComponent(code)}/coordination`,
    { hours, min_authors },
    options,
  );

export const getEntities = (code, { limit = 20, entity_type, months = 6 } = {}, options) =>
  sentimentApi.get(
    `/campaigns/${encodeURIComponent(code)}/entities`,
    { limit, entity_type, months },
    options,
  );

export const getEmotions = (code, { days = 14 } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/emotions`, { days }, options);

export const getSources = (code, { health } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/sources`, { health }, options);

// ── Catalogos y registro de indicadores ─────────────────────────────────────
export const getCatalogs = (options) => sentimentApi.get('/catalogs', undefined, options);
export const getMetrics = (options) => sentimentApi.get('/metrics', undefined, options);

// ── Trabajos de analisis ────────────────────────────────────────────────────
export const listJobs = (code, params = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/jobs`, params, options);

export const getJob = (jobId, options) =>
  sentimentApi.get(`/jobs/${jobId}`, undefined, options);

export const createJob = (code, body, options) =>
  sentimentApi.post(`/campaigns/${encodeURIComponent(code)}/jobs`, body, options);

export const patchJob = (jobId, body, options) =>
  sentimentApi.patch(`/jobs/${jobId}`, body, options);

// ── Operacion ───────────────────────────────────────────────────────────────
export const getCompliance = (options) => sentimentApi.get('/ops/compliance', undefined, options);
export const refreshKpis = (options) => sentimentApi.post('/ops/refresh-kpis', undefined, options);

export default {
  listCampaigns, getCampaign, getOverview, getTimeseries, getContenders, getTopics,
  getCrisis, getCoordination, getEntities, getEmotions, getSources, getCatalogs,
  getMetrics, listJobs, getJob, createJob, patchJob, getCompliance, refreshKpis,
};
