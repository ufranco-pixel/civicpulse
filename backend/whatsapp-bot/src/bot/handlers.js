'use strict';

/**
 * Comandos que llegan por WhatsApp.
 *
 * Quien escribe al bot NO tiene token: no hay claim del que sacar la
 * organización. Por eso el proceso sirve a una sola organización, fijada en
 * WA_ORGANIZATION_ID, y toda consulta se hace con ese contexto de RLS. La
 * alternativa —resolver la organización a partir del número que escribe—
 * exigiría leer una tabla con RLS sin contexto, es decir, desactivarla.
 *
 * Si la variable no está configurada, los comandos que tocan datos responden
 * que el bot no está enlazado. Falla cerrada y se nota, en lugar de devolver
 * cero filas en silencio.
 */

const db = require('../db');
const { logger } = require('../logger');
const { formatDigest, chatIdToNumber, truncate } = require('../utils/formatters');

const ORG_ID = process.env.WA_ORGANIZATION_ID || '';
const DEFAULT_CAMPAIGN = process.env.WA_DEFAULT_CAMPAIGN_CODE || '';
const DIGEST_DAYS = Number.parseInt(process.env.WA_DIGEST_DAYS || '7', 10);

// Actor con el que quedan firmadas las escrituras hechas desde el chat.
const BOT_ACTOR = { sub: 'whatsapp-bot', username: 'whatsapp-bot' };

const HELP = [
  '🤖 *CivicPulse · bot de WhatsApp*',
  '',
  'Comandos disponibles:',
  '• `!ping` — comprueba que el bot responde.',
  '• `!status` — estado del bot y de la base.',
  '• `!resumen <CODIGO>` — resumen de la campaña indicada.',
  '• `!baja` — deja de recibir alertas en este número.',
  '• `!help` — esta ayuda.',
  '',
  '⚠️ _Los indicadores miden conversación pública digital, no intención de voto._',
].join('\n');

function orgConfigured() {
  return Boolean(ORG_ID);
}

const NOT_LINKED = '⚙️ Este bot no está enlazado a ninguna organización '
  + '(falta WA_ORGANIZATION_ID). Avise al administrador.';

/** Resumen de una campaña: overview + tablero competitivo. */
async function campaignDigest(campaignCode, days = DIGEST_DAYS) {
  return db.withOrgContext(ORG_ID, BOT_ACTOR, async (client) => {
    // La RLS ya limita civic_api.campaigns a la organización del contexto: si
    // el código no es suyo, simplemente no existe para esta consulta.
    const { rows: campaignRows } = await client.query(
      'SELECT code, name FROM civic_api.campaigns WHERE code = $1',
      [campaignCode],
    );
    if (!campaignRows[0]) return null;

    const { rows: overviewRows } = await client.query(
      `SELECT campaign_code, campaign_name, period_start, period_end, days_to_election,
              total_mentions, unique_authors, total_reach,
              positive_pct, neutral_pct, negative_pct, net_sentiment,
              sentiment_momentum, polarization_index, avg_toxicity, avg_confidence,
              open_alerts, critical_alerts, review_backlog,
              sources_healthy, sources_total, is_reliable, last_updated
         FROM civic_kpi.campaign_overview($1, $2)`,
      [campaignCode, days],
    );

    const { rows: scoreboard } = await client.query(
      `SELECT contender_name, is_own, share_of_voice, net_support,
              support_wilson_lb, is_reliable
         FROM civic_kpi.contender_scoreboard($1, $2)
        ORDER BY rank_by_wilson
        LIMIT 5`,
      [campaignCode, days],
    );

    return { overview: overviewRows[0] || null, scoreboard };
  });
}

/** Baja del número que escribe, en todas las campañas de la organización. */
async function optOutByNumber(destination) {
  return db.withOrgContext(ORG_ID, BOT_ACTOR, async (client) => {
    // El trigger civic.enforce_subscription_consent pone is_active = FALSE al
    // ver opted_out_at, así que basta con marcar la fecha.
    const { rows } = await client.query(
      `UPDATE civic.alert_subscriptions
          SET opted_out_at = NOW()
        WHERE channel = 'whatsapp'
          AND regexp_replace(destination, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
          AND opted_out_at IS NULL
        RETURNING id, campaign_code`,
      [destination],
    );
    return rows;
  });
}

async function handlePing() {
  return `🏓 pong · ${new Date().toISOString()}`;
}

async function handleStatus(botState) {
  const lines = ['🤖 *Estado del bot*', ''];
  lines.push(`• WhatsApp: ${botState.status}`);
  if (botState.connectedAt) lines.push(`• Conectado desde: ${botState.connectedAt}`);
  if (botState.lastError) lines.push(`• Último error: ${botState.lastError}`);
  lines.push(`• Organización enlazada: ${orgConfigured() ? 'sí' : 'no'}`);

  try {
    const latency = await db.ping();
    lines.push(`• Base de datos: accesible (${latency} ms)`);
  } catch (err) {
    lines.push(`• Base de datos: inaccesible (${err.message})`);
  }
  lines.push(`• Tiempo en marcha: ${Math.round(process.uptime())} s`);
  return lines.join('\n');
}

async function handleResumen(args) {
  if (!orgConfigured()) return NOT_LINKED;

  const code = (args[0] || DEFAULT_CAMPAIGN || '').trim();
  if (!code) return 'Indique el código de campaña: `!resumen CODIGO`';
  // El código es un identificador público corto; cualquier otra cosa es ruido
  // y no vale la pena llevarla a la base.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    return `El código «${truncate(code, 40)}» no tiene forma de código de campaña.`;
  }

  const result = await campaignDigest(code);
  if (!result) return `No encuentro la campaña «${code}» en esta organización.`;
  return formatDigest(result.overview, result.scoreboard);
}

async function handleBaja(msg) {
  if (!orgConfigured()) return NOT_LINKED;

  const number = chatIdToNumber(msg.from);
  const rows = await optOutByNumber(number);
  if (!rows.length) {
    return 'No encontré suscripciones activas para este número. '
      + 'Si sigue recibiendo mensajes, avise al administrador de la campaña.';
  }
  const campaigns = [...new Set(rows.map((r) => r.campaign_code))].join(', ');
  return `✅ Listo. Este número ya no recibirá alertas de: ${campaigns}.\n\n`
    + '_Para volver a darse de alta hace falta un consentimiento nuevo._';
}

/**
 * Punto de entrada de los mensajes entrantes.
 *
 * @param {object} msg mensaje de whatsapp-web.js
 * @param {object} waClient cliente (no se usa: la respuesta va por msg.reply)
 * @param {{getState: () => object}} bot módulo del cliente, para !status
 */
async function handleMessage(msg, waClient, bot) {
  const body = String(msg.body || '').trim();
  // Sólo se atienden comandos. Contestar a todo convierte al bot en un eco en
  // cualquier grupo donde lo metan.
  if (!body.startsWith('!')) return null;

  const [rawCommand, ...args] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const log = logger.child({ chat: chatIdToNumber(msg.from), command });

  let reply;
  try {
    switch (command) {
      case '!ping':
        reply = await handlePing();
        break;
      case '!status':
        reply = await handleStatus(bot ? bot.getState() : { status: 'desconocido' });
        break;
      case '!help':
      case '!ayuda':
        reply = HELP;
        break;
      case '!resumen':
        reply = await handleResumen(args);
        break;
      case '!baja':
        reply = await handleBaja(msg);
        break;
      default:
        // Comando desconocido: se responde la ayuda, no un error. Quien
        // escribe desde un teléfono no va a leer un código de estado.
        reply = `No conozco el comando «${truncate(command, 40)}».\n\n${HELP}`;
    }
  } catch (err) {
    log.error('fallo al atender un comando', { err });
    // Nada del interior sale al chat: los mensajes de PostgreSQL llevan
    // nombres de tablas y a veces fragmentos de la consulta.
    reply = '⚠️ No pude atender la solicitud. El error quedó registrado.';
  }

  if (reply) {
    await msg.reply(truncate(reply));
    log.info('comando atendido');
  }
  return reply;
}

module.exports = {
  handleMessage,
  campaignDigest,
  optOutByNumber,
  HELP,
  ORG_ID,
  BOT_ACTOR,
  orgConfigured,
};
