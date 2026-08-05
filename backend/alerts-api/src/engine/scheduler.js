'use strict';

/**
 * Planificador de evaluación de reglas.
 *
 * Corrige la carencia central del sistema base: allí las reglas se guardaban y
 * nada las evaluaba nunca. Aquí, cada ALERT_EVAL_INTERVAL_SEC segundos se
 * invoca civic.evaluate_alert_rules(código, false) por cada campaña activa y
 * las alertas creadas se difunden por SSE.
 *
 * La lógica de evaluación NO vive aquí. Vive en la base, que es donde están
 * los datos: histéresis, cooldown, tope diario, muestra mínima y veda son
 * responsabilidad de la función SQL. Este módulo sólo la dispara, difunde el
 * resultado y lo registra.
 *
 * Coordinación entre réplicas: pg_try_advisory_lock. Con tres réplicas del
 * servicio detrás de un balanceador, las tres tienen el mismo temporizador;
 * sin el candado, las tres evaluarían y el cooldown de las reglas se
 * consumiría tres veces más rápido.
 */

const { pool, withOrgContext } = require('../db');
const { logger } = require('../logger');
const { sseManager } = require('../sse/manager');
const { listActiveCampaigns } = require('../store/campaigns');

const LOCK_KEY = Number.parseInt(process.env.ALERT_EVAL_LOCK_KEY || '880311', 10);

class AlertScheduler {
  constructor(options = {}) {
    this.intervalSec = options.intervalSec
      || Number.parseInt(process.env.ALERT_EVAL_INTERVAL_SEC || '60', 10);
    this.initialDelaySec = options.initialDelaySec
      ?? Number.parseInt(process.env.ALERT_EVAL_INITIAL_DELAY_SEC || '15', 10);
    this.enabled = String(process.env.ALERT_EVAL_ENABLED ?? 'true').toLowerCase() !== 'false';
    this.timer = null;
    this.startTimer = null;
    // Evita solapes: si una corrida tarda más que el intervalo, la siguiente
    // se salta en lugar de acumularse.
    this.running = false;
    this.lastRun = null;
    this.runCount = 0;
  }

  start() {
    if (!this.enabled) {
      logger.warn('planificador de alertas deshabilitado (ALERT_EVAL_ENABLED=false)');
      return;
    }
    if (this.timer) return;

    logger.info('planificador de alertas iniciado', {
      interval_sec: this.intervalSec,
      initial_delay_sec: this.initialDelaySec,
      lock_key: LOCK_KEY,
    });

    this.startTimer = setTimeout(() => {
      this.runOnce().catch((err) => logger.error('fallo en la corrida inicial', { err }));
      this.timer = setInterval(() => {
        this.runOnce().catch((err) => logger.error('fallo en la corrida programada', { err }));
      }, this.intervalSec * 1000);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }, this.initialDelaySec * 1000);
    if (typeof this.startTimer.unref === 'function') this.startTimer.unref();
  }

  stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
    logger.info('planificador de alertas detenido');
  }

  status() {
    return {
      enabled: this.enabled,
      interval_sec: this.intervalSec,
      running: this.running,
      run_count: this.runCount,
      last_run: this.lastRun,
    };
  }

  /**
   * Una corrida completa. Es idempotente frente a errores parciales: si una
   * campaña falla, las demás se evalúan igual.
   */
  async runOnce({ dryRun = false, force = false } = {}) {
    if (this.running && !force) {
      logger.warn('corrida omitida: la anterior sigue en curso');
      return { skipped: 'overlap' };
    }
    this.running = true;
    const runId = `run-${Date.now()}`;
    const log = logger.child({ run_id: runId });
    const startedAt = Date.now();

    // El candado se toma sobre una conexión dedicada: pg_try_advisory_lock a
    // nivel de sesión sólo se libera desde la misma conexión que lo tomó.
    let lockClient = null;
    let holdsLock = false;

    try {
      lockClient = await pool.connect();
      const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
      holdsLock = rows[0]?.locked === true;

      if (!holdsLock) {
        // Otra réplica está evaluando. No es un error: es el mecanismo funcionando.
        log.info('corrida omitida: otra instancia tiene el candado', { lock_key: LOCK_KEY });
        return { skipped: 'locked' };
      }

      const campaigns = await listActiveCampaigns();
      log.info('inicia evaluación de reglas', { campaigns: campaigns.length, dry_run: dryRun });

      const summary = {
        run_id: runId,
        campaigns_evaluated: 0,
        campaigns_failed: 0,
        rules_evaluated: 0,
        alerts_created: 0,
        alerts_broadcast: 0,
        skipped_by_reason: {},
      };

      for (const campaign of campaigns) {
        try {
          const result = await this._evaluateCampaign(campaign, dryRun, log);
          summary.campaigns_evaluated += 1;
          summary.rules_evaluated += result.rulesEvaluated;
          summary.alerts_created += result.alertsCreated;
          summary.alerts_broadcast += result.alertsBroadcast;
          for (const [reason, n] of Object.entries(result.skipped)) {
            summary.skipped_by_reason[reason] = (summary.skipped_by_reason[reason] || 0) + n;
          }
        } catch (err) {
          summary.campaigns_failed += 1;
          log.error('fallo al evaluar la campaña', {
            campaign_code: campaign.code,
            organization_id: campaign.organizationId,
            err,
          });
        }
      }

      summary.duration_ms = Date.now() - startedAt;
      this.lastRun = { ...summary, finished_at: new Date().toISOString() };
      this.runCount += 1;
      log.info('evaluación de reglas terminada', summary);
      return summary;
    } finally {
      if (lockClient) {
        if (holdsLock) {
          await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((err) =>
            logger.error('no se pudo liberar el candado consultivo', { lock_key: LOCK_KEY, err }));
        }
        lockClient.release();
      }
      this.running = false;
    }
  }

  /** Evalúa una campaña y difunde por SSE lo que la base haya creado. */
  async _evaluateCampaign(campaign, dryRun, log) {
    const { organizationId, code } = campaign;

    const rows = await withOrgContext(organizationId, { sub: 'alerts-api:scheduler', username: 'scheduler' },
      async (client) => {
        const { rows: r } = await client.query(
          'SELECT * FROM civic.evaluate_alert_rules($1, $2)',
          [code, dryRun],
        );
        return r;
      });

    const skipped = {};
    const createdIds = [];
    for (const row of rows) {
      if (row.skip_reason) skipped[row.skip_reason] = (skipped[row.skip_reason] || 0) + 1;
      if (row.alert_id) createdIds.push(row.alert_id);
    }

    let alertsBroadcast = 0;
    if (createdIds.length > 0) {
      // Se releen desde civic_api.alerts para difundir exactamente la misma
      // forma que devuelve GET /alerts: etiquetas, colores y, sobre todo,
      // metric_caveat. Difundir la fila cruda obligaría al frontend a tener
      // dos formas distintas de la misma entidad.
      const alerts = await withOrgContext(organizationId, { sub: 'alerts-api:scheduler' }, async (client) => {
        const { rows: a } = await client.query(
          'SELECT * FROM civic_api.alerts WHERE id = ANY($1::uuid[]) ORDER BY created_at',
          [createdIds],
        );
        return a;
      });

      for (const alert of alerts) {
        // civic_api.alerts no expone organization_id (la vista filtra por RLS).
        // El manager lo exige, así que se adjunta el de la campaña evaluada,
        // que es el mismo con el que se abrió la transacción.
        const delivered = sseManager.broadcast({ ...alert, organization_id: organizationId });
        alertsBroadcast += delivered > 0 ? 1 : 0;
        log.info('alerta creada y difundida', {
          alert_id: alert.id,
          campaign_code: alert.campaign_code,
          severity: alert.severity_code,
          alert_type: alert.alert_type_code,
          metric: alert.metric,
          observed: alert.observed_value,
          threshold: alert.threshold_value,
          sample_size: alert.sample_size,
          during_blackout: alert.during_blackout,
          sse_clients: delivered,
        });
      }
    }

    log.debug('campaña evaluada', {
      campaign_code: code,
      organization_id: organizationId,
      rules_evaluated: rows.length,
      alerts_created: createdIds.length,
      skipped,
    });

    return {
      rulesEvaluated: rows.length,
      alertsCreated: createdIds.length,
      alertsBroadcast,
      skipped,
    };
  }
}

const scheduler = new AlertScheduler();

module.exports = { AlertScheduler, scheduler };
