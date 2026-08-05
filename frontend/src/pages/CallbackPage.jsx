/**
 * Retorno del proveedor de identidad.
 *
 * keycloak-js procesa el codigo durante `init()`; aqui solo se espera a que el
 * contexto resuelva y se redirige. La ruta existe para poder registrarla como
 * URI de redireccion valida en el cliente de Keycloak.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';

export function CallbackPage() {
  const { loading, authenticated } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    navigate(authenticated ? '/resumen' : '/acceso', { replace: true });
  }, [loading, authenticated, navigate]);

  return (
    <div className="cp-boot" role="status" aria-live="polite">
      <div className="cp-boot-pulse" />
      <p className="text-muted">Completando el inicio de sesion…</p>
    </div>
  );
}

export default CallbackPage;
