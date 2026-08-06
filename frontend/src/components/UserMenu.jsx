/**
 * Menu de usuario: identidad, numeros de WhatsApp y cierre de sesion.
 *
 * Antes mostraba tambien los roles del token, el selector de tema y un aviso
 * de autenticacion desactivada; para un tablero de seguimiento eso es ruido de
 * configuracion en el sitio de mas trafico visual.
 */
import { useEffect, useRef, useState } from 'react';
import { LogOut, Smartphone, UserRound } from 'lucide-react';
import { useAuth } from '../auth/useAuth.js';
import WhatsappNumbersModal from './WhatsappNumbersModal.jsx';

export function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [numeros, setNumeros] = useState(false);
  const wrapper = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (event) => {
      if (wrapper.current && !wrapper.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = (user?.name || user?.username || '?')
    .split(' ').slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  return (
    <div className="cp-usermenu" ref={wrapper}>
      <button
        type="button"
        className="cp-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={user?.username || 'Cuenta'}
      >
        {initials}
      </button>

      {open && (
        <div className="cp-menu" role="menu">
          {/* Se conserva quien esta dentro: sin ello, cerrar sesion en un
              equipo compartido es un boton a ciegas. */}
          <div className="cp-menu-head">
            <UserRound size={16} aria-hidden="true" />
            <div>
              <strong>{user?.name || 'Usuario'}</strong>
              <span className="text-subtle">{user?.email || user?.username}</span>
            </div>
          </div>

          {/* Abre un modal y no un panel dentro del menú: la tabla de números
              no cabe en 280 px sin quedar apretada. */}
          <button
            type="button"
            className="btn btn-sm cp-menu-action"
            role="menuitem"
            onClick={() => { setOpen(false); setNumeros(true); }}
          >
            <Smartphone size={14} aria-hidden="true" /> Números de WhatsApp
          </button>

          <button type="button" className="btn btn-sm cp-menu-action" role="menuitem" onClick={logout}>
            <LogOut size={14} aria-hidden="true" /> Cerrar sesion
          </button>
        </div>
      )}

      {numeros && <WhatsappNumbersModal onClose={() => setNumeros(false)} />}
    </div>
  );
}

export default UserMenu;
