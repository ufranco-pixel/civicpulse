/**
 * Evaluacion de modelos y prompts.
 *
 * Lo que hace util esta pagina no es la exactitud global sino los cortes: un
 * modelo con F1 de 0.82 global y de 0.41 en textos con ironia esta roto para
 * conversacion politica, y solo el desglose por `slice` lo muestra.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, Play, XCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi.js';
import {
  compareRuns, computeMetrics, getConfusion, getPromotionGate, getRunErrors,
  getRunMetrics, listDatasets, listRuns,
} from '../services/evaluation.service.js';
import { useToast } from '../components/ToastSystem.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { SkeletonRows, SkeletonTile } from '../components/SkeletonTile.jsx';
import { formatDateTime, formatNumber, truncate } from '../config/format.js';

const TASKS = ['sentiment', 'stance', 'intent'];

function ConfusionMatrix({ cells }) {
  if (!cells || cells.length === 0) return <EmptyState compact title="Sin matriz de confusion calculada" />;

  const golds = [...new Set(cells.map((cell) => cell.gold_class))].sort();
  const preds = [...new Set(cells.map((cell) => cell.pred_class))].sort();
  const lookup = new Map(cells.map((cell) => [`${cell.gold_class}|${cell.pred_class}`, cell.count]));
  const max = Math.max(...cells.map((cell) => cell.count), 1);

  return (
    <div className="cp-table-wrap">
      <table className="table cp-confusion">
        <thead>
          <tr>
            <th>real \ predicho</th>
            {preds.map((pred) => <th key={pred} className="num">{pred}</th>)}
          </tr>
        </thead>
        <tbody>
          {golds.map((gold) => (
            <tr key={gold}>
              <th scope="row">{gold}</th>
              {preds.map((pred) => {
                const count = lookup.get(`${gold}|${pred}`) || 0;
                const intensity = count / max;
                const correct = gold === pred;
                return (
                  <td
                    key={pred}
                    className="num mono"
                    style={{
                      background: count === 0 ? 'transparent'
                        : `color-mix(in srgb, var(${correct ? '--c-positive' : '--c-negative'}) ${Math.round(intensity * 55)}%, transparent)`,
                    }}
                  >
                    {formatNumber(count)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvaluationPage() {
  const toast = useToast();
  const [runId, setRunId] = useState('');
  const [task, setTask] = useState('sentiment');
  const [computing, setComputing] = useState(false);

  const datasets = useApi(({ signal }) => listDatasets({}, { signal }), []);
  const runs = useApi(({ signal }) => listRuns({ limit: 50 }, { signal }), []);

  useEffect(() => {
    if (!runId && runs.data && runs.data.length > 0) setRunId(runs.data[0].id);
  }, [runs.data, runId]);

  const metrics = useApi(
    ({ signal }) => getRunMetrics(runId, { task }, { signal }),
    [runId, task],
    { enabled: Boolean(runId) },
  );
  const confusion = useApi(
    ({ signal }) => getConfusion(runId, { task, slice: 'all' }, { signal }),
    [runId, task],
    { enabled: Boolean(runId) },
  );
  const gate = useApi(
    ({ signal }) => getPromotionGate(runId, {}, { signal }),
    [runId],
    { enabled: Boolean(runId) },
  );
  const errors = useApi(
    ({ signal }) => getRunErrors(runId, { task, limit: 40 }, { signal }),
    [runId, task],
    { enabled: Boolean(runId) },
  );

  const run = (runs.data || []).find((item) => item.id === runId) || null;

  const comparison = useApi(
    ({ signal }) => compareRuns(runId, run?.baseline_run_id, { signal }),
    [runId, run?.baseline_run_id],
    { enabled: Boolean(runId && run?.baseline_run_id) },
  );

  async function recompute() {
    if (!runId) return;
    setComputing(true);
    try {
      await computeMetrics(runId);
      toast.success('Metricas recalculadas.');
      metrics.reload();
      confusion.reload();
      gate.reload();
    } catch (err) {
      toast.error(err.message || 'No se pudieron calcular las metricas.');
    } finally {
      setComputing(false);
    }
  }

  const bySlice = (metrics.data || []).reduce((acc, metric) => {
    (acc[metric.slice] = acc[metric.slice] || []).push(metric);
    return acc;
  }, {});

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Evaluacion"
        description="Nada se promueve a produccion sin una corrida contra un conjunto congelado."
        onReload={() => { runs.reload(); metrics.reload(); confusion.reload(); gate.reload(); errors.reload(); }}
      >
        <label className="row" style={{ gap: 'var(--sp-2)' }}>
          <span className="field-label">Tarea</span>
          <select className="select" style={{ width: 'auto' }} value={task} onChange={(event) => setTask(event.target.value)}>
            {TASKS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </PageHeader>

      <section className="tile">
        <div className="tile-head">
          <h3 className="tile-title">Corridas</h3>
          <span className="tile-sub">{formatNumber((datasets.data || []).length)} conjunto(s) · {formatNumber((runs.data || []).length)} corrida(s)</span>
        </div>
        {runs.error ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : runs.loading ? (
          <SkeletonRows rows={4} />
        ) : (runs.data || []).length === 0 ? (
          <EmptyState title="Sin corridas de evaluacion" message="Cree un conjunto, congelelo y encole una corrida desde la API." />
        ) : (
          <div className="cp-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Corrida</th>
                  <th>Conjunto</th>
                  <th>Modelo</th>
                  <th>Estado</th>
                  <th className="num">Casos</th>
                  <th className="num">Fallos de esquema</th>
                  <th className="num">Coste USD</th>
                  <th>Veredicto</th>
                  <th>Creada</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((item) => (
                  <tr key={item.id} className={item.id === runId ? 'cp-row-selected' : ''}>
                    <td>
                      <input
                        type="radio"
                        name="run"
                        checked={item.id === runId}
                        onChange={() => setRunId(item.id)}
                        aria-label={`Seleccionar corrida ${item.name || item.id}`}
                      />
                    </td>
                    <td><strong>{item.name || item.id.slice(0, 8)}</strong></td>
                    <td>{item.dataset_code || '—'}</td>
                    <td>{item.model_name || '—'}</td>
                    <td><span className="pill">{item.status_code}</span></td>
                    <td className="num mono">{formatNumber(item.items_predicted)} / {formatNumber(item.items_total)}</td>
                    <td className="num mono">{formatNumber(item.schema_violations)}</td>
                    <td className="num mono">{Number(item.total_cost_usd || 0).toFixed(2)}</td>
                    <td>{item.verdict || '—'}</td>
                    <td className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {runId && (
        <>
          <div className="grid grid-2">
            <section className="tile">
              <div className="tile-head">
                <h3 className="tile-title">Puerta de promocion</h3>
                <button type="button" className="btn btn-sm" onClick={recompute} disabled={computing}>
                  <Play size={13} aria-hidden="true" /> Recalcular metricas
                </button>
              </div>
              {gate.error ? (
                <ErrorState compact error={gate.error} onRetry={gate.reload} />
              ) : gate.loading ? (
                <SkeletonTile lines={2} title={false} />
              ) : gate.data ? (
                <div className={`cp-gate ${gate.data.passed ? 'is-pass' : 'is-fail'}`}>
                  {gate.data.passed
                    ? <CheckCircle2 size={22} aria-hidden="true" />
                    : <XCircle size={22} aria-hidden="true" />}
                  <div>
                    <strong>{gate.data.passed ? 'Puede promoverse' : 'No puede promoverse'}</strong>
                    <p className="text-muted">{gate.data.reason}</p>
                  </div>
                </div>
              ) : (
                <EmptyState compact title="La corrida no tiene metricas calculadas" />
              )}
            </section>

            <section className="tile">
              <div className="tile-head"><h3 className="tile-title">Comparacion contra la linea base</h3></div>
              {!run?.baseline_run_id ? (
                <EmptyState compact title="La corrida no declara linea base" message="Sin base de comparacion, una metrica aislada no dice si el cambio mejora algo." />
              ) : comparison.error ? (
                <ErrorState compact error={comparison.error} onRetry={comparison.reload} />
              ) : comparison.loading ? (
                <SkeletonRows rows={4} />
              ) : (
                <div className="cp-table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Tarea</th><th>Corte</th><th>Metrica</th><th className="num">Base</th><th className="num">Candidata</th><th className="num">Delta</th><th>Veredicto</th></tr>
                    </thead>
                    <tbody>
                      {(comparison.data || []).map((row, index) => (
                        <tr key={`${row.task}-${row.slice}-${row.metric}-${index}`}>
                          <td>{row.task}</td>
                          <td className="mono">{row.slice}</td>
                          <td>{row.metric}</td>
                          <td className="num mono">{Number(row.baseline).toFixed(3)}</td>
                          <td className="num mono">{Number(row.candidate).toFixed(3)}</td>
                          <td className={`num mono ${row.delta >= 0 ? 'text-success' : 'text-danger'}`}>
                            {row.delta > 0 ? '+' : ''}{Number(row.delta).toFixed(3)}
                          </td>
                          <td><span className="pill">{row.verdict}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="tile">
            <div className="tile-head"><h3 className="tile-title">Metricas por corte</h3></div>
            {metrics.error ? (
              <ErrorState error={metrics.error} onRetry={metrics.reload} />
            ) : metrics.loading ? (
              <SkeletonRows rows={5} />
            ) : Object.keys(bySlice).length === 0 ? (
              <EmptyState compact title="Sin metricas para esta tarea" message="Use «Recalcular metricas» si la corrida ya termino." />
            ) : (
              Object.entries(bySlice).map(([slice, rows]) => (
                <div key={slice} className="cp-slice">
                  <h4 className="mono">{slice}</h4>
                  <div className="cp-table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>Clase</th><th>Metrica</th><th className="num">Valor</th><th className="num">Soporte</th><th className="num">IC 95 %</th></tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={`${row.class_code}-${row.metric_name}-${index}`}>
                            <td>{row.class_code}</td>
                            <td>{row.metric_name}</td>
                            <td className="num mono">{Number(row.metric_value).toFixed(4)}</td>
                            <td className="num mono">{row.support === null ? '—' : formatNumber(row.support)}</td>
                            <td className="num mono">
                              {row.ci_lower === null || row.ci_upper === null
                                ? '—'
                                : `${Number(row.ci_lower).toFixed(3)} – ${Number(row.ci_upper).toFixed(3)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </section>

          <div className="grid grid-2">
            <section className="tile">
              <div className="tile-head"><h3 className="tile-title">Matriz de confusion · {task}</h3></div>
              {confusion.error ? (
                <ErrorState compact error={confusion.error} onRetry={confusion.reload} />
              ) : confusion.loading ? (
                <SkeletonRows rows={4} />
              ) : (
                <ConfusionMatrix cells={confusion.data || []} />
              )}
            </section>

            <section className="tile">
              <div className="tile-head">
                <h3 className="tile-title">Analisis de errores</h3>
                <span className="tile-sub">Casos fallidos y violaciones de esquema</span>
              </div>
              {errors.error ? (
                <ErrorState compact error={errors.error} onRetry={errors.reload} />
              ) : errors.loading ? (
                <SkeletonRows rows={5} />
              ) : (errors.data || []).length === 0 ? (
                <EmptyState compact title="Sin errores para esta tarea" />
              ) : (
                <ul className="cp-error-list">
                  {errors.data.map((item) => (
                    <li key={item.prediction_id}>
                      <p>{truncate(item.text, 220)}</p>
                      <div className="row row-wrap">
                        <span className="pill">real: {item[`gold_${task}`] ?? '—'}</span>
                        <span className="pill cp-flag-risk">predicho: {item[`pred_${task}`] ?? '—'}</span>
                        {item.confidence !== null && <span className="pill mono">confianza {Number(item.confidence).toFixed(2)}</span>}
                        {item.difficulty && <span className="pill">{item.difficulty}</span>}
                        {(item.phenomena || []).map((phenomenon) => <span key={phenomenon} className="pill">{phenomenon}</span>)}
                        {item.is_contested && <span className="pill cp-rel-warn">caso disputado</span>}
                        {!item.schema_valid && <span className="pill cp-flag-risk">esquema invalido</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default EvaluationPage;
