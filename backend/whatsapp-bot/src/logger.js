'use strict';

/**
 * Logging estructurado en JSON, una línea por evento.
 *
 * Se escribe a stdout/stderr y nada más: en contenedores el recolector de logs
 * es quien decide destino y retención. Escribir a archivo desde el proceso
 * obliga a montar volúmenes y a rotar a mano.
 *
 * Cada línea lleva request_id cuando existe, que es lo único que permite
 * reconstruir una petición que atravesó tres servicios.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SERVICE = process.env.SERVICE_NAME || 'whatsapp-bot';
const MIN_LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// Claves que nunca deben quedar escritas en un log. La lista es corta a
// propósito: si crece demasiado es señal de que se está logueando de más.
const REDACTED_KEYS = new Set([
  'authorization', 'token', 'access_token', 'id_token', 'refresh_token',
  'password', 'secret', 'cookie', 'set-cookie', 'apikey', 'api_key',
]);

function serializeError(err) {
  return {
    name: err.name,
    message: err.message,
    // El código de PostgreSQL (p. ej. 23514) es lo que permite distinguir una
    // violación de restricción de un fallo de red sin parsear el mensaje.
    code: err.code,
    constraint: err.constraint,
    detail: err.detail,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  };
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return serializeError(value);
  if (depth > 4) return '[profundidad máxima]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redactado]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, message, meta, bindings) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    message,
    ...bindings,
    ...sanitize(meta || {}),
  };
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    // Referencias circulares: mejor una línea degradada que perder el evento.
    line = JSON.stringify({ ts: record.ts, level, service: SERVICE, message, log_error: 'no serializable' });
  }
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function build(bindings) {
  return {
    debug: (message, meta) => emit('debug', message, meta, bindings),
    info: (message, meta) => emit('info', message, meta, bindings),
    warn: (message, meta) => emit('warn', message, meta, bindings),
    error: (message, meta) => emit('error', message, meta, bindings),
    /** Deriva un logger que arrastra contexto fijo (request_id, campaign_code...). */
    child: (extra) => build({ ...bindings, ...extra }),
  };
}

const logger = build({});

module.exports = { logger };
