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

/** Versión instalada de whatsapp-web.js, para poder verla en el log. */
const WWEBJS_VERSION = (() => {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require('whatsapp-web.js/package.json').version;
  } catch {
    return 'desconocida';
  }
})();

// El valor por defecto coincide con el WA_SESSION_PATH del Dockerfile y con
// la ruta que monta docker-compose. Cuando divergían, la carpeta preparada
// con dueño `node` no era la que se usaba y el arranque moría con EACCES.
const SESSION_PATH = process.env.WA_SESSION_PATH || '/app/wa-session';
const CLIENT_ID = process.env.WA_CLIENT_ID || 'oeste-sentimientos';
const PRINT_QR_TERMINAL = String(process.env.WA_PRINT_QR_TERMINAL || 'true').toLowerCase() === 'true';

const MAX_RETRIES = Number.parseInt(process.env.WA_MAX_INIT_RETRIES || '8', 10);
const RETRY_BASE_MS = Number.parseInt(process.env.WA_RETRY_BASE_MS || '5000', 10);
const RETRY_MAX_MS = Number.parseInt(process.env.WA_RETRY_MAX_MS || '300000', 10);

/**
 * Argumentos de Chromium.
 *
 * SIN `--single-process` ni `--no-zygote`, y esto es lo importante.
 *
 * Estaban puestos con el razonamiento de que «para una sola pestaña no hace
 * falta más de un proceso». Es falso para WhatsApp Web: con un único proceso,
 * el hilo del renderizador comparte destino con el del navegador, y la carga
 * de sincronizar los chats lo tumba. El síntoma exacto era
 * «Protocol error (Network.setUserAgentOverride): Session closed» en el
 * arranque, y —peor— un cliente que autenticaba y luego moría en silencio sin
 * llegar nunca a 'ready', dejando el canal colgado sin ningún error.
 *
 * El resto sí responde a un problema real en contenedor:
 *  --no-sandbox / --disable-setuid-sandbox: sin CAP_SYS_ADMIN no hay sandbox.
 *  --disable-dev-shm-usage: /dev/shm por defecto es de 64 MB y Chromium muere.
 *  --disable-gpu: no hay GPU.
 *  Los cuatro de *backgrounding*: sin ventana visible, Chromium considera la
 *    pestaña oculta y estrangula sus temporizadores; la sesión de WhatsApp
 *    deja de latir y el servidor la da por caída al cabo de un rato.
 */
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IsolateOrigins,site-per-process',
];

/**
 * Margen entre 'authenticated' y 'ready'.
 *
 * WhatsApp Web sincroniza los chats entre ambos eventos y eso puede tardar
 * minutos en una cuenta con historial. Pero si el renderizador muere durante
 * la sincronización no se emite ningún evento: el cliente se queda a medias
 * para siempre. Este vigilante convierte ese cuelgue silencioso en un error
 * visible y un reintento.
 */
const READY_TIMEOUT_MS = Number.parseInt(process.env.WA_READY_TIMEOUT_MS || '240000', 10);

/**
 * `authenticating` es el hueco entre 'authenticated' y 'ready': la sesión es
 * válida pero WhatsApp aún sincroniza los chats y NO se puede enviar todavía.
 * Antes no existía y ese rato se veía como el estado anterior, que podía ser
 * 'error' de un intento fallido previo.
 * @type {{status: 'disconnected'|'qr_pending'|'authenticating'|'connected'|'error', qrCode: string|null, lastError: string|null, connectedAt: string|null}}
 */
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

let readyTimer = null;

/** Arranca la cuenta atrás entre 'authenticated' y 'ready'. */
function armarVigilanteReady(onMessage) {
  cancelarVigilanteReady();
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (state.status === 'connected' || stopped) return;
    setStatus('error', {
      lastError:
        `Autenticó pero no llegó a 'ready' en ${Math.round(READY_TIMEOUT_MS / 1000)} s. `
        + 'Lo habitual es que el navegador muriera durante la sincronización.',
    });
    logger.error('WhatsApp autenticó pero nunca quedó listo; se reintenta', {
      timeout_ms: READY_TIMEOUT_MS,
    });
    scheduleRetry(0, onMessage);
  }, READY_TIMEOUT_MS);
  if (readyTimer.unref) readyTimer.unref();
}

function cancelarVigilanteReady() {
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
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
    // Agente de usuario de un Chrome de escritorio.
    //
    // Con el que anuncia Chromium headless, WhatsApp Web sirve una variante
    // distinta de la aplicación y los selectores que inyecta la librería no
    // encuentran lo que buscan: autentica y nunca emite 'ready'.
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

    // SIN caché de versión de WhatsApp Web.
    //
    // Por omisión la librería fija una versión concreta descargada de un
    // repositorio remoto. Si esa versión ya no es compatible con lo que sirve
    // WhatsApp, el cliente se queda a medias sin ningún error. Con 'none' usa
    // la que WhatsApp entregue en ese momento, que es lo que hace funcionar el
    // servicio de ziba.
    webVersionCache: { type: 'none' },

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
    // El estado TIENE que cambiar aquí. Antes solo se registraba en el log, y
    // si un intento anterior había dejado el estado en 'error', ahí se quedaba
    // aunque el cliente estuviera autenticando correctamente. El despachador
    // leía «estado: error» y rechazaba los envíos sin más explicación.
    setStatus('authenticating', { qrCode: null, lastError: null });
    logger.info('sesión de WhatsApp autenticada; sincronizando chats');
    armarVigilanteReady(onMessage);
  });

  c.on('ready', () => {
    cancelarVigilanteReady();
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
    cancelarVigilanteReady();
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
    // La versión de la librería en el log no es adorno: una versión vieja
    // autentica y se queda esperando 'ready' para siempre, porque los
    // selectores que inyecta ya no coinciden con lo que sirve WhatsApp Web.
    // Verlo aquí evita depurar durante una hora una imagen que no se
    // reconstruyó.
    logger.info('inicializando cliente de WhatsApp', {
      attempt: state.attempts,
      session_path: SESSION_PATH,
      wwebjs: WWEBJS_VERSION,
    });
    await client.initialize();
    return getState();
  } catch (err) {
    cancelarVigilanteReady();
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
  cancelarVigilanteReady();
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
