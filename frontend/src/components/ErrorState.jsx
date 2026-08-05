/**
 * Estado de error con reintento.
 *
 * Se muestra el codigo y el identificador de peticion cuando existen: es lo
 * que permite a quien opera encontrar la traza exacta en los registros.
 */
import { AlertOctagon, RefreshCw } from 'lucide-react';

export function ErrorState({ error, onRetry, title = 'No se pudieron cargar los datos', compact = false }) {
  const status = error?.status;
  const detail = error?.message || 'Error desconocido.';

  const hint = (() => {
    if (status === 401) return 'La sesion expiro. Vuelva a iniciar sesion.';
    if (status === 403) return 'Su cuenta no tiene permiso para consultar este recurso.';
    if (status === 404) return 'El recurso no existe o no pertenece a su organizacion.';
    if (status === 0) return 'No hubo respuesta del servicio. Revise la conexion o si el servicio esta levantado.';
    if (status >= 500) return 'El servicio devolvio un error. Puede reintentar en unos segundos.';
    return null;
  })();

  return (
    <div className={`cp-state cp-state-error ${compact ? 'cp-state-compact' : ''}`} role="alert">
      <AlertOctagon size={compact ? 22 : 30} aria-hidden="true" className="text-danger" />
      <p className="cp-state-title">{title}</p>
      <p className="cp-state-msg">{detail}</p>
      {hint && <p className="cp-state-msg text-subtle">{hint}</p>}
      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden="true" /> Reintentar
          </button>
        )}
      </div>
      {(error?.code || error?.requestId) && (
        <p className="cp-state-meta mono">
          {error.code ? `código ${error.code}` : ''}
          {error.code && error.requestId ? ' · ' : ''}
          {error.requestId ? `petición ${error.requestId}` : ''}
        </p>
      )}
    </div>
  );
}

export default ErrorState;
