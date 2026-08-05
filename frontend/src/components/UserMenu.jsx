/** Menu de usuario: identidad, organizacion, tema y cierre de sesion. */
import { useEffect, useRef, useState } from 'react';
import { LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useAuth } from '../auth/useAuth.js';
import { useTheme } from '../hooks/useTheme.js';

export function UserMenu() {
  const { user, logout, authDisabled } = useAuth();
  const { preference, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
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
          <div className="cp-menu-head">
            <UserRound size={15} aria-hidden="true" />
            <div>
              <strong>{user?.name || 'Usuario'}</strong>
              <span className="text-subtle">{user?.email || user?.username}</span>
              {user?.organizationName && <span className="text-subtle">{user.organizationName}</span>}
            </div>
          </div>

          {user?.roles?.length > 0 && (
            <div className="cp-menu-roles">
              {user.roles.slice(0, 8).map((role) => <span key={role} className="pill">{role}</span>)}
            </div>
          )}

          {authDisabled && (
            <p className="cp-menu-warn">
              Autenticacion desactivada (VITE_AUTH_DISABLED). Solo para desarrollo.
            </p>
          )}

          <div className="cp-menu-section">
            <span className="field-label">Tema</span>
            <div className="cp-theme-toggle" role="group" aria-label="Tema de la interfaz">
              <button type="button" className={`btn btn-sm ${preference === 'light' ? 'btn-primary' : ''}`} onClick={() => setTheme('light')}>
                <Sun size={13} aria-hidden="true" /> Claro
              </button>
              <button type="button" className={`btn btn-sm ${preference === 'dark' ? 'btn-primary' : ''}`} onClick={() => setTheme('dark')}>
                <Moon size={13} aria-hidden="true" /> Oscuro
              </button>
              <button type="button" className={`btn btn-sm ${preference === 'system' ? 'btn-primary' : ''}`} onClick={() => setTheme('system')}>
                <Monitor size={13} aria-hidden="true" /> Sistema
              </button>
            </div>
          </div>

          <button type="button" className="btn btn-sm cp-menu-action" role="menuitem" onClick={logout}>
            <LogOut size={13} aria-hidden="true" /> Cerrar sesion
          </button>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
