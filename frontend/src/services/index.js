/**
 * Instancias de cliente, una por microservicio.
 *
 * Cada servicio tiene su propio origen: en despliegue estan detras de rutas
 * distintas del mismo dominio, y en desarrollo en puertos distintos.
 */
import { createApiClient } from './apiClient.js';

const env = import.meta.env;
const timeoutMs = Number.parseInt(env.VITE_API_TIMEOUT_MS || '20000', 10);

const clean = (value, fallback) => String(value || fallback || '').replace(/\/+$/, '');

// sentiment-api monta los routers de negocio bajo API_PREFIX (/v1 por
// defecto); /health y /ready quedan fuera a proposito.
const SENTIMENT_PREFIX = (() => {
  const raw = String(env.VITE_SENTIMENT_API_PREFIX ?? '/v1').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
})();

export const SENTIMENT_ORIGIN = clean(env.VITE_SENTIMENT_API_URL, 'http://localhost:8000');
export const ALERTS_ORIGIN = clean(env.VITE_ALERTS_API_URL, 'http://localhost:8003');
export const REPORTS_ORIGIN = clean(env.VITE_REPORTS_API_URL, 'http://localhost:8004');
export const WHATSAPP_ORIGIN = clean(env.VITE_WHATSAPP_API_URL, 'http://localhost:8005');

export const sentimentApi = createApiClient({
  name: 'sentiment-api',
  baseURL: `${SENTIMENT_ORIGIN}${SENTIMENT_PREFIX}`,
  timeoutMs,
});

export const alertsApi = createApiClient({
  name: 'alerts-api',
  baseURL: ALERTS_ORIGIN,
  timeoutMs,
});

export const reportsApi = createApiClient({
  name: 'reports-api',
  baseURL: REPORTS_ORIGIN,
  // Generar un informe tarda; el sondeo de estado, no. El margen extra evita
  // que la peticion de encolado expire justo cuando el servicio esta ocupado.
  timeoutMs: timeoutMs * 2,
});

export const whatsappApi = createApiClient({
  name: 'whatsapp-bot',
  baseURL: WHATSAPP_ORIGIN,
  timeoutMs,
});

const ALL = [sentimentApi, alertsApi, reportsApi, whatsappApi];

/**
 * Conecta la sesion con la capa de servicios.
 *
 * `getToken` debe devolver el token vigente en el momento de llamarla, no una
 * copia; `refresh` renueva y resuelve a booleano.
 */
export function injectTokenToAllServices(getToken, refresh) {
  for (const client of ALL) {
    client.setTokenGetter(getToken);
    client.setTokenRefresher(refresh);
  }
}

export { ApiError } from './apiClient.js';
export default { sentimentApi, alertsApi, reportsApi, whatsappApi };
