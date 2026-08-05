/**
 * Tabla de contenidos analizados.
 *
 * Las claves de los bloques JSON son las que construye la vista
 * `civic_api.inferences`:
 *   emotions   {code, label, score, dominant}
 *   stances    {contender_id, contender, stance, score, confidence, method, evidence}
 *   topics     {category, label, relevance, sentiment, primary}
 *   entities   {text, type, sentiment}
 *   risk_flags {code, label, score, severity, review_state}
 *
 * La fila desplegada muestra el fragmento de evidencia de cada postura: sin el
 * no hay forma de auditar por que el modelo atribuyo esa postura a ese actor.
 */
import { Fragment, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, ExternalLink, PencilLine, Search, X,
} from 'lucide-react';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatCompact, formatDateTime, formatNumber, truncate } from '../config/format.js';
import EmptyState from './EmptyState.jsx';
import ErrorState from './ErrorState.jsx';
import { SkeletonRows } from './SkeletonTile.jsx';

const STANCE_CLASS = {
  favor: 'badge-favor',
  lean_favor: 'badge-favor',
  against: 'badge-against',
  lean_against: 'badge-against',
  undecided: 'badge-undecided',
  neutral: 'badge-neutral',
  unclear: 'badge-neutral',
};

function SentimentBadge({ code, label }) {
  const cls = { positive: 'badge-positive', negative: 'badge-negative', mixed: 'badge-mixed' }[code] || 'badge-neutral';
  return <span className={`badge ${cls}`}>{label || code}</span>;
}

export function ContentTable({
  items = [],
  total = 0,
  page = 1,
  pageSize = 50,
  filters = {},
  onFiltersChange,
  onPageChange,
  loading = false,
  error = null,
  onReload,
  onAnnotate,
  contenders = [],
}) {
  const { catalog, getLabel } = useCatalogs();
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState(filters.q || '');

  const setFilter = (patch) => onFiltersChange?.({ ...filters, ...patch, page: 1 });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeFilters = Object.entries(filters).filter(
    ([key, value]) => !['page', 'page_size'].includes(key) && value !== undefined && value !== '' && value !== null,
  );

  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-title">Contenidos analizados</h3>
        <span className="tile-sub mono">{formatNumber(total)} resultados</span>
      </div>

      {/* ── Filtros ─────────────────────────────────────────────────────── */}
      <div className="cp-filters">
        <form
          className="cp-search"
          onSubmit={(event) => { event.preventDefault(); setFilter({ q: search || undefined }); }}
        >
          <Search size={14} aria-hidden="true" />
          <input
            className="input"
            type="search"
            placeholder="Buscar en el texto…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar en el texto de los contenidos"
          />
          <button type="submit" className="btn btn-sm">Buscar</button>
        </form>

        <select className="select" value={filters.source_type || ''} onChange={(e) => setFilter({ source_type: e.target.value || undefined })} aria-label="Fuente">
          <option value="">Toda fuente</option>
          {catalog('source_types').map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
        </select>

        <select className="select" value={filters.sentiment || ''} onChange={(e) => setFilter({ sentiment: e.target.value || undefined })} aria-label="Sentimiento">
          <option value="">Todo sentimiento</option>
          {catalog('sentiment_types').map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
        </select>

        <select className="select" value={filters.contender_id || ''} onChange={(e) => setFilter({ contender_id: e.target.value || undefined })} aria-label="Postura hacia">
          <option value="">Toda postura</option>
          {contenders.map((item) => (
            <option key={item.contender_id} value={item.contender_id}>hacia {item.contender_name}</option>
          ))}
        </select>

        <select className="select" value={filters.intent || ''} onChange={(e) => setFilter({ intent: e.target.value || undefined })} aria-label="Intencion">
          <option value="">Toda intencion</option>
          {catalog('intent_types').map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
        </select>

        <select className="select" value={filters.topic || ''} onChange={(e) => setFilter({ topic: e.target.value || undefined })} aria-label="Tema">
          <option value="">Todo tema</option>
          {catalog('topic_categories').map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
        </select>

        <label className="cp-conf-filter">
          <span className="field-label">Confianza min. {filters.min_confidence ?? 0}</span>
          <input
            type="range" min="0" max="1" step="0.05"
            value={filters.min_confidence ?? 0}
            onChange={(e) => setFilter({ min_confidence: Number(e.target.value) || undefined })}
          />
        </label>

        <label className="row" style={{ gap: 'var(--sp-1)', fontSize: 'var(--fs-xs)' }}>
          <input
            type="checkbox"
            checked={filters.needs_review === true}
            onChange={(e) => setFilter({ needs_review: e.target.checked ? true : undefined })}
          />
          Solo pendientes de revision
        </label>
      </div>

      {activeFilters.length > 0 && (
        <div className="cp-active-filters">
          {activeFilters.map(([key, value]) => (
            <button
              key={key}
              type="button"
              className="pill cp-pill-remove"
              onClick={() => setFilter({ [key]: undefined })}
            >
              {key}: {String(value)} <X size={11} aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setSearch(''); onFiltersChange?.({ page: 1, page_size: pageSize }); }}>
            Limpiar todo
          </button>
        </div>
      )}

      {/* ── Cuerpo ──────────────────────────────────────────────────────── */}
      {error ? (
        <ErrorState error={error} onRetry={onReload} />
      ) : loading ? (
        <SkeletonRows rows={8} />
      ) : items.length === 0 ? (
        <EmptyState
          title={activeFilters.length > 0 ? 'Ningun contenido pasa los filtros' : 'Sin contenidos analizados en el periodo'}
          message={activeFilters.length > 0 ? 'Pruebe a ampliar el rango o quitar algun filtro.' : undefined}
          action={activeFilters.length > 0 ? () => onFiltersChange?.({ page: 1, page_size: pageSize }) : undefined}
          actionLabel="Limpiar filtros"
        />
      ) : (
        <div className="cp-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Contenido</th>
                <th style={{ width: 130 }}>Fuente</th>
                <th style={{ width: 110 }}>Sentimiento</th>
                <th style={{ width: 96 }} className="num">Confianza</th>
                <th style={{ width: 92 }} className="num">Alcance</th>
                <th style={{ width: 150 }}>Publicado</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const isOpen = expanded === row.id;
                const risky = (row.risk_flags || []).length > 0;
                const sarcastic = Number(row.sarcasm_score || 0) >= 0.6;

                return (
                  <Fragment key={row.id}>
                    <tr className={row.needs_review ? 'cp-row-review' : ''}>
                      <td>
                        <button
                          type="button"
                          className="btn-icon btn-ghost"
                          aria-label={isOpen ? 'Contraer detalle' : 'Expandir detalle'}
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : row.id)}
                        >
                          {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                        </button>
                      </td>
                      <td>
                        <div className="cp-content-text">{truncate(row.text, 170)}</div>
                        <div className="cp-content-tags">
                          {row.intent_label && <span className="pill">{row.intent_label}</span>}
                          {(row.topics || []).slice(0, 2).map((topic) => (
                            <span key={topic.category} className="pill">{topic.label}</span>
                          ))}
                          {sarcastic && (
                            <span className="pill cp-rel-warn" title="Ironia alta: la lectura literal del sentimiento puede ser incorrecta.">
                              ironia {Number(row.sarcasm_score).toFixed(2)}
                            </span>
                          )}
                          {risky && (
                            <span className="pill cp-flag-risk">
                              <AlertTriangle size={11} aria-hidden="true" /> {row.risk_flags.length} bandera(s)
                            </span>
                          )}
                          {row.needs_review && <span className="pill cp-flag-review">pendiente de revision</span>}
                        </div>
                      </td>
                      <td>
                        <span className="pill">{row.source_label || row.source_type}</span>
                        <div className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>{row.source_name}</div>
                      </td>
                      <td>
                        <SentimentBadge code={row.sentiment_code} label={row.sentiment_label} />
                        <div className="mono text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>
                          {Number(row.sentiment_score).toFixed(2)}
                        </div>
                      </td>
                      <td className="num mono">{Number(row.overall_confidence).toFixed(2)}</td>
                      <td className="num mono">{formatCompact(row.reach_estimate)}</td>
                      <td className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(row.published_at)}</td>
                      <td>
                        {row.url && (
                          <a href={row.url} target="_blank" rel="noreferrer noopener" className="btn-icon btn-ghost" aria-label="Abrir publicacion original">
                            <ExternalLink size={14} aria-hidden="true" />
                          </a>
                        )}
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="cp-row-detail">
                        <td colSpan={8}>
                          <div className="cp-detail">
                            <div className="cp-detail-main">
                              <h4>Texto completo</h4>
                              <p className="cp-detail-text">{row.text}</p>

                              {(row.stances || []).length > 0 && (
                                <>
                                  <h4>Postura por contendiente</h4>
                                  <ul className="cp-stance-list">
                                    {row.stances.map((stance) => (
                                      <li key={`${stance.contender_id}-${stance.stance}`}>
                                        <div className="row">
                                          <strong>{stance.contender}</strong>
                                          <span className={`badge ${STANCE_CLASS[stance.stance] || 'badge-neutral'}`}>
                                            {getLabel('stance_types', stance.stance)}
                                          </span>
                                          <span className="pill mono">confianza {Number(stance.confidence ?? 0).toFixed(2)}</span>
                                          {stance.method && <span className="pill">{stance.method}</span>}
                                        </div>
                                        {stance.evidence && (
                                          <blockquote className="cp-evidence">“{stance.evidence}”</blockquote>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                            </div>

                            <div className="cp-detail-side">
                              {(row.emotions || []).length > 0 && (
                                <div>
                                  <h4>Emociones</h4>
                                  <div className="row row-wrap">
                                    {row.emotions.map((emotion) => (
                                      <span key={emotion.code} className={`pill ${emotion.dominant ? 'cp-pill-strong' : ''}`}>
                                        {emotion.label} <b className="mono">{Number(emotion.score ?? 0).toFixed(2)}</b>
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {(row.entities || []).length > 0 && (
                                <div>
                                  <h4>Entidades</h4>
                                  <div className="row row-wrap">
                                    {row.entities.slice(0, 14).map((entity, index) => (
                                      <span key={`${entity.text}-${index}`} className="pill" title={getLabel('entity_types', entity.type)}>
                                        {entity.text}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {(row.risk_flags || []).length > 0 && (
                                <div>
                                  <h4>Banderas de riesgo</h4>
                                  <div className="row row-wrap">
                                    {row.risk_flags.map((flag) => (
                                      <span key={flag.code} className={`badge badge-${flag.severity || 'medium'}`}>
                                        {flag.label} · {Number(flag.score ?? 0).toFixed(2)}
                                        {flag.review_state ? ` · ${flag.review_state}` : ''}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              <dl className="cp-detail-meta">
                                <div><dt>Toxicidad</dt><dd className="mono">{row.toxicity_score ?? '—'}</dd></div>
                                <div><dt>Ironia</dt><dd className="mono">{row.sarcasm_score ?? '—'}</dd></div>
                                <div><dt>Revision</dt><dd>{row.review_status}</dd></div>
                                <div><dt>Analizado</dt><dd>{formatDateTime(row.analyzed_at)}</dd></div>
                              </dl>

                              {onAnnotate && (
                                <button type="button" className="btn btn-primary btn-sm" onClick={() => onAnnotate(row)}>
                                  <PencilLine size={13} aria-hidden="true" /> Corregir clasificacion
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Paginacion ──────────────────────────────────────────────────── */}
      {total > pageSize && (
        <div className="cp-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPageChange?.(page - 1)}>Anterior</button>
          <span className="mono text-subtle">pagina {page} de {totalPages}</span>
          <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => onPageChange?.(page + 1)}>Siguiente</button>
        </div>
      )}
    </section>
  );
}

export default ContentTable;
