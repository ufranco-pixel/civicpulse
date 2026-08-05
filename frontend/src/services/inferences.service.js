/**
 * Contenidos analizados, cola de revision y correccion humana.
 *
 * `list` devuelve el sobre Page{total, page, page_size, items} tal cual lo
 * define schemas/common.py.
 */
import { sentimentApi } from './index.js';

/**
 * @param {string} code  codigo publico de la campana
 * @param {object} filters  sentiment, intent, source_type, contender_id, topic,
 *                          min_confidence, needs_review, q, date_from, date_to,
 *                          page, page_size
 */
export const listInferences = (code, filters = {}, options) =>
  sentimentApi.get(
    `/campaigns/${encodeURIComponent(code)}/inferences`,
    {
      page: filters.page ?? 1,
      page_size: filters.page_size ?? 50,
      sentiment: filters.sentiment,
      intent: filters.intent,
      source_type: filters.source_type,
      contender_id: filters.contender_id,
      topic: filters.topic,
      min_confidence: filters.min_confidence,
      needs_review: filters.needs_review,
      q: filters.q,
      date_from: filters.date_from,
      date_to: filters.date_to,
    },
    options,
  );

export const getInference = (inferenceId, options) =>
  sentimentApi.get(`/inferences/${inferenceId}`, undefined, options);

export const getReviewQueue = (code, { limit = 50 } = {}, options) =>
  sentimentApi.get(`/campaigns/${encodeURIComponent(code)}/review-queue`, { limit }, options);

/**
 * Correccion humana. `stance_code` exige `stance_target_id`: la postura
 * siempre es hacia alguien, y el backend rechaza el cuerpo si falta.
 */
export const annotateInference = (inferenceId, body, options) =>
  sentimentApi.post(`/inferences/${inferenceId}/annotate`, body, options);

/** Confirma la etiqueta del modelo sin corregirla. */
export const reviewInference = (inferenceId, body, options) =>
  sentimentApi.patch(`/inferences/${inferenceId}/review`, body, options);

export default {
  listInferences, getInference, getReviewQueue, annotateInference, reviewInference,
};
