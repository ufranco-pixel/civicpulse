'use strict';

/**
 * Manejo centralizado de errores.
 *
 * Traduce los códigos SQLSTATE que la base usa deliberadamente como contrato
 * (23514 del trigger de consentimiento, 22023 de métrica desconocida) en
 * respuestas que el cliente puede entender y mostrar. Devolver "500 error
 * interno" ante una violación de consentimiento oculta justo la información
 * que el operador necesita para corregir.
 */

const { logger } = require('../logger');

/** SQLSTATE → respuesta HTTP. */
const PG_ERRORS = {
  // Violación de CHECK. En este esquema la más habitual es el trigger que
  // exige consent_given_at en WhatsApp y correo.
  23514: {
    status: 422,
    code: 'CONSTRAINT_VIOLATION',
    message: 'La operación viola una restricción de integridad de la base de datos.',
  },
  23505: { status: 409, code: 'DUPLICATE', message: 'Ya existe un registro con esos valores únicos.' },
  23503: { status: 422, code: 'FK_VIOLATION', message: 'Referencia a un registro que no existe.' },
  23502: { status: 422, code: 'NOT_NULL_VIOLATION', message: 'Falta un campo obligatorio.' },
  '22P02': { status: 422, code: 'INVALID_INPUT_SYNTAX', message: 'Un valor no tiene el formato esperado (¿UUID mal formado?).' },
  22023: { status: 422, code: 'INVALID_PARAMETER', message: 'Parámetro no admitido por la función de base de datos.' },
  '42501': { status: 403, code: 'DB_PERMISSION_DENIED', message: 'Sin permisos para la operación solicitada.' },
  '57014': { status: 504, code: 'STATEMENT_TIMEOUT', message: 'La consulta excedió el tiempo máximo.' },
  '40001': { status: 409, code: 'SERIALIZATION_FAILURE', message: 'Conflicto de concurrencia; reintente.' },
};

function notFound(req, res, next) {
  const err = new Error(`Ruta no encontrada: ${req.method} ${req.originalUrl.split('?')[0]}`);
  err.status = 404;
  err.code = 'NOT_FOUND';
  err.expose = true;
  next(err);
}

function errorHandler() {
  // eslint-disable-next-line no-unused-vars -- Express identifica el manejador de errores por la aridad 4.
  return function errorHandlerMiddleware(err, req, res, next) {
    const mapped = err.code && PG_ERRORS[err.code] ? PG_ERRORS[err.code] : null;
    const status = err.status || mapped?.status || 500;
    const code = err.code && !mapped ? err.code : (mapped?.code || 'INTERNAL_ERROR');
    const log = req.log || logger;

    // 5xx es un fallo nuestro y va a nivel error; 4xx es del cliente y basta warn.
    const level = status >= 500 ? 'error' : 'warn';
    log[level]('error al atender la petición', {
      status,
      code,
      err,
      path: req.originalUrl?.split('?')[0],
      // El mensaje que PostgreSQL genera en un RAISE suele ser el más útil.
      pg_detail: err.detail,
      pg_constraint: err.constraint,
    });

    if (res.headersSent) {
      // Típico en SSE: la respuesta ya empezó. Sólo se puede cerrar.
      return res.end();
    }

    const body = {
      error: {
        code,
        // Los mensajes de 5xx no se exponen: pueden filtrar nombres de tablas
        // o cadenas de conexión. Los de 4xx marcados como expose sí.
        message: status >= 500 && !err.expose
          ? 'Error interno del servicio'
          : (mapped ? `${mapped.message} ${err.message || ''}`.trim() : err.message),
        request_id: req.id,
      },
    };
    if (err.details) body.error.details = err.details;

    return res.status(status).json(body);
  };
}

module.exports = { notFound, errorHandler, PG_ERRORS };
