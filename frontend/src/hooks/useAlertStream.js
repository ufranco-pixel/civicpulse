/**
 * Alertas en vivo sobre el stream SSE.
 *
 * Acumula lo recibido en la sesion actual (con tope, para no crecer sin
 * limite en un tablero que queda abierto todo el dia) y lleva la cuenta de las
 * no leidas.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAlertStream, SSE_STATUS } from '../services/sse.js';
import { useAuth } from '../auth/useAuth.js';

const MAX_BUFFER = 200;
const DEFAULT_SEVERITY_MIN = import.meta.env.VITE_SSE_SEVERITY_MIN || null;

export function useAlertStream({ campaignCode = null, severityMin = DEFAULT_SEVERITY_MIN, alertTypes = null, enabled = true } = {}) {
  const { authenticated, token } = useAuth();
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState(SSE_STATUS.IDLE);
  const [unread, setUnread] = useState(0);
  const [lastEventAt, setLastEventAt] = useState(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const typesKey = Array.isArray(alertTypes) ? alertTypes.join(',') : '';

  useEffect(() => {
    if (!enabled || !authenticated) {
      setStatus(SSE_STATUS.IDLE);
      return undefined;
    }

    const stream = createAlertStream({
      getToken: () => tokenRef.current?.(),
      campaignCode,
      severityMin,
      alertTypes: typesKey ? typesKey.split(',') : null,
      onAlert: (alert) => {
        setAlerts((current) => {
          // El servidor puede reenviar tras una reconexion: se descarta el
          // duplicado en lugar de contarlo otra vez como alerta nueva.
          if (current.some((a) => a.id === alert.id)) return current;
          return [alert, ...current].slice(0, MAX_BUFFER);
        });
        setUnread((n) => n + 1);
        setLastEventAt(new Date());
      },
      onAlertUpdated: (payload) => {
        setAlerts((current) => current.map(
          (a) => (a.id === payload.id ? { ...a, status: payload.status, is_read: payload.is_read } : a),
        ));
        setLastEventAt(new Date());
      },
      onStatus: (next) => setStatus(next),
    });

    stream.connect();
    return () => stream.close();
  }, [enabled, authenticated, campaignCode, severityMin, typesKey]);

  const clear = useCallback(() => { setAlerts([]); setUnread(0); }, []);
  const markAllRead = useCallback(() => setUnread(0), []);

  return {
    alerts,
    unread,
    status,
    lastEventAt,
    connected: status === SSE_STATUS.OPEN,
    clear,
    markAllRead,
  };
}

export default useAlertStream;
