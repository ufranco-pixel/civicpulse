/**
 * Catalogos y registro de indicadores, cargados UNA vez.
 *
 * Es lo que permite que ningun componente lleve etiquetas, colores ni
 * advertencias codificadas: la verdad esta en la base y se pide al arrancar.
 *
 * El proveedor se construye con createElement en lugar de JSX para que este
 * fichero pueda ser .js sin configurar un cargador especial en Vite.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getCatalogs, getMetrics } from '../services/campaigns.service.js';
import { useAuth } from '../auth/useAuth.js';

const CatalogsContext = createContext(null);

const EMPTY = Object.freeze([]);

export function CatalogsProvider({ children }) {
  const { authenticated } = useAuth();
  const [catalogs, setCatalogs] = useState({});
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!authenticated) return undefined;

    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);

    Promise.all([
      getCatalogs({ signal: controller.signal }),
      getMetrics({ signal: controller.signal }),
    ])
      .then(([catalogsResult, metricsResult]) => {
        if (!alive) return;
        setCatalogs(catalogsResult || {});
        setMetrics(Array.isArray(metricsResult) ? metricsResult : []);
      })
      .catch((err) => {
        if (!alive || err?.aborted) return;
        setError(err);
      })
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; controller.abort(); };
  }, [authenticated, attempt]);

  const metricsByCode = useMemo(() => {
    const map = new Map();
    for (const metric of metrics) map.set(metric.code, metric);
    return map;
  }, [metrics]);

  const catalog = useCallback((name) => catalogs[name] || EMPTY, [catalogs]);

  /**
   * Ficha de un indicador. Devuelve siempre un objeto utilizable: si el codigo
   * no esta en el registro, el componente sigue pintando el numero pero sin
   * advertencia, en lugar de romperse.
   */
  const getMetric = useCallback(
    (code) => {
      const found = metricsByCode.get(code);
      if (!found) {
        return {
          code,
          label: code,
          label_es: code,
          caveat: null,
          unit: null,
          min_sample_size: 0,
          higher_is_better: null,
          definition: null,
          family: null,
          is_alertable: false,
          known: false,
        };
      }
      return {
        ...found,
        label: found.label_es,
        known: true,
      };
    },
    [metricsByCode],
  );

  /** Etiqueta en espanol de un codigo de catalogo, con el propio codigo de reserva. */
  const getLabel = useCallback(
    (catalogName, code) => {
      if (!code) return '—';
      const entry = (catalogs[catalogName] || EMPTY).find((item) => item.code === code);
      return entry ? entry.label_es : code;
    },
    [catalogs],
  );

  /** Token de color del catalogo (una variable CSS, p. ej. `--c-positive`). */
  const getColor = useCallback(
    (catalogName, code, fallback = 'var(--c-neutral)') => {
      const entry = (catalogs[catalogName] || EMPTY).find((item) => item.code === code);
      if (!entry || !entry.color_token) return fallback;
      return entry.color_token.startsWith('--') ? `var(${entry.color_token})` : entry.color_token;
    },
    [catalogs],
  );

  const value = useMemo(
    () => ({
      catalogs,
      metrics,
      loading,
      error,
      reload: () => setAttempt((n) => n + 1),
      catalog,
      getMetric,
      getLabel,
      getColor,
      alertableMetrics: metrics.filter((m) => m.is_alertable),
    }),
    [catalogs, metrics, loading, error, catalog, getMetric, getLabel, getColor],
  );

  return createElement(CatalogsContext.Provider, { value }, children);
}

export function useCatalogs() {
  const context = useContext(CatalogsContext);
  if (context === null) {
    throw new Error('useCatalogs debe usarse dentro de <CatalogsProvider>.');
  }
  return context;
}

export default useCatalogs;
