'use strict';

/**
 * Consultas sobre campañas que necesita el planificador y las rutas.
 *
 * La enumeración de campañas activas es el único punto del servicio que
 * necesita mirar más allá de una organización, y por eso tiene tratamiento
 * especial (ver getSchedulerPool en db.js y las notas de .env.example).
 */

const { withOrgContext, getSchedulerPool, UUID_RE } = require('../db');
const { logger } = require('../logger');

function configuredOrgIds() {
  return String(process.env.ALERT_EVAL_ORG_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
}

/**
 * Campañas activas agrupadas por organización.
 *
 * Modo 1 (recomendado): ALERT_EVAL_ORG_IDS lista las organizaciones y cada una
 * se recorre con su propio contexto RLS usando el rol de aplicación.
 *
 * Modo 2: sin lista, se usa SCHEDULER_DATABASE_URL, cuyo rol debe tener
 * BYPASSRLS. Se consulta civic.campaigns directamente porque civic_api.campaigns
 * no expone lo que aquí hace falta agrupado y esta consulta es interna del
 * planificador, no parte del contrato de la API.
 *
 * @returns {Promise<Array<{organizationId: string, code: string, name: string, timezone: string, inBlackout: boolean}>>}
 */
async function listActiveCampaigns() {
  const orgIds = configuredOrgIds();

  if (orgIds.length > 0) {
    const out = [];
    for (const orgId of orgIds) {
      try {
        const rows = await withOrgContext(orgId, { sub: 'alerts-api:scheduler' }, async (client) => {
          const { rows: r } = await client.query(
            `SELECT c.id, c.code, c.name, c.timezone,
                    (c.blackout_starts_on IS NOT NULL
                     AND CURRENT_DATE BETWEEN c.blackout_starts_on
                                          AND COALESCE(c.blackout_ends_on, c.blackout_starts_on)) AS in_blackout
               FROM civic.campaigns c
              WHERE c.status = 'active'
              ORDER BY c.code`,
          );
          return r;
        });
        for (const row of rows) {
          out.push({
            organizationId: orgId,
            campaignId: row.id,
            code: row.code,
            name: row.name,
            timezone: row.timezone,
            inBlackout: row.in_blackout,
          });
        }
      } catch (err) {
        // Una organización mal configurada no debe impedir evaluar las demás.
        logger.error('no se pudieron listar las campañas de la organización', { organization_id: orgId, err });
      }
    }
    return out;
  }

  const pool = getSchedulerPool();
  const { rows } = await pool.query(
    `SELECT c.organization_id, c.id, c.code, c.name, c.timezone,
            (c.blackout_starts_on IS NOT NULL
             AND CURRENT_DATE BETWEEN c.blackout_starts_on
                                  AND COALESCE(c.blackout_ends_on, c.blackout_starts_on)) AS in_blackout
       FROM civic.campaigns c
      WHERE c.status = 'active'
      ORDER BY c.organization_id, c.code`,
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    campaignId: row.id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    inBlackout: row.in_blackout,
  }));
}

/** Resuelve una campaña dentro del contexto de organización ya abierto. */
async function findCampaignByCode(client, code) {
  const { rows } = await client.query(
    `SELECT id, code, name, timezone, in_blackout, status, organization_id
       FROM civic_api.campaigns
      WHERE code = $1`,
    [code],
  );
  return rows[0] || null;
}

module.exports = { listActiveCampaigns, findCampaignByCode, configuredOrgIds };
