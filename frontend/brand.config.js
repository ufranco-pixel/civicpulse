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
    primary: '#F4981B',   // naranja de oeste
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
    review: false,   // retirado del producto
    evaluation: true,
    reports: true,
    settings: true,
  },

  copyright: `© ${new Date().getFullYear()} Análisis de Sentimientos`,
  supportEmail: 'soporte@oeste-sentimientos.mx',
  docsUrl: '',

  /**
   * Aviso metodologico, retirado de la interfaz a peticion del cliente.
   *
   * Las tres claves se conservan VACIAS y no se borran: `src/config/brand.js`
   * las lee y hace `pick()` sobre `disclaimer.full`. Quitarlas del objeto
   * romperia esa lectura con «cannot read properties of undefined».
   *
   * Volver a mostrarlo es rellenar estas cadenas; el pie de pagina y las
   * cabeceras que lo pintaban ya no existen, asi que habria que reponer
   * tambien el <p className="disclaimer"> donde se quiera.
   *
   * Nota aparte: el PDF que genera reports-api lleva su propia nota
   * metodologica, en su plantilla del backend. Este cambio no lo toca.
   */
  disclaimer: {
    short: '',
    full: '',
    long: '',
  },
};

export default brand;
