/**
 * Tablero competitivo.
 *
 * Dos decisiones de presentacion que no son cosmeticas:
 *
 *  1. El orden lo manda `rank_by_wilson`, la cota inferior de Wilson, no el
 *     apoyo neto: un actor con 5 menciones y 100 % de apoyo no debe encabezar
 *     la tabla.
 *  2. `baseline_support_pct` (la encuesta de referencia) se muestra AL LADO
 *     del apoyo digital, nunca mezclado ni promediado con el. Son dos
 *     mediciones de universos distintos; ponerlas juntas sirve para
 *     contrastarlas, no para sumarlas.
 */
import { ArrowDownRight, ArrowUpRight, Minus, Star } from 'lucide-react';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatCompact, formatNumber, isNil } from '../config/format.js';
import InfoTooltip from './InfoTooltip.jsx';
import EmptyState from './EmptyState.jsx';
import { periodLabel } from './PageHeader.jsx';

function Momentum({ value }) {
  if (isNil(value)) return <span className="text-subtle">—</span>;
  const n = Number(value);
  const Icon = n > 0.5 ? ArrowUpRight : n < -0.5 ? ArrowDownRight : Minus;
  const tone = n > 0.5 ? 'good' : n < -0.5 ? 'bad' : 'neutral';
  return (
    <span className={`cp-delta cp-delta-${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {`${n > 0 ? '+' : ''}${n.toFixed(1)} pp`}
    </span>
  );
}

export function ContenderTable({ contenders = [], days = 14 }) {
  const { getMetric } = useCatalogs();
  const sov = getMetric('share_of_voice');
  const netSupport = getMetric('net_support');
  const wilson = getMetric('support_wilson_lb');
  const momentum = getMetric('competitive_momentum');

  if (!contenders || contenders.length === 0) {
    return (
      <section className="tile">
        <div className="tile-head"><h3 className="tile-title">Tablero competitivo</h3></div>
        <EmptyState compact title="Sin contendientes con menciones en el periodo" />
      </section>
    );
  }

  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-title">Tablero competitivo · {periodLabel(days)}</h3>
        <span className="tile-sub">Ordenado por cota conservadora de Wilson</span>
      </div>

      <div className="cp-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 34 }}>#</th>
              <th>Contendiente</th>
              <th className="num">
                Menciones
              </th>
              <th className="num">
                Voz <InfoTooltip text={sov.caveat} title={sov.label} />
              </th>
              <th className="num">
                Apoyo neto <InfoTooltip text={netSupport.caveat} title={netSupport.label} />
              </th>
              <th className="num">
                Cota Wilson <InfoTooltip text={wilson.caveat} title={wilson.label} />
              </th>
              <th className="num">
                Momentum <InfoTooltip text={momentum.caveat} title={momentum.label} />
              </th>
              <th className="num">
                Encuesta base{' '}
                <InfoTooltip
                  title="Linea base de encuesta"
                  text="Apoyo declarado en la encuesta de referencia cargada para la campana. Mide intencion de voto sobre una muestra probabilistica; el apoyo digital mide postura en texto publico. Se muestran juntas para contrastarlas, no para promediarlas."
                />
              </th>
              <th className="num">Alcance</th>
            </tr>
          </thead>
          <tbody>
            {contenders.map((row) => {
              const stanceTotal = (row.favor_count || 0) + (row.against_count || 0)
                + (row.neutral_count || 0) + (row.undecided_count || 0);
              const gap = !isNil(row.net_support) && !isNil(row.baseline_support_pct)
                ? Number(row.net_support) - Number(row.baseline_support_pct)
                : null;

              return (
                <tr key={row.contender_id} className={row.is_reliable ? '' : 'unreliable'}>
                  <td className="mono text-subtle">{row.rank_by_wilson ?? '—'}</td>
                  <td>
                    <div className="cp-contender-name">
                      {row.is_own && <Star size={13} aria-hidden="true" className="cp-own" title="Contendiente propio" />}
                      <strong>{row.contender_name}</strong>
                    </div>
                    <div className="cp-stance-bar" title={`A favor ${row.favor_count} · En contra ${row.against_count} · Neutral ${row.neutral_count} · Indecisos ${row.undecided_count}`}>
                      {stanceTotal > 0 && (
                        <>
                          <i style={{ width: `${(row.favor_count / stanceTotal) * 100}%`, background: 'var(--c-favor)' }} />
                          <i style={{ width: `${(row.undecided_count / stanceTotal) * 100}%`, background: 'var(--c-undecided)' }} />
                          <i style={{ width: `${(row.neutral_count / stanceTotal) * 100}%`, background: 'var(--c-neutral)' }} />
                          <i style={{ width: `${(row.against_count / stanceTotal) * 100}%`, background: 'var(--c-against)' }} />
                        </>
                      )}
                    </div>
                    {!row.is_reliable && (
                      <span className="cp-metric-warn">muestra insuficiente para publicar sus porcentajes</span>
                    )}
                  </td>
                  <td className="num mono">
                    {formatNumber(row.mentions)}
                    <div className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>
                      {formatNumber(row.unique_authors)} autores
                    </div>
                  </td>
                  <td className="num mono">{isNil(row.share_of_voice) ? '—' : `${Number(row.share_of_voice).toFixed(1)} %`}</td>
                  <td className="num mono">
                    {row.is_reliable && !isNil(row.net_support) ? `${Number(row.net_support).toFixed(1)} %` : '—'}
                  </td>
                  <td className="num mono">{isNil(row.support_wilson_lb) ? '—' : Number(row.support_wilson_lb).toFixed(3)}</td>
                  <td className="num">{row.is_reliable ? <Momentum value={row.competitive_momentum} /> : <span className="text-subtle">—</span>}</td>
                  <td className="num mono">
                    {isNil(row.baseline_support_pct)
                      ? <span className="text-subtle" title="La campana no tiene encuesta de referencia cargada">sin encuesta</span>
                      : (
                        <>
                          {Number(row.baseline_support_pct).toFixed(1)} %
                          {gap !== null && (
                            <div className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>
                              brecha {gap > 0 ? '+' : ''}{gap.toFixed(1)} pp
                            </div>
                          )}
                        </>
                      )}
                  </td>
                  <td className="num mono">{formatCompact(row.total_reach)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="cp-legend-row">
        <span className="pill"><i className="cp-dot" style={{ background: 'var(--c-favor)' }} /> a favor</span>
        <span className="pill"><i className="cp-dot" style={{ background: 'var(--c-undecided)' }} /> indeciso</span>
        <span className="pill"><i className="cp-dot" style={{ background: 'var(--c-neutral)' }} /> neutral</span>
        <span className="pill"><i className="cp-dot" style={{ background: 'var(--c-against)' }} /> en contra</span>
      </div>
    </section>
  );
}

export default ContenderTable;
