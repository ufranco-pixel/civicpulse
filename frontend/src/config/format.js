/**
 * Formato de numeros, fechas y unidades.
 *
 * Un solo sitio decide como se escribe un porcentaje o una fecha: si cada
 * componente lo resuelve por su cuenta, el mismo indicador aparece con dos
 * precisiones distintas en dos tarjetas contiguas.
 */
const LOCALE = 'es-MX';

export const nf = (digits = 0) =>
  new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function isNil(value) {
  return value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value));
}

export function formatNumber(value, digits = 0) {
  if (isNil(value)) return '—';
  return nf(digits).format(Number(value));
}

/** Volumenes grandes en forma compacta: 12 400 → 12.4 k. */
export function formatCompact(value) {
  if (isNil(value)) return '—';
  const n = Number(value);
  if (Math.abs(n) < 1000) return nf(0).format(n);
  return new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * Da forma a un valor segun la unidad del registro de indicadores
 * (civic_kpi.metric_registry.unit): percent, score, ratio, index, count,
 * zscore, minutes.
 */
export function formatByUnit(value, unit, { compact = false } = {}) {
  if (isNil(value)) return '—';
  const n = Number(value);
  switch (unit) {
    case 'percent':  return `${nf(1).format(n)} %`;
    case 'score':    return nf(2).format(n);
    case 'ratio':    return nf(3).format(n);
    case 'index':    return nf(1).format(n);
    case 'zscore':   return `${n > 0 ? '+' : ''}${nf(2).format(n)} σ`;
    case 'minutes':  return formatDuration(n * 60);
    case 'count':    return compact ? formatCompact(n) : nf(0).format(n);
    default:         return Number.isInteger(n) ? nf(0).format(n) : nf(2).format(n);
  }
}

export function formatDelta(value, unit) {
  if (isNil(value)) return null;
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  if (unit === 'percent') return `${sign}${nf(1).format(n)} pp`;
  if (unit === 'count') return `${sign}${formatCompact(n)}`;
  return `${sign}${nf(2).format(n)}`;
}

export function formatDuration(seconds) {
  if (isNil(seconds)) return '—';
  const s = Math.round(Number(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${nf(1).format(s / 3600)} h`;
  return `${nf(1).format(s / 86400)} d`;
}

export function formatDate(value, { withTime = false } = {}) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function formatDateTime(value) {
  return formatDate(value, { withTime: true });
}

/** "hace 4 min". Sin dependencias: Intl.RelativeTimeFormat basta. */
export function formatRelative(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const steps = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [604800, 'day', 86400],
    [2629800, 'week', 604800],
    [31557600, 'month', 2629800],
  ];
  const abs = Math.abs(diffSeconds);
  for (const [limit, unit, divisor] of steps) {
    if (abs < limit) return rtf.format(Math.round(diffSeconds / divisor), unit);
  }
  return rtf.format(Math.round(diffSeconds / 31557600), 'year');
}

/** Recorta sin partir palabras a la mitad. */
export function truncate(text, max = 180) {
  if (!text) return '';
  const value = String(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function pct(part, total, digits = 1) {
  if (!total) return '—';
  return `${nf(digits).format((Number(part) / Number(total)) * 100)} %`;
}

export default {
  formatNumber, formatCompact, formatByUnit, formatDelta, formatDuration,
  formatDate, formatDateTime, formatRelative, truncate, pct, isNil,
};
