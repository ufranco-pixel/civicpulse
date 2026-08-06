/**
 * Armazon del tablero: rail lateral, cabecera, franja de veda y pie.
 *
 * El stream de alertas se abre UNA vez aqui y se comparte por contexto: si
 * cada pagina abriera el suyo, un usuario con tres pestanas consumiria nueve
 * de las 500 conexiones que admite cada instancia de alerts-api.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity, AlertTriangle, BarChart3, Ban, ChevronLeft, ChevronRight,
  FileText, LayoutDashboard, Menu, MessageSquareText, RefreshCw, Settings, Users,
} from 'lucide-react';
import { brand } from '../config/brand.js';
import { PageHeaderSlotContext, PERIODS, periodOptionLabel } from './PageHeader.jsx';
import { useCampaign } from '../hooks/useCampaign.js';
import { useAlertStream } from '../hooks/useAlertStream.js';
import { useAvailableModules } from '../hooks/useAvailableModules.js';
import { useResponsive } from '../hooks/useResponsive.js';
import UserMenu from './UserMenu.jsx';

const LiveAlertsContext = createContext(null);

/** Alertas en vivo compartidas por todo el tablero. */
export function useLiveAlerts() {
  return useContext(LiveAlertsContext) || { alerts: [], unread: 0, connected: false };
}

const NAV = [
  { to: '/resumen',       label: 'Resumen',       icon: LayoutDashboard,    module: 'overview' },
  { to: '/sentimiento',   label: 'Sentimiento',   icon: Activity,           module: 'sentiment' },
  { to: '/contendientes', label: 'Contendientes', icon: Users,              module: 'contenders' },
  { to: '/agenda',        label: 'Agenda',        icon: BarChart3,          module: 'agenda' },
  { to: '/contenidos',    label: 'Contenidos',    icon: MessageSquareText,  module: 'content' },
  { to: '/alertas',       label: 'Alertas',       icon: AlertTriangle,      module: 'alerts', badge: true },
  { to: '/informes',      label: 'Informes',      icon: FileText,           module: 'reports' },
  { to: '/ajustes',       label: 'Ajustes',       icon: Settings,           module: 'settings' },
];

export function Layout() {
  const { campaign, code, inBlackout } = useCampaign();
  const { isMobile, isCompact } = useResponsive();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  const live = useAlertStream({ campaignCode: code });
  const liveValue = useMemo(() => live, [live]);

  // Oculta del rail las secciones que hoy no tienen nada que ensenar.
  // Reaparecen solas al cargar contendientes, temas o reglas de alerta.
  const modulos = useAvailableModules(code);

  // En movil el rail es un cajon que se desliza sobre el contenido, no una
  // franja apilada arriba: con nueve secciones la franja horizontal obligaba a
  // desplazarla de lado y empujaba el tablero media pantalla hacia abajo.
  //
  // Al navegar se cierra solo. Sin esto el cajon se queda abierto tapando la
  // pagina que se acaba de abrir, que es el fallo clasico de este patron.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    // Bloquea el desplazamiento del fondo mientras el cajon esta abierto.
    const previo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previo;
    };
  }, [drawerOpen]);

  // En movil el rail se muestra SIEMPRE expandido dentro del cajon: alli hay
  // ancho de sobra y una tira de iconos sin etiqueta no ayuda a nadie.
  const railCollapsed = isMobile ? false : (collapsed || isCompact);

  // ── Ranura de cabecera ────────────────────────────────────────────────────
  // Cada página publica aquí su título, descripción y periodo, y esta barra
  // los pinta. Los callbacks viven en un ref y NO en el estado: si viajaran
  // en el objeto publicado, cada render de la página crearía funciones nuevas
  // y la publicación provocaría un render del armazón, que volvería a
  // renderizar la página. Bucle infinito.
  const [slot, setSlot] = useState(null);
  const headerCallbacks = useRef({});
  const publish = useCallback((data) => setSlot(data), []);
  const slotValue = useMemo(
    () => ({ publish, callbacks: headerCallbacks }),
    [publish],
  );

  return (
    <PageHeaderSlotContext.Provider value={slotValue}>
    <LiveAlertsContext.Provider value={liveValue}>
      <div className={`cp-shell ${railCollapsed ? 'cp-shell-collapsed' : ''} ${drawerOpen ? 'cp-shell-drawer-open' : ''}`}>
        {/* Fondo oscurecido: cierra el cajon al tocar fuera. aria-hidden
            porque la tecla Escape ya cubre el caso accesible. */}
        <div
          className="cp-drawer-scrim"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />

        {/* Nada de aria-hidden en el cajon cerrado: dentro hay enlaces
            enfocables y marcarlo asi deja elementos alcanzables con el
            tabulador dentro de un contenedor oculto, que es justo lo que la
            regla prohibe. El cierre se hace con `visibility: hidden` en el
            CSS, que si los saca del orden de tabulacion y del arbol de
            accesibilidad. */}
        <aside
          className={`cp-rail ${drawerOpen ? 'is-open' : ''}`}
          aria-label="Navegacion principal"
        >
          <div className={`cp-rail-perfil ${railCollapsed ? 'is-compact' : ''}`}>
            {/* La foto se sirve desde public/ y NO se importa: asi se puede
                reemplazar en el contenedor sin recompilar el bundle.
                Si falta el fichero, onError deja el hueco limpio en lugar de
                pintar el icono de imagen rota del navegador. */}
            <img
              className="cp-rail-foto"
              src="/foto.jpg"
              alt={campaign?.name ? `Fotografia de ${campaign.name}` : 'Fotografia'}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            {!railCollapsed && (
              <span className="cp-rail-perfil-texto">
                <strong>{campaign?.name || brand.productName}</strong>
                <small>{campaign?.name ? brand.productName : brand.tagline}</small>
              </span>
            )}
          </div>

          <nav className="cp-nav">
            {NAV.filter((item) => brand.modules[item.module] !== false
                              && modulos.isVisible(item.module)).map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `cp-nav-item ${isActive ? 'is-active' : ''}`}
                  title={railCollapsed ? item.label : undefined}
                >
                  <Icon size={17} aria-hidden="true" />
                  {!railCollapsed && <span>{item.label}</span>}
                  {item.badge && live.unread > 0 && (
                    <span className="cp-nav-badge">{live.unread > 99 ? '99+' : live.unread}</span>
                  )}
                </NavLink>
              );
            })}
          </nav>

          {/* Contraer solo tiene sentido en escritorio: en movil el rail vive
              en un cajon y en tableta ya viene contraido de serie.
              Es un boton redondo de icono, sin etiqueta: la palabra
              «Contraer» a media altura del rail competia con la navegacion
              por atencion sin aportar nada. */}
          {!isCompact && (
            <button
              type="button"
              className="cp-rail-toggle"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expandir navegacion' : 'Contraer navegacion'}
              title={collapsed ? 'Expandir' : 'Contraer'}
            >
              {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
            </button>
          )}

          {/* Firma de oeste al pie del rail. `margin-top: auto` en el CSS la
              empuja abajo del todo sea cual sea el numero de secciones
              visibles, que ahora varia segun los datos que haya. */}
          <a
            className={`cp-rail-oeste ${railCollapsed ? 'is-compact' : ''}`}
            href="https://oesteinvestgroup.com/#!/es"
            target="_blank"
            rel="noopener noreferrer"
            title="Organización de Estudios del Territorio"
          >
            <img src="/oeste-logo.svg" alt="oeste" className="cp-rail-oeste-logo" />
            {!railCollapsed && (
              <span className="cp-rail-oeste-texto">
                Organización de Estudios
                <br />
                del Territorio
              </span>
            )}
          </a>
        </aside>

        <div className="cp-main">
          <header className="cp-header">
            {isMobile && (
              <button
                type="button"
                className="cp-burger"
                onClick={() => setDrawerOpen(true)}
                aria-label="Abrir navegacion"
                aria-expanded={drawerOpen}
              >
                <Menu size={20} aria-hidden="true" />
              </button>
            )}

            {/* Título y descripción de la página activa, publicados por su
                <PageHeader>. Mientras no haya ninguno montado se cae al
                nombre de la campaña para que la barra nunca quede muda. */}
            <div className="cp-header-page">
              <h1 className="cp-header-titulo">
                {slot?.title || campaign?.name || brand.productName}
              </h1>
              {slot?.description && !isMobile && (
                <p className="cp-header-desc">{slot.description}</p>
              )}
            </div>

            <div className="spacer" />

            {slot?.hasDays && (
              <label className="cp-header-periodo">
                {!isMobile && <span className="field-label">Periodo</span>}
                <select
                  className="select"
                  value={slot.days}
                  aria-label="Periodo"
                  onChange={(e) => headerCallbacks.current.onDaysChange?.(Number(e.target.value))}
                >
                  {(slot.periods || PERIODS).map((v) => (
                    <option key={v} value={v}>{periodOptionLabel(v)}</option>
                  ))}
                </select>
              </label>
            )}

            {slot?.hasReload && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => headerCallbacks.current.onReload?.()}
                aria-label="Recargar"
                title="Recargar"
              >
                <RefreshCw size={15} aria-hidden="true" />
              </button>
            )}

            <UserMenu />
          </header>

          {inBlackout && (
            <div className="blackout-strip" role="status">
              <Ban size={14} aria-hidden="true" />
              <span>
                Veda electoral en curso{campaign?.blackout_ends_on ? ` hasta el ${campaign.blackout_ends_on}` : ''}.
                Las alertas se registran pero no se notifican por canales externos si la regla respeta la veda.
              </span>
            </div>
          )}

          <main className="cp-content">
            <Outlet />
          </main>

          <footer className="cp-footer">
            <div className="spacer" />
            <span className="text-subtle">{brand.copyright}</span>
          </footer>
        </div>
      </div>
    </LiveAlertsContext.Provider>
    </PageHeaderSlotContext.Provider>
  );
}

export default Layout;
