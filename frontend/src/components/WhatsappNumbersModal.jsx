/**
 * Gestión de los números que reciben las alertas por WhatsApp.
 *
 * Se abre desde el menú de usuario. Es un modal y no una tarjeta dentro del
 * menú porque el menú mide 280 px: una tabla con número, severidad mínima y
 * acciones no cabe ahí sin quedar apretada.
 *
 * Dos cosas que la interfaz deja explícitas porque son las que hacen que un
 * alta «correcta» no reciba nada:
 *
 *  · El CONSENTIMIENTO es obligatorio. La base lo impone con un disparador; si
 *    no se marca la casilla, el alta se rechaza. Aquí se pide de forma
 *    afirmativa en vez de mandar la fecha en silencio, porque quien da de alta
 *    a alguien debe declarar que esa persona aceptó.
 *
 *  · La SEVERIDAD MÍNIMA decide si le llega o no. El aviso de comentario
 *    negativo es «alta»: con el umbral en «crítica» ese número no recibe nada,
 *    y desde fuera parece que el canal está roto. La tabla muestra qué
 *    números quedan fuera.
 */
import { useCallback, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useApi } from '../hooks/useApi.js';
import { useCampaign } from '../hooks/useCampaign.js';
import { useAuth } from '../auth/useAuth.js';
import {
  createSubscription, deleteSubscription, listSubscriptions, updateSubscription,
} from '../services/whatsapp.service.js';
import EmptyState from './EmptyState.jsx';
import ErrorState from './ErrorState.jsx';
import { SkeletonRows } from './SkeletonTile.jsx';

const SEVERIDADES = [
  { code: 'info', label: 'Todas (info y superior)' },
  { code: 'low', label: 'Baja y superior' },
  { code: 'medium', label: 'Media y superior' },
  { code: 'high', label: 'Alta y superior' },
  { code: 'critical', label: 'Solo críticas' },
];

// Orden de severidad, para avisar de los umbrales que dejan fuera la alerta de
// comentario negativo (que es 'high').
const RANGO = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

const soloDigitos = (v) => String(v || '').replace(/\D/g, '');

export function WhatsappNumbersModal({ onClose }) {
  const { code } = useCampaign();
  const { hasRole } = useAuth();
  const puedeEditar = hasRole('admin') || hasRole('owner') || hasRole('alerts:write');

  const [numero, setNumero] = useState('');
  const [nombre, setNombre] = useState('');
  const [severidad, setSeveridad] = useState('low');
  const [consiente, setConsiente] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);

  const subs = useApi(
    ({ signal }) => listSubscriptions({ campaign_code: code, channel: 'whatsapp' }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );

  const filas = subs.data?.data || subs.data || [];

  const agregar = useCallback(async (e) => {
    e.preventDefault();
    const digitos = soloDigitos(numero);
    if (digitos.length < 10) {
      setError('El número debe llevar la clave del país y al menos 10 dígitos. Ejemplo: 5215512345678.');
      return;
    }
    if (!consiente) {
      setError('Sin declarar el consentimiento no se puede dar de alta: la base lo rechaza.');
      return;
    }
    setGuardando(true); setError(null);
    try {
      await createSubscription({
        campaignCode: code,
        channel: 'whatsapp',
        destination: digitos,
        displayName: nombre.trim() || null,
        minSeverity: severidad,
        alertTypes: [],
        consentGivenAt: new Date().toISOString(),
        consentSource: 'alta desde el tablero',
      });
      setNumero(''); setNombre(''); setConsiente(false);
      subs.reload();
    } catch (err) {
      setError(err?.message || 'No se pudo dar de alta el número.');
    } finally {
      setGuardando(false);
    }
  }, [code, numero, nombre, severidad, consiente, subs]);

  const quitar = useCallback(async (id) => {
    setError(null);
    try { await deleteSubscription(id); subs.reload(); } catch (err) {
      setError(err?.message || 'No se pudo eliminar.');
    }
  }, [subs]);

  const alternar = useCallback(async (fila) => {
    setError(null);
    try { await updateSubscription(fila.id, { isActive: !fila.is_active }); subs.reload(); } catch (err) {
      setError(err?.message || 'No se pudo cambiar el estado.');
    }
  }, [subs]);

  return (
    <div
      className="cp-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="cp-modal" role="dialog" aria-modal="true" aria-labelledby="cp-wa-title">
        <header className="cp-modal-head">
          <h2 id="cp-wa-title">Números de WhatsApp</h2>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Cerrar">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="cp-modal-body">
          <p className="text-muted" style={{ margin: 0 }}>
            Reciben las alertas de <b>{code || 'la campaña activa'}</b>.
          </p>

          {error && <p className="text-danger" style={{ margin: 0 }}>{error}</p>}

          {subs.error ? (
            <ErrorState compact error={subs.error} onRetry={subs.reload} />
          ) : subs.loading ? (
            <SkeletonRows rows={3} />
          ) : filas.length === 0 ? (
            <EmptyState
              compact
              title="Ningún número dado de alta"
              message="Las alertas se registrarán, pero no saldrá ningún mensaje."
            />
          ) : (
            <div className="cp-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Número</th>
                    <th>Nombre</th>
                    <th>Recibe desde</th>
                    <th>Estado</th>
                    {puedeEditar && <th aria-label="Acciones" />}
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) => {
                    // 'high' es la severidad del aviso de comentario negativo.
                    const fueraDeAlcance = RANGO[f.min_severity] > RANGO.high;
                    return (
                      <tr key={f.id} className={f.is_active ? '' : 'unreliable'}>
                        <td className="mono">{f.destination}</td>
                        <td>{f.display_name || '—'}</td>
                        <td>
                          {SEVERIDADES.find((s) => s.code === f.min_severity)?.label || f.min_severity}
                          {fueraDeAlcance && (
                            <div className="cp-metric-warn">
                              No recibirá el aviso de comentario negativo, que es de severidad alta.
                            </div>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${f.is_active ? 'badge-positive' : 'badge-neutral'}`}>
                            {f.is_active ? 'activo' : 'de baja'}
                          </span>
                        </td>
                        {puedeEditar && (
                          <td className="num">
                            <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
                              <button type="button" className="btn btn-sm" onClick={() => alternar(f)}>
                                {f.is_active ? 'Dar de baja' : 'Reactivar'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => quitar(f.id)}
                                aria-label={`Eliminar ${f.destination}`}
                                title="Eliminar"
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {puedeEditar && (
            <form className="stack" onSubmit={agregar}>
              <h3 className="tile-title">Agregar número</h3>

              <div className="grid grid-3">
                <label className="field">
                  <span className="field-label">Número con clave de país</span>
                  <input
                    className="input mono"
                    value={numero}
                    onChange={(e) => setNumero(e.target.value)}
                    placeholder="5215512345678"
                    inputMode="numeric"
                    required
                  />
                </label>

                <label className="field">
                  <span className="field-label">Nombre (opcional)</span>
                  <input className="input" value={nombre} maxLength={200} onChange={(e) => setNombre(e.target.value)} />
                </label>

                <label className="field">
                  <span className="field-label">Recibe desde</span>
                  <select className="select" value={severidad} onChange={(e) => setSeveridad(e.target.value)}>
                    {SEVERIDADES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                  </select>
                </label>
              </div>

              <label className="row" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={consiente}
                  onChange={(e) => setConsiente(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  Declaro que esta persona aceptó recibir avisos por WhatsApp.
                  <span className="text-subtle"> Obligatorio: la base rechaza el alta sin consentimiento.</span>
                </span>
              </label>

              <div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={guardando || !code}>
                  <Plus size={14} aria-hidden="true" /> {guardando ? 'Agregando…' : 'Agregar'}
                </button>
              </div>
            </form>
          )}
        </div>

        <footer className="cp-modal-foot">
          <span className="text-subtle">
            El número se guarda solo con dígitos, sin espacios ni signos.
          </span>
          <div className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Cerrar</button>
        </footer>
      </div>
    </div>
  );
}

export default WhatsappNumbersModal;
