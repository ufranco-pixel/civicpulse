/**
 * Tarjeta de indicador.
 *
 * Regla del producto que este componente materializa: ningun numero se muestra
 * desnudo. Siempre lleva
 *   · su etiqueta y unidad tomadas del registro de indicadores,
 *   · el tamano de muestra,
 *   · su advertencia de interpretacion (`caveat`) accesible por el icono de
 *     informacion,
 * y cuando la muestra es insuficiente el widget se atenua, oculta el delta y
 * NO dibuja la tendencia: una linea sobre 6 observaciones sugiere una
 * trayectoria que no existe.
 *
 * El signo del delta se colorea segun `higher_is_better` del registro, no
 * segun si el numero sube: en `negative_pct` subir es malo.
 */
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatByUnit, formatDelta, isNil } from '../config/format.js';
import InfoTooltip from './InfoTooltip.jsx';

/** Linea de tendencia minima. SVG a mano: recharts para 20 puntos es desmedido. */
function Sparkline({ points, tone }) {
  const values = (points || []).map(Number).filter(Number.isFinite);
  if (values.length < 3) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 100;
  const height = 28;
  const step = width / (values.length - 1);
  const d = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)},${(height - ((value - min) / span) * (height - 4) - 2).toFixed(2)}`)
    .join(' ');

  return (
    <svg className="cp-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MetricCard({
  metricCode,
  value,
  unit,
  sampleSize,
  isReliable = true,
  delta,
  sparkline,
  label,
  footnote,
  compact = false,
  onClick,
}) {
  const { getMetric } = useCatalogs();
  const metric = getMetric(metricCode);

  const effectiveUnit = unit || metric.unit;
  const title = label || metric.label || metricCode;
  const minSample = metric.min_sample_size ?? null;
  const reliable = Boolean(isReliable);

  // Direccion "buena" del indicador. null = ni bueno ni malo (p. ej. topic_share).
  const higherIsBetter = metric.higher_is_better;
  const deltaNumber = isNil(delta) ? null : Number(delta);
  const deltaTone = (() => {
    if (deltaNumber === null || deltaNumber === 0 || higherIsBetter === null || higherIsBetter === undefined) {
      return 'neutral';
    }
    const improving = higherIsBetter ? deltaNumber > 0 : deltaNumber < 0;
    return improving ? 'good' : 'bad';
  })();

  const DeltaIcon = deltaNumber === null || deltaNumber === 0
    ? Minus
    : (deltaNumber > 0 ? TrendingUp : TrendingDown);

  const sparkTone = deltaTone === 'good'
    ? 'var(--c-positive)'
    : deltaTone === 'bad' ? 'var(--c-negative)' : 'var(--c-brand)';

  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`tile cp-metric ${compact ? 'cp-metric-compact' : ''} ${reliable ? '' : 'unreliable'} ${onClick ? 'cp-metric-clickable' : ''}`}
    >
      <div className="cp-metric-head">
        <span className="cp-metric-label">{title}</span>
        <InfoTooltip
          title={metric.label}
          text={
            metric.caveat
            || metric.definition
            || 'Este indicador no declara advertencia en el registro.'
          }
          label={`Como interpretar ${title}`}
        />
      </div>

      <div className="cp-metric-value mono">
        {formatByUnit(value, effectiveUnit, { compact: true })}
      </div>

      <div className="cp-metric-foot">
        {reliable && deltaNumber !== null && (
          <span className={`cp-delta cp-delta-${deltaTone}`}>
            <DeltaIcon size={13} aria-hidden="true" />
            {formatDelta(deltaNumber, effectiveUnit)}
          </span>
        )}

      </div>

      {reliable && sparkline && sparkline.length >= 3 && (
        <Sparkline points={sparkline} tone={sparkTone} />
      )}

      {footnote && <p className="cp-metric-note">{footnote}</p>}
    </Wrapper>
  );
}

export default MetricCard;
