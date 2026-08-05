/**
 * Marca efectiva = brand.config.js + variables VITE_BRAND_*.
 *
 * El fichero da los valores por defecto del producto; el entorno los
 * sobreescribe sin recompilar el codigo fuente (aunque si la imagen: Vite
 * congela las VITE_* al compilar, ver Dockerfile).
 */
import base from '../../brand.config.js';

const env = import.meta.env;

/** Devuelve el valor de entorno solo si trae contenido util. */
function pick(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed === '' ? fallback : trimmed;
}

export const brand = {
  ...base,
  name: pick(env.VITE_BRAND_NAME, base.name),
  shortName: pick(env.VITE_BRAND_SHORT_NAME, base.shortName),
  productName: pick(env.VITE_BRAND_PRODUCT_NAME, base.productName),
  tagline: pick(env.VITE_BRAND_TAGLINE, base.tagline),
  supportEmail: pick(env.VITE_BRAND_SUPPORT_EMAIL, base.supportEmail),
  copyright: pick(env.VITE_BRAND_COPYRIGHT, base.copyright),
  colors: {
    primary: pick(env.VITE_BRAND_PRIMARY_COLOR, base.colors.primary),
    accent: pick(env.VITE_BRAND_ACCENT_COLOR, base.colors.accent),
  },
  disclaimer: {
    ...base.disclaimer,
    full: pick(env.VITE_BRAND_DISCLAIMER, base.disclaimer.full),
  },
};

/** Texto que acompana a todo el tablero. Atajo muy usado. */
export const DISCLAIMER = brand.disclaimer.full;

/**
 * Inyecta los colores de marca como variables CSS.
 *
 * Solo se tocan --c-brand y --c-accent: la escala completa la define
 * design-system.css. Reemplazar la escala entera desde JS haria imposible
 * mantener el contraste del tema oscuro.
 */
export function applyBrandTheme(target) {
  const root = target || document.documentElement;
  if (!root || !root.style) return;
  root.style.setProperty('--c-brand', brand.colors.primary);
  root.style.setProperty('--c-accent', brand.colors.accent);
  root.dataset.brand = brand.shortName;
  if (typeof document !== 'undefined' && document.title === '') {
    document.title = brand.productName;
  }
}

export default brand;
