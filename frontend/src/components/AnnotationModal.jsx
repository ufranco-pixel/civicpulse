/**
 * Correccion humana de una inferencia (POST /inferences/{id}/annotate).
 *
 * Dos reglas del backend que el formulario respeta para no provocar un 422:
 *  · `stance_code` exige `stance_target_id`: la postura siempre es hacia
 *    alguien. Si se elige postura sin contendiente, el boton no se habilita.
 *  · Al menos una etiqueta debe venir informada: una anotacion vacia marcaria
 *    la inferencia como reemplazada sin aportar verdad de referencia.
 *
 * Anotar marca la inferencia del modelo como reemplazada y los KPIs la
 * excluyen de inmediato: es una correccion, no un comentario.
 */
import { useMemo, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { annotateInference } from '../services/inferences.service.js';
import { useToast } from './ToastSystem.jsx';
import { truncate } from '../config/format.js';

export function AnnotationModal({ inference, contenders = [], onClose, onSaved }) {
  const { catalog } = useCatalogs();
  const toast = useToast();

  const [sentimentCode, setSentimentCode] = useState(inference?.sentiment_code || '');
  const [intentCode, setIntentCode] = useState(inference?.intent_code || '');
  const [stanceCode, setStanceCode] = useState('');
  const [stanceTargetId, setStanceTargetId] = useState('');
  const [emotionCodes, setEmotionCodes] = useState([]);
  const [topicCodes, setTopicCodes] = useState([]);
  const [riskFlagCodes, setRiskFlagCodes] = useState([]);
  const [confidence, setConfidence] = useState(0.9);
  const [isGold, setIsGold] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toggle = (list, setList, code) => {
    setList(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);
  };

  const stanceNeedsTarget = Boolean(stanceCode) && !stanceTargetId;
  const hasSomething = Boolean(
    sentimentCode || intentCode || stanceCode
    || emotionCodes.length || topicCodes.length || riskFlagCodes.length,
  );
  const canSave = hasSomething && !stanceNeedsTarget && !saving;

  const body = useMemo(
    () => ({
      sentiment_code: sentimentCode || null,
      intent_code: intentCode || null,
      stance_code: stanceCode || null,
      stance_target_id: stanceTargetId || null,
      emotion_codes: emotionCodes,
      topic_codes: topicCodes,
      risk_flag_codes: riskFlagCodes,
      annotator_confidence: Number(confidence),
      is_gold: isGold,
      notes: notes || null,
    }),
    [sentimentCode, intentCode, stanceCode, stanceTargetId, emotionCodes, topicCodes, riskFlagCodes, confidence, isGold, notes],
  );

  async function submit(event) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await annotateInference(inference.id, body);
      toast.success('Correccion registrada. La inferencia del modelo queda reemplazada.');
      onSaved?.(result);
      onClose?.();
    } catch (err) {
      setError(err);
      toast.error(err.message || 'No se pudo guardar la correccion.');
    } finally {
      setSaving(false);
    }
  }

  if (!inference) return null;

  return (
    <div className="cp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cp-modal" role="dialog" aria-modal="true" aria-labelledby="cp-annot-title">
        <header className="cp-modal-head">
          <h2 id="cp-annot-title">Corregir clasificacion</h2>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="cp-modal-body">
          <blockquote className="cp-evidence">{truncate(inference.text, 420)}</blockquote>
          <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
            El modelo dijo: <b>{inference.sentiment_label || inference.sentiment_code}</b>
            {' '}(confianza {Number(inference.overall_confidence).toFixed(2)})
          </p>

          <form onSubmit={submit} className="stack" id="cp-annot-form">
            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">Sentimiento</span>
                <select className="select" value={sentimentCode} onChange={(e) => setSentimentCode(e.target.value)}>
                  <option value="">Sin cambio</option>
                  {catalog('sentiment_types').map((item) => (
                    <option key={item.code} value={item.code}>{item.label_es}</option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field-label">Intencion</span>
                <select className="select" value={intentCode} onChange={(e) => setIntentCode(e.target.value)}>
                  <option value="">Sin cambio</option>
                  {catalog('intent_types').map((item) => (
                    <option key={item.code} value={item.code}>{item.label_es}</option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field-label">Postura</span>
                <select className="select" value={stanceCode} onChange={(e) => setStanceCode(e.target.value)}>
                  <option value="">Sin postura</option>
                  {catalog('stance_types').map((item) => (
                    <option key={item.code} value={item.code}>{item.label_es}</option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field-label">Postura hacia</span>
                <select
                  className="select"
                  value={stanceTargetId}
                  onChange={(e) => setStanceTargetId(e.target.value)}
                  aria-invalid={stanceNeedsTarget}
                >
                  <option value="">— elegir contendiente —</option>
                  {contenders.map((item) => (
                    <option key={item.contender_id} value={item.contender_id}>{item.contender_name}</option>
                  ))}
                </select>
                {stanceNeedsTarget && (
                  <span className="field-help text-danger">
                    La postura siempre es hacia alguien: elija el contendiente o quite la postura.
                  </span>
                )}
              </label>
            </div>

            <fieldset className="cp-fieldset">
              <legend className="field-label">Emociones</legend>
              <div className="row row-wrap">
                {catalog('emotion_types').map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    className={`pill cp-pill-toggle ${emotionCodes.includes(item.code) ? 'is-on' : ''}`}
                    onClick={() => toggle(emotionCodes, setEmotionCodes, item.code)}
                  >
                    {item.label_es}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="cp-fieldset">
              <legend className="field-label">Temas</legend>
              <div className="row row-wrap">
                {catalog('topic_categories').map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    className={`pill cp-pill-toggle ${topicCodes.includes(item.code) ? 'is-on' : ''}`}
                    onClick={() => toggle(topicCodes, setTopicCodes, item.code)}
                  >
                    {item.label_es}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="cp-fieldset">
              <legend className="field-label">Banderas de riesgo</legend>
              <div className="row row-wrap">
                {catalog('risk_flags').map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    className={`pill cp-pill-toggle ${riskFlagCodes.includes(item.code) ? 'is-on' : ''}`}
                    onClick={() => toggle(riskFlagCodes, setRiskFlagCodes, item.code)}
                  >
                    {item.label_es}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">Su confianza: {Number(confidence).toFixed(2)}</span>
                <input type="range" min="0" max="1" step="0.05" value={confidence} onChange={(e) => setConfidence(e.target.value)} />
              </label>

              <label className="field">
                <span className="field-label">Caso dorado</span>
                <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)' }}>
                  <input type="checkbox" checked={isGold} onChange={(e) => setIsGold(e.target.checked)} />
                  Apto para el conjunto de evaluacion
                </label>
                <span className="field-help">
                  Marquelo solo si la etiqueta es indiscutible: los casos dorados fijan el techo contra el que se mide el modelo.
                </span>
              </label>
            </div>

            <label className="field">
              <span className="field-label">Notas</span>
              <textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Por que el modelo se equivoco (ironia, jerga local, negacion…)" />
            </label>

            {error && <p className="text-danger" style={{ fontSize: 'var(--fs-xs)' }}>{error.message}</p>}
          </form>
        </div>

        <footer className="cp-modal-foot">
          <span className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>
            Guardar reemplaza la inferencia del modelo y actualiza los indicadores.
          </span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" form="cp-annot-form" className="btn btn-primary" disabled={!canSave}>
            {saving ? <Loader2 size={14} className="cp-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            Guardar correccion
          </button>
        </footer>
      </div>
    </div>
  );
}

export default AnnotationModal;
