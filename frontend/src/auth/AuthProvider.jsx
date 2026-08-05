/**
 * Contexto de sesion.
 *
 * Responsabilidades: inicializar Keycloak una vez, programar la renovacion del
 * token antes de que expire, y conectar la capa de servicios con el token
 * vigente mediante un getter (nunca con una copia del valor).
 */
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUTH_DISABLED, MIN_VALIDITY, getProfile, getToken, initKeycloak,
  login as kcLogin, logout as kcLogout, refreshToken,
} from './keycloak.js';
import { injectTokenToAllServices } from '../services/index.js';

export const AuthContext = createContext(null);

export const AUTH_STATUS = {
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  UNAUTHENTICATED: 'unauthenticated',
  ERROR: 'error',
};

/** Usuario ficticio del modo sin autenticacion. Espeja al de AUTH_DISABLED del backend. */
const DEV_USER = {
  sub: 'dev-user',
  username: 'desarrollo',
  name: 'Usuario de desarrollo',
  email: 'dev@localhost',
  organizationId: '00000000-0000-0000-0000-000000000000',
  organizationName: 'Organizacion de desarrollo',
  roles: ['owner', 'admin', 'strategist', 'analyst', 'viewer', 'auditor', 'alerts:write', 'reports:write'],
  expiresAt: null,
};

export function AuthProvider({ children }) {
  const [status, setStatus] = useState(AUTH_STATUS.LOADING);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const refreshTimer = useRef(null);

  // El getter se registra una sola vez y siempre devuelve el token del momento.
  useEffect(() => {
    injectTokenToAllServices(
      () => (AUTH_DISABLED ? null : getToken()),
      async () => {
        if (AUTH_DISABLED) return false;
        const ok = await refreshToken(MIN_VALIDITY);
        if (ok) setUser(getProfile());
        return ok;
      },
    );
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (AUTH_DISABLED) return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    const profile = getProfile();
    if (!profile?.expiresAt) return;

    // Se renueva a mitad de la vida restante, con un suelo de 15 s: renovar en
    // el ultimo segundo deja peticiones en vuelo con un token ya caducado.
    const remaining = profile.expiresAt - Date.now();
    const delay = Math.max(remaining / 2, 15000);

    refreshTimer.current = setTimeout(async () => {
      const ok = await refreshToken(MIN_VALIDITY);
      if (ok) {
        setUser(getProfile());
        scheduleRefresh();
      } else {
        setStatus(AUTH_STATUS.UNAUTHENTICATED);
        setUser(null);
      }
    }, delay);
  }, []);

  useEffect(() => {
    let alive = true;

    if (AUTH_DISABLED) {
      console.warn('[auth] VITE_AUTH_DISABLED=true: sesion ficticia. NO usar fuera de desarrollo.');
      setUser(DEV_USER);
      setStatus(AUTH_STATUS.AUTHENTICATED);
      return () => { alive = false; };
    }

    initKeycloak().then((result) => {
      if (!alive) return;
      if (result.error) {
        setError(result.error);
        setStatus(AUTH_STATUS.ERROR);
        return;
      }
      if (result.authenticated) {
        setUser(getProfile());
        setStatus(AUTH_STATUS.AUTHENTICATED);
        scheduleRefresh();
      } else {
        setStatus(AUTH_STATUS.UNAUTHENTICATED);
      }
    });

    return () => {
      alive = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [scheduleRefresh]);

  const hasRole = useCallback(
    (role) => Boolean(role) && Boolean(user?.roles?.includes(role)),
    [user],
  );

  const hasAnyRole = useCallback(
    (roles) => {
      if (!roles || roles.length === 0) return true;
      return roles.some((role) => user?.roles?.includes(role));
    },
    [user],
  );

  const value = useMemo(
    () => ({
      status,
      loading: status === AUTH_STATUS.LOADING,
      authenticated: status === AUTH_STATUS.AUTHENTICATED,
      error,
      user,
      authDisabled: AUTH_DISABLED,
      // Funcion y no valor: quien lo llame obtiene el token de ese instante.
      token: () => (AUTH_DISABLED ? null : getToken()),
      login: kcLogin,
      logout: () => {
        if (AUTH_DISABLED) {
          setUser(null);
          setStatus(AUTH_STATUS.UNAUTHENTICATED);
          return;
        }
        kcLogout();
      },
      hasRole,
      hasAnyRole,
    }),
    [status, error, user, hasRole, hasAnyRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthProvider;
