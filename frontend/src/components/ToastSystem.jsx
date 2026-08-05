/**
 * Avisos efimeros.
 *
 * Los errores no se autodescartan: si una anotacion fallo, el analista tiene
 * que enterarse aunque estuviera mirando otra pestana.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((toast) => {
    counter.current += 1;
    const id = `t${counter.current}`;
    const kind = toast.kind || 'info';
    const duration = toast.duration ?? (kind === 'error' ? 0 : 5000);

    setToasts((current) => [...current.slice(-4), { ...toast, id, kind }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (message, title) => push({ kind: 'success', message, title }),
      error: (message, title) => push({ kind: 'error', message, title: title || 'Error' }),
      warning: (message, title) => push({ kind: 'warning', message, title }),
      info: (message, title) => push({ kind: 'info', message, title }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cp-toasts" role="region" aria-live="polite" aria-label="Avisos">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.kind] || Info;
          return (
            <div key={toast.id} className={`cp-toast cp-toast-${toast.kind} animate-in`}>
              <Icon size={16} aria-hidden="true" />
              <div className="cp-toast-body">
                {toast.title && <strong>{toast.title}</strong>}
                <span>{toast.message}</span>
              </div>
              <button type="button" className="btn-icon btn-ghost" aria-label="Cerrar aviso" onClick={() => dismiss(toast.id)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast debe usarse dentro de <ToastProvider>.');
  return context;
}

export default ToastProvider;
