'use strict';

/**
 * Análisis de Sentimientos · alerts-api (8003)
 *
 * Expone las alertas, sus reglas y sus entregas, y difunde en tiempo real por
 * SSE lo que el planificador va creando.
 *
 * Nota sobre la evaluación: la lógica de las reglas vive en la base
 * (civic.evaluate_alert_rules). Este servicio la invoca; no la reimplementa.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { logger } = require('./logger');
const db = require('./db');
const { requestContext } = require('./middleware/context');
const { notFound, errorHandler } = require('./middleware/errors');
const { authenticate, requireRole } = require('./middleware/auth');
const { asyncHandler } = require('./middleware/validate');
const { sseManager } = require('./sse/manager');
const { scheduler } = require('./engine/scheduler');

const alertsRouter = require('./routes/alerts');
const rulesRouter = require('./routes/rules');
const deliveriesRouter = require('./routes/deliveries');

const PORT = Number.parseInt(process.env.PORT || '8003', 10);
const app = express();

// Detrás de un balanceador; sin esto req.ip y el protocolo son los del proxy.
app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));
app.disable('x-powered-by');
app.disable('etag');

// ── Seguridad de cabeceras ──────────────────────────────────────────────────
// Es una API: no sirve HTML, así que la CSP por defecto de helmet sobra y
// contentSecurityPolicy se desactiva. COEP se desactiva porque interfiere con
// EventSource entre orígenes.
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
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', process.env.REQUEST_ID_HEADER || 'X-Request-Id'],
  exposedHeaders: [process.env.REQUEST_ID_HEADER || 'X-Request-Id'],
  maxAge: 600,
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));
app.use(requestContext());

// ── Sondas públicas ─────────────────────────────────────────────────────────
// /health responde siempre que el proceso viva: es la sonda de liveness y no
// debe depender de la base, o un hipo de PostgreSQL provoca que el orquestador
// reinicie contenedores sanos en cadena.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: process.env.SERVICE_NAME || 'alerts-api',
    version: process.env.SERVICE_VERSION || '1.0.0',
    uptime_sec: Math.round(process.uptime()),
    sse_clients: sseManager.size,
  });
});

// /ready sí comprueba la base: es la sonda de readiness, la que decide si esta
// réplica debe recibir tráfico.
app.get('/ready', asyncHandler(async (req, res) => {
  try {
    const latencyMs = await db.ping();
    res.json({
      status: 'ready',
      database: { reachable: true, latency_ms: latencyMs },
      scheduler: scheduler.status(),
      sse_clients: sseManager.size,
    });
  } catch (err) {
    req.log.error('sonda de readiness fallida', { err });
    res.status(503).json({ status: 'not_ready', database: { reachable: false, error: err.message } });
  }
}));

// ── Rutas ───────────────────────────────────────────────────────────────────
app.use('/alerts', alertsRouter);
app.use('/rules', rulesRouter);
app.use('/deliveries', deliveriesRouter);

// Disparo manual de una corrida. Útil para probar una regla recién creada sin
// esperar al intervalo. dry_run=true no crea alertas.
app.post(
  '/engine/run',
  authenticate(),
  requireRole('alerts:write', 'admin'),
  asyncHandler(async (req, res) => {
    const dryRun = String(req.query.dry_run || 'false').toLowerCase() === 'true';
    req.log.info('corrida del evaluador solicitada manualmente', { dry_run: dryRun, by: req.auth.username });
    const summary = await scheduler.runOnce({ dryRun });
    res.json({ data: summary });
  }),
);

app.get(
  '/engine/status',
  authenticate(),
  requireRole(),
  (req, res) => res.json({ data: scheduler.status() }),
);

app.use(notFound);
app.use(errorHandler());

// ── Arranque ────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info('alerts-api escuchando', {
    port: PORT,
    node_env: process.env.NODE_ENV,
    cors_origins: ALLOWED_ORIGINS,
  });
  scheduler.start();
});

// Los streams SSE son conexiones largas: sin esto, el servidor las cortaría
// por keep-alive inactivo antes que el propio latido.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
// 0 = sin límite de duración de la petición. Un stream SSE dura horas.
server.requestTimeout = 0;

// ── Cierre ordenado ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('cierre ordenado iniciado', { signal });

  scheduler.stop();
  // Avisar a los clientes SSE antes de cerrar el socket: así reconectan contra
  // otra réplica en lugar de esperar a que expire el retry.
  sseManager.closeAll('server_shutdown');

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
