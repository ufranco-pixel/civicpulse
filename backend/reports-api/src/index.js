'use strict';

/**
 * Análisis de Sentimientos · reports-api (8002)
 *
 * Genera informes de campaña en PDF. Los datos SIEMPRE se leen de la base con
 * el contexto de RLS de quien pide el informe; el cliente sólo elige campaña,
 * periodo y secciones. Un informe de campaña puede acabar citado en público:
 * no hay ruta por la que un número entre desde el cuerpo de la petición.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { logger } = require('./logger');
const db = require('./db');
const { requestContext } = require('./middleware/context');
const { notFound, errorHandler } = require('./middleware/errors');
const { asyncHandler } = require('./middleware/validate');

const reportsRouter = require('./routes/reports');

const PORT = Number.parseInt(process.env.PORT || '8002', 10);
const app = express();

// Detrás de un balanceador; sin esto req.ip y el protocolo son los del proxy.
app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));
app.disable('x-powered-by');
app.disable('etag');

// ── Seguridad de cabeceras ──────────────────────────────────────────────────
// Es una API: no sirve HTML, así que la CSP por defecto de helmet sobra.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── CORS por lista blanca ───────────────────────────────────────────────────
// Nunca reflejo del Origin recibido: con credenciales, reflejar el origen
// equivale a no tener CORS.
const ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Sin Origin: peticiones servidor a servidor, curl, sondas de salud.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    logger.warn('origen rechazado por CORS', { origin });
    return callback(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', process.env.REQUEST_ID_HEADER || 'X-Request-Id'],
  exposedHeaders: [process.env.REQUEST_ID_HEADER || 'X-Request-Id', 'Content-Disposition'],
  maxAge: 600,
}));

// El cuerpo de /reports/generate es una lista de secciones: no necesita más.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '64kb' }));
app.use(requestContext());

// ── Sondas públicas ─────────────────────────────────────────────────────────
// /health responde mientras el proceso viva: es la sonda de liveness y no debe
// depender de la base ni del disco, o un hipo de PostgreSQL provoca que el
// orquestador reinicie contenedores sanos en cadena.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: process.env.SERVICE_NAME || 'reports-api',
    version: process.env.SERVICE_VERSION || '1.0.0',
    uptime_sec: Math.round(process.uptime()),
    queue: reportsRouter.queueStatus(),
  });
});

// /ready sí comprueba la base: decide si esta réplica recibe tráfico.
app.get('/ready', asyncHandler(async (req, res) => {
  try {
    const latencyMs = await db.ping();
    res.json({
      status: 'ready',
      database: { reachable: true, latency_ms: latencyMs },
      storage: { dir: reportsRouter.STORAGE_DIR, writable: storageWritable },
      queue: reportsRouter.queueStatus(),
    });
  } catch (err) {
    req.log.error('sonda de readiness fallida', { err });
    res.status(503).json({ status: 'not_ready', database: { reachable: false, error: err.message } });
  }
}));

// ── Rutas ───────────────────────────────────────────────────────────────────
app.use('/reports', reportsRouter);

app.use(notFound);
app.use(errorHandler());

// ── Arranque ────────────────────────────────────────────────────────────────
// El directorio de informes se prepara ANTES de escuchar: si el volumen no es
// escribible conviene saberlo ya, no con el primer informe a medio generar.
let storageWritable = false;

const server = app.listen(PORT, () => {
  logger.info('reports-api escuchando', {
    port: PORT,
    node_env: process.env.NODE_ENV,
    cors_origins: ALLOWED_ORIGINS,
    storage_dir: reportsRouter.STORAGE_DIR,
  });
});

reportsRouter.ensureStorageDir()
  .then(() => { storageWritable = true; })
  .catch((err) => {
    // No se aborta el proceso: /health y /ready deben seguir respondiendo para
    // que el operador vea el motivo en lugar de un contenedor en bucle.
    storageWritable = false;
    logger.error('el directorio de informes no es utilizable', { dir: reportsRouter.STORAGE_DIR, err });
  });

// La descarga de un PDF de varios MB puede ser lenta en una red mala.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);

// ── Cierre ordenado ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('cierre ordenado iniciado', { signal, queue: reportsRouter.queueStatus() });

  const forced = setTimeout(() => {
    logger.error('el cierre ordenado excedió el tiempo; se fuerza la salida');
    process.exit(1);
  }, Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '15000', 10));
  forced.unref();

  server.close(async () => {
    await db.close();
    logger.info('cierre ordenado completado');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('promesa rechazada sin manejar', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on('uncaughtException', (err) => {
  // Tras una excepción no capturada el proceso queda en estado desconocido:
  // se registra y se sale para que el orquestador levante uno limpio.
  logger.error('excepción no capturada; el proceso termina', { err });
  shutdown('uncaughtException').finally(() => process.exit(1));
});

module.exports = { app, server };
