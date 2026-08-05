/**
 * Selector de campana de la cabecera.
 *
 * Muestra el estado y, si aplica, los dias a la eleccion: son los dos datos
 * que cambian como se lee todo lo demas del tablero.
 */
import { CalendarClock, ChevronDown } from 'lucide-react';
import { useCampaign } from '../hooks/useCampaign.js';

export function CampaignSelector() {
  const { campaigns, code, selectCampaign, loading, campaign } = useCampaign();

  if (loading && campaigns.length === 0) {
    return <div className="skeleton" style={{ height: 34, width: 220 }} aria-hidden="true" />;
  }

  if (campaigns.length === 0) {
    return <span className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>Sin campanas visibles</span>;
  }

  return (
    <div className="cp-campaign-select">
      <label className="sr-only" htmlFor="cp-campaign">Campana activa</label>
      <div className="cp-select-wrap">
        <select
          id="cp-campaign"
          className="select"
          value={code || ''}
          onChange={(event) => selectCampaign(event.target.value)}
        >
          {campaigns.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}{item.status !== 'active' ? ` · ${item.status}` : ''}
            </option>
          ))}
        </select>
        <ChevronDown size={14} aria-hidden="true" className="cp-select-caret" />
      </div>

      {campaign?.days_to_election !== null && campaign?.days_to_election !== undefined && (
        <span className="pill" title="Dias para la jornada electoral">
          <CalendarClock size={12} aria-hidden="true" />
          {campaign.days_to_election} d
        </span>
      )}
    </div>
  );
}

export default CampaignSelector;
