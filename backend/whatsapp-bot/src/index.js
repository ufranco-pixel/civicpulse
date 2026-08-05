'use strict';

/**
 * CivicPulse · whatsapp-bot (8001)
 *
 * Canal de WhatsApp: alertas, resúmenes y comandos desde el chat.
 *
 * ARRANQUE NO BLOQUEANTE. El servidor HTTP escucha PRIMERO y la sesión de
 * WhatsApp se inicializa después, en segundo plano y con reintentos. En la
 * versión anterior la inicialización ocurría al cargar el módulo del cliente:
 * si Chromium no levantaba o el QR caducaba, el proceso nunca llegaba a
 * escuchar, /health no respondía y el orquestador reiniciaba el contenedor en
 * bucle sin que nadie pudiera ver el motivo. Aquí un WhatsApp caído es un
 * estado consultable en GET /bot/status, no una caída del servicio.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { logger } = require('./logger');
const db = require('./db');
const bot = require('./bot/client');
const templatesStore = require('./store/templates');
const { requestContext } = require('./middleware/context');
const { notFound, errorHandler } = require('./middleware/errors');
const { asyncHandler } = require('./middleware/validate');

const botRouter = require('./routes/bot');
const messagesRouter = require('./routes/messages');
const templatesRouter = require('./routes/templates');
const subscriptionsRouter = require('./routes/subscriptions');

const PORT = Number.parseInt(process.env.PORT || '8001', 10);
const app = express();

// Detrás de un balanceador; sin esto req.ip y el protocolo son los del proxy.
app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));
app.disable('x-powered-by');
app.disable('etag');

// ── Seguridad de cabeceras ──────────────────────────────────────────────────
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
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', process.env.REQUEST_ID_HEADER || 'X-Request-Id'],
  exposedHeaders: [process.env.REQUEST_ID_HEADER || 'X-Request-Id'],
  maxAge: 600,
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '128kb' }));
app.use(requestContext());

// ── Sondas públicas ─────────────────────────────────────────────────────────
// /health NO lleva autenticación y NO depende de WhatsApp ni de la base: es la
// sonda de vivacidad. Si respondiera 503 porque el teléfono se desvinculó, el
// orquestador reiniciaría el contenedor una y otra vez, borrando de paso la
// única forma de ver el QR nuevo.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: process.env.SERVICE_NAME || 'whatsapp-bot',
    version: process.env.SERVICE_VERSION || '1.0.0',
    uptime_sec: Math.round(process.uptime()),
    // Informativo, nunca condiciona el código de estado.
    whatsapp: bot.getState().status,
  });
});

// /ready sí comprueba la base: decide si esta réplica recibe tráfico. WhatsApp
// tampoco entra aquí; los endpoints de lectura y de administración funcionan
// sin sesión vinculada.
app.get('/ready', asyncHandler(async (req, res) => {
  try {
    const latencyMs = await db.ping();
    res.json({
      status: 'ready',
      database: { reachable: true, latency_ms: latencyMs },
      whatsapp: bot.getState(),
    });
  } catch (err) {
    req.log.error('sonda de readiness fallida', { err });
    res.status(503).json({ status: 'not_ready', database: { reachable: false, error: err.message } });
  }
}));

// ── Rutas (todas autenticadas en su propio router) ──────────────────────────
app.use('/bot', botRouter);
app.use('/messages', messagesRouter);
app.use('/templates', templatesRouter);
app.use('/subscriptions', subscriptionsRouter);

app.use(notFound);
app.use(errorHandler());

// ── Arranque ────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info('whatsapp-bot escuchando', {
    port: PORT,
    node_env: process.env.NODE_ENV,
    cors_origins: ALLOWED_ORIGINS,
    organization_bound: Boolean(process.env.WA_ORGANIZATION_ID),
  });

  // A PARTIR DE AQUÍ, y no antes. Nada de esto puede impedir que el servidor
  // atienda: los fallos se registran y quedan visibles en las sondas.
  templatesStore.ensureTable().catch((err) => {
    logger.error('no se pudo preparar civic.message_templates', { err });
  });

  if (String(process.env.WA_AUTOSTART || 'true').toLowerCase() === 'true') {
    bot.initClient({ onMessage: botRouter.onMessage }).catch((err) => {
      // initClient ya no lanza, pero si un día lo hiciera no debe tumbar nada.
      logger.error('fallo inesperado al inicializar WhatsApp', { err });
    });
  } else {
    logger.warn('WA_AUTOSTART=false: la sesión se inicia con POST /bot/reconnect');
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

// ── Cierre ordenado ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('cierre ordenado iniciado', { signal });

  const forced = setTimeout(() => {
    logger.error('el cierre ordenado excedió el tiempo; se fuerza la salida');
    process.exit(1);
  }, Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '20000', 10));
  forced.unref();

  server.close(async () => {
    // Chromium se cierra explícitamente: un navegador huérfano deja bloqueado
    // el perfil de LocalAuth y el siguiente arranque no puede usar la sesión.
    await bot.destroy();
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
  logger.error('excepción no capturada; el proceso termina', { err });
  shutdown('uncaughtException').finally(() => process.exit(1));
});

module.exports = { app, server };
