/**
 * Ruta protegida.
 *
 * Sin sesion manda a /acceso conservando el destino; con sesion pero sin los
 * roles pedidos manda a /sin-permiso. Esto es comodidad de interfaz: la
 * autorizacion real la aplica cada servicio contra el token.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from './useAuth.js';

export function PrivateRoute({ children, requiredRoles }) {
  const { loading, authenticated, hasAnyRole, error } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="cp-boot" role="status" aria-live="polite">
        <div className="cp-boot-pulse" />
        <p className="text-muted">Comprobando la sesion…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cp-boot">
        <ShieldAlert size={32} className="text-danger" aria-hidden="true" />
        <h2>No se pudo contactar con el proveedor de identidad</h2>
        <p className="text-muted">Reintente en unos segundos o avise al administrador.</p>
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/acceso" state={{ from: location }} replace />;
  }

  if (requiredRoles && requiredRoles.length > 0 && !hasAnyRole(requiredRoles)) {
    return <Navigate to="/sin-permiso" state={{ requiredRoles, from: location }} replace />;
  }

  return children;
}

export default PrivateRoute;
