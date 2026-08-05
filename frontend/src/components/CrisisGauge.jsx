/**
 * Indice de riesgo de crisis con su desglose.
 *
 * El numero solo no sirve para decidir nada: lo que permite actuar es saber
 * cual de los cuatro componentes lo esta empujando. Un indice de 60 por
 * toxicidad se atiende de forma distinta a uno de 60 por anomalia de volumen.
 * La explicacion que se muestra es la que devuelve la API, sin reescribir.
 */
import { ShieldAlert } from 'lucide-react';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { formatNumber, isNil } from '../config/format.js';
import InfoTooltip from './InfoTooltip.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';

const LEVEL_LABEL = {
  none: 'Sin senal',
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  critical: 'Critico',
};

const COMPONENTS = [
  { key: 'volume_component', label: 'Anomalia de volumen', weight: '30 %' },
  { key: 'sentiment_component', label: 'Caida de sentimiento', weight: '30 %' },
  { key: 'toxicity_component', label: 'Toxicidad', weight: '20 %' },
  { key: 'flags_component', label: 'Banderas de riesgo', weight: '20 %' },
];

export function CrisisGauge({ crisis, hours = 24 }) {
  const { getMetric } = useCatalogs();
  const metric = getMetric('crisis_risk_index');

  if (!crisis) return null;

  const index = isNil(crisis.risk_index) ? null : Number(crisis.risk_index);
  const level = String(crisis.risk_level || 'none').toLowerCase();
  const reliable = Boolean(crisis.is_reliable);
  const angle = index === null ? 0 : Math.max(0, Math.min(100, index)) * 1.8; // 0-180 grados

  return (
    <section className={`tile ${reliable ? '' : 'unreliable'}`}>
      <div className="tile-head">
        <h3 className="tile-title">
          <ShieldAlert size={15} aria-hidden="true" />
          Riesgo de crisis · {hours} h
          <InfoTooltip title={metric.label} text={metric.caveat || metric.definition} />
        </h3>
        <ReliabilityBadge
          isReliable={reliable}
          sampleSize={crisis.sample_size}
          minSampleSize={metric.min_sample_size}
        />
      </div>

      <div className="cp-gauge">
        <svg viewBox="0 0 200 108" className="cp-gauge-svg" role="img" aria-label={`Indice de riesgo ${index ?? 'sin dato'}`}>
          <path d="M14 100 A86 86 0 0 1 186 100" fill="none" stroke="var(--c-surface-3)" strokeWidth="16" strokeLinecap="round" />
          {index !== null && (
            <path
              d="M14 100 A86 86 0 0 1 186 100"
              fill="none"
              stroke={`var(--c-sev-${level === 'none' ? 'info' : level})`}
              strokeWidth="16"
              strokeLinecap="round"
              strokeDasharray={`${(angle / 180) * 270} 270`}
            />
          )}
        </svg>
        <div className="cp-gauge-value">
          <span className="mono">{index === null ? '—' : index.toFixed(0)}</span>
          <span className={`badge badge-${level === 'none' ? 'info' : level}`}>
            {LEVEL_LABEL[level] || crisis.risk_level}
          </span>
        </div>
      </div>

      <ul className="cp-gauge-parts">
        {COMPONENTS.map((component) => {
          const value = crisis[component.key];
          const pctValue = isNil(value) ? 0 : Math.max(0, Math.min(100, Number(value)));
          return (
            <li key={component.key}>
              <div className="row">
                <span>{component.label}</span>
                <span className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>peso {component.weight}</span>
                <div className="spacer" />
                <span className="mono">{isNil(value) ? '—' : Number(value).toFixed(1)}</span>
              </div>
              <div className="cp-bar"><i style={{ width: `${pctValue}%` }} /></div>
            </li>
          );
        })}
      </ul>

      {crisis.explanation && <p className="cp-gauge-note">{crisis.explanation}</p>}

      {!reliable && (
        <p className="cp-metric-warn">
          muestra insuficiente (n = {formatNumber(crisis.sample_size)} &lt; {formatNumber(metric.min_sample_size)}): el indice se muestra como referencia, no como diagnostico.
        </p>
      )}
    </section>
  );
}

export default CrisisGauge;
