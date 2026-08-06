/**
 * Resumen de campana.
 *
 * Todo sale de la API: `campaign_overview`, `sentiment_timeseries`,
 * `crisis_risk` y `topic_agenda`. Cuando `is_reliable` viene en falso, el
 * bloque entero se atenua y las tarjetas dejan de mostrar deltas.
 */
import { useState } from 'react';
import { Activity, AlertTriangle, ServerCrash } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { getCrisis, getOverview, getTimeseries, getTopics } from '../services/campaigns.service.js';
import { formatDateTime, formatNumber } from '../config/format.js';
import PageHeader, { ALL_TIME, periodLabel, resolveDays } from '../components/PageHeader.jsx';
import MetricCard from '../components/MetricCard.jsx';
import SentimentDonut from '../components/SentimentDonut.jsx';
import TimeSeriesChart from '../components/TimeSeriesChart.jsx';
import TopicTreemap from '../components/TopicTreemap.jsx';
import CrisisGauge from '../components/CrisisGauge.jsx';
import ErrorState from '../components/ErrorState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonGrid, SkeletonTile } from '../components/SkeletonTile.jsx';

export function OverviewPage() {
  const { code, campaign, loading: campaignLoading } = useCampaign();
  const [days, setDays] = useState(ALL_TIME);

  const overview = useApi(
    ({ signal }) => getOverview(code, { days: resolveDays(days) }, { signal }),
    [code, days],
    { enabled: Boolean(code) },
  );
  const series = useApi(
    ({ signal }) => getTimeseries(code, { days: resolveDays(days) }, { signal }),
    [code, days],
    { enabled: Boolean(code) },
  );
  const crisis = useApi(
    ({ signal }) => getCrisis(code, { hours: 24 }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );
  const topics = useApi(
    ({ signal }) => getTopics(code, { days: resolveDays(days), limit: 8 }, { signal }),
    [code, days],
    { enabled: Boolean(code) },
  );

  if (!code && !campaignLoading) {
    return <EmptyState title="No hay ninguna campana seleccionada" message="Elija una campana en la cabecera para ver sus indicadores." />;
  }

  const data = overview.data;
  const points = series.data || [];
  const sparkNet = points.map((point) => point.net_sentiment).filter((value) => value !== null && value !== undefined);
  const sparkVolume = points.map((point) => point.total_count);
  const reliable = Boolean(data?.is_reliable);

  const reloadAll = () => { overview.reload(); series.reload(); crisis.reload(); topics.reload(); };

  return (
    <div className="stack animate-in">
      <PageHeader
        title={campaign ? campaign.name : 'Resumen'}
        description={`Conversacion publica de ${periodLabel(days)}${data?.last_updated ? ` · actualizado ${formatDateTime(data.last_updated)}` : ''}`}
        days={days}
        onDaysChange={setDays}
        onReload={reloadAll}
      />

      {overview.error ? (
        <ErrorState error={overview.error} onRetry={overview.reload} />
      ) : overview.loading ? (
        <SkeletonGrid count={8} />
      ) : !data ? (
        <EmptyState title="Sin datos de resumen para el periodo" />
      ) : (
        <>
          {!reliable && (
            <p className="cp-banner-warn">
              <AlertTriangle size={14} aria-hidden="true" />
              El volumen del periodo esta por debajo del minimo publicable. Los porcentajes se muestran atenuados y no deben citarse.
            </p>
          )}

          <div className="grid grid-auto">
            <MetricCard
              metricCode="mention_volume"
              value={data.total_mentions}
              sampleSize={data.total_mentions}
              isReliable={reliable}
              sparkline={sparkVolume}
            />
            <MetricCard
              metricCode="unique_authors"
              value={data.unique_authors}
              sampleSize={data.total_mentions}
              isReliable={reliable}
            />
            <MetricCard
              metricCode="net_sentiment"
              value={data.net_sentiment}
              sampleSize={data.total_mentions}
              isReliable={reliable}
              sparkline={sparkNet}
            />
            <MetricCard
              metricCode="avg_sentiment_score"
              value={data.avg_sentiment_score}
              delta={data.sentiment_momentum}
              sampleSize={data.total_mentions}
              isReliable={reliable}
              footnote="El delta es el momentum: diferencia con la ventana previa de igual duracion."
            />
            <MetricCard
              metricCode="negative_pct"
              value={data.negative_pct}
              sampleSize={data.total_mentions}
              isReliable={reliable}
            />
            <MetricCard
              metricCode="polarization_index"
              value={data.polarization_index}
              sampleSize={data.total_mentions}
              isReliable={reliable}
            />
            <MetricCard
              metricCode="toxicity_avg"
              value={data.avg_toxicity}
              sampleSize={data.total_mentions}
              isReliable={reliable}
            />
          </div>

          <div className="grid grid-3">
            <div className="tile cp-ops-tile">
              <div className="tile-head"><h3 className="tile-title"><Activity size={15} aria-hidden="true" /> Estado operativo</h3></div>
              <ul className="cp-kv">
                <li><span>Alertas abiertas</span><b className="mono">{formatNumber(data.open_alerts)}</b></li>
                <li><span>Alertas criticas</span><b className="mono">{formatNumber(data.critical_alerts)}</b></li>
                <li><span>Pendientes de revision</span><b className="mono">{formatNumber(data.review_backlog)}</b></li>
                <li>
                  <span>Fuentes sanas</span>
                  <b className="mono">
                    {formatNumber(data.sources_healthy)} / {formatNumber(data.sources_total)}
                  </b>
                </li>
                <li><span>Alcance estimado</span><b className="mono">{formatNumber(data.total_reach)}</b></li>
              </ul>
              {data.sources_healthy < data.sources_total && (
                <p className="cp-metric-warn">
                  <ServerCrash size={13} aria-hidden="true" />
                  Hay fuentes degradadas: una caida de volumen puede deberse a la recoleccion, no a la conversacion.
                </p>
              )}
            </div>

            <SentimentDonut
              positive={data.positive_count}
              neutral={data.neutral_count}
              negative={data.negative_count}
              mixed={data.mixed_count}
              isReliable={reliable}
            />

            {crisis.loading ? <SkeletonTile /> : crisis.error
              ? <ErrorState compact error={crisis.error} onRetry={crisis.reload} />
              : <CrisisGauge crisis={crisis.data} hours={24} />}
          </div>
        </>
      )}

      {series.error ? (
        <ErrorState error={series.error} onRetry={series.reload} />
      ) : series.loading ? (
        <SkeletonTile height={320} lines={1} />
      ) : (
        <TimeSeriesChart points={points} />
      )}

      {topics.error ? (
        <ErrorState error={topics.error} onRetry={topics.reload} />
      ) : topics.loading ? (
        <SkeletonTile height={300} />
      ) : (
        <TopicTreemap topics={topics.data || []} height={260} title="Temas dominantes" />
      )}
    </div>
  );
}

export default OverviewPage;
