/**
 * Informes en PDF (reports-api).
 *
 * La generacion es asincrona: POST /reports/generate devuelve 202 con jobId y
 * el cliente sondea /status hasta que el trabajo es terminal.
 */
import { reportsApi } from './index.js';

/** Secciones que admite el generador, en el orden en que las compone el PDF. */
export const REPORT_SECTIONS = [
  { code: 'executive_summary', label: 'Resumen ejecutivo' },
  { code: 'sentiment_distribution', label: 'Distribucion de sentimiento' },
  { code: 'timeline', label: 'Linea de tiempo' },
  { code: 'contenders', label: 'Contendientes' },
  { code: 'topics', label: 'Agenda tematica' },
  { code: 'alerts', label: 'Alertas del periodo' },
];

/** La nota metodologica va siempre: no es una seccion elegible. */
export const MANDATORY_SECTIONS = ['methodology'];

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export const listReports = (params = {}, options) => reportsApi.get('/reports', params, options);

/** @returns {Promise<{jobId, status, campaign, statusUrl, downloadUrl}>} */
export const generateReport = ({ campaignCode, periodDays = 30, sections, format = 'pdf' }, options) =>
  reportsApi.post(
    '/reports/generate',
    {
      campaignCode,
      periodDays,
      sections: sections && sections.length ? sections : REPORT_SECTIONS.map((s) => s.code),
      format,
    },
    options,
  );

export const getReportStatus = (jobId, options) =>
  reportsApi.get(`/reports/${jobId}/status`, undefined, options);

/**
 * Sondeo hasta estado terminal.
 *
 * `onProgress` recibe el bloque `data` de cada respuesta. El intervalo crece
 * un poco en cada vuelta: un informe largo no necesita 200 peticiones.
 */
export async function pollReport(jobId, { intervalMs = 2000, maxWaitMs = 300000, onProgress, signal } = {}) {
  const started = Date.now();
  let wait = intervalMs;

  for (;;) {
    const response = await getReportStatus(jobId, { signal });
    const job = response?.data || response;
    if (onProgress) onProgress(job);
    if (job && (job.isTerminal || TERMINAL.has(job.status))) return job;
    if (Date.now() - started > maxWaitMs) {
      const err = new Error('El informe tardo mas de lo previsto; consulte el listado mas tarde.');
      err.code = 'REPORT_TIMEOUT';
      throw err;
    }
    await new Promise((resolve) => { setTimeout(resolve, wait); });
    wait = Math.min(Math.round(wait * 1.25), 10000);
  }
}

/**
 * Descarga el PDF.
 *
 * No se usa un enlace directo porque la descarga necesita la cabecera
 * Authorization: se pide como blob y se dispara con un objeto URL efimero.
 */
export async function downloadReport(jobId, filename) {
  const response = await reportsApi.request(`/reports/${jobId}/download`, {
    method: 'GET',
    accept: 'application/pdf',
    raw: true,
    timeout: 120000,
  });

  if (response.status === 202) {
    const body = await response.json().catch(() => ({}));
    const err = new Error(body.message || 'El informe aun se esta generando.');
    err.code = 'REPORT_NOT_READY';
    throw err;
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename || `oeste-sentimientos-${String(jobId).slice(0, 8)}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revocar de inmediato aborta la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  return true;
}

export default {
  REPORT_SECTIONS, MANDATORY_SECTIONS, listReports, generateReport,
  getReportStatus, pollReport, downloadReport,
};
