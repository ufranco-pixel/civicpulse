/**
 * Distintivo de fiabilidad de la muestra.
 *
 * `is_reliable=false` no significa "no hay datos": significa que el volumen
 * esta por debajo del minimo publicable del indicador. Se dice con esas
 * palabras y con el numero, porque "n = 7" junto a "minimo 30" es lo que
 * evita que alguien lleve un 100 % de negatividad a una reunion.
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatNumber } from '../config/format.js';

export function ReliabilityBadge({ isReliable, sampleSize, minSampleSize, compact = false }) {
  const n = Number.isFinite(Number(sampleSize)) ? Number(sampleSize) : null;
  const min = Number.isFinite(Number(minSampleSize)) ? Number(minSampleSize) : null;

  if (isReliable) {
    if (compact) {
      return (
        <span className="pill" title={`Muestra suficiente${min ? ` (minimo ${min})` : ''}`}>
          n = {n === null ? '—' : formatNumber(n)}
        </span>
      );
    }
    return (
      <span className="pill cp-rel-ok">
        <CheckCircle2 size={12} aria-hidden="true" />
        n = {n === null ? '—' : formatNumber(n)}
      </span>
    );
  }

  return (
    <span
      className="pill cp-rel-warn"
      title={
        min !== null
          ? `Muestra insuficiente: ${n === null ? 'sin datos' : formatNumber(n)} por debajo del minimo publicable (${formatNumber(min)}).`
          : 'Muestra insuficiente para publicar el indicador.'
      }
    >
      <AlertTriangle size={12} aria-hidden="true" />
      muestra insuficiente
      {n !== null && min !== null ? ` (n = ${formatNumber(n)} < ${formatNumber(min)})` : ''}
      {n !== null && min === null ? ` (n = ${formatNumber(n)})` : ''}
    </span>
  );
}

export default ReliabilityBadge;
