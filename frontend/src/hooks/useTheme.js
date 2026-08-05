/**
 * Tema claro/oscuro/sistema.
 *
 * El valor inicial lo fija el script en linea de index.html antes del primer
 * pintado; aqui solo se lee lo ya aplicado para no provocar un parpadeo.
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'cp-theme';
export const THEMES = ['light', 'dark', 'system'];

function stored() {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [preference, setPreference] = useState(() => stored() || 'system');
  const [resolved, setResolved] = useState(
    () => document.documentElement.getAttribute('data-theme') || systemTheme(),
  );

  useEffect(() => {
    const effective = preference === 'system' ? systemTheme() : preference;
    document.documentElement.setAttribute('data-theme', effective);
    setResolved(effective);
    try { window.localStorage.setItem(STORAGE_KEY, preference); } catch { /* modo privado */ }

    if (preference !== 'system') return undefined;
    // Con 'system' hay que seguir al sistema operativo en caliente.
    const list = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event) => {
      const next = event.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      setResolved(next);
    };
    list.addEventListener('change', handler);
    return () => list.removeEventListener('change', handler);
  }, [preference]);

  const toggle = useCallback(() => {
    setPreference((current) => {
      const effective = current === 'system' ? systemTheme() : current;
      return effective === 'dark' ? 'light' : 'dark';
    });
  }, []);

  return { theme: resolved, preference, setTheme: setPreference, toggle, isDark: resolved === 'dark' };
}

export default useTheme;
