/**
 * Informes en PDF.
 *
 * La generacion es asincrona: se encola, se sondea el estado y despues se
 * descarga. La nota metodologica va siempre en el documento; no es una seccion
 * que se pueda desmarcar.
 */
import { useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import {
  REPORT_SECTIONS, downloadReport, generateReport, listReports, pollReport,
} from '../services/reports.service.js';
import { brand } from '../config/brand.js';
import { useToast } from '../components/ToastSystem.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { SkeletonRows } from '../components/SkeletonTile.jsx';
import { formatDateTime, formatNumber } from '../config/format.js';

export function ReportsPage() {
  const { code, campaign } = useCampaign();
  const toast = useToast();

  const [periodDays, setPeriodDays] = useState(30);
  const [sections, setSections] = useState(REPORT_SECTIONS.map((section) => section.code));
  const [job, setJob] = useState(null);
  const [working, setWorking] = useState(false);

  const reports = useApi(
    ({ signal }) => listReports({ campaign_code: code, limit: 50 }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );

  if (!code) return <EmptyState title="Seleccione una campana" />;

  const toggleSection = (sectionCode) => {
    setSections((current) => (current.includes(sectionCode)
      ? current.filter((item) => item !== sectionCode)
      : [...current, sectionCode]));
  };

  async function generate(event) {
    event.preventDefault();
    if (sections.length === 0) return;
    setWorking(true);
    setJob(null);
    try {
      const created = await generateReport({ campaignCode: code, periodDays, sections });
      toast.info('Informe encolado. Se avisara al terminar.');
      const finished = await pollReport(created.jobId, { onProgress: setJob });
      setJob(finished);
      if (finished.status === 'completed') {
        toast.success('Informe listo para descargar.');
        reports.reload();
      } else {
        toast.error(finished.error || `El informe termino en estado ${finished.status}.`);
      }
    } catch (err) {
      toast.error(err.message || 'No se pudo generar el informe.');
    } finally {
      setWorking(false);
    }
  }

  async function download(jobId) {
    try {
      await downloadReport(jobId, `oeste-sentimientos-${code}-${String(jobId).slice(0, 8)}.pdf`);
    } catch (err) {
      toast.error(err.message || 'No se pudo descargar el informe.');
    }
  }

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Informes"
        description={`Documento en PDF con los datos reales de ${campaign?.name || code}.`}
        onReload={reports.reload}
      />

      <form className="tile stack" onSubmit={generate}>
        <div className="tile-head"><h3 className="tile-title"><FileText size={15} aria-hidden="true" /> Nuevo informe</h3></div>


        <label className="field" style={{ maxWidth: 220 }}>
          <span className="field-label">Periodo (dias)</span>
          <input className="input" type="number" min="1" max="365" value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))} />
        </label>

        <fieldset className="cp-fieldset">
          <legend className="field-label">Secciones</legend>
          <div className="row row-wrap">
            {REPORT_SECTIONS.map((section) => (
              <button
                key={section.code}
                type="button"
                className={`pill cp-pill-toggle ${sections.includes(section.code) ? 'is-on' : ''}`}
                onClick={() => toggleSection(section.code)}
              >
                {section.label}
              </button>
            ))}
            <span className="pill cp-pill-locked" title="Obligatoria">Nota metodologica</span>
          </div>
        </fieldset>

        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={working || sections.length === 0}>
            {working ? <Loader2 size={14} className="cp-spin" aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
            Generar informe
          </button>
          {job && (
            <span className="pill mono">
              {job.status} · {formatNumber(job.progressPct)} %
              {job.processedItems ? ` · ${formatNumber(job.processedItems)}/${formatNumber(job.totalItems)}` : ''}
            </span>
          )}
          {job?.status === 'completed' && (
            <button type="button" className="btn btn-sm" onClick={() => download(job.jobId)}>
              <Download size={13} aria-hidden="true" /> Descargar
            </button>
          )}
        </div>

        {job?.artifact?.warnings?.length > 0 && (
          <ul className="cp-warn-list">
            {job.artifact.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        )}
      </form>

      <section className="tile">
        <div className="tile-head"><h3 className="tile-title">Informes generados</h3></div>
        {reports.error ? (
          <ErrorState error={reports.error} onRetry={reports.reload} />
        ) : reports.loading ? (
          <SkeletonRows rows={5} />
        ) : (reports.data?.data || []).length === 0 ? (
          <EmptyState compact title="Todavia no se ha generado ningun informe" />
        ) : (
          <div className="cp-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Informe</th><th>Estado</th><th className="num">Periodo</th><th>Secciones</th>
                  <th className="num">Tamano</th><th>Creado por</th><th>Fecha</th><th />
                </tr>
              </thead>
              <tbody>
                {reports.data.data.map((item) => (
                  <tr key={item.jobId}>
                    <td className="mono">{String(item.jobId).slice(0, 8)}</td>
                    <td>
                      <span className="pill">{item.statusLabel || item.status}</span>
                      {item.error && <div className="text-danger" style={{ fontSize: 'var(--fs-2xs)' }}>{item.error}</div>}
                    </td>
                    <td className="num mono">{item.periodDays ? `${item.periodDays} d` : '—'}</td>
                    <td className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>{(item.sections || []).join(', ') || '—'}</td>
                    <td className="num mono">{item.bytes ? `${Math.round(item.bytes / 1024)} kB` : '—'}</td>
                    <td className="text-subtle">{item.createdBy || '—'}</td>
                    <td className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(item.createdAt)}</td>
                    <td>
                      {item.status === 'completed' && !item.purged && (
                        <button type="button" className="btn btn-sm" onClick={() => download(item.jobId)}>
                          <Download size={13} aria-hidden="true" /> PDF
                        </button>
                      )}
                      {item.purged && <span className="pill" title="Borrado por la politica de retencion">purgado</span>}
                    </td>
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

export default ReportsPage;
