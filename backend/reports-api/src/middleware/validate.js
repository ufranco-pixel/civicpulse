'use strict';

/**
 * Validación de entrada con zod.
 *
 * Devuelve 422 con el detalle campo a campo. Un 400 genérico obliga al cliente
 * a adivinar qué envió mal; con el detalle, el formulario del tablero puede
 * marcar el campo exacto.
 *
 * El resultado parseado REEMPLAZA a req.body / req.query / req.params, de modo
 * que las rutas trabajan con datos ya convertidos (números como números,
 * fechas como Date) y sin propiedades extra.
 */

const { ZodError } = require('zod');

class ValidationError extends Error {
  constructor(details) {
    super('La solicitud no superó la validación');
    this.name = 'ValidationError';
    this.status = 422;
    this.code = 'VALIDATION_FAILED';
    this.expose = true;
    this.details = details;
  }
}

function formatIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(raíz)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * @param {{body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny}} schemas
 */
function validate(schemas = {}) {
  return function validateMiddleware(req, res, next) {
    const details = [];
    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        details.push(...formatIssues(result.error).map((d) => ({ ...d, in: source })));
      } else {
        // req.query es un getter de sólo lectura en Express 5; en 4 es
        // asignable. Se usa defineProperty para no depender de la versión.
        Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
      }
    }
    if (details.length) return next(new ValidationError(details));
    return next();
  };
}

/** Envuelve manejadores async para que sus rechazos lleguen al manejador de errores. */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { validate, asyncHandler, ValidationError, ZodError };
