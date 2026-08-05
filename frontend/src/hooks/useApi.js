/**
 * Hook generico de lectura.
 *
 * `fetcher` recibe `{ signal }` y debe pasarselo al servicio: al desmontar (o
 * al cambiar las dependencias) se aborta la peticion en vuelo, de modo que la
 * respuesta tardia de una campana que ya no esta seleccionada no sobreescribe
 * los datos de la actual.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useApi(fetcher, deps = [], options = {}) {
  const { enabled = true, initialData = null, onSuccess, onError } = options;

  const [data, setData] = useState(initialData);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const [reloadKey, setReloadKey] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const callbacks = useRef({ onSuccess, onError });
  callbacks.current = { onSuccess, onError };

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let alive = true;

    setLoading(true);
    setError(null);

    Promise.resolve()
      .then(() => fetcherRef.current({ signal: controller.signal }))
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
        callbacks.current.onSuccess?.(result);
      })
      .catch((err) => {
        // Una cancelacion no es un fallo que mostrar al usuario.
        if (!alive || err?.aborted || err?.name === 'AbortError') return;
        setError(err);
        callbacks.current.onError?.(err);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reloadKey, ...deps]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { data, error, loading, reload, setData };
}

export default useApi;
