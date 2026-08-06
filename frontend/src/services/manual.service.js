/**
 * Registro manual de comentarios (sentiment-api).
 *
 * Los dos endpoints exigen rol admin en el backend. El frontend esconde la
 * tarjeta a quien no lo tiene, pero eso es comodidad de interfaz, no control
 * de acceso: quien llame a mano recibirá 403.
 */
import { sentimentApi } from './index.js';

/** Registra un comentario y, si `notify`, genera la alerta y las entregas. */
export const createManualComment = (code, body, options) =>
  sentimentApi.post(`/campaigns/${encodeURIComponent(code)}/manual-comments`, body, options);

/**
 * Quién recibiría hoy una alerta de esa severidad.
 *
 * Aplica los mismos filtros que el reparto de la base (consentimiento,
 * severidad mínima, alta activa), así que si aquí sale 0, el envío también
 * saldrá vacío.
 */
export const listWhatsappRecipients = (code, { severity = 'high' } = {}, options) =>
  sentimentApi.get(
    `/campaigns/${encodeURIComponent(code)}/whatsapp-recipients`,
    { severity },
    options,
  );

export default { createManualComment, listWhatsappRecipients };
