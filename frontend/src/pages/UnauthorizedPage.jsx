/** 403 de interfaz. El servicio ya rechazo (o rechazaria) la peticion. */
import { Link, useLocation } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import { useAuth } from '../auth/useAuth.js';

export function UnauthorizedPage() {
  const location = useLocation();
  const { user } = useAuth();
  const required = location.state?.requiredRoles || [];

  return (
    <div className="cp-state cp-state-error" role="alert">
      <ShieldX size={34} aria-hidden="true" className="text-danger" />
      <p className="cp-state-title">Sin permiso para esta seccion</p>
      {required.length > 0 && (
        <p className="cp-state-msg">Se requiere alguno de estos roles: <b className="mono">{required.join(', ')}</b>.</p>
      )}
      <p className="cp-state-msg text-subtle">
        Su cuenta tiene: <span className="mono">{(user?.roles || []).join(', ') || 'ninguno'}</span>
      </p>
      <Link className="btn btn-sm" to="/resumen">Volver al resumen</Link>
    </div>
  );
}

export default UnauthorizedPage;
