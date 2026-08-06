/**
 * Agenda tematica en barras horizontales.
 *
 * Se descarto el treemap: con etiquetas en espanol, los rectangulos pequenos
 * quedan sin texto legible y el usuario tiene que pasar el raton por cada uno.
 * La barra ordenada compara mejor y deja sitio para el sentimiento del tema,
 * que es el dato que da sentido al peso: dominar la conversacion sobre
 * seguridad con sentimiento negativo no es una fortaleza.
 */
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Flame, TrendingUp } from 'lucide-react';
import { formatNumber } from '../config/format.js';
import EmptyState from './EmptyState.jsx';
import InfoTooltip from './InfoTooltip.jsx';
import { useCatalogs } from '../hooks/useCatalogs.js';

/** Verde a rojo segun el sentimiento medio del tema (-1 a 1). */
function toneFor(avgSentiment) {
  if (avgSentiment === null || avgSentiment === undefined) return 'var(--c-neutral)';
  const value = Number(avgSentiment);
  if (value > 0.15) return 'var(--c-positive)';
  if (value < -0.15) return 'var(--c-negative)';
  return 'var(--c-neutral)';
}

export function TopicTreemap({ topics = [], height = 380, title = 'Agenda tematica', onSelect }) {
  const { getMetric } = useCatalogs();
  const metric = getMetric('topic_share');

  if (!topics || topics.length === 0) {
    return (
      <section className="tile">
        <div className="tile-head"><h3 className="tile-title">{title}</h3></div>
        <EmptyState compact title="Sin temas detectados en el periodo" />
      </section>
    );
  }

  const data = topics.map((topic) => ({
    ...topic,
    nombre: topic.label_es || topic.category_code,
    peso: Number(topic.topic_share) || 0,
    tono: toneFor(topic.avg_sentiment),
  }));

  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-title">
          {title}
          <InfoTooltip title={metric.label} text={metric.caveat || metric.definition} />
        </h3>
        <span className="tile-sub">Color = sentimiento medio del tema</span>
      </div>

      <div style={{ height: Math.max(height, data.length * 30) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 46, bottom: 4, left: 8 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="nombre"
              width={168}
              tick={{ fontSize: 11, fill: 'var(--c-text-muted)' }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: 'var(--c-surface-2)' }}
              contentStyle={{
                background: 'var(--c-surface)',
                border: '1px solid var(--c-border)',
                borderRadius: 'var(--r-sm)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--c-text)',
              }}
              formatter={(value, _name, entry) => [
                `${Number(value).toFixed(1)} % · ${formatNumber(entry.payload.mentions)} menciones · sentimiento ${entry.payload.avg_sentiment ?? '—'}`,
                entry.payload.nombre,
              ]}
            />
            <Bar
              dataKey="peso"
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
              onClick={onSelect ? (entry) => onSelect(entry.category_code) : undefined}
              cursor={onSelect ? 'pointer' : undefined}
            >
              {data.map((item) => <Cell key={item.category_code} fill={item.tono} />)}
              <LabelList
                dataKey="peso"
                position="right"
                formatter={(value) => `${Number(value).toFixed(1)} %`}
                style={{ fontSize: 10, fill: 'var(--c-text-subtle)' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="cp-topic-flags">
        {data.filter((t) => t.is_emerging).map((t) => (
          <span key={`e-${t.category_code}`} className="pill cp-flag-emerging">
            <Flame size={11} aria-hidden="true" /> emergente: {t.nombre}
          </span>
        ))}
        {data.filter((t) => t.is_owned_issue).map((t) => (
          <span key={`o-${t.category_code}`} className="pill">
            <TrendingUp size={11} aria-hidden="true" /> tema propio: {t.nombre}
          </span>
        ))}
      </div>
    </section>
  );
}

export default TopicTreemap;
