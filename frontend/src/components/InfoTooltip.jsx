/**
 * Icono de informacion con globo de ayuda.
 *
 * Es el vehiculo del `caveat`: la advertencia de interpretacion que el
 * registro de indicadores publica para cada metrica. Se abre con el raton y
 * con el teclado, y se anuncia a los lectores de pantalla; una advertencia que
 * solo existe al pasar el raton no la lee quien mas la necesita.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

export function InfoTooltip({ text, title, side = 'top', size = 14, label = 'Mas informacion' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    const onClickOutside = (event) => {
      if (wrapper.current && !wrapper.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [open]);

  if (!text) return null;

  return (
    <span className="cp-tip" ref={wrapper}>
      <button
        type="button"
        className="cp-tip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info size={size} aria-hidden="true" />
      </button>
      {open && (
        <span role="tooltip" id={id} className={`cp-tip-bubble cp-tip-${side}`}>
          {title && <strong className="cp-tip-title">{title}</strong>}
          <span>{text}</span>
        </span>
      )}
    </span>
  );
}

export default InfoTooltip;
