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
  FileText, Gauge, LayoutDashboard, MessageSquareText, Radio, Settings,
  Users, WifiOff,
} from 'lucide-react';
import { brand } from '../config/brand.js';
import { useCampaign } from '../hooks/useCampaign.js';
import { useAlertStream } from '../hooks/useAlertStream.js';
import { useResponsive } from '../hooks/useResponsive.js';
import CampaignSelector from './CampaignSelector.jsx';
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

function ConnectionIndicator({ connected, status, unread }) {
  return (
    <span
      className={`cp-conn ${connected ? 'cp-conn-on' : 'cp-conn-off'}`}
      title={connected
        ? 'Conectado al stream de alertas en tiempo real'
        : `Sin conexion en vivo (${status}). Las alertas siguen apareciendo al recargar el listado.`}
    >
      {connected ? <Radio size={13} aria-hidden="true" /> : <WifiOff size={13} aria-hidden="true" />}
      <span className="cp-conn-text">{connected ? 'en vivo' : 'sin conexion'}</span>
      {unread > 0 && <span className="cp-conn-count">{unread > 99 ? '99+' : unread}</span>}
    </span>
  );
}

export function Layout() {
  const { campaign, code, inBlackout } = useCampaign();
  const { isCompact } = useResponsive();
  const [collapsed, setCollapsed] = useState(false);

  const live = useAlertStream({ campaignCode: code });
  const liveValue = useMemo(() => live, [live]);

  const railCollapsed = collapsed || isCompact;

  return (
    <LiveAlertsContext.Provider value={liveValue}>
      <div className={`cp-shell ${railCollapsed ? 'cp-shell-collapsed' : ''}`}>
        <aside className="cp-rail" aria-label="Navegacion principal">
          <div className="cp-rail-brand">
            <span className="cp-logo" aria-hidden="true">{brand.shortName}</span>
            {!railCollapsed && (
              <span className="cp-brand-text">
                <strong>{brand.productName}</strong>
                <small>{brand.tagline}</small>
              </span>
            )}
          </div>

          <nav className="cp-nav">
            {NAV.filter((item) => brand.modules[item.module] !== false).map((item) => {
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
        </aside>

        <div className="cp-main">
          <header className="cp-header">
            <CampaignSelector />
            <div className="spacer" />
            <ConnectionIndicator connected={live.connected} status={live.status} unread={live.unread} />
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
            <Gauge size={13} aria-hidden="true" />
            <span>{brand.disclaimer.full}</span>
            <div className="spacer" />
            <span className="text-subtle">{brand.copyright}</span>
            {brand.supportEmail && (
              <a href={`mailto:${brand.supportEmail}`} className="text-subtle">{brand.supportEmail}</a>
            )}
          </footer>
        </div>
      </div>
    </LiveAlertsContext.Provider>
  );
}

export default Layout;
