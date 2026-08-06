/**
 * Agenda tematica y entidades.
 *
 * El peso de un tema no dice si beneficia o perjudica: por eso la barra va
 * coloreada por el sentimiento del tema y la tabla muestra el porcentaje
 * negativo al lado del crecimiento.
 */
import { useState } from 'react';
import { Flame } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { getEntities, getTopics } from '../services/campaigns.service.js';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatNumber, isNil } from '../config/format.js';
import PageHeader, { ALL_TIME, resolveDays } from '../components/PageHeader.jsx';
import TopicTreemap from '../components/TopicTreemap.jsx';
import ErrorState from '../components/ErrorState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import InfoTooltip from '../components/InfoTooltip.jsx';
import { SkeletonTile } from '../components/SkeletonTile.jsx';

export function AgendaPage() {
  const { code } = useCampaign();
  const { getMetric, getLabel, catalog } = useCatalogs();
  const [days, setDays] = useState(ALL_TIME);
  const [entityType, setEntityType] = useState('');

  const topics = useApi(({ signal }) => getTopics(code, { days: resolveDays(days), limit: 25 }, { signal }), [code, days], { enabled: Boolean(code) });
  const entities = useApi(
    ({ signal }) => getEntities(code, { limit: 30, entity_type: entityType || undefined, months: 6 }, { signal }),
    [code, entityType],
    { enabled: Boolean(code) },
  );

  if (!code) return <EmptyState title="Seleccione una campana" />;

  const growth = getMetric('topic_growth');
  const rows = topics.data || [];
  const entityTypes = catalog('entity_types');

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Agenda"
        description="De que habla la conversacion y con que carga."
        days={days}
        onDaysChange={setDays}
        onReload={() => { topics.reload(); entities.reload(); }}
      />

      {topics.error ? (
        <ErrorState error={topics.error} onRetry={topics.reload} />
      ) : topics.loading ? (
        <SkeletonTile height={380} />
      ) : (
        <TopicTreemap topics={rows} />
      )}

      <section className="tile">
        <div className="tile-head">
          <h3 className="tile-title">
            Detalle por tema
            <InfoTooltip title={growth.label} text={growth.caveat} />
          </h3>
        </div>
        {topics.loading ? <SkeletonTile lines={4} title={false} /> : rows.length === 0 ? (
          <EmptyState compact title="Sin temas en el periodo" />
        ) : (
          <div className="cp-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tema</th>
                  <th>Dimension</th>
                  <th className="num">Menciones</th>
                  <th className="num">Peso</th>
                  <th className="num">Sentimiento</th>
                  <th className="num">% negativo</th>
                  <th className="num">Crecimiento</th>
                  <th>Marcas</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((topic) => (
                  <tr key={topic.category_code} className={topic.is_reliable ? '' : 'unreliable'}>
                    <td><strong>{topic.label_es}</strong></td>
                    <td className="text-subtle">{topic.dimension || '—'}</td>
                    <td className="num mono">{formatNumber(topic.mentions)}</td>
                    <td className="num mono">{isNil(topic.topic_share) ? '—' : `${Number(topic.topic_share).toFixed(1)} %`}</td>
                    <td className="num mono">{isNil(topic.avg_sentiment) ? '—' : Number(topic.avg_sentiment).toFixed(2)}</td>
                    <td className="num mono">{isNil(topic.negative_pct) ? '—' : `${Number(topic.negative_pct).toFixed(1)} %`}</td>
                    <td className="num mono">
                      {topic.is_reliable && !isNil(topic.topic_growth) ? `${Number(topic.topic_growth) > 0 ? '+' : ''}${Number(topic.topic_growth).toFixed(1)} %` : '—'}
                    </td>
                    <td>
                      {topic.is_emerging && <span className="pill cp-flag-emerging"><Flame size={11} aria-hidden="true" /> emergente</span>}
                      {topic.is_owned_issue && <span className="pill">tema propio</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="tile">
        <div className="tile-head">
          <h3 className="tile-title">Entidades mas mencionadas · ultimos 6 meses</h3>
          <select className="select" style={{ width: 'auto' }} value={entityType} onChange={(event) => setEntityType(event.target.value)} aria-label="Tipo de entidad">
            <option value="">Todo tipo</option>
            {entityTypes.map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
          </select>
        </div>
        {entities.error ? (
          <ErrorState compact error={entities.error} onRetry={entities.reload} />
        ) : entities.loading ? (
          <SkeletonTile lines={4} title={false} />
        ) : (entities.data || []).length === 0 ? (
          <EmptyState compact title="Sin entidades registradas" />
        ) : (
          <div className="cp-entities">
            {entities.data.map((entity) => {
              const tone = isNil(entity.avg_sentiment)
                ? 'var(--c-neutral)'
                : Number(entity.avg_sentiment) > 0.15 ? 'var(--c-positive)'
                  : Number(entity.avg_sentiment) < -0.15 ? 'var(--c-negative)' : 'var(--c-neutral)';
              return (
                <span
                  key={`${entity.entity_type_code}-${entity.entity_text}`}
                  className="cp-entity"
                  style={{ borderColor: tone }}
                  title={`${getLabel('entity_types', entity.entity_type_code)} · ${formatNumber(entity.frequency)} menciones · sentimiento ${entity.avg_sentiment ?? '—'}`}
                >
                  {entity.entity_text}
                  <b className="mono">{formatNumber(entity.frequency)}</b>
                </span>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export default AgendaPage;
