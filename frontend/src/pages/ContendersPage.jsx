/**
 * Comparativa entre contendientes.
 *
 * El aviso metodologico encabeza la pagina: es donde mas facil resulta
 * confundir "quien lleva la conversacion" con "quien va ganando".
 */
import { useState } from 'react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { getCoordination, getContenders } from '../services/campaigns.service.js';
import { brand } from '../config/brand.js';
import { formatDateTime, formatNumber, truncate } from '../config/format.js';
import PageHeader, { ALL_TIME, resolveDays } from '../components/PageHeader.jsx';
import ContenderTable from '../components/ContenderTable.jsx';
import MetricCard from '../components/MetricCard.jsx';
import ErrorState from '../components/ErrorState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonTile } from '../components/SkeletonTile.jsx';

export function ContendersPage() {
  const { code } = useCampaign();
  const [days, setDays] = useState(ALL_TIME);

  const contenders = useApi(({ signal }) => getContenders(code, { days: resolveDays(days) }, { signal }), [code, days], { enabled: Boolean(code) });
  const coordination = useApi(({ signal }) => getCoordination(code, { hours: 24, min_authors: 3 }, { signal }), [code], { enabled: Boolean(code) });

  if (!code) return <EmptyState title="Seleccione una campana" />;

  const rows = contenders.data || [];
  const own = rows.find((row) => row.is_own) || null;

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Contendientes"
        description="Voz, postura y momentum de cada actor en la conversacion publica."
        days={days}
        onDaysChange={setDays}
        onReload={() => { contenders.reload(); coordination.reload(); }}
        periods={[7, 14, 30, 60]}
      />


      {own && (
        <div className="grid grid-4">
          <MetricCard metricCode="share_of_voice" value={own.share_of_voice} sampleSize={own.mentions} isReliable={own.is_reliable} label={`Voz · ${own.contender_name}`} />
          <MetricCard metricCode="net_support" value={own.net_support} delta={own.competitive_momentum} sampleSize={own.mentions} isReliable={own.is_reliable} />
          <MetricCard metricCode="support_wilson_lb" value={own.support_wilson_lb} sampleSize={own.mentions} isReliable={own.is_reliable} />
          <MetricCard metricCode="attention_share" value={own.attention_share} sampleSize={own.mentions} isReliable={own.is_reliable} />
        </div>
      )}

      {contenders.error ? (
        <ErrorState error={contenders.error} onRetry={contenders.reload} />
      ) : contenders.loading ? (
        <SkeletonTile height={320} lines={5} />
      ) : (
        <ContenderTable contenders={rows} days={days} />
      )}

      <section className="tile">
        <div className="tile-head">
          <h3 className="tile-title">Indicios de coordinacion · ultimas 24 h</h3>
          <span className="tile-sub">Textos casi identicos publicados por autores distintos</span>
        </div>
        {coordination.error ? (
          <ErrorState compact error={coordination.error} onRetry={coordination.reload} />
        ) : coordination.loading ? (
          <SkeletonTile lines={3} title={false} />
        ) : (coordination.data || []).length === 0 ? (
          <EmptyState compact title="Sin replicas detectadas en la ventana" />
        ) : (
          <div className="cp-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Texto</th>
                  <th className="num">Copias</th>
                  <th className="num">Autores</th>
                  <th className="num">Difusion</th>
                  <th>Fuentes</th>
                  <th>Primera vez</th>
                </tr>
              </thead>
              <tbody>
                {coordination.data.map((signal) => (
                  <tr key={signal.fingerprint_hex}>
                    <td>{truncate(signal.sample_text, 160)}</td>
                    <td className="num mono">{formatNumber(signal.copies)}</td>
                    <td className="num mono">{formatNumber(signal.distinct_authors)}</td>
                    <td className="num mono">{signal.spread_minutes === null ? '—' : `${Math.round(signal.spread_minutes)} min`}</td>
                    <td>{(signal.sources || []).map((source) => <span key={source} className="pill">{source}</span>)}</td>
                    <td className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(signal.first_seen)}</td>
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

export default ContendersPage;
