/**
 * Cliente HTTP sobre fetch.
 *
 * Cosas que el cliente del sistema base hacia mal y aqui no:
 *
 *  - El temporizador de expiracion quedaba huerfano cuando el llamador pasaba
 *    su propia AbortSignal: la peticion se cancelaba, pero el setTimeout
 *    seguia vivo y abortaba un controlador ya inservible. Aqui SIEMPRE se
 *    limpia el temporizador y el escucha de la senal externa en el `finally`.
 *  - El token se capturaba al construir el cliente, de modo que tras renovar
 *    la sesion se seguia enviando el viejo. Aqui se pide con un getter
 *    perezoso en cada peticion.
 *  - Reintentaba cualquier fallo, incluidos los POST: un informe se encolaba
 *    tres veces. Aqui solo se reintentan los GET y solo ante 502/503/504.
 */

const DEFAULT_TIMEOUT = Number.parseInt(import.meta.env.VITE_API_TIMEOUT_MS || '20000', 10);
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRY_METHODS = new Set(['GET', 'HEAD']);

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, body = null, url = '', requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.url = url;
    this.requestId = requestId;
  }

  get isAuth() { return this.status === 401 || this.status === 403; }
  get isNotFound() { return this.status === 404; }
  get isValidation() { return this.status === 422 || this.status === 400; }
  get isNetwork() { return this.status === 0; }
}

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Serializa la query saltandose null/undefined y expandiendo arreglos a CSV. */
export function buildQuery(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      usp.append(key, value.join(','));
    } else if (value instanceof Date) {
      usp.append(key, value.toISOString());
    } else {
      usp.append(key, String(value));
    }
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function createApiClient({
  name = 'api',
  baseURL = '',
  timeoutMs = DEFAULT_TIMEOUT,
  maxRetries = 2,
} = {}) {
  const root = String(baseURL || '').replace(/\/+$/, '');

  // Getters perezosos: el proveedor de autenticacion los inyecta cuando la
  // sesion esta lista, y siguen devolviendo el token vigente tras cada
  // renovacion.
  let tokenGetter = null;
  let tokenRefresher = null;

  function setTokenGetter(fn) { tokenGetter = typeof fn === 'function' ? fn : null; }
  function setTokenRefresher(fn) { tokenRefresher = typeof fn === 'function' ? fn : null; }
  function getToken() {
    try { return tokenGetter ? tokenGetter() : null; } catch { return null; }
  }

  function url(path, query) {
    const suffix = String(path || '');
    const joined = suffix.startsWith('http')
      ? suffix
      : `${root}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
    return `${joined}${buildQuery(query)}`;
  }

  async function parseBody(response) {
    if (response.status === 204 || response.status === 205) return null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      try { return await response.json(); } catch { return null; }
    }
    if (type.includes('application/pdf') || type.includes('octet-stream')) {
      return await response.blob();
    }
    const text = await response.text();
    return text || null;
  }

  function describeError(body, status) {
    if (!body) return `Error HTTP ${status}`;
    if (typeof body === 'string') return body.slice(0, 400);
    // sentiment-api: {detail, code}. alerts/reports: {error:{message,code}}.
    return body.detail
      || body.error?.message
      || body.message
      || `Error HTTP ${status}`;
  }

  async function once(path, options, attempt) {
    const {
      method = 'GET',
      query,
      body,
      headers = {},
      signal: externalSignal,
      timeout = timeoutMs,
      accept,
      raw = false,
    } = options;

    const requestId = newRequestId();
    const controller = new AbortController();

    // Expiracion propia + propagacion de la senal externa. Ambas se
    // desmontan en el finally: ni el temporizador ni el escucha sobreviven a
    // la peticion.
    const timer = timeout > 0
      ? setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeout)
      : null;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const finalHeaders = {
      Accept: accept || 'application/json',
      'X-Request-ID': requestId,
      ...headers,
    };
    const token = getToken();
    if (token) finalHeaders.Authorization = `Bearer ${token}`;

    let payload;
    if (body !== undefined && body !== null) {
      if (body instanceof FormData || body instanceof Blob) {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        finalHeaders['Content-Type'] = 'application/json';
      }
    }

    const target = url(path, query);

    try {
      const response = await fetch(target, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: controller.signal,
        credentials: 'omit',
        mode: 'cors',
      });

      if (raw) {
        if (!response.ok) {
          throw new ApiError(describeError(await parseBody(response), response.status), {
            status: response.status, url: target, requestId,
          });
        }
        return response;
      }

      const parsed = await parseBody(response);

      if (!response.ok) {
        throw new ApiError(describeError(parsed, response.status), {
          status: response.status,
          code: (parsed && (parsed.code || parsed.error?.code)) || null,
          body: parsed,
          url: target,
          requestId: response.headers.get('X-Request-ID') || requestId,
        });
      }
      return parsed;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        // Una cancelacion pedida por el llamador no es un error del servicio:
        // se reetiqueta para que los hooks la ignoren al desmontar.
        const aborted = new ApiError(
          externalSignal && externalSignal.aborted
            ? 'Peticion cancelada.'
            : `La peticion excedio ${timeout} ms.`,
          { status: 0, code: externalSignal && externalSignal.aborted ? 'ABORTED' : 'TIMEOUT', url: target, requestId },
        );
        aborted.aborted = true;
        throw aborted;
      }
      throw new ApiError(`No se pudo contactar con ${name}: ${err?.message || 'error de red'}`, {
        status: 0, code: 'NETWORK', url: target, requestId,
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      void attempt;
    }
  }

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      try {
        return await once(path, { ...options, method }, attempt);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        if (!apiError || apiError.aborted) throw err;

        // 401: se intenta renovar UNA vez. Un bucle de renovacion contra un
        // token revocado martillearia al proveedor de identidad.
        if (apiError.status === 401 && !refreshed && tokenRefresher) {
          refreshed = true;
          let ok = false;
          try { ok = await tokenRefresher(); } catch { ok = false; }
          if (ok) continue;
          throw apiError;
        }

        const retryable = RETRY_METHODS.has(method)
          && (RETRYABLE_STATUS.has(apiError.status) || apiError.code === 'NETWORK');
        if (retryable && attempt < maxRetries) {
          // Espera exponencial con ruido: sin el, todas las pestanas abiertas
          // reintentan a la vez y rematan al servicio que se recupera.
          const delay = Math.min(2 ** attempt * 400, 4000) + Math.random() * 250;
          attempt += 1;
          await sleep(delay);
          continue;
        }
        throw apiError;
      }
    }
  }

  return {
    name,
    baseURL: root,
    url,
    request,
    setTokenGetter,
    setTokenRefresher,
    getToken,
    get: (path, query, options) => request(path, { ...options, method: 'GET', query }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),
  };
}

export default createApiClient;
