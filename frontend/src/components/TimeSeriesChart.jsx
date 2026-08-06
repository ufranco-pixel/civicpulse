/**
 * Serie temporal de sentimiento.
 *
 * Tres capas sobre el mismo eje temporal:
 *   · area apilada con el volumen por clase de sentimiento,
 *   · linea de la media movil de 7 dias que publica la funcion SQL
 *     (`rolling_avg_7`), que es la que hay que mirar para la tendencia,
 *   · marcadores en los dias con `is_spike`.
 *
 * Los puntos con `is_reliable=false` se pintan en el area (el volumen es un
 * hecho) pero NO alimentan la linea de tendencia: interpolar la media sobre
 * dias de muestra minima produce una curva que no significa nada.
 */
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceDot,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatDate, formatNumber } from '../config/format.js';
import InfoTooltip from './InfoTooltip.jsx';
import EmptyState from './EmptyState.jsx';

const axisStyle = { fontSize: 11, fill: 'var(--c-text-subtle)' };

export function TimeSeriesChart({ points = [], height = 320, title = 'Evolucion de la conversacion' }) {
  const { getMetric } = useCatalogs();
  const metric = getMetric('net_sentiment');

  if (!points || points.length === 0) {
    return (
      <section className="tile">
        <div className="tile-head"><h3 className="tile-title">{title}</h3></div>
        <EmptyState compact title="Sin serie temporal para el periodo elegido" />
      </section>
    );
  }

  const data = points.map((point) => ({
    period: point.period,
    label: formatDate(point.period),
    positivos: point.positive_count,
    neutrales: point.neutral_count,
    negativos: point.negative_count,
    mixtos: point.mixed_count,
    total: point.total_count,
    // La media movil solo existe donde la muestra da: null corta la linea.
    tendencia: point.is_reliable ? point.rolling_avg_7 : null,
    neto: point.net_sentiment,
    is_spike: point.is_spike,
    is_reliable: point.is_reliable,
  }));

  const spikes = data.filter((point) => point.is_spike);

  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-title">
          {title}
          <InfoTooltip
            title="Como leer esta grafica"
            text={`El area es el volumen por clase de sentimiento. La linea es la media movil de 7 dias del puntaje, y solo se dibuja en los dias con muestra suficiente. Los puntos ambar marcan picos de volumen. ${metric.caveat || ''}`}
          />
        </h3>
        <div className="row" style={{ gap: 'var(--sp-2)' }}>
          {spikes.length > 0 && <span className="pill">{spikes.length} pico(s) de volumen</span>}
        </div>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" vertical={false} />
            <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: 'var(--c-border)' }} minTickGap={24} />
            <YAxis yAxisId="vol" tick={axisStyle} tickLine={false} axisLine={false} width={54} />
            <YAxis yAxisId="score" orientation="right" domain={[-1, 1]} tick={axisStyle} tickLine={false} axisLine={false} width={44} />
            <Tooltip
              contentStyle={{
                background: 'var(--c-surface)',
                border: '1px solid var(--c-border)',
                borderRadius: 'var(--r-sm)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--c-text)',
              }}
              formatter={(value, name) => [
                name === 'tendencia' ? Number(value).toFixed(3) : formatNumber(value),
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-xs)', color: 'var(--c-text-muted)' }} />

            <Area yAxisId="vol" type="monotone" dataKey="positivos" stackId="s" stroke="var(--c-positive)" fill="var(--c-positive)" fillOpacity={0.35} isAnimationActive={false} />
            <Area yAxisId="vol" type="monotone" dataKey="neutrales" stackId="s" stroke="var(--c-neutral)" fill="var(--c-neutral)" fillOpacity={0.28} isAnimationActive={false} />
            <Area yAxisId="vol" type="monotone" dataKey="mixtos" stackId="s" stroke="var(--c-mixed)" fill="var(--c-mixed)" fillOpacity={0.28} isAnimationActive={false} />
            <Area yAxisId="vol" type="monotone" dataKey="negativos" stackId="s" stroke="var(--c-negative)" fill="var(--c-negative)" fillOpacity={0.35} isAnimationActive={false} />

            <Line
              yAxisId="score"
              type="monotone"
              dataKey="tendencia"
              stroke="var(--c-brand)"
              strokeWidth={2.4}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />

            {spikes.map((spike) => (
              <ReferenceDot
                key={spike.period}
                yAxisId="vol"
                x={spike.label}
                y={spike.total}
                r={5}
                fill="var(--c-accent)"
                stroke="var(--c-surface)"
                strokeWidth={2}
                isFront
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export default TimeSeriesChart;
