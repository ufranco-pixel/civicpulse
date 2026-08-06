/**
 * Cabecera de página. Ya NO pinta nada donde se coloca.
 *
 * El título, la descripción, el selector de periodo y el botón de recargar se
 * publican a la barra superior del armazón a través de un contexto, y este
 * componente devuelve null.
 *
 * Se hizo así, y no moviendo el marcado a Layout, porque los datos son de la
 * página: el título de Resumen es el nombre de la campaña, el de Contenidos es
 * fijo, y `days` es estado local de cada una. Subirlo a Layout habría obligado
 * a que el armazón supiera qué ruta está abierta y qué periodo maneja, que es
 * exactamente el acoplamiento que este contexto evita.
 *
 * Las páginas no cambian: siguen escribiendo <PageHeader title=… days=… />.
 */
import { createContext, useContext, useEffect } from 'react';

/**
 * Sentinela de «todo el periodo».
 *
 * Se usa 0 y no null porque el valor viaja por un <select>, y ahi todo es
 * cadena: `Number('')` da 0 igualmente, mientras que null volveria como la
 * cadena "null" y habria que tratarla aparte en cada pagina.
 *
 * Es un valor de INTERFAZ, no de API. Antes de llamar al backend hay que
 * traducirlo con `resolveDays()`: los endpoints de indicadores exigen
 * `days >= 1`, y mandarles un 0 devuelve un 422.
 */
export const ALL_TIME = 0;

/** Ventana que representa «todo» al consultar indicadores: 5 anos. */
export const ALL_TIME_DAYS = 1825;

/** Traduce el valor del selector al parametro `days` que espera la API. */
export const resolveDays = (days) => (days === ALL_TIME ? ALL_TIME_DAYS : days);

export const PERIODS = [ALL_TIME, 7, 14, 30, 60, 90];

export const periodOptionLabel = (value) => (
  value === ALL_TIME ? 'Todo el periodo' : `${value} dias`
);

/**
 * Texto del periodo para descripciones y titulos.
 *
 * Existe para que nadie interpole `days` a pelo: con el selector en «Todo»
 * eso imprime «los ultimos 0 dias», que es justo lo contrario de lo que pasa.
 */
export const periodLabel = (days) => (
  days === ALL_TIME ? 'todo el periodo registrado' : `los ultimos ${days} dias`
);

/**
 * Ranura de la barra superior.
 *
 * `publish` recibe solo valores serializables; los callbacks van aparte en un
 * ref. Si viajaran en el mismo objeto, cada render de la pagina crearia
 * funciones nuevas, el objeto seria distinto, y publicarlo provocaria un
 * render del armazon que a su vez volveria a renderizar la pagina: bucle.
 */
export const PageHeaderSlotContext = createContext(null);

export function usePageHeaderSlot() {
  return useContext(PageHeaderSlotContext);
}

export function PageHeader({
  title, description, days, onDaysChange, onReload, children, periods = PERIODS,
}) {
  const slot = usePageHeaderSlot();

  // Sin dependencias: se ejecuta tras cada render y mantiene los callbacks
  // frescos sin provocar una republicacion.
  useEffect(() => {
    if (!slot) return;
    slot.callbacks.current = { onDaysChange, onReload };
  });

  useEffect(() => {
    if (!slot) return undefined;
    slot.publish({
      title,
      description,
      days,
      periods,
      hasDays: typeof onDaysChange === 'function',
      hasReload: typeof onReload === 'function',
    });
    // Al desmontar se limpia: si no, la cabecera conservaria el titulo de la
    // pagina anterior durante el primer render de la siguiente.
    return () => slot.publish(null);
    // `periods` es un array literal en la mayoria de llamadas; se compara por
    // contenido para no republicar en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, days, String(periods), typeof onDaysChange, typeof onReload]);

  // `children` era el hueco para píldoras junto al título. Ya no hay dónde
  // pintarlas, y ninguna página lo usa desde que se quitó la de «en vivo».
  return children ?? null;
}

export default PageHeader;
