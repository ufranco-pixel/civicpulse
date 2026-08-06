/**
 * Cola de revision humana.
 *
 * Ordenada por `review_priority`, que ya calcula la vista combinando confianza
 * baja, ironia alta y alcance: revisar por orden cronologico desperdicia el
 * tiempo del analista en comentarios que no lee nadie.
 *
 * Dos acciones distintas y no intercambiables:
 *  · Confirmar (PATCH /review) deja la etiqueta del modelo, que sigue contando.
 *  · Corregir (POST /annotate) la reemplaza y los KPIs la excluyen.
 */
import { useState } from 'react';
import { Check, ExternalLink, PencilLine } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { getInference, getReviewQueue, reviewInference } from '../services/inferences.service.js';
import { getContenders } from '../services/campaigns.service.js';
import { useToast } from '../components/ToastSystem.jsx';
import AnnotationModal from '../components/AnnotationModal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { SkeletonRows } from '../components/SkeletonTile.jsx';
import { formatDateTime, formatNumber, truncate } from '../config/format.js';

export function ReviewPage() {
  const { code } = useCampaign();
  const toast = useToast();
  const [annotating, setAnnotating] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const queue = useApi(
    ({ signal }) => getReviewQueue(code, { limit: 50 }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );

  const contenders = useApi(
    ({ signal }) => getContenders(code, { days: 30 }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );

  if (!code) return <EmptyState title="Seleccione una campana" />;

  async function confirm(item) {
    setBusyId(item.inference_id);
    try {
      await reviewInference(item.inference_id, { review_status: 'confirmed' });
      toast.success('Etiqueta confirmada. Sigue contando en los indicadores.');
      queue.reload();
    } catch (err) {
      toast.error(err.message || 'No se pudo confirmar.');
    } finally {
      setBusyId(null);
    }
  }

  async function openCorrection(item) {
    try {
      // La cola trae un extracto; el modal necesita la inferencia completa
      // para mostrar lo que el modelo dijo y precargar las etiquetas.
      const full = await getInference(item.inference_id);
      setAnnotating(full);
    } catch (err) {
      toast.error(err.message || 'No se pudo abrir el detalle.');
    }
  }

  const items = queue.data || [];

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Revision"
        description="Cola priorizada: primero lo que mas puede estar mal clasificado y mas se ve."
        onReload={queue.reload}
      />


      {queue.error ? (
        <ErrorState error={queue.error} onRetry={queue.reload} />
      ) : queue.loading ? (
        <SkeletonRows rows={6} />
      ) : items.length === 0 ? (
        <EmptyState title="No hay nada pendiente de revision" message="La cola esta vacia para esta campana." />
      ) : (
        <ul className="cp-review-list">
          {items.map((item) => (
            <li key={item.inference_id} className="tile">
              <div className="row row-wrap">
                <span className="pill cp-priority" title="Prioridad calculada por la vista de revision">
                  prioridad {formatNumber(item.review_priority)}
                </span>
                <span className="pill">{item.source_type}</span>
                <span className="pill">{item.sentiment_code} · <b className="mono">{Number(item.sentiment_score).toFixed(2)}</b></span>
                <span className="pill mono">confianza {Number(item.overall_confidence).toFixed(2)}</span>
                {Number(item.sarcasm_score || 0) >= 0.5 && (
                  <span className="pill cp-rel-warn">ironia {Number(item.sarcasm_score).toFixed(2)}</span>
                )}
                {Number(item.toxicity_score || 0) >= 0.5 && (
                  <span className="pill cp-flag-risk">toxicidad {Number(item.toxicity_score).toFixed(2)}</span>
                )}
                <div className="spacer" />
                <span className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{formatDateTime(item.published_at)}</span>
              </div>

              <p className="cp-review-text">{truncate(item.text, 420)}</p>

              <div className="row row-wrap">
                <button type="button" className="btn btn-sm btn-primary" disabled={busyId === item.inference_id} onClick={() => confirm(item)}>
                  <Check size={13} aria-hidden="true" /> Confirmar etiqueta
                </button>
                <button type="button" className="btn btn-sm" onClick={() => openCorrection(item)}>
                  <PencilLine size={13} aria-hidden="true" /> Corregir
                </button>
                {item.url && (
                  <a className="btn btn-sm btn-ghost" href={item.url} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={13} aria-hidden="true" /> Original
                  </a>
                )}
                <div className="spacer" />
                <span className="pill mono">alcance {formatNumber(item.reach_estimate)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {annotating && (
        <AnnotationModal
          inference={annotating}
          contenders={contenders.data || []}
          onClose={() => setAnnotating(null)}
          onSaved={() => queue.reload()}
        />
      )}
    </div>
  );
}

export default ReviewPage;
