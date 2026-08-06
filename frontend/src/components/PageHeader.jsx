/** Cabecera comun de pagina: titulo, descripcion y selector de periodo. */
import { RefreshCw } from 'lucide-react';

/**
 * Sentinela de «todo el periodo».
 *
 * Se usa 0 y no null porque el valor viaja por un <select>, y ahi todo es
 * cadena: `Number('')` da 0 igualmente, mientras que null volveria como la
 * cadena "null" y habria que tratarla aparte en cada pagina.
 *
 * Es un valor de INTERFAZ, no de API. Antes de llamar al backend hay que
 * traducirlo con `resolveDays()`: los endpoints de indicadores exigen
 * `days >= 1`, y mandarles un 0 devuelve un 422.
 */
export const ALL_TIME = 0;

/** Ventana que representa «todo» al consultar indicadores: 5 anos. */
export const ALL_TIME_DAYS = 1825;

/** Traduce el valor del selector al parametro `days` que espera la API. */
export const resolveDays = (days) => (days === ALL_TIME ? ALL_TIME_DAYS : days);

export const PERIODS = [ALL_TIME, 7, 14, 30, 60, 90];

const etiqueta = (value) => (value === ALL_TIME ? 'Todo el periodo' : `${value} dias`);

/**
 * Texto del periodo para descripciones y titulos.
 *
 * Existe para que nadie interpole `days` a pelo: con el selector en «Todo»
 * eso imprime «los ultimos 0 dias», que es justo lo contrario de lo que pasa.
 */
export const periodLabel = (days) => (
  days === ALL_TIME ? 'todo el periodo registrado' : `los ultimos ${days} dias`
);

export function PageHeader({ title, description, days, onDaysChange, onReload, children, periods = PERIODS }) {
  return (
    <header className="cp-page-head">
      <div>
        <h1>{title}</h1>
        {description && <p className="text-muted">{description}</p>}
      </div>
      <div className="spacer" />
      {children}
      {onDaysChange && (
        <label className="row" style={{ gap: 'var(--sp-2)' }}>
          <span className="field-label">Periodo</span>
          <select className="select" value={days} onChange={(event) => onDaysChange(Number(event.target.value))} style={{ width: 'auto' }}>
            {periods.map((value) => <option key={value} value={value}>{etiqueta(value)}</option>)}
          </select>
        </label>
      )}
      {onReload && (
        <button type="button" className="btn btn-sm" onClick={onReload} aria-label="Recargar">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      )}
    </header>
  );
}

export default PageHeader;
