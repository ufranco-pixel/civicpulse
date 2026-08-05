/**
 * Suscripciones y plantillas de notificacion (whatsapp-bot).
 *
 * Solo lectura y alta/baja de suscripciones desde el tablero: el envio de
 * mensajes lo hace el motor de alertas, no la interfaz.
 */
import { whatsappApi } from './index.js';

export const listSubscriptions = (params = {}, options) =>
  whatsappApi.get('/subscriptions', params, options);

export const getSubscription = (id, options) =>
  whatsappApi.get(`/subscriptions/${id}`, undefined, options);

export const createSubscription = (body, options) =>
  whatsappApi.post('/subscriptions', body, options);

export const updateSubscription = (id, body, options) =>
  whatsappApi.patch(`/subscriptions/${id}`, body, options);

export const deleteSubscription = (id, options) =>
  whatsappApi.del(`/subscriptions/${id}`, options);

export const listTemplates = (params = {}, options) =>
  whatsappApi.get('/templates', params, options);

export const getBotStatus = (options) => whatsappApi.get('/bot/status', undefined, options);

export default {
  listSubscriptions, getSubscription, createSubscription, updateSubscription,
  deleteSubscription, listTemplates, getBotStatus,
};
