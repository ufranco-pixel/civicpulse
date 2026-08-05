'use strict';

/**
 * Cliente de WhatsApp (whatsapp-web.js sobre Chromium headless).
 *
 * Corrección respecto del sistema base: este módulo NO se inicializa al
 * cargarse. Antes, `require` de este archivo arrancaba el navegador y bloqueaba
 * el arranque del servidor HTTP; si WhatsApp no vinculaba —QR caducado, sesión
 * revocada, Chromium sin memoria— el contenedor jamás respondía /health y el
 * orquestador lo mataba en bucle. Aquí `initClient()` se llama a mano DESPUÉS
 * de `app.listen()` y reintenta en segundo plano con espera exponencial.
 *
 * El estado vive en un objeto de módulo, no en la sesión de un usuario: hay una
 * sola sesión de WhatsApp por proceso y /bot/status debe poder describirla
 * aunque nadie haya enviado nada todavía.
 */

const path = require('node:path');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const { logger } = require('../logger');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/lib/civicpulse/wa-session';
const CLIENT_ID = process.env.WA_CLIENT_ID || 'civicpulse';
const PRINT_QR_TERMINAL = String(process.env.WA_PRINT_QR_TERMINAL || 'true').toLowerCase() === 'true';

const MAX_RETRIES = Number.parseInt(process.env.WA_MAX_INIT_RETRIES || '8', 10);
const RETRY_BASE_MS = Number.parseInt(process.env.WA_RETRY_BASE_MS || '5000', 10);
const RETRY_MAX_MS = Number.parseInt(process.env.WA_RETRY_MAX_MS || '300000', 10);

/**
 * Argumentos de Chromium. Cada uno responde a un fallo concreto en contenedor:
 *  --no-sandbox / --disable-setuid-sandbox: sin CAP_SYS_ADMIN no hay sandbox.
 *  --disable-dev-shm-usage: /dev/shm por defecto es de 64 MB y Chromium muere.
 *  --disable-gpu, --no-zygote, --single-process: no hay GPU ni sentido en
 *    mantener varios procesos para una sola pestaña.
 */
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process',
];

/** @type {{status: 'disconnected'|'qr_pending'|'connected'|'error', qrCode: string|null, lastError: string|null, connectedAt: string|null}} */
const state = {
  status: 'disconnected',
  qrCode: null,
  lastError: null,
  connectedAt: null,
  // Metadatos útiles para diagnosticar sin abrir el contenedor.
  attempts: 0,
  lastAttemptAt: null,
  qrGeneratedAt: null,
  pushname: null,
  wid: null,
};

let client = null;
let initializing = false;
let retryTimer = null;
let stopped = false;

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
}

/** Copia del estado. Nunca se devuelve el objeto vivo: nadie debe mutarlo desde una ruta. */
function getState() {
  return {
    status: state.status,
    qrCode: state.qrCode,
    lastError: state.lastError,
    connectedAt: state.connectedAt,
    attempts: state.attempts,
    lastAttemptAt: state.lastAttemptAt,
    qrGeneratedAt: state.qrGeneratedAt,
    pushname: state.pushname,
    wid: state.wid,
    sessionPath: SESSION_PATH,
  };
}

function isConnected() {
  return state.status === 'connected' && client !== null;
}

function buildClient(onMessage) {
  const c = new Client({
    // LocalAuth guarda la sesión en disco: sin volumen persistente hay que
    // escanear el QR en cada despliegue, que es inviable en operación.
    authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS,
      // En Alpine el Chromium del sistema es el único disponible; puppeteer no
      // descarga el suyo (PUPPETEER_SKIP_CHROMIUM_DOWNLOAD en el Dockerfile).
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    },
    takeoverOnConflict: true,
    qrMaxRetries: 0,
  });

  c.on('qr', (qr) => {
    setStatus('qr_pending', { qrGeneratedAt: new Date().toISOString(), lastError: null });
    // El QR se guarda como data URL para que /bot/status lo pueda pintar: pedir
    // al operador que entre por SSH al contenedor a leer la terminal no escala.
    qrcode.toDataURL(qr, { errorCorrectionLevel: 'L', margin: 1 })
      .then((dataUrl) => { state.qrCode = dataUrl; })
      .catch((err) => logger.warn('no se pudo convertir el QR a imagen', { err }));
    if (PRINT_QR_TERMINAL) qrcodeTerminal.generate(qr, { small: true });
    logger.warn('WhatsApp espera vinculación: escanee el QR (GET /bot/status)');
  });

  c.on('authenticated', () => {
    logger.info('sesión de WhatsApp autenticada');
    state.lastError = null;
  });

  c.on('ready', () => {
    setStatus('connected', {
      qrCode: null,
      lastError: null,
      connectedAt: new Date().toISOString(),
      attempts: 0,
      pushname: c.info?.pushname || null,
      wid: c.info?.wid?._serialized || null,
    });
    logger.info('WhatsApp conectado', { pushname: state.pushname, wid: state.wid });
  });

  c.on('auth_failure', (message) => {
    // Credenciales inservibles: reintentar con la misma sesión no arregla nada,
    // hace falta un QR nuevo. Se marca error y se deja que /bot/logout limpie.
    setStatus('error', { qrCode: null, lastError: `Fallo de autenticación: ${message}` });
    logger.error('fallo de autenticación de WhatsApp', { message });
  });

  c.on('disconnected', (reason) => {
    setStatus('disconnected', { qrCode: null, connectedAt: null, lastError: `Desconectado: ${reason}` });
    logger.warn('WhatsApp desconectado', { reason });
    // Reconexión en segundo plano. El servidor HTTP sigue atendiendo mientras.
    scheduleRetry(0, onMessage);
  });

  if (typeof onMessage === 'function') {
    // 'message' (no 'message_create') para no procesar lo que envía el propio
    // bot: con message_create cada respuesta se reprocesaría como comando.
    c.on('message', (msg) => {
      Promise.resolve(onMessage(msg, c)).catch((err) => {
        logger.error('error al procesar mensaje entrante', { err });
      });
    });
  }

  return c;
}

/** Espera exponencial con tope y una pizca de aleatoriedad para no sincronizar réplicas. */
function backoffMs(attempt) {
  const exponential = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

function scheduleRetry(delayMs, onMessage) {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    initClient({ onMessage }).catch(() => {});
  }, delayMs);
  // unref: un reintento pendiente no debe impedir que el proceso termine.
  retryTimer.unref();
}

/**
 * Arranca el cliente en segundo plano.
 *
 * Nunca lanza: un fallo de WhatsApp NO debe tumbar el servicio HTTP. El error
 * queda en `state.lastError` y visible en GET /bot/status.
 *
 * @param {{onMessage?: (msg: object, client: object) => any, force?: boolean}} options
 */
async function initClient(options = {}) {
  const { onMessage, force = false } = options;
  if (initializing) return getState();
  if (client && isConnected() && !force) return getState();

  stopped = false;
  initializing = true;
  state.attempts += 1;
  state.lastAttemptAt = new Date().toISOString();

  try {
    if (client) {
      // Se destruye el anterior antes de crear otro: dos clientes sobre la
      // misma sesión de LocalAuth se pisan el perfil de Chromium.
      await client.destroy().catch(() => {});
      client = null;
    }
    client = buildClient(onMessage);
    logger.info('inicializando cliente de WhatsApp', { attempt: state.attempts, session_path: SESSION_PATH });
    await client.initialize();
    return getState();
  } catch (err) {
    setStatus('error', { lastError: String(err && err.message ? err.message : err) });
    logger.error('no se pudo inicializar WhatsApp', { attempt: state.attempts, err });

    if (state.attempts < MAX_RETRIES) {
      const delay = backoffMs(state.attempts);
      logger.info('se reintentará la conexión con WhatsApp', { in_ms: delay, next_attempt: state.attempts + 1 });
      scheduleRetry(delay, onMessage);
    } else {
      logger.error('agotados los reintentos de conexión con WhatsApp; use POST /bot/reconnect', {
        attempts: state.attempts,
      });
    }
    return getState();
  } finally {
    initializing = false;
  }
}

/** Reintento manual: reinicia el contador para que la espera vuelva a ser corta. */
async function reconnect(onMessage) {
  state.attempts = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  return initClient({ onMessage, force: true });
}

/** Cierra la sesión y borra las credenciales locales: el próximo arranque pedirá QR. */
async function logout() {
  if (!client) {
    setStatus('disconnected', { qrCode: null, connectedAt: null });
    return getState();
  }
  try {
    await client.logout();
  } catch (err) {
    logger.warn('logout de WhatsApp con error; se destruye el cliente igualmente', { err });
  }
  await client.destroy().catch(() => {});
  client = null;
  setStatus('disconnected', { qrCode: null, connectedAt: null, lastError: null, attempts: 0, pushname: null, wid: null });
  logger.info('sesión de WhatsApp cerrada');
  return getState();
}

/** Detiene reintentos y cierra el navegador. Para el apagado ordenado. */
async function destroy() {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (client) {
    await client.destroy().catch(() => {});
    client = null;
  }
  setStatus('disconnected', { qrCode: null, connectedAt: null });
}

/**
 * Envía un mensaje de texto.
 *
 * Falla explícitamente si no hay sesión: devolver "enviado" cuando el cliente
 * está desconectado convierte una alerta perdida en un silencio.
 *
 * @param {string} chatId destino ya normalizado por formatChatId
 * @param {string} text
 */
async function sendMessage(chatId, text) {
  if (!isConnected()) {
    const err = new Error(`WhatsApp no está conectado (estado: ${state.status}).`);
    err.status = 503;
    err.code = 'WA_NOT_CONNECTED';
    err.expose = true;
    throw err;
  }
  const sent = await client.sendMessage(chatId, text);
  return {
    id: sent?.id?._serialized || null,
    timestamp: sent?.timestamp || Math.floor(Date.now() / 1000),
    to: chatId,
  };
}

/** Acceso al cliente crudo para los manejadores. Puede ser null. */
function getClient() {
  return client;
}

module.exports = {
  getState,
  isConnected,
  initClient,
  reconnect,
  logout,
  destroy,
  sendMessage,
  getClient,
  SESSION_PATH: path.resolve(SESSION_PATH),
  PUPPETEER_ARGS,
};
