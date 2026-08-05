'use strict';

/**
 * Reunión de los datos del informe.
 *
 * TODO sale de la base. El sistema base fabricaba datos de ejemplo cuando el
 * cuerpo de la petición venía vacío; en un informe de campaña que puede acabar
 * sobre la mesa de un equipo de estrategia —o citado públicamente— eso es
 * inaceptable. Aquí el cliente sólo elige campaña, periodo y secciones: los
 * números los pone civic_kpi.
 *
 * Si una sección no tiene datos suficientes se marca como tal y el PDF lo
 * dice. Una sección vacía y honesta es infinitamente mejor que una inventada.
 */

const { withOrgContext } = require('../db');

const SECTIONS = [
  'executive_summary',
  'sentiment_distribution',
  'timeline',
  'contenders',
  'topics',
  'alerts',
];

// La nota metodológica no se elige: siempre se incluye. Ver pdf.js.
const MANDATORY_SECTIONS = ['methodology'];

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Convierte los NUMERIC de pg (que llegan como cadena) en números de JS. */
function numericRows(rows, fields) {
  return rows.map((row) => {
    const out = { ...row };
    for (const f of fields) if (f in out) out[f] = num(out[f]);
    return out;
  });
}

/**
 * @param {object} auth principal del token
 * @param {{campaignCode: string, periodDays: number, sections: string[]}} params
 * @param {(processed: number, message: string) => Promise<void>} [onProgress]
 */
async function collectReportData(auth, { campaignCode, periodDays, sections }, onProgress) {
  const wanted = new Set(sections);
  let processed = 0;
  const progress = async (message) => {
    processed += 1;
    if (onProgress) await onProgress(processed, message);
  };

  return withOrgContext(auth.organizationId, auth, async (client) => {
    // ── Campaña ─────────────────────────────────────────────────────────────
    const { rows: campaignRows } = await client.query(
      `SELECT id, code, name, objective, campaign_kind, contest_label, status,
              timezone, starts_on, ends_on, election_date, days_to_election,
              blackout_starts_on, blackout_ends_on, in_blackout,
              organization_name, geo_area_name, contender_count, active_source_count
         FROM civic_api.campaigns WHERE code = $1`,
      [campaignCode],
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      const err = new Error(`No existe la campaña ${campaignCode} en esta organización`);
      err.status = 404;
      err.code = 'CAMPAIGN_NOT_FOUND';
      err.expose = true;
      throw err;
    }

    const data = {
      campaign,
      period: {
        days: periodDays,
        // Se calculan aquí para que la portada y las consultas hablen del
        // mismo periodo aunque la generación cruce la medianoche.
        end: new Date(),
        start: new Date(Date.now() - periodDays * 86400000),
      },
      generated_at: new Date().toISOString(),
      generated_by: auth.username,
      sections: {},
      warnings: [],
    };

    // ── Resumen general (siempre: alimenta portada y resumen ejecutivo) ─────
    const { rows: overviewRows } = await client.query(
      'SELECT * FROM civic_kpi.campaign_overview($1, $2)',
      [campaignCode, periodDays],
    );
    data.overview = overviewRows[0]
      ? numericRows(overviewRows, [
        'positive_pct', 'neutral_pct', 'negative_pct', 'net_sentiment', 'avg_sentiment_score',
        'sentiment_momentum', 'polarization_index', 'avg_toxicity', 'avg_confidence',
      ])[0]
      : null;

    if (!data.overview || Number(data.overview.total_mentions || 0) === 0) {
      data.warnings.push('No hay contenidos analizados en el periodo seleccionado. El informe se emite vacío a propósito: no se sustituyen datos ausentes por estimaciones.');
    } else if (data.overview.is_reliable === false) {
      data.warnings.push('El volumen del periodo está por debajo del mínimo de fiabilidad del registro de indicadores. Los porcentajes se muestran, pero no deben leerse como tendencia.');
    }
    await progress('Resumen general obtenido');

    // ── Serie temporal ──────────────────────────────────────────────────────
    if (wanted.has('timeline') || wanted.has('executive_summary')) {
      const { rows } = await client.query(
        'SELECT * FROM civic_kpi.sentiment_timeseries($1, $2, $3, NULL)',
        [campaignCode, periodDays, 'day'],
      );
      data.sections.timeline = numericRows(rows, [
        'positive_pct', 'negative_pct', 'net_sentiment', 'avg_score', 'rolling_avg_7', 'volume_zscore',
      ]);
      await progress('Serie temporal obtenida');
    }

    // ── Tablero competitivo ─────────────────────────────────────────────────
    if (wanted.has('contenders')) {
      const { rows } = await client.query(
        'SELECT * FROM civic_kpi.contender_scoreboard($1, $2)',
        [campaignCode, periodDays],
      );
      data.sections.contenders = numericRows(rows, [
        'share_of_voice', 'attention_share', 'net_support', 'support_wilson_lb',
        'avg_stance_score', 'avg_text_sentiment', 'prev_net_support', 'competitive_momentum',
        'baseline_support_pct', 'model_attribution_ratio',
      ]);
      await progress('Tablero competitivo obtenido');
    }

    // ── Agenda de temas ─────────────────────────────────────────────────────
    if (wanted.has('topics')) {
      const { rows } = await client.query(
        'SELECT * FROM civic_kpi.topic_agenda($1, $2, $3)',
        [campaignCode, periodDays, 15],
      );
      data.sections.topics = numericRows(rows, ['topic_share', 'avg_sentiment', 'negative_pct', 'topic_growth']);
      await progress('Agenda de temas obtenida');
    }

    // ── Riesgo de crisis ────────────────────────────────────────────────────
    // Se pide siempre: es el dato que el equipo mira primero y cabe en el
    // resumen ejecutivo. La ventana es de horas, no de días.
    const { rows: riskRows } = await client.query(
      'SELECT * FROM civic_kpi.crisis_risk($1, $2)',
      [campaignCode, 24],
    );
    data.risk = riskRows[0]
      ? numericRows(riskRows, [
        'risk_index', 'volume_component', 'sentiment_component', 'toxicity_component', 'flags_component',
      ])[0]
      : null;

    // ── Alertas del periodo ─────────────────────────────────────────────────
    if (wanted.has('alerts')) {
      const { rows } = await client.query(
        `SELECT id, created_at, severity_code, severity_label, severity_rank,
                alert_type_code, alert_type_label, title, message, status,
                metric, metric_label, metric_unit, metric_caveat,
                observed_value, threshold_value, sample_size,
                contender_name, source_name, during_blackout, was_false_positive,
                resolved_at, resolution_note
           FROM civic_api.alerts
          WHERE campaign_code = $1
            AND created_at >= NOW() - ($2 || ' days')::interval
          ORDER BY severity_rank DESC, created_at DESC
          LIMIT 100`,
        [campaignCode, periodDays],
      );
      data.sections.alerts = numericRows(rows, ['observed_value', 'threshold_value']);

      const { rows: openRows } = await client.query(
        `SELECT count(*)::int AS open_now,
                count(*) FILTER (WHERE severity_code = 'critical')::int AS critical_now
           FROM civic_api.alerts
          WHERE campaign_code = $1 AND status IN ('open','acknowledged','in_progress')`,
        [campaignCode],
      );
      data.open_alerts = openRows[0];
      await progress('Alertas del periodo obtenidas');
    }

    // ── Fuentes incluidas (obligatorio para la nota metodológica) ───────────
    // Sin la lista de fuentes el lector no puede juzgar de qué universo se
    // habla. Va en el informe aunque no se pida ninguna sección opcional.
    const { rows: sourceRows } = await client.query(
      `SELECT s.name, s.type_label, s.type_family, s.is_public_data, s.status,
              s.legal_basis, s.volume_7d, s.health, s.last_success_at
         FROM civic_api.sources s
        WHERE s.campaign_id = $1
        ORDER BY s.volume_7d DESC NULLS LAST, s.name`,
      [campaign.id],
    );
    data.sources = sourceRows;

    // ── Advertencias de los indicadores usados ──────────────────────────────
    // Cada número del informe arrastra su caveat desde el registro. No se
    // escriben a mano en el PDF: si el registro cambia, el informe cambia.
    const usedMetrics = [
      'mention_volume', 'unique_authors', 'net_sentiment', 'negative_pct', 'positive_pct',
      'polarization_index', 'toxicity_avg', 'share_of_voice', 'topic_growth',
      'crisis_risk_index', 'confidence_avg', 'volume_zscore',
    ];
    const { rows: metricRows } = await client.query(
      `SELECT code, label_es, family, definition, formula, unit, min_sample_size, caveat
         FROM civic_kpi.metric_registry
        WHERE is_active AND code = ANY($1::text[])
        ORDER BY family, sort_order`,
      [usedMetrics],
    );
    data.metrics = metricRows;

    // Modelos que produjeron las inferencias del periodo: parte de la
    // trazabilidad metodológica.
    const { rows: modelRows } = await client.query(
      `SELECT i.model_name_snapshot AS model_name, count(*)::int AS n
         FROM civic.inferences i
        WHERE i.campaign_id = $1
          AND i.published_at >= NOW() - ($2 || ' days')::interval
          AND NOT i.is_superseded
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [campaign.id, periodDays],
    );
    data.models = modelRows;

    await progress('Metodología y fuentes obtenidas');

    return data;
  });
}

module.exports = { collectReportData, SECTIONS, MANDATORY_SECTIONS };
