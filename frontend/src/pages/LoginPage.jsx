/**
 * Pantalla de acceso.
 *
 * No redirige sola: `check-sso` ya comprobo que no hay sesion, y mandar al
 * usuario a Keycloak sin que pulse nada convierte un error de red en un bucle
 * de redirecciones.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useAuth } from '../auth/useAuth.js';
import { brand } from '../config/brand.js';

export function LoginPage() {
  const { authenticated, loading, login, error } = useAuth();
  const location = useLocation();

  if (authenticated) {
    const target = location.state?.from?.pathname || '/resumen';
    return <Navigate to={target} replace />;
  }

  return (
    <div className="cp-login">
      <div className="cp-login-card tile animate-in">
        <div className="cp-login-brand">
          <span className="cp-logo cp-logo-lg" aria-hidden="true">{brand.shortName}</span>
          <div>
            <h1>{brand.productName}</h1>
            <p className="text-muted">{brand.tagline}</p>
          </div>
        </div>

        <p className="disclaimer">{brand.disclaimer.long}</p>

        {error && (
          <p className="text-danger" style={{ fontSize: 'var(--fs-xs)' }}>
            No se pudo contactar con el proveedor de identidad. Reintente o avise al administrador.
          </p>
        )}

        <button type="button" className="btn btn-primary" onClick={() => login()} disabled={loading}>
          <LogIn size={15} aria-hidden="true" /> Entrar con la cuenta de la organizacion
        </button>

        {brand.supportEmail && (
          <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
            Problemas de acceso: <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>
          </p>
        )}
      </div>
    </div>
  );
}

export default LoginPage;
