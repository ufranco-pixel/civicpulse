/**
 * Cliente del stream de alertas (alerts-api · GET /alerts/stream).
 *
 * EventSource no admite cabeceras, asi que el token viaja en la query. El
 * backend lo verifica con el mismo codigo que la cabecera Authorization
 * (firma, emisor, expiracion): no es un endpoint abierto. Aun asi el token
 * queda en los registros de acceso del proxy, por lo que conviene emitir uno
 * de vida corta para el stream.
 *
 * Eventos del servidor: `connected`, `alert`, `alert_updated`, `shutdown`, y
 * comentarios de latido (`: heartbeat`) que el navegador ignora.
 */
import { ALERTS_ORIGIN } from './index.js';

const BASE_DELAY = Number.parseInt(import.meta.env.VITE_SSE_RETRY_BASE_MS || '2000', 10);
const MAX_DELAY = Number.parseInt(import.meta.env.VITE_SSE_RETRY_MAX_MS || '60000', 10);

export const SSE_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
  ERROR: 'error',
};

/**
 * @param {object} config
 * @param {() => string|null} config.getToken   token vigente en el momento de conectar
 * @param {string}   [config.campaignCode]
 * @param {string}   [config.severityMin]       info | low | medium | high | critical
 * @param {string[]} [config.alertTypes]
 * @param {(alert: object) => void} [config.onAlert]
 * @param {(payload: object) => void} [config.onAlertUpdated]
 * @param {(status: string, detail: object) => void} [config.onStatus]
 */
export function createAlertStream(config = {}) {
  const {
    getToken,
    campaignCode = null,
    severityMin = null,
    alertTypes = null,
    onAlert,
    onAlertUpdated,
    onStatus,
    origin = ALERTS_ORIGIN,
  } = config;

  let source = null;
  let attempt = 0;
  let retryTimer = null;
  let closed = false;
  let status = SSE_STATUS.IDLE;

  function setStatus(next, detail = {}) {
    status = next;
    if (onStatus) onStatus(next, detail);
  }

  function buildUrl() {
    const params = new URLSearchParams();
    const token = typeof getToken === 'function' ? getToken() : null;
    if (token) params.set('token', token);
    if (campaignCode) params.set('campaign_code', campaignCode);
    if (severityMin) params.set('severity_min', severityMin);
    if (Array.isArray(alertTypes) && alertTypes.length) params.set('alert_types', alertTypes.join(','));
    return `${origin}/alerts/stream?${params.toString()}`;
  }

  function parse(event) {
    try { return JSON.parse(event.data); } catch { return null; }
  }

  function scheduleReconnect() {
    if (closed) return;
    // Exponencial con tope y ruido: sin tope, una caida larga del servicio deja
    // decenas de pestanas reintentando cada 2 s indefinidamente.
    const delay = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY) + Math.random() * 500;
    attempt += 1;
    setStatus(SSE_STATUS.RECONNECTING, { attempt, delay });
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (closed) return;
    disposeSource();
    setStatus(SSE_STATUS.CONNECTING, { attempt });

    try {
      source = new EventSource(buildUrl());
    } catch (err) {
      setStatus(SSE_STATUS.ERROR, { error: err });
      scheduleReconnect();
      return;
    }

    source.addEventListener('connected', (event) => {
      attempt = 0;
      setStatus(SSE_STATUS.OPEN, { info: parse(event) });
    });

    source.addEventListener('alert', (event) => {
      const alert = parse(event);
      if (alert && onAlert) onAlert(alert);
    });

    // Cambio de estado de una alerta existente. Va como evento propio para que
    // el tablero no lo trate como alerta nueva ni vuelva a notificar.
    source.addEventListener('alert_updated', (event) => {
      const payload = parse(event);
      if (payload && onAlertUpdated) onAlertUpdated(payload);
    });

    source.addEventListener('shutdown', () => {
      // El servidor cierra ordenadamente: se reconecta contra otra replica.
      setStatus(SSE_STATUS.RECONNECTING, { reason: 'server_shutdown' });
    });

    source.onopen = () => {
      attempt = 0;
      setStatus(SSE_STATUS.OPEN, {});
    };

    source.onerror = () => {
      // EventSource reconecta solo, pero sin control del intervalo y sin
      // renovar el token de la query. Se cierra y se reconecta a mano.
      disposeSource();
      scheduleReconnect();
    };
  }

  function disposeSource() {
    if (source) {
      source.onopen = null;
      source.onerror = null;
      try { source.close(); } catch { /* ya cerrado */ }
      source = null;
    }
  }

  function close() {
    closed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    disposeSource();
    setStatus(SSE_STATUS.CLOSED, {});
  }

  return {
    connect,
    close,
    get status() { return status; },
    get attempt() { return attempt; },
  };
}

export default createAlertStream;
