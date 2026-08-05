/**
 * Campana activa.
 *
 * Se persiste el CODIGO, no el objeto: el objeto caduca (cambia el estado, la
 * veda, el numero de fuentes) y guardarlo entero significa pintar datos viejos
 * en la cabecera hasta la primera recarga.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { listCampaigns } from '../services/campaigns.service.js';
import { useAuth } from '../auth/useAuth.js';

const STORAGE_KEY = 'cp-campaign';
const CampaignContext = createContext(null);

function readStored() {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function writeStored(code) {
  try {
    if (code) window.localStorage.setItem(STORAGE_KEY, code);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* modo privado: se sigue sin persistir */ }
}

export function CampaignProvider({ children }) {
  const { authenticated } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [code, setCode] = useState(() => readStored());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!authenticated) return undefined;

    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);

    listCampaigns({}, { signal: controller.signal })
      .then((rows) => {
        if (!alive) return;
        const list = Array.isArray(rows) ? rows : [];
        setCampaigns(list);
        setCode((current) => {
          // La campana guardada puede haberse archivado o pertenecer a otra
          // organizacion tras cambiar de usuario: se valida contra la lista.
          if (current && list.some((c) => c.code === current)) return current;
          const preferred = list.find((c) => c.status === 'active') || list[0];
          const next = preferred ? preferred.code : null;
          writeStored(next);
          return next;
        });
      })
      .catch((err) => { if (alive && !err?.aborted) setError(err); })
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; controller.abort(); };
  }, [authenticated, attempt]);

  const selectCampaign = useCallback((nextCode) => {
    setCode(nextCode);
    writeStored(nextCode);
  }, []);

  const campaign = useMemo(
    () => campaigns.find((c) => c.code === code) || null,
    [campaigns, code],
  );

  const value = useMemo(
    () => ({
      campaigns,
      campaign,
      code,
      loading,
      error,
      selectCampaign,
      reload: () => setAttempt((n) => n + 1),
      // La veda la calcula la vista de la base con la zona horaria de la
      // campana: nunca se recalcula con la fecha del navegador.
      inBlackout: Boolean(campaign?.in_blackout),
      daysToElection: campaign?.days_to_election ?? null,
    }),
    [campaigns, campaign, code, loading, error, selectCampaign],
  );

  return createElement(CampaignContext.Provider, { value }, children);
}

export function useCampaign() {
  const context = useContext(CampaignContext);
  if (context === null) {
    throw new Error('useCampaign debe usarse dentro de <CampaignProvider>.');
  }
  return context;
}

export default useCampaign;
