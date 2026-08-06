'use strict';

/**
 * Despachador de entregas de WhatsApp.
 *
 * Cierra el hueco que tenía el sistema: las alertas creaban filas en
 * `civic.alert_deliveries` con estado 'pending' y ahí se quedaban, porque no
 * había nada que las enviara.
 *
 *   civic.alerts
 *        │  (disparador tg_alerts_fanout)
 *        ▼
 *   civic.alert_deliveries  status='pending'
 *        │  claim_whatsapp_deliveries  → 'sending'
 *        ▼
 *   adaptador (wwebjs · meta_cloud · twilio · mock)
 *        │
 *        ├── éxito ──────────► mark_delivery_sent      → 'sent'
 *        └── fallo ──┬─ transitorio ─► 'pending' con espera creciente
 *                    └─ permanente ──► 'failed'
 *
 * El reclamo y el cierre viven en funciones de la base, no aquí. Dos razones:
 * el `FOR UPDATE SKIP LOCKED` permite levantar varias réplicas del bot sin que
 * dos manden el mismo mensaje, y el criterio de reintento queda en un solo
 * sitio aunque haya varios despachadores con configuraciones distintas.
 */

const db = require('../db');
const { logger } = require('../logger');
const { resolveAdapter, WhatsAppSendError } = require('./adapters');
const { formatAlert } = require('../utils/formatters');

const CFG = {
  enabled: String(process.env.WA_DISPATCH_ENABLED || 'true').toLowerCase() === 'true',
  intervalMs: Number.parseInt(process.env.WA_DISPATCH_INTERVAL_MS || '10000', 10),
  batchSize: Number.parseInt(process.env.WA_DISPATCH_BATCH || '10', 10),
  maxAttempts: Number.parseInt(process.env.WA_MAX_ATTEMPTS || '5', 10),
  retryBaseMin: Number.parseInt(process.env.WA_RETRY_BASE_MINUTES || '1', 10),
  stuckMinutes: Number.parseInt(process.env.WA_STUCK_MINUTES || '5', 10),
};

const estado = {
  running: false,
  lastRunAt: null,
  lastError: null,
  sent: 0,
  failed: 0,
  cycles: 0,
};

let timer = null;
let enCurso = false;

/**
 * Texto del mensaje.
 *
 * Reutiliza `formatAlert`, que ya incluye la advertencia metodológica. Esa
 * advertencia no es adorno: un mensaje que dice «el sentimiento cayó 12 %» sin
 * decir que mide conversación digital y no intención de voto se reenvía por
 * ahí como si fuera una encuesta.
 */
function construirTexto(fila) {
  try {
    return formatAlert({
      title: fila.title,
      message: fila.message,
      severity_code: fila.severity,
      severity_label: fila.severity_label,
      alert_type_code: fila.alert_type,
      alert_type_label: fila.alert_type_label,
      campaign_code: fila.campaign_code,
      observed_value: fila.observed,
      threshold_value: fila.threshold,
      sample_size: fila.sample_size,
      created_at: fila.created_at,
    });
  } catch (err) {
    // Si el formateador cambia de contrato, mejor un mensaje pobre que
    // ninguna alerta: el aviso llega igual y el fallo se ve en el log.
    logger.warn('formatAlert falló, se usa texto plano', { error: err.message });
    return `${fila.title}\n\n${fila.message}`;
  }
}

async function procesar(fila) {
  // resolveAdapter() y el formateo van DENTRO del try.
  //
  // Estaban fuera, y con un WA_PROVIDER mal escrito la excepción subía hasta
  // el ciclo con la entrega ya marcada 'sending': se quedaba encallada hasta
  // que el reaper la liberaba cinco minutos después, para volver a encallarse
  // en el ciclo siguiente. Una errata en el .env paralizaba la cola en
  // silencio. Ahora se registra como fallo permanente de esa entrega, con el
  // motivo escrito en error_message.
  let adaptador = { name: 'sin-resolver' };
  try {
    adaptador = resolveAdapter();
    const texto = construirTexto(fila);
    const r = await adaptador.send({ to: fila.recipient, body: texto });
    await db.query('SELECT civic.mark_delivery_sent($1, $2)', [fila.delivery_id, r.messageId]);
    estado.sent += 1;
    logger.info('entrega enviada', {
      delivery_id: fila.delivery_id,
      proveedor: adaptador.name,
      provider_ref: r.messageId,
      campaign: fila.campaign_code,
    });
  } catch (err) {
    const esNuestro = err instanceof WhatsAppSendError;
    // Un error inesperado (un fallo de programación, por ejemplo) se trata
    // como transitorio: si es un error nuestro, descartar la alerta sería lo
    // peor que podríamos hacer con ella.
    const permanente = esNuestro ? !err.retryable : false;

    const { rows } = await db.query(
      'SELECT civic.mark_delivery_failed($1, $2, $3, $4) AS estado',
      [fila.delivery_id, err.message, permanente, CFG.maxAttempts],
    );
    const nuevoEstado = rows[0]?.estado;
    if (nuevoEstado === 'failed') estado.failed += 1;

    logger[nuevoEstado === 'failed' ? 'error' : 'warn']('entrega fallida', {
      delivery_id: fila.delivery_id,
      proveedor: adaptador.name,
      intento: fila.attempt + 1,
      permanente,
      nuevo_estado: nuevoEstado,
      error: err.message,
    });
  }
}

async function ciclo() {
  // Sin este guardián, un lote que tarda más que el intervalo se solapa con el
  // siguiente y ambos compiten por las mismas filas.
  if (enCurso) return;
  enCurso = true;
  estado.cycles += 1;
  estado.lastRunAt = new Date().toISOString();

  try {
    const rescatadas = await db.query('SELECT civic.reap_stuck_deliveries($1) AS n', [CFG.stuckMinutes]);
    const n = rescatadas.rows[0]?.n || 0;
    if (n > 0) logger.warn('entregas rescatadas de un despachador caído', { n });

    const { rows } = await db.query(
      'SELECT * FROM civic.claim_whatsapp_deliveries($1, $2, $3)',
      [CFG.batchSize, CFG.retryBaseMin, CFG.maxAttempts],
    );
    if (rows.length === 0) { estado.lastError = null; return; }

    logger.info('lote reclamado', { entregas: rows.length });
    // En serie y no en paralelo: whatsapp-web.js maneja un solo navegador, y
    // varios envíos simultáneos sobre la misma sesión se pisan.
    for (const fila of rows) {
      await procesar(fila);
    }
    estado.lastError = null;
  } catch (err) {
    estado.lastError = err.message;
    logger.error('el ciclo del despachador falló', { error: err.message });
  } finally {
    enCurso = false;
  }
}

function start() {
  if (!CFG.enabled) {
    logger.warn('despachador de WhatsApp desactivado (WA_DISPATCH_ENABLED=false)');
    return;
  }
  if (timer) return;
  estado.running = true;

  const proveedor = process.env.WA_OVERRIDE_PROVIDER || process.env.WA_PROVIDER || 'mock';
  logger.info('despachador de WhatsApp en marcha', {
    intervalo_ms: CFG.intervalMs,
    lote: CFG.batchSize,
    proveedor,
  });

  // Aviso a nivel warn, no info: con `mock` las entregas pasan a 'sent' con un
  // provider_ref que empieza por «mock-», así que desde la base y desde el
  // tablero parece que todo salió bien. La única señal es una línea de log
  // entre otras muchas. Que sea un aviso al arrancar evita descubrirlo cuando
  // alguien pregunta por qué no le llegó el WhatsApp.
  if (proveedor === 'mock') {
    logger.warn(
      'MODO SIMULADO: no se envía ningún WhatsApp real. Las entregas se marcarán '
      + 'como enviadas con un identificador falso. Para enviar de verdad ponga '
      + 'WA_PROVIDER=wwebjs (y deje WA_OVERRIDE_PROVIDER vacío) y reinicie el servicio.',
      { proveedor, override: process.env.WA_OVERRIDE_PROVIDER || null },
    );
  }
  // unref() para que este temporizador no impida que el proceso termine
  // cuando llegue la señal de apagado.
  timer = setInterval(() => { void ciclo(); }, CFG.intervalMs);
  if (timer.unref) timer.unref();
  void ciclo();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  estado.running = false;
}

function getStatus() {
  return { ...estado, config: CFG, provider: process.env.WA_OVERRIDE_PROVIDER || process.env.WA_PROVIDER || 'mock' };
}

module.exports = { start, stop, getStatus, ciclo };
