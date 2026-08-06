/**
 * Secciones que ahora mismo tienen algo que ensenar.
 *
 * Un tablero con «Contendientes», «Agenda» y «Alertas» siempre vacias no
 * transmite que falten datos: transmite que el producto esta roto. Este hook
 * pregunta una sola vez por campana y devuelve el conjunto de modulos con
 * contenido real, para que el rail lateral oculte el resto.
 *
 * Dos decisiones deliberadas:
 *
 *  1. FALLA HACIA MOSTRAR. Si una consulta revienta o expira, el modulo se
 *     considera disponible. Un corte de red debe degradar a «se ve un menu
 *     completo con una seccion vacia», nunca a «desaparecio media aplicacion»,
 *     que es mucho mas dificil de diagnosticar para quien lo esta usando.
 *
 *  2. SE REEVALUA AL CAMBIAR DE CAMPANA. Las secciones reaparecen solas en
 *     cuanto se cargan contendientes o se define la primera regla: no hay que
 *     recompilar ni tocar brand.config.js.
 *
 * Las rutas siguen registradas. Ocultar es solo de navegacion: quien tenga un
 * enlace directo a /contendientes lo abre y ve su estado vacio explicativo.
 */
import { useEffect, useMemo, useState } from 'react';
import { getContenders, getTopics } from '../services/campaigns.service.js';
import { listRulesFromSentiment, listAlertsFromSentiment } from '../services/alerts.service.js';

/** Modulos que nunca se ocultan: o son la base del tablero o son configuracion. */
const SIEMPRE = ['overview', 'sentiment', 'content', 'review', 'reports', 'settings'];

const noVacio = (r) => (Array.isArray(r) ? r.length > 0 : Boolean(r?.items?.length));

export function useAvailableModules(code) {
  const [conDatos, setConDatos] = useState(null);

  useEffect(() => {
    if (!code) { setConDatos(null); return undefined; }

    const controller = new AbortController();
    const opts = { signal: controller.signal };
    let vivo = true;

    // `allSettled` y no `all`: si contendientes falla, agenda y alertas deben
    // resolverse igual. Con `all` un solo fallo dejaria las tres ocultas.
    Promise.allSettled([
      getContenders(code, {}, opts),
      getTopics(code, {}, opts),
      Promise.allSettled([
        listRulesFromSentiment(code, {}, opts),
        listAlertsFromSentiment(code, {}, opts),
      ]),
    ]).then(([contendientes, agenda, alertas]) => {
      if (!vivo) return;

      // rejected → true: se muestra. Es la regla de fallar hacia mostrar.
      const hay = (r) => r.status !== 'fulfilled' || noVacio(r.value);
      const hayAlertas = alertas.status !== 'fulfilled'
        || alertas.value.some((r) => r.status !== 'fulfilled' || noVacio(r.value));

      setConDatos({
        contenders: hay(contendientes),
        agenda: hay(agenda),
        alerts: hayAlertas,
      });
    });

    return () => { vivo = false; controller.abort(); };
  }, [code]);

  return useMemo(() => ({
    /** Mientras no se sabe, se muestra todo: evita el parpadeo del menu. */
    isVisible: (modulo) => {
      if (SIEMPRE.includes(modulo)) return true;
      if (conDatos === null) return true;
      return conDatos[modulo] !== false;
    },
    resuelto: conDatos !== null,
  }), [conDatos]);
}

export default useAvailableModules;
