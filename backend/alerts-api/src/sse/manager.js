'use strict';

/**
 * Gestor de clientes SSE.
 *
 * Invariante innegociable: una alerta jamás llega a un cliente de otra
 * organización. El filtro por organización se aplica ANTES que cualquier otro
 * y se comprueba por igualdad estricta de UUID. Si una alerta llega sin
 * organización identificable no se difunde a nadie (falla cerrada). Es
 * preferible perder una notificación a filtrar datos entre clientes: quien no
 * recibió la alerta la verá en el listado al refrescar; una fuga es
 * irreversible.
 *
 * El orgId del cliente proviene del token verificado, nunca de la query.
 */

const { randomUUID } = require('node:crypto');
const { logger } = require('../logger');

// Orden de civic_cat.severity_levels.rank. Se usa como respaldo cuando la
// alerta difundida no trae severity_rank (p. ej. eventos sintéticos).
const SEVERITY_RANK = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

function rankOf(severityCode, explicitRank) {
  if (Number.isFinite(explicitRank)) return Number(explicitRank);
  return SEVERITY_RANK[String(severityCode || '').toLowerCase()] ?? 0;
}

/** Escapa los saltos de línea del payload: en SSE cada \n delimita un campo. */
function formatEvent({ id, event, data, retryMs }) {
  let out = '';
  if (retryMs) out += `retry: ${retryMs}\n`;
  if (id) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of String(payload).split('\n')) out += `data: ${line}\n`;
  return out + '\n';
}

class SseManager {
  constructor(options = {}) {
    this.clients = new Map(); // clientId -> { res, orgId, campaignCode, severityMin, ... }
    this.heartbeatMs = options.heartbeatMs
      || Number.parseInt(process.env.SSE_HEARTBEAT_MS || '25000', 10);
    this.retryMs = options.retryMs
      || Number.parseInt(process.env.SSE_RETRY_MS || '5000', 10);
    this.maxClients = options.maxClients
      || Number.parseInt(process.env.SSE_MAX_CLIENTS || '500', 10);
    this.heartbeatTimer = null;
    this.closed = false;
  }

  get size() {
    return this.clients.size;
  }

  /**
   * Registra un cliente y deja el stream abierto.
   * @returns {string|null} clientId, o null si se rechazó por aforo.
   */
  add(req, res, { orgId, sub, campaignCode = null, severityMin = null, alertTypes = null }) {
    if (!orgId) throw new Error('No se puede abrir un stream SSE sin organización');

    if (this.clients.size >= this.maxClients) {
      // 503 y no cola: mantener conexiones que no podemos atender sólo
      // desplaza el problema a la memoria del proceso.
      res.status(503).json({
        error: { code: 'SSE_CAPACITY', message: 'Máximo de clientes SSE alcanzado en esta instancia.' },
      });
      return null;
    }

    const clientId = randomUUID();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Desactiva el búfer de nginx: sin esto el proxy retiene los eventos
      // hasta llenar su búfer y el "tiempo real" se vuelve de minutos.
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const client = {
      id: clientId,
      res,
      orgId: String(orgId),
      sub: sub || null,
      campaignCode: campaignCode || null,
      severityMin: severityMin || null,
      severityMinRank: severityMin ? rankOf(severityMin) : 0,
      alertTypes: Array.isArray(alertTypes) && alertTypes.length ? new Set(alertTypes) : null,
      connectedAt: new Date().toISOString(),
      sentCount: 0,
    };
    this.clients.set(clientId, client);

    // El retry: le dice al navegador cuánto esperar antes de reconectar.
    // Se envía junto al primer evento para que aplique desde el inicio.
    this._write(client, formatEvent({
      event: 'connected',
      retryMs: this.retryMs,
      data: {
        client_id: clientId,
        campaign_code: client.campaignCode,
        severity_min: client.severityMin,
        heartbeat_ms: this.heartbeatMs,
        server_time: client.connectedAt,
      },
    }));

    const cleanup = (reason) => this.remove(clientId, reason);
    req.on('close', () => cleanup('client_closed'));
    req.on('error', (err) => {
      logger.warn('error en la conexión SSE', { client_id: clientId, err });
      cleanup('request_error');
    });
    res.on('error', (err) => {
      logger.warn('error al escribir en el stream SSE', { client_id: clientId, err });
      cleanup('response_error');
    });

    this._ensureHeartbeat();

    logger.info('cliente SSE conectado', {
      client_id: clientId,
      organization_id: client.orgId,
      campaign_code: client.campaignCode,
      severity_min: client.severityMin,
      total_clients: this.clients.size,
    });

    return clientId;
  }

  remove(clientId, reason = 'unspecified') {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    try {
      client.res.end();
    } catch {
      // El socket ya podía estar destruido; no hay nada que hacer.
    }
    logger.info('cliente SSE desconectado', {
      client_id: clientId,
      organization_id: client.orgId,
      reason,
      sent_count: client.sentCount,
      total_clients: this.clients.size,
    });
    if (this.clients.size === 0) this._stopHeartbeat();
  }

  /**
   * Difunde una alerta a los clientes que corresponda.
   *
   * @param {object} alert Debe traer organization_id. Sin él no se difunde.
   * @returns {number} clientes alcanzados
   */
  broadcast(alert) {
    const orgId = alert?.organization_id || alert?.organizationId;
    if (!orgId) {
      // Falla cerrada. Este caso es un error de programación en el emisor:
      // se registra a nivel error para que salte en el monitoreo.
      logger.error('alerta descartada: no trae organization_id, no se puede aislar por organización', {
        alert_id: alert?.id,
        campaign_code: alert?.campaign_code,
      });
      return 0;
    }

    const orgKey = String(orgId);
    const alertRank = rankOf(alert.severity_code, alert.severity_rank);
    let delivered = 0;

    for (const client of this.clients.values()) {
      // 1. Aislamiento por organización. Siempre primero.
      if (client.orgId !== orgKey) continue;
      // 2. Filtros que el cliente pidió.
      if (client.campaignCode && client.campaignCode !== alert.campaign_code) continue;
      if (client.severityMinRank && alertRank < client.severityMinRank) continue;
      if (client.alertTypes && !client.alertTypes.has(alert.alert_type_code)) continue;

      const ok = this._write(client, formatEvent({
        id: alert.seq ? String(alert.seq) : alert.id,
        event: 'alert',
        data: alert,
      }));
      if (ok) {
        client.sentCount += 1;
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Evento arbitrario para una organización (p. ej. resultado de una corrida). */
  broadcastSystem(orgId, eventName, data) {
    if (!orgId) return 0;
    const orgKey = String(orgId);
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.orgId !== orgKey) continue;
      if (this._write(client, formatEvent({ event: eventName, data }))) delivered += 1;
    }
    return delivered;
  }

  _write(client, chunk) {
    try {
      // writableEnded cubre la ventana entre el cierre del socket y el evento
      // 'close', durante la cual escribir lanza ERR_STREAM_WRITE_AFTER_END.
      if (client.res.writableEnded || client.res.destroyed) {
        this.remove(client.id, 'stream_ended');
        return false;
      }
      client.res.write(chunk);
      return true;
    } catch (err) {
      logger.warn('no se pudo escribir en el cliente SSE; se descarta', { client_id: client.id, err });
      this.remove(client.id, 'write_failed');
      return false;
    }
  }

  _ensureHeartbeat() {
    if (this.heartbeatTimer || this.closed) return;
    this.heartbeatTimer = setInterval(() => {
      // Comentario SSE (línea que empieza por ':'). El navegador lo ignora,
      // pero mantiene viva la conexión frente a proxies con timeout de
      // inactividad, que es lo que mata los streams "silenciosos".
      const beat = `: heartbeat ${Date.now()}\n\n`;
      for (const client of [...this.clients.values()]) this._write(client, beat);
    }, this.heartbeatMs);
    // unref: el latido no debe impedir que el proceso termine.
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Estadísticas sin exponer identificadores de otras organizaciones. */
  statsFor(orgId) {
    let total = 0;
    const byCampaign = {};
    for (const client of this.clients.values()) {
      if (client.orgId !== String(orgId)) continue;
      total += 1;
      const key = client.campaignCode || '(todas)';
      byCampaign[key] = (byCampaign[key] || 0) + 1;
    }
    return { clients: total, by_campaign: byCampaign, instance_total: this.clients.size };
  }

  /** Cierre ordenado: avisa a los clientes antes de cortar. */
  closeAll(reason = 'server_shutdown') {
    this.closed = true;
    this._stopHeartbeat();
    for (const client of [...this.clients.values()]) {
      this._write(client, formatEvent({ event: 'shutdown', data: { reason } }));
      this.remove(client.id, reason);
    }
  }
}

const sseManager = new SseManager();

module.exports = { SseManager, sseManager, formatEvent, SEVERITY_RANK, rankOf };
