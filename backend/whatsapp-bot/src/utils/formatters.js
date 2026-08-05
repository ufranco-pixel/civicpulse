'use strict';

/**
 * Formateo de mensajes de WhatsApp.
 *
 * Regla que no se negocia: ningún mensaje sale con un número desnudo. Todo
 * indicador viaja con su tamaño de muestra y con la advertencia metodológica
 * que la base publica en civic_kpi.metric_registry y que civic_api.alerts
 * expone como `metric_caveat`. Un "net_sentiment -12" sobre 8 comentarios y
 * uno sobre 8 000 se leen igual en un teléfono si sólo se manda el valor.
 */

// Tope real de un mensaje de WhatsApp. Se recorta antes de enviar: un mensaje
// rechazado por longitud se pierde entero, y una alerta perdida no se nota.
const MAX_MESSAGE_LENGTH = 4000;

const SEVERITY_EMOJI = {
  info: 'ℹ️',
  low: '🔵',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
};

// Advertencia global del sistema. Va en todo resumen: quien lee un porcentaje
// en el teléfono no tiene delante la nota metodológica del tablero.
const METHODOLOGY_NOTE =
  'Mide conversación pública digital, no intención de voto. '
  + 'Quien publica no es una muestra representativa del electorado.';

/**
 * Normaliza un destino a chatId de WhatsApp.
 *
 * Acepta un valor ya formateado (52551234567@c.us, o un @g.us de grupo) y lo
 * devuelve tal cual; en otro caso se queda con los dígitos. El '+' y los
 * espacios de un número copiado de una agenda son la causa más común de un
 * envío que "no falla" pero no llega a nadie.
 *
 * @param {string} numero
 * @returns {string} chatId listo para client.sendMessage
 */
function formatChatId(numero) {
  const raw = String(numero || '').trim();
  if (!raw) throw new Error('El destino está vacío.');

  if (raw.includes('@')) {
    const [id, domain] = raw.split('@');
    if (!/^[0-9-]+$/.test(id) || !['c.us', 'g.us', 's.whatsapp.net'].includes(domain)) {
      throw new Error(`Destino con formato de chatId no reconocido: ${raw}`);
    }
    return raw;
  }

  const digits = raw.replace(/\D/g, '');
  // 8 dígitos es un número local corto; 15 es el máximo de E.164. Fuera de ese
  // rango casi siempre es un dato mal capturado, no un número exótico.
  if (digits.length < 8 || digits.length > 15) {
    throw new Error(`Número no válido (${digits.length} dígitos): se espera formato internacional sin '+', p. ej. 5215512345678.`);
  }
  return `${digits}@c.us`;
}

/** Deshace el formateo para mostrar el destino en logs y respuestas. */
function chatIdToNumber(chatId) {
  return String(chatId || '').split('@')[0];
}

function truncate(text, max = MAX_MESSAGE_LENGTH) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 20)}\n…(mensaje recortado)`;
}

function num(value, decimals = 1) {
  if (value === null || value === undefined || value === '') return 's/d';
  const n = Number(value);
  if (!Number.isFinite(n)) return 's/d';
  return n.toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function int(value) {
  if (value === null || value === undefined || value === '') return 's/d';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('es-MX') : 's/d';
}

function pct(value, decimals = 1) {
  const formatted = num(value, decimals);
  return formatted === 's/d' ? formatted : `${formatted} %`;
}

/** Valor con su unidad, tal como la declara el registro de indicadores. */
function withUnit(value, unit) {
  const formatted = num(value, 2);
  if (formatted === 's/d') return formatted;
  if (!unit || unit === 'count') return int(value);
  if (unit === 'percent' || unit === 'pct') return `${formatted} %`;
  return `${formatted} ${unit}`;
}

function fmtDateTime(value) {
  if (!value) return 's/d';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? 's/d' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Mensaje de una alerta de civic_api.alerts.
 *
 * @param {object} alert fila de civic_api.alerts (incluye metric_caveat)
 * @returns {string}
 */
function formatAlert(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity_code] || '⚪';
  const lines = [];

  lines.push(`${emoji} *${(alert.severity_label || alert.severity_code || 'Alerta').toUpperCase()}* · ${alert.alert_type_label || alert.alert_type_code || ''}`.trim());
  lines.push(`*${alert.title || 'Alerta CivicPulse'}*`);
  lines.push('');
  if (alert.message) lines.push(alert.message);

  const facts = [];
  if (alert.campaign_code) facts.push(`Campaña: ${alert.campaign_code}`);
  if (alert.contender_name) facts.push(`Contendiente: ${alert.contender_name}`);
  if (alert.source_name) facts.push(`Fuente: ${alert.source_name}`);
  if (alert.topic_category) facts.push(`Tema: ${alert.topic_category}`);
  if (alert.metric) {
    const label = alert.metric_label || alert.metric;
    facts.push(`${label}: ${withUnit(alert.observed_value, alert.metric_unit)} (umbral ${withUnit(alert.threshold_value, alert.metric_unit)})`);
  }
  // El tamaño de muestra no es un adorno: es lo que distingue una señal de un
  // ruido de tres publicaciones.
  if (alert.sample_size !== null && alert.sample_size !== undefined) {
    facts.push(`Muestra: ${int(alert.sample_size)} contenidos`);
  }
  if (alert.window_start && alert.window_end) {
    facts.push(`Ventana: ${fmtDateTime(alert.window_start)} → ${fmtDateTime(alert.window_end)}`);
  }
  if (facts.length) {
    lines.push('');
    lines.push(facts.map((f) => `• ${f}`).join('\n'));
  }

  if (alert.during_blackout) {
    lines.push('');
    lines.push('🚫 _Generada durante la veda electoral._');
  }

  // Obligatorio. Si el indicador no trae caveat propio, va al menos la nota
  // general del sistema: ninguna plantilla sale sin advertencia.
  lines.push('');
  lines.push(`⚠️ _${alert.metric_caveat || METHODOLOGY_NOTE}_`);

  return truncate(lines.join('\n'));
}

/**
 * Resumen diario de una campaña.
 *
 * @param {object} overview fila de civic_kpi.campaign_overview
 * @param {object[]} scoreboard filas de civic_kpi.contender_scoreboard
 */
function formatDigest(overview, scoreboard) {
  if (!overview) {
    return '📊 *CivicPulse*\n\nNo hay datos para el periodo solicitado. '
      + 'El resumen se emite vacío a propósito: no se sustituyen datos ausentes por estimaciones.';
  }

  const lines = [];
  lines.push(`📊 *${overview.campaign_name || overview.campaign_code}*`);
  lines.push(`_Periodo: ${overview.period_start || 's/d'} → ${overview.period_end || 's/d'}_`);
  if (overview.days_to_election !== null && overview.days_to_election !== undefined) {
    lines.push(`_Faltan ${int(overview.days_to_election)} días para la elección._`);
  }
  lines.push('');

  lines.push('*Volumen*');
  lines.push(`• Menciones: ${int(overview.total_mentions)}`);
  lines.push(`• Autores únicos: ${int(overview.unique_authors)}`);
  lines.push(`• Alcance estimado: ${int(overview.total_reach)}`);
  lines.push('');

  lines.push('*Sentimiento*');
  lines.push(`• Positivo ${pct(overview.positive_pct)} · Neutro ${pct(overview.neutral_pct)} · Negativo ${pct(overview.negative_pct)}`);
  lines.push(`• Neto: ${num(overview.net_sentiment)} (momentum ${num(overview.sentiment_momentum)})`);
  lines.push(`• Polarización: ${num(overview.polarization_index)} · Toxicidad media: ${num(overview.avg_toxicity, 2)}`);
  lines.push('');

  if (Array.isArray(scoreboard) && scoreboard.length) {
    lines.push('*Contendientes* (por cota inferior de Wilson)');
    for (const c of scoreboard.slice(0, 5)) {
      const mark = c.is_own ? '⭐ ' : '';
      const unreliable = c.is_reliable === false ? ' ⚠️ muestra insuficiente' : '';
      lines.push(`${mark}${c.contender_name}: SOV ${pct(c.share_of_voice)}, apoyo neto ${num(c.net_support)}${unreliable}`);
    }
    lines.push('');
  }

  const pendientes = [];
  if (Number(overview.open_alerts || 0) > 0) pendientes.push(`${int(overview.open_alerts)} alertas abiertas`);
  if (Number(overview.critical_alerts || 0) > 0) pendientes.push(`${int(overview.critical_alerts)} críticas`);
  if (Number(overview.review_backlog || 0) > 0) pendientes.push(`${int(overview.review_backlog)} en cola de revisión`);
  if (pendientes.length) {
    lines.push(`🔔 ${pendientes.join(' · ')}`);
  }
  if (overview.sources_total !== undefined) {
    lines.push(`🛰️ Fuentes sanas: ${int(overview.sources_healthy)} de ${int(overview.sources_total)}`);
  }

  lines.push('');
  if (overview.is_reliable === false) {
    lines.push('⚠️ _El volumen del periodo está por debajo del mínimo de fiabilidad: '
      + 'los porcentajes se muestran, pero no deben leerse como tendencia._');
  }
  lines.push(`⚠️ _${METHODOLOGY_NOTE}_`);
  lines.push(`_Actualizado: ${fmtDateTime(overview.last_updated)}_`);

  return truncate(lines.join('\n'));
}

module.exports = {
  formatChatId,
  chatIdToNumber,
  formatAlert,
  formatDigest,
  truncate,
  SEVERITY_EMOJI,
  METHODOLOGY_NOTE,
  MAX_MESSAGE_LENGTH,
};
