'use strict';

/**
 * Autenticación con JWT RS256 verificado contra el JWKS del emisor.
 *
 * Decisiones que importan:
 *
 *  - La clave pública se obtiene por JWKS con caché. Nunca se acepta el
 *    algoritmo del propio token: se fuerza RS256. Aceptar `alg` del token es
 *    la puerta al ataque de confusión de algoritmo (alg: none / HS256 firmado
 *    con la clave pública).
 *  - El organization_id se toma EXCLUSIVAMENTE del token. Ningún endpoint lo
 *    lee del cuerpo ni de la query: si lo hiciera, cualquier usuario
 *    autenticado podría leer datos de otra organización.
 *  - El token puede venir por cabecera Authorization o por ?token=. Lo segundo
 *    existe porque EventSource del navegador no permite cabeceras. En AMBOS
 *    casos se verifica con el mismo código: el sistema base aceptaba el
 *    stream SSE sin validar nada, que es exactamente el fallo que se corrige.
 */

const jwt = require('jsonwebtoken');
const { JwksClient } = require('jwks-rsa');
const { logger } = require('../logger');

const ISSUER = process.env.OIDC_ISSUER;
const AUDIENCE = process.env.OIDC_AUDIENCE || undefined;
const ORG_CLAIM = process.env.AUTH_ORG_CLAIM || 'organization_id';
const ROLES_CLIENT = process.env.AUTH_ROLES_CLIENT || '';
const CLOCK_TOLERANCE = Number.parseInt(process.env.AUTH_CLOCK_TOLERANCE_SEC || '5', 10);

const JWKS_URI = process.env.OIDC_JWKS_URI
  || (ISSUER ? `${ISSUER.replace(/\/$/, '')}/protocol/openid-connect/certs` : null);

if (!ISSUER) logger.error('OIDC_ISSUER no está definida: toda petición autenticada será rechazada');

const jwks = JWKS_URI
  ? new JwksClient({
    jwksUri: JWKS_URI,
    // La caché evita una llamada de red por petición. Sin ella, el proveedor
    // de identidad se convierte en el cuello de botella del tablero.
    cache: true,
    cacheMaxEntries: Number.parseInt(process.env.JWKS_CACHE_MAX_ENTRIES || '5', 10),
    cacheMaxAge: Number.parseInt(process.env.JWKS_CACHE_MAX_AGE_MS || '600000', 10),
    // Techo de peticiones al JWKS: un atacante que envíe tokens con kid
    // aleatorios no debe poder usarnos para golpear al emisor.
    rateLimit: true,
    jwksRequestsPerMinute: Number.parseInt(process.env.JWKS_RATE_LIMIT_PER_MIN || '10', 10),
    timeout: 5000,
  })
  : null;

class AuthError extends Error {
  constructor(message, code = 'UNAUTHORIZED', status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function getKey(header, callback) {
  if (!jwks) return callback(new AuthError('JWKS no configurado', 'AUTH_MISCONFIGURED', 500));
  if (!header.kid) return callback(new AuthError('El token no declara kid'));
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/** Verifica y decodifica el token. Lanza AuthError con motivo distinguible. */
function verifyToken(raw) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      raw,
      getKey,
      {
        algorithms: ['RS256'],   // nunca el alg que traiga el token
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE,
        ignoreExpiration: false,
      },
      (err, payload) => {
        if (err) {
          if (err.name === 'TokenExpiredError') return reject(new AuthError('Token expirado', 'TOKEN_EXPIRED'));
          if (err.name === 'JsonWebTokenError') return reject(new AuthError(`Token inválido: ${err.message}`, 'TOKEN_INVALID'));
          if (err instanceof AuthError) return reject(err);
          return reject(new AuthError('No se pudo verificar el token', 'TOKEN_UNVERIFIABLE'));
        }
        resolve(payload);
      },
    );
  });
}

/** Reúne roles de realm_access y de resource_access.<cliente>. */
function extractRoles(payload) {
  const roles = new Set();
  for (const r of payload?.realm_access?.roles || []) roles.add(r);
  if (ROLES_CLIENT) {
    for (const r of payload?.resource_access?.[ROLES_CLIENT]?.roles || []) roles.add(r);
  }
  if (Array.isArray(payload?.roles)) for (const r of payload.roles) roles.add(r);
  return [...roles];
}

function buildPrincipal(payload) {
  const organizationId = payload[ORG_CLAIM];
  if (!organizationId) {
    // Sin organización no hay contexto de RLS posible. 403 y no 401: el token
    // es válido, lo que falta es la reclamación.
    throw new AuthError(`El token no incluye la reclamación ${ORG_CLAIM}`, 'ORG_CLAIM_MISSING', 403);
  }
  return {
    sub: payload.sub,
    username: payload.preferred_username || payload.email || payload.sub,
    email: payload.email || null,
    organizationId: String(organizationId),
    roles: extractRoles(payload),
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    raw: payload,
  };
}

/** Extrae el token en bruto. `allowQueryToken` sólo se activa en el stream SSE. */
function readRawToken(req, allowQueryToken) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (header) {
    const [scheme, value] = String(header).split(' ');
    if (!/^Bearer$/i.test(scheme || '') || !value) {
      throw new AuthError('Se esperaba una cabecera Authorization: Bearer <token>', 'BAD_AUTH_HEADER');
    }
    return value.trim();
  }
  if (allowQueryToken && req.query && typeof req.query.token === 'string' && req.query.token) {
    return req.query.token.trim();
  }
  throw new AuthError('Falta el token de acceso', 'TOKEN_MISSING');
}

/**
 * Middleware de autenticación.
 * @param {{allowQueryToken?: boolean}} options
 */
function authenticate(options = {}) {
  const allowQueryToken = options.allowQueryToken === true;
  return async function authenticateMiddleware(req, res, next) {
    try {
      const raw = readRawToken(req, allowQueryToken);
      const payload = await verifyToken(raw);
      req.auth = buildPrincipal(payload);
      req.log = (req.log || logger).child({ sub: req.auth.sub, organization_id: req.auth.organizationId });
      next();
    } catch (err) {
      next(err instanceof AuthError ? err : new AuthError('Fallo de autenticación', 'AUTH_FAILED'));
    }
  };
}

/** Exige al menos uno de los roles indicados. Sin roles listados sólo exige sesión. */
function requireRole(...roles) {
  const required = roles.flat().filter(Boolean);
  return function requireRoleMiddleware(req, res, next) {
    if (!req.auth) return next(new AuthError('No autenticado', 'UNAUTHENTICATED'));
    if (required.length === 0) return next();
    const has = req.auth.roles.some((r) => required.includes(r));
    if (!has) {
      return next(new AuthError(
        `Se requiere uno de estos roles: ${required.join(', ')}`,
        'FORBIDDEN_ROLE',
        403,
      ));
    }
    return next();
  };
}

module.exports = { authenticate, requireRole, verifyToken, buildPrincipal, AuthError };
