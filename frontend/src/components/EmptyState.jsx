/**
 * Estado vacio.
 *
 * "No hay datos" y "hay datos pero el filtro no deja pasar ninguno" son cosas
 * distintas y el usuario tiene que poder distinguirlas: el segundo caso ofrece
 * limpiar el filtro.
 */
import { Inbox } from 'lucide-react';

export function EmptyState({
  icon: Icon = Inbox,
  title = 'Sin datos para este periodo',
  message,
  action,
  actionLabel,
  compact = false,
}) {
  return (
    <div className={`cp-state ${compact ? 'cp-state-compact' : ''}`}>
      <Icon size={compact ? 22 : 30} aria-hidden="true" className="text-subtle" />
      <p className="cp-state-title">{title}</p>
      {message && <p className="cp-state-msg">{message}</p>}
      {action && actionLabel && (
        <button type="button" className="btn btn-sm" onClick={action}>{actionLabel}</button>
      )}
    </div>
  );
}

export default EmptyState;
