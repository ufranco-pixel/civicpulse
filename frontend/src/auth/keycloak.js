/**
 * Instancia unica de Keycloak.
 *
 * La promesa de inicializacion se cachea a proposito: en desarrollo, el modo
 * estricto de React monta cada componente dos veces, y llamar dos veces a
 * `keycloak.init()` lanza "A 'Keycloak' instance can only be initialized
 * once". Con la promesa cacheada el segundo montaje se engancha al mismo
 * resultado.
 *
 * Los tokens viven SOLO en memoria. Guardarlos en localStorage los expone a
 * cualquier XSS y los deja sobrevivir al cierre de sesion.
 */
import Keycloak from 'keycloak-js';

const env = import.meta.env;

export const AUTH_DISABLED = String(env.VITE_AUTH_DISABLED || 'false').toLowerCase() === 'true';
export const MIN_VALIDITY = Number.parseInt(env.VITE_TOKEN_MIN_VALIDITY || '70', 10);

export const keycloakConfig = {
  url: env.VITE_KEYCLOAK_URL || 'http://localhost:8080',
  realm: env.VITE_KEYCLOAK_REALM || 'civicpulse',
  clientId: env.VITE_KEYCLOAK_CLIENT_ID || 'civicpulse-frontend',
};

let instance = null;
let initPromise = null;

export function getKeycloak() {
  if (AUTH_DISABLED) return null;
  if (!instance) instance = new Keycloak(keycloakConfig);
  return instance;
}

/**
 * Inicializa una sola vez y devuelve `{ authenticated }`.
 *
 * `check-sso` no redirige: si no hay sesion, la aplicacion pinta la pantalla
 * de acceso en lugar de mandar al usuario a Keycloak sin avisar.
 */
export function initKeycloak() {
  if (AUTH_DISABLED) {
    return Promise.resolve({ authenticated: false, disabled: true });
  }
  if (initPromise) return initPromise;

  const kc = getKeycloak();
  initPromise = kc
    .init({
      onLoad: 'check-sso',
      silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
      // S256 y no 'plain': sin el reto hasheado, interceptar el codigo de
      // autorizacion basta para obtener el token.
      pkceMethod: 'S256',
      checkLoginIframe: false,
      enableLogging: import.meta.env.DEV,
      responseMode: 'query',
    })
    .then((authenticated) => ({ authenticated, disabled: false }))
    .catch((error) => {
      // No se limpia initPromise: reintentar en bucle contra un Keycloak caido
      // solo empeora la situacion. El usuario recarga si quiere reintentar.
      console.error('[auth] fallo la inicializacion de Keycloak', error);
      return { authenticated: false, disabled: false, error };
    });

  return initPromise;
}

export function login(options) {
  const kc = getKeycloak();
  if (kc) kc.login({ redirectUri: window.location.origin, ...options });
}

export function logout() {
  const kc = getKeycloak();
  if (kc) kc.logout({ redirectUri: window.location.origin });
}

export function getToken() {
  const kc = getKeycloak();
  return kc && kc.authenticated ? kc.token : null;
}

/** Renueva si al token le quedan menos de MIN_VALIDITY segundos. */
export async function refreshToken(minValidity = MIN_VALIDITY) {
  const kc = getKeycloak();
  if (!kc || !kc.authenticated) return false;
  try {
    await kc.updateToken(minValidity);
    return true;
  } catch {
    return false;
  }
}

/** Roles de realm y de cliente reunidos, sin duplicados. */
export function getRoles() {
  const kc = getKeycloak();
  if (!kc || !kc.tokenParsed) return [];
  const realmRoles = kc.tokenParsed.realm_access?.roles || [];
  const clientRoles = kc.tokenParsed.resource_access?.[keycloakConfig.clientId]?.roles || [];
  return [...new Set([...realmRoles, ...clientRoles])];
}

export function getProfile() {
  const kc = getKeycloak();
  const claims = kc?.tokenParsed;
  if (!claims) return null;
  return {
    sub: claims.sub,
    username: claims.preferred_username || claims.email || claims.sub,
    name: claims.name || claims.preferred_username || 'Usuario',
    email: claims.email || null,
    // El backend exige esta reclamacion: sin ella no hay contexto de RLS.
    organizationId: claims.organization_id || null,
    organizationName: claims.organization_name || null,
    roles: getRoles(),
    expiresAt: claims.exp ? claims.exp * 1000 : null,
  };
}

export default { getKeycloak, initKeycloak, login, logout, getToken, refreshToken, getRoles, getProfile };
