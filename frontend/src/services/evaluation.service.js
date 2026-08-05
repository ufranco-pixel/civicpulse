/**
 * Evaluacion de modelos y prompts (sentiment-api, prefijo /evaluation).
 *
 * Nada se promueve sin pasar por aqui: conjunto congelado, corrida, metricas
 * por corte y puerta de promocion.
 */
import { sentimentApi } from './index.js';

// ── Conjuntos ───────────────────────────────────────────────────────────────
export const listDatasets = (params = {}, options) =>
  sentimentApi.get('/evaluation/datasets', { split: params.split, campaign_id: params.campaign_id }, options);

export const createDataset = (body, options) =>
  sentimentApi.post('/evaluation/datasets', body, options);

/** Congelar es irreversible: sin ello las corridas no son comparables. */
export const freezeDataset = (datasetId, options) =>
  sentimentApi.post(`/evaluation/datasets/${datasetId}/freeze`, undefined, options);

export const addDatasetItems = (datasetId, items, options) =>
  sentimentApi.post(`/evaluation/datasets/${datasetId}/items`, { items }, options);

// ── Corridas ────────────────────────────────────────────────────────────────
export const listRuns = (params = {}, options) =>
  sentimentApi.get(
    '/evaluation/runs',
    { dataset_id: params.dataset_id, model_id: params.model_id, limit: params.limit ?? 50 },
    options,
  );

export const getRun = (runId, options) =>
  sentimentApi.get(`/evaluation/runs/${runId}`, undefined, options);

export const createRun = (body, options) =>
  sentimentApi.post('/evaluation/runs', body, options);

export const computeMetrics = (runId, options) =>
  sentimentApi.post(`/evaluation/runs/${runId}/compute-metrics`, undefined, options);

/** El corte va como `slice`: 'all', 'lang:es', 'source:x_twitter', 'phenom:sarcasm'. */
export const getRunMetrics = (runId, { slice, task } = {}, options) =>
  sentimentApi.get(`/evaluation/runs/${runId}/metrics`, { slice, task }, options);

export const getConfusion = (runId, { task = 'sentiment', slice = 'all' } = {}, options) =>
  sentimentApi.get(`/evaluation/runs/${runId}/confusion`, { task, slice }, options);

export const compareRuns = (runId, baselineRunId, options) =>
  sentimentApi.get(`/evaluation/runs/${runId}/compare`, { baseline_run_id: baselineRunId }, options);

/** Puerta de promocion. Los umbrales son los del router, no inventados. */
export const getPromotionGate = (runId, gate = {}, options) =>
  sentimentApi.get(
    `/evaluation/runs/${runId}/gate`,
    {
      min_f1_macro: gate.min_f1_macro ?? 0.7,
      min_schema_rate: gate.min_schema_rate ?? 0.98,
      max_calibration: gate.max_calibration ?? 0.15,
      max_slice_drop: gate.max_slice_drop ?? 0.15,
    },
    options,
  );

/** task admite sentiment, stance o intent; cualquier otro valor es 400. */
export const getRunErrors = (runId, { task = 'sentiment', limit = 100, only_schema_violations = false } = {}, options) =>
  sentimentApi.get(
    `/evaluation/runs/${runId}/errors`,
    { task, limit, only_schema_violations },
    options,
  );

export default {
  listDatasets, createDataset, freezeDataset, addDatasetItems, listRuns, getRun,
  createRun, computeMetrics, getRunMetrics, getConfusion, compareRuns,
  getPromotionGate, getRunErrors,
};
