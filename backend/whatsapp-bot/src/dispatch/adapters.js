'use strict';

/**
 * Adaptadores de envío de WhatsApp.
 *
 * Mismo contrato que el `whatsapp-sender` de ziba, a propósito: un adaptador
 * sabe mandar UN mensaje y devolver el identificador del proveedor, y los
 * fallos se levantan como `WhatsAppSendError` con un indicador `retryable`
 * para que el despachador decida entre reintentar o dar la entrega por
 * perdida.
 *
 * Esa distinción no es cosmética. Un 5xx o un corte de red se arreglan solos
 * al segundo intento; un número mal escrito no. Sin el indicador, los cinco
 * intentos se gastan en el número imposible y retrasan los mensajes que sí
 * podían salir.
 */

const bot = require('../bot/client');
const { logger } = require('../logger');

class WhatsAppSendError extends Error {
  constructor(message, retryable, providerResponse, httpStatus) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.retryable = retryable;
    this.providerResponse = providerResponse;
    this.httpStatus = httpStatus;
  }
}

/** Deja el número en solo dígitos. Devuelve null si no queda nada. */
function soloDigitos(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length ? d : null;
}

// ── mock ────────────────────────────────────────────────────────────────────
// No manda nada: registra y devuelve un identificador falso. Es el valor por
// omisión para que un despliegue recién levantado no intente escribir a nadie
// por accidente mientras se prueban los destinatarios.
const mockAdapter = {
  name: 'mock',
  async send({ to, body }) {
    const fallos = Number.parseFloat(process.env.WA_MOCK_FAILURE_RATE || '0');
    await new Promise((r) => setTimeout(r, Number.parseInt(process.env.WA_MOCK_LATENCY_MS || '80', 10)));
    if (fallos > 0 && Math.random() < fallos) {
      throw new WhatsAppSendError('fallo simulado del adaptador mock', true);
    }
    logger.info('mock: envío simulado', { to, chars: body.length });
    return { messageId: `mock-${Date.now()}`, rawResponse: { simulado: true, to } };
  },
};

// ── whatsapp-web.js ─────────────────────────────────────────────────────────
// Se apoya en el cliente que el bot ya mantiene: es el mismo que atiende los
// comandos entrantes y el que se vincula por QR. Levantar un segundo cliente
// sobre la misma sesión en disco la corrompe.
const wwebjsAdapter = {
  name: 'wwebjs',
  async send({ to, body }) {
    const digitos = soloDigitos(to);
    if (!digitos) throw new WhatsAppSendError(`destino vacío o inválido: "${to}"`, false);

    if (!bot.isConnected()) {
      // Reintentable: la sesión suele volver sola tras una reconexión, y
      // marcar 'failed' aquí perdería alertas por una caída pasajera.
      const estado = bot.getState?.().status || 'desconocido';
      throw new WhatsAppSendError(`WhatsApp no conectado (estado: ${estado})`, true);
    }

    try {
      const r = await bot.sendMessage(`${digitos}@c.us`, body);
      return {
        messageId: r?.id || `wweb-${Date.now()}`,
        rawResponse: { id: r?.id, to: r?.to, timestamp: r?.timestamp },
      };
    } catch (err) {
      // WA_NOT_CONNECTED lo levanta el propio cliente y es transitorio.
      const transitorio = err.code === 'WA_NOT_CONNECTED' || err.status === 503;
      throw new WhatsAppSendError(`wwebjs: ${err.message}`, transitorio);
    }
  },
};

// ── Meta WhatsApp Cloud API ─────────────────────────────────────────────────
const metaAdapter = {
  name: 'meta_cloud',
  async send({ to, body }) {
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    const version = process.env.META_API_VERSION || 'v18.0';
    if (!phoneId || !token) {
      // No reintentable: sin credenciales, insistir no cambia nada.
      throw new WhatsAppSendError('meta_cloud sin META_PHONE_NUMBER_ID o META_ACCESS_TOKEN', false);
    }
    const digitos = soloDigitos(to);
    if (!digitos) throw new WhatsAppSendError(`destino inválido: "${to}"`, false);

    const res = await fetchConTiempo(
      `https://graph.facebook.com/${version}/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: digitos,
          type: 'text',
          text: { preview_url: false, body },
        }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new WhatsAppSendError(
        `meta_cloud ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
        res.status >= 500 || res.status === 429,
        json, res.status,
      );
    }
    const id = json?.messages?.[0]?.id;
    if (!id) throw new WhatsAppSendError('meta_cloud respondió sin id de mensaje', true, json);
    return { messageId: id, rawResponse: json };
  },
};

// ── Twilio ──────────────────────────────────────────────────────────────────
const twilioAdapter = {
  name: 'twilio',
  async send({ to, body }) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
      throw new WhatsAppSendError('twilio sin TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o TWILIO_FROM', false);
    }
    const digitos = soloDigitos(to);
    if (!digitos) throw new WhatsAppSendError(`destino inválido: "${to}"`, false);

    const cuerpo = new URLSearchParams({ To: `whatsapp:+${digitos}`, From: from, Body: body });
    const res = await fetchConTiempo(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: cuerpo.toString(),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new WhatsAppSendError(
        `twilio ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
        res.status >= 500 || res.status === 429,
        json, res.status,
      );
    }
    if (!json.sid) throw new WhatsAppSendError('twilio respondió sin sid', true, json);
    return { messageId: json.sid, rawResponse: json };
  },
};

/** fetch con tiempo límite: sin él, un proveedor colgado bloquea el lote. */
async function fetchConTiempo(url, opciones) {
  const ms = Number.parseInt(process.env.WA_SEND_TIMEOUT_MS || '30000', 10);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opciones, signal: ctrl.signal });
  } catch (err) {
    throw new WhatsAppSendError(
      err.name === 'AbortError' ? `tiempo agotado tras ${ms} ms` : `red: ${err.message}`,
      true,
    );
  } finally {
    clearTimeout(t);
  }
}

const REGISTRO = {
  mock: mockAdapter,
  wwebjs: wwebjsAdapter,
  meta_cloud: metaAdapter,
  twilio: twilioAdapter,
};

/**
 * Elige el adaptador.
 *
 * `WA_OVERRIDE_PROVIDER` gana siempre: sirve para forzar `mock` contra una
 * base de producción sin tocar los datos, que es la única forma segura de
 * probar el despachador con destinatarios reales.
 */
function resolveAdapter() {
  const pedido = String(
    process.env.WA_OVERRIDE_PROVIDER || process.env.WA_PROVIDER || 'mock',
  ).toLowerCase();
  const adaptador = REGISTRO[pedido];
  if (!adaptador) {
    throw new WhatsAppSendError(
      `proveedor desconocido "${pedido}". Válidos: ${Object.keys(REGISTRO).join(', ')}`,
      false,
    );
  }
  return adaptador;
}

module.exports = { resolveAdapter, WhatsAppSendError, REGISTRO };
