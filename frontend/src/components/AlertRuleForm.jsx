/**
 * Alta y edicion de reglas de alerta.
 *
 * El selector de metrica se puebla desde GET /metrics y se limita a las
 * `is_alertable`: hay indicadores validos para el tablero que no sirven para
 * disparar alertas (por ejemplo los que necesitan 14 dias de historia).
 *
 * La muestra minima se destaca a proposito. Es el parametro que separa una
 * regla util de una fabrica de falsos positivos: dos comentarios negativos de
 * dos dan 100 % de negatividad. Si el valor queda por debajo del minimo del
 * registro, el backend devuelve un aviso y aqui se muestra antes de guardar.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FlaskConical, Loader2, Save } from 'lucide-react';
import { useCatalogs } from '../hooks/useCatalogs.js';
import { createRule, testRule, updateRule } from '../services/alerts.service.js';
import { useToast } from './ToastSystem.jsx';
import InfoTooltip from './InfoTooltip.jsx';
import { formatNumber } from '../config/format.js';

const OPERATORS = [
  { code: 'gt', label: 'mayor que (>)' },
  { code: 'gte', label: 'mayor o igual (≥)' },
  { code: 'lt', label: 'menor que (<)' },
  { code: 'lte', label: 'menor o igual (≤)' },
  { code: 'eq', label: 'igual a (=)' },
  { code: 'neq', label: 'distinto de (≠)' },
];

const CHANNELS = ['sse', 'email', 'whatsapp', 'webhook', 'slack'];

const EMPTY = {
  name: '',
  alert_type_code: '',
  severity_code: 'medium',
  metric: '',
  operator: 'gt',
  threshold: 0,
  window_minutes: 60,
  min_sample_size: 30,
  cooldown_minutes: 120,
  consecutive_hits: 1,
  max_per_day: 12,
  respect_blackout: true,
  channels: ['sse'],
  is_enabled: true,
  message_template: '',
};

export function AlertRuleForm({ campaignCode, rule = null, onSaved, onCancel }) {
  const { catalog, alertableMetrics, getMetric } = useCatalogs();
  const toast = useToast();
  const [form, setForm] = useState({ ...EMPTY, ...(rule || {}) });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const metric = useMemo(() => (form.metric ? getMetric(form.metric) : null), [form.metric, getMetric]);
  const weakSample = metric && Number(form.min_sample_size) < Number(metric.min_sample_size || 0);

  // Al elegir metrica se propone la muestra minima del registro: es el punto
  // de partida correcto, y el usuario puede subirla pero vera el aviso si baja.
  useEffect(() => {
    if (metric && metric.known && !rule) {
      set({ min_sample_size: metric.min_sample_size ?? 30 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.metric]);

  const alertTypes = catalog('alert_types');
  const severities = catalog('severity_levels');

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        alert_type_code: form.alert_type_code,
        severity_code: form.severity_code,
        metric: form.metric,
        operator: form.operator,
        threshold: Number(form.threshold),
        window_minutes: Number(form.window_minutes),
        min_sample_size: Number(form.min_sample_size),
        cooldown_minutes: Number(form.cooldown_minutes),
        consecutive_hits: Number(form.consecutive_hits),
        max_per_day: Number(form.max_per_day),
        respect_blackout: Boolean(form.respect_blackout),
        channels: form.channels,
        message_template: form.message_template || null,
        is_enabled: Boolean(form.is_enabled),
      };

      const response = rule
        ? await updateRule(rule.id, payload)
        : await createRule({ ...payload, campaign_code: campaignCode });

      const warnings = response?.warnings || [];
      if (warnings.length > 0) warnings.forEach((warning) => toast.warning(warning));
      toast.success(rule ? 'Regla actualizada.' : 'Regla creada.');
      onSaved?.(response?.data || response);
    } catch (err) {
      setError(err);
      toast.error(err.message || 'No se pudo guardar la regla.');
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!rule) return;
    setTesting(true);
    try {
      const result = await testRule(rule.id, {
        threshold: Number(form.threshold),
        operator: form.operator,
        window_minutes: Number(form.window_minutes),
      });
      setTestResult(result);
    } catch (err) {
      toast.error(err.message || 'No se pudo probar la regla.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="tile stack" onSubmit={save}>
      <div className="tile-head">
        <h3 className="tile-title">{rule ? 'Editar regla' : 'Nueva regla de alerta'}</h3>
      </div>

      <div className="grid grid-2">
        <label className="field">
          <span className="field-label">Nombre</span>
          <input className="input" required minLength={3} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>

        <label className="field">
          <span className="field-label">Tipo de alerta</span>
          <select className="select" required value={form.alert_type_code} onChange={(e) => set({ alert_type_code: e.target.value })}>
            <option value="">— elegir —</option>
            {alertTypes.map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Severidad</span>
          <select className="select" value={form.severity_code} onChange={(e) => set({ severity_code: e.target.value })}>
            {severities.map((item) => <option key={item.code} value={item.code}>{item.label_es}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="field-label">
            Indicador
            <InfoTooltip text="Solo aparecen los indicadores marcados como alertables en el registro. Los demas son validos para el tablero pero no para disparar alertas." />
          </span>
          <select className="select" required value={form.metric} onChange={(e) => set({ metric: e.target.value })}>
            <option value="">— elegir —</option>
            {alertableMetrics.map((item) => (
              <option key={item.code} value={item.code}>{item.label_es} ({item.unit})</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-3">
        <label className="field">
          <span className="field-label">Operador</span>
          <select className="select" value={form.operator} onChange={(e) => set({ operator: e.target.value })}>
            {OPERATORS.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Umbral {metric?.unit ? `(${metric.unit})` : ''}</span>
          <input className="input" type="number" step="any" required value={form.threshold} onChange={(e) => set({ threshold: e.target.value })} />
        </label>

        <label className="field">
          <span className="field-label">Ventana (minutos)</span>
          <input className="input" type="number" min="1" max="43200" value={form.window_minutes} onChange={(e) => set({ window_minutes: e.target.value })} />
        </label>
      </div>

      <label className="field cp-highlight-field">
        <span className="field-label">
          Muestra minima
          <InfoTooltip
            title="Por que importa"
            text="Es el numero minimo de contenidos que debe haber en la ventana para que la regla pueda dispararse. Sin el, dos comentarios negativos de dos producen un 100 % de negatividad y una alerta critica sobre nada. El registro de indicadores publica un minimo por metrica; bajarlo es posible, pero la alerta podra dispararse sobre datos que el propio indicador considera no publicables."
          />
        </span>
        <input className="input" type="number" min="0" value={form.min_sample_size} onChange={(e) => set({ min_sample_size: e.target.value })} />
        {metric?.known && (
          <span className={`field-help ${weakSample ? 'text-danger' : ''}`}>
            Minimo del registro para {metric.label}: {formatNumber(metric.min_sample_size)}.
            {weakSample && ' Por debajo de ese valor la regla puede disparar sobre muestras no publicables.'}
          </span>
        )}
      </label>

      <div className="grid grid-3">
        <label className="field">
          <span className="field-label">
            Histeresis (aciertos consecutivos)
            <InfoTooltip text="Numero de evaluaciones seguidas que deben cumplir la condicion antes de disparar. Evita la alerta por un pico de un minuto." />
          </span>
          <input className="input" type="number" min="1" max="32" value={form.consecutive_hits} onChange={(e) => set({ consecutive_hits: e.target.value })} />
        </label>

        <label className="field">
          <span className="field-label">
            Silencio tras disparo (minutos)
            <InfoTooltip text="Tiempo durante el cual la regla no vuelve a disparar aunque la condicion siga cumpliendose." />
          </span>
          <input className="input" type="number" min="0" max="10080" value={form.cooldown_minutes} onChange={(e) => set({ cooldown_minutes: e.target.value })} />
        </label>

        <label className="field">
          <span className="field-label">Tope diario</span>
          <input className="input" type="number" min="1" value={form.max_per_day} onChange={(e) => set({ max_per_day: e.target.value })} />
        </label>
      </div>

      <fieldset className="cp-fieldset">
        <legend className="field-label">Canales</legend>
        <div className="row row-wrap">
          {CHANNELS.map((channel) => (
            <button
              key={channel}
              type="button"
              className={`pill cp-pill-toggle ${form.channels.includes(channel) ? 'is-on' : ''}`}
              onClick={() => set({
                channels: form.channels.includes(channel)
                  ? form.channels.filter((c) => c !== channel)
                  : [...form.channels, channel],
              })}
            >
              {channel}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="row row-wrap">
        <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)' }}>
          <input type="checkbox" checked={form.respect_blackout} onChange={(e) => set({ respect_blackout: e.target.checked })} />
          Respetar la veda electoral
          <InfoTooltip text="Durante la veda la alerta se registra igualmente, pero no se notifica por canales externos." />
        </label>
        <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)' }}>
          <input type="checkbox" checked={form.is_enabled} onChange={(e) => set({ is_enabled: e.target.checked })} />
          Regla activa
        </label>
      </div>

      {weakSample && (
        <p className="cp-metric-warn">
          <AlertTriangle size={13} aria-hidden="true" /> La muestra minima esta por debajo del minimo del registro.
        </p>
      )}

      {testResult && (
        <div className="tile cp-test-result">
          <strong>Prueba en seco</strong>
          <ul>
            <li>Valor observado: <span className="mono">{testResult.evaluation?.observed_value ?? '—'}</span></li>
            <li>Condicion: {testResult.evaluation?.condition_met ? 'se cumple' : 'no se cumple'}</li>
            <li>Dispararia: <b>{testResult.evaluation?.would_fire ? 'si' : 'no'}</b> · notificaria: <b>{testResult.evaluation?.would_notify ? 'si' : 'no'}</b></li>
            {(testResult.evaluation?.blockers || []).length > 0 && (
              <li>Bloqueos: {testResult.evaluation.blockers.join('; ')}</li>
            )}
            {(testResult.evaluation?.notify_blockers || []).length > 0 && (
              <li>Bloqueos de notificacion: {testResult.evaluation.notify_blockers.join('; ')}</li>
            )}
            <li className="text-subtle">Muestra fiable segun el registro: {testResult.reliable ? 'si' : 'no'}</li>
          </ul>
        </div>
      )}

      {error && <p className="text-danger" style={{ fontSize: 'var(--fs-xs)' }}>{error.message}</p>}

      <div className="row">
        {rule && (
          <button type="button" className="btn btn-sm" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 size={13} className="cp-spin" aria-hidden="true" /> : <FlaskConical size={13} aria-hidden="true" />}
            Probar sin disparar
          </button>
        )}
        <div className="spacer" />
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancelar</button>}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <Loader2 size={14} className="cp-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
          {rule ? 'Guardar cambios' : 'Crear regla'}
        </button>
      </div>
    </form>
  );
}

export default AlertRuleForm;
