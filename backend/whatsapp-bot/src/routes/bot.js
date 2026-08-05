'use strict';

/**
 * Control de la sesión de WhatsApp.
 *
 * Estos endpoints van autenticados aunque no toquen la base: el QR de
 * vinculación es, para todo efecto práctico, la credencial de la cuenta. Quien
 * lo escanea se lleva la sesión.
 */

const express = require('express');
const { z } = require('zod');

const bot = require('../bot/client');
const { handleMessage } = require('../bot/handlers');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, asyncHandler } = require('../middleware/validate');

const router = express.Router();

/** Manejador de entrantes que se vuelve a enganchar en cada reconexión. */
const onMessage = (msg, waClient) => handleMessage(msg, waClient, bot);

// ── GET /bot/status ─────────────────────────────────────────────────────────
router.get(
  '/status',
  authenticate(),
  requireRole(),
  validate({
    query: z.object({
      // El QR es una imagen de ~5 KB en base64; no se manda si no se pide.
      include_qr: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const state = bot.getState();
    if (!req.query.include_qr) delete state.qrCode;
    res.json({ data: { ...state, hasQr: bot.getState().qrCode !== null } });
  }),
);

// ── POST /bot/reconnect ─────────────────────────────────────────────────────
// Fuerza un intento inmediato. Reinicia el contador de reintentos para que la
// espera exponencial no siga en varios minutos tras un fallo transitorio ya
// resuelto (por ejemplo, el teléfono que volvió a tener red).
router.post(
  '/reconnect',
  authenticate(),
  requireRole('whatsapp:admin', 'admin'),
  asyncHandler(async (req, res) => {
    req.log.info('reconexión de WhatsApp solicitada', { by: req.auth.username });
    // No se espera a que conecte: la vinculación puede tardar minutos si hay
    // que escanear un QR, y la petición HTTP no debe quedarse colgada ahí.
    const state = await bot.reconnect(onMessage);
    res.status(202).json({ data: state, message: 'Reconexión en curso; consulte GET /bot/status.' });
  }),
);

// ── POST /bot/logout ────────────────────────────────────────────────────────
router.post(
  '/logout',
  authenticate(),
  requireRole('whatsapp:admin', 'admin'),
  asyncHandler(async (req, res) => {
    req.log.warn('cierre de sesión de WhatsApp solicitado', { by: req.auth.username });
    const state = await bot.logout();
    res.json({
      data: state,
      message: 'Sesión cerrada. El próximo arranque pedirá un QR nuevo.',
    });
  }),
);

module.exports = router;
module.exports.onMessage = onMessage;
