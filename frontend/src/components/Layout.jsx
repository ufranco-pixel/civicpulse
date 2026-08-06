/**
 * Armazon del tablero: rail lateral, cabecera, franja de veda y pie.
 *
 * El stream de alertas se abre UNA vez aqui y se comparte por contexto: si
 * cada pagina abriera el suyo, un usuario con tres pestanas consumiria nueve
 * de las 500 conexiones que admite cada instancia de alerts-api.
 */
import { createContext, useContext, useMemo, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity, AlertTriangle, BarChart3, Ban, ChevronLeft, ChevronRight, ClipboardCheck,
  FileText, LayoutDashboard, MessageSquareText, Settings, Users,
} from 'lucide-react';
import { brand } from '../config/brand.js';
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
  { to: '/revision',      label: 'Revision',      icon: ClipboardCheck,     module: 'review' },
  { to: '/informes',      label: 'Informes',      icon: FileText,           module: 'reports' },
  { to: '/ajustes',       label: 'Ajustes',       icon: Settings,           module: 'settings' },
];

export function Layout() {
  const { campaign, code, inBlackout } = useCampaign();
  const { isCompact } = useResponsive();
  const [collapsed, setCollapsed] = useState(false);

  const live = useAlertStream({ campaignCode: code });
  const liveValue = useMemo(() => live, [live]);

  // Oculta del rail las secciones que hoy no tienen nada que ensenar.
  // Reaparecen solas al cargar contendientes, temas o reglas de alerta.
  const modulos = useAvailableModules(code);

  const railCollapsed = collapsed || isCompact;

  return (
    <LiveAlertsContext.Provider value={liveValue}>
      <div className={`cp-shell ${railCollapsed ? 'cp-shell-collapsed' : ''}`}>
        <aside className="cp-rail" aria-label="Navegacion principal">
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

          {!isCompact && (
            <button
              type="button"
              className="cp-rail-toggle btn btn-ghost btn-sm"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expandir navegacion' : 'Contraer navegacion'}
            >
              {collapsed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronLeft size={15} aria-hidden="true" />}
              {!collapsed && <span>Contraer</span>}
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
            <div className="spacer" />
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
  );
}

export default Layout;
