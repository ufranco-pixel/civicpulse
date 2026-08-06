/**
 * Listado de alertas con sus acciones.
 *
 * Cada alerta se presenta con el valor observado FRENTE al umbral y con el
 * tamano de muestra: una alerta de "80 % de negatividad" sobre 5 comentarios
 * no merece la misma reaccion que sobre 500, y el operador tiene que poder
 * verlo sin abrir nada.
 *
 * La evidencia son los contenidos que dispararon la regla, tal como los
 * adjunta civic.evaluate_alert_rules: {content_id, text, published_at, url,
 * sentiment, score}.
 */
import { useState } from 'react';
import {
  Ban, Check, ChevronDown, ChevronRight, CircleSlash, Clock, ExternalLink, ThumbsDown, X,
} from 'lucide-react';
import {
  acknowledgeAlert, dismissAlert, markAlertRead, resolveAlert,
} from '../services/alerts.service.js';
import { formatByUnit, formatDateTime, formatNumber, formatRelative, truncate } from '../config/format.js';
import { useToast } from './ToastSystem.jsx';
import InfoTooltip from './InfoTooltip.jsx';
import EmptyState from './EmptyState.jsx';
import ErrorState from './ErrorState.jsx';
import { SkeletonRows } from './SkeletonTile.jsx';

function ResolveForm({ alertId, onDone, onCancel }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [falsePositive, setFalsePositive] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    try {
      await resolveAlert(alertId, note.trim(), falsePositive);
      toast.success('Alerta resuelta.');
      onDone?.();
    } catch (err) {
      toast.error(err.message || 'No se pudo resolver la alerta.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cp-resolve" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Nota de resolucion (obligatoria)</span>
        <textarea
          className="textarea"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Que se comprobo y que se hizo"
        />
        <span className="field-help">
          Sin nota no se puede recalibrar la regla despues: el servicio rechaza la resolucion.
        </span>
      </label>
      <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)' }}>
        <input type="checkbox" checked={falsePositive} onChange={(event) => setFalsePositive(event.target.checked)} />
        Fue un falso positivo
        <InfoTooltip text="Marcar los falsos positivos alimenta la recalibracion de las reglas que disparan de mas." />
      </label>
      <div className="row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!note.trim() || busy}>Resolver</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

export function AlertList({ alerts = [], loading = false, error = null, onReload, onChanged }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(null);
  const [resolving, setResolving] = useState(null);

  const act = async (action, alert) => {
    try {
      if (action === 'ack') await acknowledgeAlert(alert.id);
      if (action === 'dismiss') await dismissAlert(alert.id, 'Descartada desde el tablero.');
      if (action === 'read') await markAlertRead(alert.id, !alert.is_read);
      toast.success('Alerta actualizada.');
      onChanged?.();
    } catch (err) {
      toast.error(err.message || 'No se pudo actualizar la alerta.');
    }
  };

  if (error) return <ErrorState error={error} onRetry={onReload} />;
  if (loading) return <SkeletonRows rows={6} />;
  if (alerts.length === 0) {
    return <EmptyState title="Sin alertas con estos filtros" message="Cuando una regla se dispare aparecera aqui y en el stream en vivo." />;
  }

  return (
    <ul className="cp-alerts">
      {alerts.map((alert) => {
        const severity = String(alert.severity_code || 'info').toLowerCase();
        const isOpen = expanded === alert.id;
        const overdue = Number(alert.sla_overdue_minutes || 0) > 0;

        return (
          <li key={alert.id} className={`cp-alert cp-alert-${severity} ${alert.is_read ? '' : 'is-unread'}`}>
            <div className="cp-alert-head">
              <button
                type="button"
                className="btn-icon btn-ghost"
                aria-label={isOpen ? 'Contraer' : 'Ver evidencia'}
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : alert.id)}
              >
                {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              </button>

              <span className={`badge badge-${severity}`}>{alert.severity_label || severity}</span>

              <div className="cp-alert-title">
                <strong>{alert.title}</strong>
                <span className="text-muted">{alert.message}</span>
              </div>

              <div className="spacer" />

              <span className="pill" title={formatDateTime(alert.created_at)}>
                <Clock size={11} aria-hidden="true" /> {formatRelative(alert.created_at)}
              </span>
              {overdue && (
                <span className="pill cp-rel-warn" title="Fuera del tiempo de atencion comprometido">
                  SLA +{formatNumber(alert.sla_overdue_minutes)} min
                </span>
              )}
              {alert.during_blackout && (
                <span className="pill cp-flag-blackout" title="Se genero durante la veda electoral">
                  <Ban size={11} aria-hidden="true" /> veda
                </span>
              )}
              <span className="pill">{alert.status}</span>
            </div>

            <div className="cp-alert-metrics">
              {alert.metric && (
                <span className="pill">
                  {alert.metric_label || alert.metric}
                  {alert.metric_caveat && <InfoTooltip title={alert.metric_label || alert.metric} text={alert.metric_caveat} />}
                </span>
              )}
              <span className="pill mono">
                observado {formatByUnit(alert.observed_value, alert.metric_unit)}
              </span>
              <span className="pill mono">
                umbral {formatByUnit(alert.threshold_value, alert.metric_unit)}
              </span>
              {alert.contender_name && <span className="pill">{alert.contender_name}</span>}
              {alert.source_name && <span className="pill">{alert.source_name}</span>}
              {alert.window_start && (
                <span className="pill text-subtle">
                  ventana {formatDateTime(alert.window_start)} → {formatDateTime(alert.window_end)}
                </span>
              )}
            </div>

            {isOpen && (
              <div className="cp-alert-body">
                {(alert.evidence || []).length > 0 ? (
                  <>
                    <h4>Evidencia ({alert.evidence.length})</h4>
                    <ul className="cp-evidence-list">
                      {alert.evidence.map((item, index) => (
                        <li key={item.content_id || index}>
                          <blockquote className="cp-evidence">“{truncate(item.text, 260)}”</blockquote>
                          <div className="row row-wrap">
                            {item.sentiment && <span className="pill">{item.sentiment}</span>}
                            {item.score !== undefined && item.score !== null && (
                              <span className="pill mono">{Number(item.score).toFixed(2)}</span>
                            )}
                            {item.published_at && <span className="pill text-subtle">{formatDateTime(item.published_at)}</span>}
                            {item.url && (
                              <a className="pill" href={item.url} target="_blank" rel="noreferrer noopener">
                                <ExternalLink size={11} aria-hidden="true" /> original
                              </a>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                    La regla no adjunto evidencia. Revise el listado de contenidos de la ventana.
                  </p>
                )}

                {alert.resolution_note && (
                  <p className="cp-alert-note">Resolucion: {alert.resolution_note}</p>
                )}
              </div>
            )}

            <div className="cp-alert-actions">
              {alert.status === 'open' && (
                <button type="button" className="btn btn-sm" onClick={() => act('ack', alert)}>
                  <Check size={13} aria-hidden="true" /> Acusar recibo
                </button>
              )}
              {!['resolved', 'dismissed'].includes(alert.status) && (
                <button type="button" className="btn btn-sm" onClick={() => setResolving(resolving === alert.id ? null : alert.id)}>
                  <Check size={13} aria-hidden="true" /> Resolver
                </button>
              )}
              {!['resolved', 'dismissed'].includes(alert.status) && (
                <button type="button" className="btn btn-sm" onClick={() => act('dismiss', alert)}>
                  <CircleSlash size={13} aria-hidden="true" /> Descartar
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => act('read', alert)}>
                {alert.is_read ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                {alert.is_read ? 'Marcar no leida' : 'Marcar leida'}
              </button>
              {alert.was_false_positive && (
                <span className="pill cp-rel-warn"><ThumbsDown size={11} aria-hidden="true" /> falso positivo</span>
              )}
            </div>

            {resolving === alert.id && (
              <ResolveForm
                alertId={alert.id}
                onDone={() => { setResolving(null); onChanged?.(); }}
                onCancel={() => setResolving(null)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default AlertList;
