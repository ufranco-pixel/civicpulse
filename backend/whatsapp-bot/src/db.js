'use strict';

/**
 * Acceso a PostgreSQL.
 *
 * Este módulo se duplica en los tres microservicios a propósito. Son
 * despliegues independientes: un paquete compartido obligaría a redesplegar
 * los tres por un cambio que sólo afecta a uno.
 *
 * La pieza importante es withOrgContext(). La base tiene RLS activa y las
 * políticas se apoyan en civic_ops.current_org_id(), que lee un ajuste de
 * sesión fijado con civic_ops.set_session_context(). Ese ajuste se pone con
 * is_local = TRUE, es decir, vive sólo hasta el final de la transacción.
 * Por eso toda consulta con datos de organización DEBE ir dentro de una
 * transacción abierta por este helper: fuera de ella current_org_id() es NULL
 * y las políticas niegan todo.
 */

const { Pool } = require('pg');
const { logger } = require('./logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildPool(connectionString, label) {
  if (!connectionString) return null;
  const pool = new Pool({
    connectionString,
    max: toInt(process.env.DATABASE_POOL_MAX, 10),
    idleTimeoutMillis: toInt(process.env.DATABASE_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: toInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS, 5000),
    // statement_timeout del lado del servidor: una consulta colgada no debe
    // retener una conexión del pool indefinidamente.
    statement_timeout: toInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 15000) || undefined,
    application_name: `${process.env.SERVICE_NAME || 'whatsapp-bot'}:${label}`,
    ssl: String(process.env.DATABASE_SSL).toLowerCase() === 'true'
      ? { rejectUnauthorized: String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || 'true') === 'true' }
      : undefined,
  });

  // Un error en un cliente ocioso no debe tumbar el proceso; el pool lo
  // descarta y abre otro. Sin este manejador, node emite unhandled 'error'.
  pool.on('error', (err) => {
    logger.error('error en cliente ocioso del pool', { pool: label, err });
  });

  return pool;
}

if (!process.env.DATABASE_URL) {
  logger.error('DATABASE_URL no está definida; el servicio no podrá consultar la base');
}

const pool = buildPool(process.env.DATABASE_URL, 'app');

/**
 * Normaliza el segundo argumento de withOrgContext.
 * Acepta una cadena (el sub del token) o {sub, username}.
 */
function normalizeActor(actor) {
  if (!actor) return { sub: null, username: null };
  if (typeof actor === 'string') return { sub: actor, username: actor };
  return { sub: actor.sub || null, username: actor.username || actor.preferred_username || actor.sub || null };
}

/**
 * Ejecuta fn(client) dentro de una transacción con el contexto de RLS fijado.
 *
 * @param {string}   orgId  UUID de organización, tomado SIEMPRE del token, nunca del cuerpo.
 * @param {string|{sub:string,username?:string}} actor
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withOrgContext(orgId, actor, fn) {
  // Falla cerrada: sin organización no hay consulta. Dejarlo pasar dejaría la
  // sesión sin contexto y, según la política, podría devolver filas de nadie
  // o de todos. Ninguna de las dos es aceptable.
  if (!orgId || !UUID_RE.test(String(orgId))) {
    const err = new Error('Contexto de organización ausente o inválido');
    err.status = 403;
    err.code = 'ORG_CONTEXT_MISSING';
    throw err;
  }
  if (!pool) throw new Error('Pool de base de datos no inicializado (falta DATABASE_URL)');

  const { sub, username } = normalizeActor(actor);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT civic_ops.set_session_context($1,$2,$3)', [orgId, sub, username]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Si el ROLLBACK falla la conexión ya está rota; el pool la reemplazará.
      logger.warn('falló el ROLLBACK', { err: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Consulta sin contexto de organización. Sólo para /health, /ready y catálogos públicos. */
async function query(text, params) {
  return pool.query(text, params);
}

/** Comprobación de vida de la base para /ready. */
async function ping(timeoutMs = 2000) {
  const started = Date.now();
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout al consultar la base')), timeoutMs).unref());
  await Promise.race([pool.query('SELECT 1'), timer]);
  return Date.now() - started;
}

async function close() {
  const pools = [pool].filter(Boolean);
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
}

module.exports = { pool, withOrgContext, query, ping, close, UUID_RE };
