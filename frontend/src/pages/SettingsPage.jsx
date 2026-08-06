/**
 * Ajustes: campana, cumplimiento, trabajos y estado de los servicios.
 *
 * El panel de cumplimiento no es decorativo: todos sus contadores deben ser
 * cero en operacion normal, y cualquier valor distinto es una obligacion legal
 * pendiente (fuentes sin base juridica, contenidos pasados de retencion,
 * suscripciones sin consentimiento).
 */
import { useState } from 'react';
import { RefreshCcw, ShieldCheck } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { useAuth } from '../auth/useAuth.js';
import { useApi } from '../hooks/useApi.js';
import { getCompliance, listJobs, refreshKpis } from '../services/campaigns.service.js';
import { getEngineStatus } from '../services/alerts.service.js';
import { useToast } from '../components/ToastSystem.jsx';
import {
  ALERTS_ORIGIN, REPORTS_ORIGIN, SENTIMENT_ORIGIN, WHATSAPP_ORIGIN,
} from '../services/index.js';
import { brand } from '../config/brand.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { SkeletonRows } from '../components/SkeletonTile.jsx';
import { formatDateTime, formatNumber } from '../config/format.js';
import ManualCommentCard from '../components/ManualCommentCard.jsx';

const COMPLIANCE_FIELDS = [
  ['sources_missing_legal_basis', 'Fuentes sin base juridica declarada'],
  ['contents_past_retention', 'Contenidos pasados del plazo de retencion'],
  ['contents_with_author_identity', 'Contenidos con identidad de autor almacenada'],
  ['stale_raw_payloads', 'Cargas crudas sin purgar'],
  ['subscriptions_without_consent', 'Suscripciones sin consentimiento'],
  ['risk_flags_pending_review', 'Banderas de riesgo sin revisar'],
  ['active_providers_without_no_training_clause', 'Proveedores sin clausula de no entrenamiento'],
];

export function SettingsPage() {
  const { campaign, code } = useCampaign();
  const { metrics, catalogs, loading: catalogsLoading, reload: reloadCatalogs } = useCatalogs();
  const { user, hasAnyRole } = useAuth();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);

  const canAudit = hasAnyRole(['auditor', 'admin', 'owner']);
  const canRefresh = hasAnyRole(['admin', 'owner']);

  const compliance = useApi(({ signal }) => getCompliance({ signal }), [], { enabled: canAudit });
  const jobs = useApi(({ signal }) => listJobs(code, { limit: 20 }, { signal }), [code], { enabled: Boolean(code) });
  const engine = useApi(({ signal }) => getEngineStatus({ signal }), []);

  async function doRefresh() {
    setRefreshing(true);
    try {
      const results = await refreshKpis();
      const failed = (results || []).filter((row) => !row.ok);
      if (failed.length > 0) toast.warning(`Algunas vistas fallaron: ${failed.map((row) => row.view_name).join(', ')}`);
      else toast.success('Vistas de indicadores refrescadas.');
    } catch (err) {
      toast.error(err.message || 'No se pudo refrescar.');
    } finally {
      setRefreshing(false);
    }
  }

  const status = compliance.data?.[0];

  return (
    <div className="stack animate-in">
      <PageHeader title="Ajustes" description="Configuracion de la campana, cumplimiento y estado de los servicios." />

      <div className="grid grid-2">
        <section className="tile">
          <div className="tile-head"><h3 className="tile-title">Campana activa</h3></div>
          {!campaign ? <EmptyState compact title="Sin campana seleccionada" /> : (
            <ul className="cp-kv">
              <li><span>Nombre</span><b>{campaign.name}</b></li>
              <li><span>Codigo</span><b className="mono">{campaign.code}</b></li>
              <li><span>Estado</span><b>{campaign.status}</b></li>
              <li><span>Tipo</span><b>{campaign.campaign_kind || '—'}</b></li>
              <li><span>Contienda</span><b>{campaign.contest_label || '—'}</b></li>
              <li><span>Zona horaria</span><b className="mono">{campaign.timezone}</b></li>
              <li><span>Jornada electoral</span><b>{campaign.election_date || '—'}</b></li>
              <li><span>Veda</span><b>{campaign.in_blackout ? `en curso hasta ${campaign.blackout_ends_on}` : (campaign.blackout_starts_on || 'no aplica')}</b></li>
              <li><span>Contendientes</span><b className="mono">{formatNumber(campaign.contender_count)}</b></li>
              <li><span>Fuentes activas</span><b className="mono">{formatNumber(campaign.active_source_count)}</b></li>
              <li><span>Organizacion</span><b>{campaign.organization_name}</b></li>
            </ul>
          )}
        </section>

        <section className="tile">
          <div className="tile-head"><h3 className="tile-title">Sesion y servicios</h3></div>
          <ul className="cp-kv">
            <li><span>Usuario</span><b>{user?.username}</b></li>
            <li><span>Organizacion</span><b className="mono">{user?.organizationId}</b></li>
            <li><span>Roles</span><b>{(user?.roles || []).join(', ') || '—'}</b></li>
            <li><span>sentiment-api</span><b className="mono">{SENTIMENT_ORIGIN}</b></li>
            <li><span>alerts-api</span><b className="mono">{ALERTS_ORIGIN}</b></li>
            <li><span>reports-api</span><b className="mono">{REPORTS_ORIGIN}</b></li>
            <li><span>whatsapp-bot</span><b className="mono">{WHATSAPP_ORIGIN}</b></li>
            <li>
              <span>Evaluador de reglas</span>
              <b className="mono">
                {engine.loading ? '…' : engine.error ? 'sin respuesta' : (engine.data?.data?.running ? 'en marcha' : 'detenido')}
              </b>
            </li>
            <li>
              <span>Registro de indicadores</span>
              <b className="mono">{catalogsLoading ? '…' : `${metrics.length} indicadores · ${Object.keys(catalogs).length} catalogos`}</b>
            </li>
          </ul>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={reloadCatalogs}>Recargar catalogos</button>
            {canRefresh && (
              <button type="button" className="btn btn-sm" onClick={doRefresh} disabled={refreshing}>
                <RefreshCcw size={13} aria-hidden="true" /> Refrescar indicadores
              </button>
            )}
          </div>
        </section>
      </div>

      {canAudit && (
        <section className="tile">
          <div className="tile-head">
            <h3 className="tile-title"><ShieldCheck size={15} aria-hidden="true" /> Cumplimiento</h3>
            <span className="tile-sub">Todos los contadores deben ser cero</span>
          </div>
          {compliance.error ? (
            <ErrorState compact error={compliance.error} onRetry={compliance.reload} />
          ) : compliance.loading ? (
            <SkeletonRows rows={4} />
          ) : !status ? (
            <EmptyState compact title="Sin datos de cumplimiento" />
          ) : (
            <>
              <div className="row row-wrap">
                <span className="pill">politica PII: {status.pii_policy}</span>
                <span className="pill">retencion: {status.data_retention_days} dias</span>
                <span className={`pill ${status.has_dpo_contact ? '' : 'cp-rel-warn'}`}>
                  contacto de proteccion de datos: {status.has_dpo_contact ? 'si' : 'no'}
                </span>
              </div>
              <ul className="cp-kv">
                {COMPLIANCE_FIELDS.map(([key, label]) => (
                  <li key={key}>
                    <span>{label}</span>
                    <b className={`mono ${status[key] > 0 ? 'text-danger' : 'text-success'}`}>{formatNumber(status[key])}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {/* Solo se pinta con rol admin; el propio componente devuelve null si no. */}
      <ManualCommentCard />

      <section className="tile">
        <div className="tile-head"><h3 className="tile-title">Trabajos de analisis recientes</h3></div>
        {jobs.error ? (
          <ErrorState compact error={jobs.error} onRetry={jobs.reload} />
        ) : jobs.loading ? (
          <SkeletonRows rows={4} />
        ) : (jobs.data || []).length === 0 ? (
          <EmptyState compact title="Sin trabajos registrados" />
        ) : (
          <div className="cp-table-wrap">
            <table className="table">
              <thead>
                <tr><th>Tipo</th><th>Estado</th><th className="num">Progreso</th><th className="num">Procesados</th><th className="num">Fallidos</th><th>Modelo</th><th>Creado</th></tr>
              </thead>
              <tbody>
                {jobs.data.map((jobRow) => (
                  <tr key={jobRow.id}>
                    <td>{jobRow.job_type}</td>
                    <td><span className="pill">{jobRow.status_label || jobRow.status_code}</span></td>
                    <td className="num mono">{formatNumber(jobRow.progress_pct)} %</td>
                    <td className="num mono">{formatNumber(jobRow.processed_items)} / {formatNumber(jobRow.total_items)}</td>
                    <td className="num mono">{formatNumber(jobRow.failed_items)}</td>
                    <td>{jobRow.model_name || '—'}</td>
                    <td className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(jobRow.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}

export default SettingsPage;
