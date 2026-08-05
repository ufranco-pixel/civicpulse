'use strict';

/**
 * Identificador de petición y registro de acceso.
 *
 * Si el proxy de entrada ya generó un x-request-id se respeta; así una misma
 * petición conserva el mismo id al atravesar tablero → alerts-api → base.
 * Generar uno nuevo en cada salto haría imposible correlacionar.
 */

const { randomUUID } = require('node:crypto');
const { logger } = require('../logger');

const HEADER = (process.env.REQUEST_ID_HEADER || 'x-request-id').toLowerCase();

function requestContext() {
  return function requestContextMiddleware(req, res, next) {
    const incoming = req.headers[HEADER];
    // Se acota la longitud: el id entrante viene de fuera y termina en los logs.
    const requestId = typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : randomUUID();

    req.id = requestId;
    req.log = logger.child({ request_id: requestId });
    res.setHeader(HEADER, requestId);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // Los latidos del SSE no se registran: sólo el cierre del stream.
      req.log.info('petición atendida', {
        method: req.method,
        path: req.route ? req.baseUrl + req.route.path : req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        sub: req.auth?.sub,
        organization_id: req.auth?.organizationId,
      });
    });

    next();
  };
}

module.exports = { requestContext };
