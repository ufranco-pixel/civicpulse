/**
 * Marca del producto.
 *
 * Vive fuera de src/ a proposito: es lo unico que un integrador necesita tocar
 * para reetiquetar el tablero, y no deberia tener que abrir el codigo fuente
 * para hacerlo. `src/config/brand.js` lo fusiona con las variables VITE_BRAND_*.
 */
const brand = {
  name: 'Análisis de Sentimientos',
  shortName: 'oeste',
  productName: 'Análisis de Sentimientos',
  tagline: 'Escucha de conversacion publica digital',
  description:
    'Analisis de sentimiento, postura y agenda sobre comentarios publicos de campanas politicas.',

  colors: {
    primary: '#1d4ed8',
    accent: '#d97706',
  },

  // Modulos visibles en la navegacion. Quitar uno lo saca del rail lateral y
  // de las rutas anunciadas; la ruta directa sigue existiendo.
  modules: {
    overview: true,
    sentiment: true,
    contenders: true,
    agenda: true,
    content: true,
    alerts: true,
    review: true,
    evaluation: true,
    reports: true,
    settings: true,
  },

  copyright: `© ${new Date().getFullYear()} Análisis de Sentimientos`,
  supportEmail: 'soporte@oeste-sentimientos.mx',
  docsUrl: '',

  /**
   * Aviso metodologico. No es decorativo: es la frase que impide que el
   * tablero se lea como una encuesta. Aparece en el pie, en la cabecera de las
   * comparativas y en el PDF que genera reports-api.
   */
  disclaimer: {
    short: 'Mide conversacion publica digital. No es una encuesta.',
    full:
      'Mide conversacion publica digital. No es una encuesta ni predice resultados electorales.',
    long:
      'Los indicadores de este tablero miden conversacion publica digital. Quien publica en redes '
      + 'y medios abiertos no es una muestra representativa del electorado: los resultados no son '
      + 'una encuesta, no tienen margen de error probabilistico y no predicen resultados '
      + 'electorales. Todo indicador se acompana de su tamano de muestra y de su advertencia de '
      + 'interpretacion tomada del registro de indicadores.',
  },
};

export default brand;
