'use strict';

/**
 * CRUD de plantillas de mensaje (civic.message_templates).
 *
 * La lista de variables NO se acepta del cliente: se deriva del cuerpo en
 * store/templates.js. Una plantilla cuyo `variables` no coincide con sus
 * `{{marcadores}}` produce mensajes con huecos que sólo se detectan cuando ya
 * llegaron al teléfono de alguien.
 */

const express = require('express');
const { z } = require('zod');

const templates = require('../store/templates');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

const uuid = z.string().uuid('Debe ser un UUID');
const CHANNELS = ['whatsapp', 'email', 'sms'];

// El código es un identificador estable que se usa desde /messages/template:
// se restringe a mayúsculas, dígitos, guion y guion bajo para que no cambie
// de significado según cómo lo escriba quien lo invoque.
const codeSchema = z.string().regex(/^[A-Z0-9_-]{2,64}$/, 'Use MAYÚSCULAS, dígitos, - o _ (2-64)');

const createBody = z.object({
  code: codeSchema,
  name: z.string().min(3).max(200),
  body: z.string().min(1).max(4000),
  channel: z.enum(CHANNELS).default('whatsapp'),
}).strict();

// El código no se puede cambiar: hay reglas de alerta y automatismos que lo
// referencian, y renombrarlo los rompería en silencio.
const updateBody = z.object({
  name: z.string().min(3).max(200),
  body: z.string().min(1).max(4000),
  channel: z.enum(CHANNELS),
}).partial().strict().refine((v) => Object.keys(v).length > 0, {
  message: 'No hay nada que actualizar.',
});

// ── GET /templates ──────────────────────────────────────────────────────────
router.get(
  '/',
  authenticate(),
  requireRole(),
  validate({
    query: z.object({
      channel: z.enum(CHANNELS).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows, total } = await templates.list(req.auth, {
      channel: q.channel, limit: q.limit, offset: q.offset,
    });
    res.json({ data: rows, pagination: { limit: q.limit, offset: q.offset, total, returned: rows.length } });
  }),
);

// ── GET /templates/:id ──────────────────────────────────────────────────────
router.get(
  '/:id',
  authenticate(),
  requireRole(),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const template = await templates.getById(req.auth, req.params.id);
    if (!template) throw templates.httpError('Plantilla no encontrada', 404, 'TEMPLATE_NOT_FOUND');
    res.json({ data: template });
  }),
);

// ── POST /templates ─────────────────────────────────────────────────────────
router.post(
  '/',
  authenticate(),
  requireRole('whatsapp:admin', 'templates:write', 'admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const created = await templates.create(req.auth, req.body);
    req.log.info('plantilla creada', { code: created.code });
    res.status(201).json({ data: created });
  }),
);

// ── PATCH /templates/:id ────────────────────────────────────────────────────
router.patch(
  '/:id',
  authenticate(),
  requireRole('whatsapp:admin', 'templates:write', 'admin'),
  validate({ params: z.object({ id: uuid }), body: updateBody }),
  asyncHandler(async (req, res) => {
    const updated = await templates.update(req.auth, req.params.id, req.body);
    if (!updated) throw templates.httpError('Plantilla no encontrada', 404, 'TEMPLATE_NOT_FOUND');
    req.log.info('plantilla actualizada', { code: updated.code });
    res.json({ data: updated });
  }),
);

// ── DELETE /templates/:id ───────────────────────────────────────────────────
router.delete(
  '/:id',
  authenticate(),
  requireRole('whatsapp:admin', 'templates:write', 'admin'),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const removed = await templates.remove(req.auth, req.params.id);
    if (!removed) throw templates.httpError('Plantilla no encontrada', 404, 'TEMPLATE_NOT_FOUND');
    req.log.warn('plantilla eliminada', { id: req.params.id, by: req.auth.username });
    res.status(204).end();
  }),
);

// ── POST /templates/:id/preview ─────────────────────────────────────────────
// Renderiza sin enviar. Es la forma de ver que no falta ninguna variable
// ANTES de mandarlo a un número real.
router.post(
  '/:id/preview',
  authenticate(),
  requireRole(),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      variables: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const template = await templates.getById(req.auth, req.params.id);
    if (!template) throw templates.httpError('Plantilla no encontrada', 404, 'TEMPLATE_NOT_FOUND');
    const text = templates.interpolate(template.body, req.body.variables);
    res.json({ data: { code: template.code, variables: template.variables, text } });
  }),
);

module.exports = router;
