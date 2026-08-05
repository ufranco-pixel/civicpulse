import { useContext } from 'react';
import { AuthContext } from './AuthProvider.jsx';

/** Acceso al contexto de sesion. Falla ruidosamente fuera del proveedor. */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth debe usarse dentro de <AuthProvider>.');
  }
  return context;
}

export default useAuth;
