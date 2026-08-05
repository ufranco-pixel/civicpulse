/** Cabecera comun de pagina: titulo, descripcion y selector de periodo. */
import { RefreshCw } from 'lucide-react';

export const PERIODS = [7, 14, 30, 60, 90];

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
            {periods.map((value) => <option key={value} value={value}>{value} dias</option>)}
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
