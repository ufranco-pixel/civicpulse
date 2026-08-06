/**
 * Alertas: listado historico, lo que llega en vivo por SSE, y las reglas.
 *
 * Lo recibido por el stream se muestra en una franja aparte, no mezclado con
 * el listado: son cosas distintas (lo que ha llegado desde que abri el
 * tablero, frente a lo que hay en la base con los filtros aplicados).
 */
import { useState } from 'react';
import { Bell, Plus, Radio, Settings2 } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { getAlertStats, listAlerts, listRules, setRuleEnabled } from '../services/alerts.service.js';
import { useLiveAlerts } from '../components/Layout.jsx';
import { useToast } from '../components/ToastSystem.jsx';
import AlertList from '../components/AlertList.jsx';
import AlertRuleForm from '../components/AlertRuleForm.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { SkeletonRows } from '../components/SkeletonTile.jsx';
import { formatNumber, formatRelative } from '../config/format.js';

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'dismissed', 'expired'];

export function AlertsPage() {
  const { code } = useCampaign();
  const live = useLiveAlerts();
  const toast = useToast();

  const [tab, setTab] = useState('alerts');
  const [status, setStatus] = useState('open');
  const [severityMin, setSeverityMin] = useState('');
  const [editingRule, setEditingRule] = useState(null);
  const [creating, setCreating] = useState(false);

  const alerts = useApi(
    ({ signal }) => listAlerts(
      {
        campaign_code: code,
        status: status ? [status] : undefined,
        severity_min: severityMin || undefined,
        limit: 100,
        order: 'created_at',
        dir: 'desc',
      },
      { signal },
    ),
    [code, status, severityMin],
    { enabled: Boolean(code) },
  );

  const stats = useApi(
    ({ signal }) => getAlertStats({ campaign_code: code, days: 30 }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );

  const rules = useApi(
    ({ signal }) => listRules({ campaign_code: code, limit: 100 }, { signal }),
    [code],
    { enabled: Boolean(code) && tab === 'rules' },
  );

  if (!code) return <EmptyState title="Seleccione una campana" />;

  const totals = stats.data?.totals;

  async function toggleRule(rule) {
    try {
      await setRuleEnabled(rule.id, !rule.is_enabled);
      toast.success(rule.is_enabled ? 'Regla desactivada.' : 'Regla activada.');
      rules.reload();
    } catch (err) {
      toast.error(err.message || 'No se pudo cambiar el estado de la regla.');
    }
  }

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Alertas"
        description="Lo que se disparo, con que valor, sobre que muestra y quien lo atendio."
        onReload={() => { alerts.reload(); stats.reload(); if (tab === 'rules') rules.reload(); }}
      >
        <div className="cp-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'alerts'} className={`btn btn-sm ${tab === 'alerts' ? 'btn-primary' : ''}`} onClick={() => setTab('alerts')}>
            <Bell size={13} aria-hidden="true" /> Alertas
          </button>
          <button type="button" role="tab" aria-selected={tab === 'rules'} className={`btn btn-sm ${tab === 'rules' ? 'btn-primary' : ''}`} onClick={() => setTab('rules')}>
            <Settings2 size={13} aria-hidden="true" /> Reglas
          </button>
        </div>
      </PageHeader>

      {totals && (
        <div className="grid grid-auto">
          <div className="tile cp-stat"><span>Abiertas</span><b className="mono">{formatNumber(totals.open)}</b></div>
          <div className="tile cp-stat"><span>Sin leer</span><b className="mono">{formatNumber(totals.unread)}</b></div>
          <div className="tile cp-stat"><span>Resueltas</span><b className="mono">{formatNumber(totals.resolved)}</b></div>
          <div className="tile cp-stat"><span>Falsos positivos</span><b className="mono">{formatNumber(totals.false_positives)}</b></div>
          <div className="tile cp-stat"><span>Fuera de SLA</span><b className="mono">{formatNumber(totals.sla_breached)}</b></div>
          <div className="tile cp-stat"><span>Durante veda</span><b className="mono">{formatNumber(totals.during_blackout)}</b></div>
        </div>
      )}

      {tab === 'alerts' ? (
        <>
          {live.alerts.length > 0 && (
            <section className="tile cp-live">
              <div className="tile-head">
                <h3 className="tile-title"><Radio size={15} aria-hidden="true" /> Recibidas en vivo en esta sesion</h3>
                <span className="tile-sub">{live.alerts.length} evento(s) · {live.lastEventAt ? formatRelative(live.lastEventAt) : 'sin eventos'}</span>
              </div>
              <ul className="cp-live-list">
                {live.alerts.slice(0, 6).map((alert) => (
                  <li key={alert.id}>
                    <span className={`badge badge-${String(alert.severity_code || 'info').toLowerCase()}`}>{alert.severity_code}</span>
                    <strong>{alert.title}</strong>
                    <span className="text-muted">{alert.message}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-sm" onClick={() => { live.clear(); alerts.reload(); }}>
                Volcar al listado y limpiar
              </button>
            </section>
          )}

          <section className="tile">
            <div className="cp-filters">
              <select className="select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Estado">
                <option value="">Todo estado</option>
                {STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <select className="select" value={severityMin} onChange={(event) => setSeverityMin(event.target.value)} aria-label="Severidad minima">
                <option value="">Toda severidad</option>
                {SEVERITIES.map((item) => <option key={item} value={item}>desde {item}</option>)}
              </select>
            </div>

            <AlertList
              alerts={alerts.data?.data || []}
              loading={alerts.loading}
              error={alerts.error}
              onReload={alerts.reload}
              onChanged={() => { alerts.reload(); stats.reload(); }}
            />
          </section>
        </>
      ) : (
        <>
          {creating || editingRule ? (
            <AlertRuleForm
              campaignCode={code}
              rule={editingRule}
              onSaved={() => { setCreating(false); setEditingRule(null); rules.reload(); }}
              onCancel={() => { setCreating(false); setEditingRule(null); }}
            />
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden="true" /> Nueva regla
            </button>
          )}

          <section className="tile">
            <div className="tile-head"><h3 className="tile-title">Reglas configuradas</h3></div>
            {rules.error ? (
              <ErrorState error={rules.error} onRetry={rules.reload} />
            ) : rules.loading ? (
              <SkeletonRows rows={5} />
            ) : (rules.data?.data || []).length === 0 ? (
              <EmptyState compact title="La campana no tiene reglas" message="Cree una para empezar a vigilar un indicador." />
            ) : (
              <div className="cp-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Regla</th>
                      <th>Indicador</th>
                      <th>Condicion</th>
                      <th className="num">Muestra min.</th>
                      <th className="num">Disparos 30 d</th>
                      <th className="num">Falsos pos.</th>
                      <th>Estado</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rules.data.data.map((rule) => (
                      <tr key={rule.id}>
                        <td><strong>{rule.name}</strong><div className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>{rule.alert_type_code} · {rule.severity_code}</div></td>
                        <td>{rule.metric_label || rule.metric}</td>
                        <td className="mono">{rule.operator} {rule.threshold} · {rule.window_minutes} min</td>
                        <td className="num mono">{formatNumber(rule.min_sample_size)}</td>
                        <td className="num mono">{formatNumber(rule.triggers_30d)}</td>
                        <td className="num mono">{formatNumber(rule.false_positives)}</td>
                        <td><span className={`badge ${rule.is_enabled ? 'badge-positive' : 'badge-neutral'}`}>{rule.is_enabled ? 'activa' : 'inactiva'}</span></td>
                        <td>
                          <div className="row">
                            <button type="button" className="btn btn-sm" onClick={() => setEditingRule(rule)}>Editar</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => toggleRule(rule)}>
                              {rule.is_enabled ? 'Desactivar' : 'Activar'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default AlertsPage;
