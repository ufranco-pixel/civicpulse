'use strict';

/**
 * Plantillas de mensaje (civic.message_templates).
 *
 * La tabla no forma parte del esquema base porque las plantillas son
 * configuración de este canal, no del modelo analítico. Se crea al arrancar
 * con CREATE TABLE IF NOT EXISTS: así el servicio es autosuficiente y no
 * obliga a añadir una migración al paquete SQL por un detalle del bot.
 *
 * El aislamiento por organización es el mismo del resto del sistema:
 * organization_id con FK a civic.organizations y toda consulta dentro de
 * withOrgContext. Como la tabla se crea aquí no tiene política de RLS propia,
 * así que el filtro por organization_id se escribe EXPLÍCITAMENTE en cada
 * consulta. No es opcional: sin él, un token de otra organización vería estas
 * plantillas.
 */

const db = require('../db');
const { logger } = require('../logger');

const DDL = `
CREATE TABLE IF NOT EXISTS civic.message_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    body            TEXT NOT NULL,
    variables       TEXT[] NOT NULL DEFAULT '{}',
    channel         TEXT NOT NULL DEFAULT 'whatsapp',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, code)
)`;

const COLUMNS = 'id, organization_id, code, name, body, variables, channel, created_at, updated_at';

// {{variable}} con espacios opcionales. Nombres de identificador, nada más:
// permitir cualquier cosa entre llaves invita a inyectar plantillas anidadas.
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

/** Crea la tabla si falta. Se llama una vez al arrancar. */
async function ensureTable() {
  await db.query(DDL);
  logger.info('tabla civic.message_templates verificada');
}

/** Variables que realmente aparecen en el cuerpo, en orden de aparición. */
function extractVariables(body) {
  const found = [];
  for (const match of String(body || '').matchAll(PLACEHOLDER_RE)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * Sustituye {{var}} por su valor.
 *
 * Falla si falta alguna variable en lugar de dejar el marcador crudo: un
 * mensaje que llega al teléfono con "{{nombre}}" es peor que uno que no llega,
 * porque nadie se entera hasta que el destinatario lo comenta.
 */
function interpolate(body, values = {}) {
  const missing = [];
  const rendered = String(body).replace(PLACEHOLDER_RE, (_full, name) => {
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return String(value);
  });

  if (missing.length) {
    throw httpError(
      `Faltan variables de la plantilla: ${[...new Set(missing)].join(', ')}`,
      422, 'TEMPLATE_VARS_MISSING',
    );
  }
  return rendered;
}

async function list(auth, { channel, limit, offset }) {
  return db.withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLUMNS}
         FROM civic.message_templates
        WHERE organization_id = $1
          AND ($2::text IS NULL OR channel = $2)
        ORDER BY code
        LIMIT $3 OFFSET $4`,
      [auth.organizationId, channel ?? null, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT count(*)::int AS total
         FROM civic.message_templates
        WHERE organization_id = $1 AND ($2::text IS NULL OR channel = $2)`,
      [auth.organizationId, channel ?? null],
    );
    return { rows, total: countRows[0].total };
  });
}

async function getByCode(auth, code) {
  return db.withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLUMNS} FROM civic.message_templates
        WHERE organization_id = $1 AND code = $2`,
      [auth.organizationId, code],
    );
    return rows[0] || null;
  });
}

async function getById(auth, id) {
  return db.withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLUMNS} FROM civic.message_templates
        WHERE organization_id = $1 AND id = $2`,
      [auth.organizationId, id],
    );
    return rows[0] || null;
  });
}

async function create(auth, { code, name, body, channel }) {
  // Las variables no se piden al cliente: se derivan del cuerpo. Así no puede
  // quedar una lista que diga una cosa y un cuerpo que use otra.
  const variables = extractVariables(body);
  return db.withOrgContext(auth.organizationId, auth, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO civic.message_templates (organization_id, code, name, body, variables, channel)
       VALUES ($1, $2, $3, $4, $5::text[], $6)
       RETURNING ${COLUMNS}`,
      [auth.organizationId, code, name, body, variables, channel],
    );
    return rows[0];
  });
}

async function update(auth, id, patch) {
  return db.withOrgContext(auth.organizationId, auth, async (client) => {
    // COALESCE por columna en lugar de armar el SET dinámicamente: el SQL
    // queda fijo y ningún nombre de columna viene de la petición.
    const body = patch.body ?? null;
    const { rows } = await client.query(
      `UPDATE civic.message_templates
          SET name       = COALESCE($3, name),
              body       = COALESCE($4, body),
              variables  = CASE WHEN $4::text IS NULL THEN variables ELSE $5::text[] END,
              channel    = COALESCE($6, channel),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [
        auth.organizationId, id,
        patch.name ?? null,
        body,
        body === null ? [] : extractVariables(body),
        patch.channel ?? null,
      ],
    );
    return rows[0] || null;
  });
}

async function remove(auth, id) {
  return db.withOrgContext(auth.organizationId, auth, async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM civic.message_templates WHERE organization_id = $1 AND id = $2',
      [auth.organizationId, id],
    );
    return rowCount > 0;
  });
}

/** Carga la plantilla por código y devuelve el texto ya interpolado. */
async function render(auth, code, values) {
  const template = await getByCode(auth, code);
  if (!template) throw httpError(`No existe la plantilla «${code}»`, 404, 'TEMPLATE_NOT_FOUND');
  return { template, text: interpolate(template.body, values) };
}

module.exports = {
  ensureTable,
  extractVariables,
  interpolate,
  list,
  getById,
  getByCode,
  create,
  update,
  remove,
  render,
  httpError,
  PLACEHOLDER_RE,
};
