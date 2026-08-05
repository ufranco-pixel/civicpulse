/**
 * Reparto de sentimiento.
 *
 * Se pintan los CUATRO valores del catalogo, incluido `mixed`: agrupar mixto
 * con neutral (que es lo que hace casi todo tablero) borra justo los textos
 * que contienen las dos valoraciones a la vez, que son los mas informativos.
 */
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatNumber, pct } from '../config/format.js';
import InfoTooltip from './InfoTooltip.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import EmptyState from './EmptyState.jsx';

const SLICES = [
  { key: 'positive', color: 'var(--c-positive)' },
  { key: 'neutral', color: 'var(--c-neutral)' },
  { key: 'negative', color: 'var(--c-negative)' },
  { key: 'mixed', color: 'var(--c-mixed)' },
];

export function SentimentDonut({
  positive = 0, neutral = 0, negative = 0, mixed = 0,
  isReliable = true, minSampleSize = null, height = 240, title = 'Reparto de sentimiento',
}) {
  const { getLabel, getMetric } = useCatalogs();
  const counts = { positive, neutral, negative, mixed };
  const total = SLICES.reduce((sum, slice) => sum + (Number(counts[slice.key]) || 0), 0);

  const data = SLICES
    .map((slice) => ({
      name: getLabel('sentiment_types', slice.key),
      code: slice.key,
      value: Number(counts[slice.key]) || 0,
      color: slice.color,
    }))
    .filter((item) => item.value > 0);

  const metric = getMetric('net_sentiment');

  return (
    <section className={`tile ${isReliable ? '' : 'unreliable'}`}>
      <div className="tile-head">
        <h3 className="tile-title">
          {title}
          <InfoTooltip
            title="Sentimiento"
            text={metric.caveat || 'Mide la valoracion expresada en el texto, no la intencion de voto.'}
          />
        </h3>
        <ReliabilityBadge isReliable={isReliable} sampleSize={total} minSampleSize={minSampleSize} />
      </div>

      {total === 0 ? (
        <EmptyState compact title="Sin contenidos clasificados en el periodo" />
      ) : (
        <>
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="58%"
                  outerRadius="82%"
                  paddingAngle={2}
                  stroke="var(--c-surface)"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {data.map((entry) => <Cell key={entry.code} fill={entry.color} />)}
                </Pie>
                <Tooltip
                  formatter={(value, name) => [`${formatNumber(value)} (${pct(value, total)})`, name]}
                  contentStyle={{
                    background: 'var(--c-surface)',
                    border: '1px solid var(--c-border)',
                    borderRadius: 'var(--r-sm)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--c-text)',
                  }}
                />
                <Legend
                  verticalAlign="bottom"
                  iconType="circle"
                  wrapperStyle={{ fontSize: 'var(--fs-xs)', color: 'var(--c-text-muted)' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="cp-donut-legend">
            {data.map((item) => (
              <span key={item.code} className="pill">
                <i style={{ background: item.color }} className="cp-dot" aria-hidden="true" />
                {item.name}: <b className="mono">{pct(item.value, total)}</b>
              </span>
            ))}
            <span className="pill mono">total {formatNumber(total)}</span>
          </div>
        </>
      )}
    </section>
  );
}

export default SentimentDonut;
