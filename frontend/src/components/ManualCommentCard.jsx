/**
 * Registro manual de un comentario, con envío de la alerta.
 *
 * Solo para rol admin. La comprobación de aquí es de interfaz —esconder un
 * botón no protege nada—; quien lo impide de verdad es el
 * `require_min_role(ROLE_ADMIN)` del endpoint. Esta capa existe para no
 * ofrecerle a un analista un botón que le va a devolver 403.
 *
 * Muestra los destinatarios ANTES de enviar. Sin ese dato el flujo es a
 * ciegas: se pulsa, sale «creado» y no hay forma de saber si salió un mensaje
 * o si simplemente no hay nadie dado de alta, que es lo que pasa la primera
 * vez que alguien lo usa.
 */
import { useCallback, useState } from 'react';
import { AlertTriangle, MessageSquarePlus, Send } from 'lucide-react';
import { useAuth } from '../auth/useAuth.js';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { createManualComment, listWhatsappRecipients } from '../services/manual.service.js';

export function ManualCommentCard() {
  const { hasRole } = useAuth();
  const { code, campaign } = useCampaign();

  const [texto, setTexto] = useState('');
  const [autor, setAutor] = useState('');
  const [avisar, setAvisar] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState(null);

  const esAdmin = hasRole('admin') || hasRole('owner');

  const destinatarios = useApi(
    ({ signal }) => listWhatsappRecipients(code, { severity: 'high' }, { signal }),
    [code],
    { enabled: Boolean(code) && esAdmin },
  );

  const enviar = useCallback(async (e) => {
    e.preventDefault();
    if (texto.trim().length < 3) return;
    setEnviando(true); setError(null); setResultado(null);
    try {
      const r = await createManualComment(code, {
        body: texto.trim(),
        sentiment: 'negative',
        author_display: autor.trim() || null,
        notify: avisar,
      });
      setResultado(r);
      setTexto(''); setAutor('');
      destinatarios.reload();
    } catch (err) {
      setError(err?.message || 'No se pudo registrar el comentario.');
    } finally {
      setEnviando(false);
    }
  }, [code, texto, autor, avisar, destinatarios]);

  if (!esAdmin) return null;

  const nDest = destinatarios.data?.count ?? null;

  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-title">
          <MessageSquarePlus size={16} aria-hidden="true" /> Registrar comentario negativo
        </h3>
        <span className="tile-sub">
          Solo administradores. Genera la alerta y manda el WhatsApp a los suscriptores.
        </span>
      </div>

      {/* Advertencia deliberada. Lo que se registra aquí entra en los mismos
          indicadores que los comentarios recogidos de fuentes reales. */}
      <p className="cp-banner-warn">
        <AlertTriangle size={14} aria-hidden="true" />
        Lo registrado cuenta en los indicadores igual que un comentario recogido de una
        fuente. Queda marcado como registro manual y con su usuario.
      </p>

      <form className="stack" onSubmit={enviar}>
        <label className="field">
          <span className="field-label">Comentario</span>
          <textarea
            className="input"
            rows={3}
            value={texto}
            maxLength={4000}
            onChange={(ev) => setTexto(ev.target.value)}
            placeholder="Texto del comentario tal como se recibió"
            required
          />
        </label>

        <label className="field" style={{ maxWidth: 280 }}>
          <span className="field-label">Autor (opcional)</span>
          <input
            className="input"
            value={autor}
            maxLength={120}
            onChange={(ev) => setAutor(ev.target.value)}
            placeholder="Nombre o alias"
          />
        </label>

        <label className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
          <input type="checkbox" checked={avisar} onChange={(ev) => setAvisar(ev.target.checked)} />
          <span>Generar alerta y notificar por WhatsApp</span>
        </label>

        <div className="row" style={{ gap: 'var(--sp-3)', alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={enviando || !code}>
            <Send size={14} aria-hidden="true" />
            {enviando ? 'Registrando…' : 'Registrar'}
          </button>

          {avisar && nDest !== null && (
            nDest === 0
              ? (
                <span className="cp-metric-warn">
                  No hay ningún destinatario de WhatsApp dado de alta: la alerta se creará
                  pero no saldrá ningún mensaje.
                </span>
              )
              : (
                <span className="text-subtle">
                  Se enviará a {nDest} {nDest === 1 ? 'destinatario' : 'destinatarios'}
                  {campaign?.in_blackout ? ' (en veda: quedará registrado sin enviarse)' : ''}
                </span>
              )
          )}
        </div>
      </form>

      {error && <p className="text-danger">{error}</p>}

      {resultado && (
        <div className="cp-kv-block">
          <p>
            Comentario registrado.
            {resultado.alert_id
              ? ' Alerta generada.'
              : ' No se generó alerta (notificación desactivada).'}
          </p>
          {resultado.deliveries_detail?.length > 0 && (
            <ul className="cp-kv">
              {resultado.deliveries_detail.map((d) => (
                <li key={d.recipient}>
                  <span>{d.recipient}</span>
                  <b className="mono">
                    {d.status}
                    {d.suppression_reason ? ` · ${d.suppression_reason}` : ''}
                  </b>
                </li>
              ))}
            </ul>
          )}
          {resultado.alert_id && resultado.deliveries === 0 && (
            <p className="cp-metric-warn">
              La alerta se creó pero sin entregas: revise que haya suscriptores de WhatsApp
              con consentimiento y severidad mínima igual o menor que «alta».
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default ManualCommentCard;
