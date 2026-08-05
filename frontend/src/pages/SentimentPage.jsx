/**
 * Sentimiento en detalle: serie temporal, reparto, emociones y salud de las
 * fuentes.
 *
 * La salud de las fuentes esta en esta pagina y no escondida en ajustes por un
 * motivo: ante una caida de sentimiento, lo primero que hay que descartar es
 * que una fuente dejara de reportar.
 */
import { useState } from 'react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { getEmotions, getOverview, getSources, getTimeseries } from '../services/campaigns.service.js';
import { formatDateTime, formatNumber } from '../config/format.js';
import PageHeader from '../components/PageHeader.jsx';
import TimeSeriesChart from '../components/TimeSeriesChart.jsx';
import SentimentDonut from '../components/SentimentDonut.jsx';
import EmotionRadar from '../components/EmotionRadar.jsx';
import MetricCard from '../components/MetricCard.jsx';
import ErrorState from '../components/ErrorState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonGrid, SkeletonTile } from '../components/SkeletonTile.jsx';

const HEALTH_CLASS = {
  healthy: 'badge-positive',
  stale: 'badge-medium',
  failing: 'badge-critical',
  inactive: 'badge-neutral',
};

export function SentimentPage() {
  const { code } = useCampaign();
  const [days, setDays] = useState(30);
  const [granularity, setGranularity] = useState('day');

  const overview = useApi(({ signal }) => getOverview(code, { days }, { signal }), [code, days], { enabled: Boolean(code) });
  const series = useApi(({ signal }) => getTimeseries(code, { days, granularity }, { signal }), [code, days, granularity], { enabled: Boolean(code) });
  const emotions = useApi(({ signal }) => getEmotions(code, { days }, { signal }), [code, days], { enabled: Boolean(code) });
  const sources = useApi(({ signal }) => getSources(code, {}, { signal }), [code], { enabled: Boolean(code) });

  if (!code) return <EmptyState title="Seleccione una campana" />;

  const data = overview.data;
  const reliable = Boolean(data?.is_reliable);

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Sentimiento"
        description="Como se distribuye y como evoluciona la valoracion expresada en el texto."
        days={days}
        onDaysChange={setDays}
        onReload={() => { overview.reload(); series.reload(); emotions.reload(); sources.reload(); }}
      >
        <label className="row" style={{ gap: 'var(--sp-2)' }}>
          <span className="field-label">Granularidad</span>
          <select className="select" style={{ width: 'auto' }} value={granularity} onChange={(event) => setGranularity(event.target.value)}>
            <option value="day">Dia</option>
            <option value="week">Semana</option>
            <option value="month">Mes</option>
          </select>
        </label>
      </PageHeader>

      {overview.error ? (
        <ErrorState error={overview.error} onRetry={overview.reload} />
      ) : overview.loading ? (
        <SkeletonGrid count={4} />
      ) : data ? (
        <div className="grid grid-4">
          <MetricCard metricCode="net_sentiment" value={data.net_sentiment} sampleSize={data.total_mentions} isReliable={reliable} />
          <MetricCard metricCode="avg_sentiment_score" value={data.avg_sentiment_score} delta={data.sentiment_momentum} sampleSize={data.total_mentions} isReliable={reliable} />
          <MetricCard metricCode="polarization_index" value={data.polarization_index} sampleSize={data.total_mentions} isReliable={reliable} />
          <MetricCard metricCode="negative_pct" value={data.negative_pct} sampleSize={data.total_mentions} isReliable={reliable} />
        </div>
      ) : null}

      {series.error ? (
        <ErrorState error={series.error} onRetry={series.reload} />
      ) : series.loading ? (
        <SkeletonTile height={340} lines={1} />
      ) : (
        <TimeSeriesChart points={series.data || []} height={340} />
      )}

      <div className="grid grid-2">
        {overview.loading ? <SkeletonTile /> : data && (
          <SentimentDonut
            positive={data.positive_count}
            neutral={data.neutral_count}
            negative={data.negative_count}
            mixed={data.mixed_count}
            isReliable={reliable}
          />
        )}

        {emotions.error ? (
          <ErrorState compact error={emotions.error} onRetry={emotions.reload} />
        ) : emotions.loading ? (
          <SkeletonTile height={300} />
        ) : (
          <EmotionRadar emotions={emotions.data || []} />
        )}
      </div>

      <section className="tile">
        <div className="tile-head">
          <h3 className="tile-title">Salud de las fuentes</h3>
          <span className="tile-sub">Una caida de volumen suele ser una fuente caida, no menos conversacion.</span>
        </div>
        {sources.error ? (
          <ErrorState compact error={sources.error} onRetry={sources.reload} />
        ) : sources.loading ? (
          <SkeletonTile lines={4} title={false} />
        ) : (sources.data || []).length === 0 ? (
          <EmptyState compact title="La campana no tiene fuentes configuradas" />
        ) : (
          <div className="cp-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fuente</th>
                  <th>Tipo</th>
                  <th>Salud</th>
                  <th className="num">24 h</th>
                  <th className="num">7 d</th>
                  <th className="num">Retraso</th>
                  <th>Ultimo exito</th>
                </tr>
              </thead>
              <tbody>
                {sources.data.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <strong>{source.name}</strong>
                      {source.last_error && <div className="text-danger" style={{ fontSize: 'var(--fs-2xs)' }}>{source.last_error}</div>}
                    </td>
                    <td><span className="pill">{source.type_label || source.type_code}</span></td>
                    <td><span className={`badge ${HEALTH_CLASS[source.health] || 'badge-neutral'}`}>{source.health}</span></td>
                    <td className="num mono">{formatNumber(source.volume_24h)}</td>
                    <td className="num mono">{formatNumber(source.volume_7d)}</td>
                    <td className="num mono">{source.lag_minutes === null || source.lag_minutes === undefined ? '—' : `${Math.round(source.lag_minutes)} min`}</td>
                    <td className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(source.last_success_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default SentimentPage;
