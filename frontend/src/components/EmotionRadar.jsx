/**
 * Perfil emocional del periodo.
 *
 * Las etiquetas salen del catalogo `emotion_types`, incluidas las extensiones
 * civicas (indignacion, esperanza, desconfianza, apatia), que son las que de
 * verdad discriminan en conversacion politica: "enojo" generico no distingue
 * entre un insulto y una denuncia de injusticia.
 */
import {
  PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip,
} from 'recharts';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatNumber } from '../config/format.js';
import EmptyState from './EmptyState.jsx';
import InfoTooltip from './InfoTooltip.jsx';

export function EmotionRadar({ emotions = [], height = 300, title = 'Perfil emocional' }) {
  const { getLabel } = useCatalogs();

  if (!emotions || emotions.length === 0) {
    return (
      <section className="tile">
        <div className="tile-head"><h3 className="tile-title">{title}</h3></div>
        <EmptyState compact title="Sin emociones detectadas en el periodo" />
      </section>
    );
  }

  const data = emotions.map((item) => ({
    emocion: getLabel('emotion_types', item.emotion_code),
    code: item.emotion_code,
    peso: Number(item.share_pct) || 0,
    intensidad: Number(item.avg_intensity) || 0,
    ocurrencias: item.occurrences,
  }));

  const total = emotions.reduce((sum, item) => sum + (Number(item.occurrences) || 0), 0);

  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-title">
          {title}
          <InfoTooltip
            title="Perfil emocional"
            text="Peso relativo de cada emocion sobre el total de emociones detectadas. Un mismo texto puede aportar varias: los porcentajes describen el reparto de senales, no de personas."
          />
        </h3>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="72%">
            <PolarGrid stroke="var(--c-border)" />
            <PolarAngleAxis dataKey="emocion" tick={{ fontSize: 11, fill: 'var(--c-text-muted)' }} />
            <PolarRadiusAxis tick={{ fontSize: 10, fill: 'var(--c-text-subtle)' }} angle={90} />
            <Radar
              name="Peso (%)"
              dataKey="peso"
              stroke="var(--c-brand)"
              fill="var(--c-brand)"
              fillOpacity={0.32}
              isAnimationActive={false}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--c-surface)',
                border: '1px solid var(--c-border)',
                borderRadius: 'var(--r-sm)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--c-text)',
              }}
              formatter={(value, name, entry) => [
                `${Number(value).toFixed(1)} % · ${formatNumber(entry.payload.ocurrencias)} menciones`,
                name,
              ]}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export default EmotionRadar;
