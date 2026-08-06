/**
 * Distintivo de fiabilidad de la muestra. RETIRADO de la interfaz.
 *
 * Antes mostraba «n = 7» y «muestra insuficiente» junto a cada indicador. Se
 * quitó a petición del cliente junto con el resto de avisos de muestra.
 *
 * El componente se conserva devolviendo null en vez de borrarse porque lo
 * importan SentimentDonut, CrisisGauge y las tarjetas de indicador; borrarlo
 * obligaría a tocar todos esos ficheros y dejaría el camino de vuelta más
 * largo del necesario. Para reponerlo basta con restaurar este fichero.
 *
 * Conviene tenerlo presente: `is_reliable=false` sigue existiendo en la API y
 * en la base. Lo que ya no se ve es el aviso, no el hecho. Un 100 % de
 * negatividad calculado sobre tres comentarios se muestra ahora igual que uno
 * calculado sobre trescientos.
 */
export function ReliabilityBadge() {
  return null;
}

export default ReliabilityBadge;
