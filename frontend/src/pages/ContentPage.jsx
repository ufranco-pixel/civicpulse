/**
 * Contenidos analizados.
 *
 * Los filtros viven en la URL para que un analista pueda compartir la vista
 * exacta que esta mirando: sin eso, "mira los negativos de Facebook con
 * confianza baja" es una instruccion que hay que repetir a mano.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCampaign } from '../hooks/useCampaign.js';
import { useApi } from '../hooks/useApi.js';
import { listInferences } from '../services/inferences.service.js';
import { getContenders } from '../services/campaigns.service.js';
import ContentTable from '../components/ContentTable.jsx';
import AnnotationModal from '../components/AnnotationModal.jsx';
import PageHeader, { ALL_TIME, ALL_TIME_DAYS, periodLabel } from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';

const PAGE_SIZE = 25;

/** Reconstruye los filtros desde la URL con los tipos que espera la API. */
function fromParams(params) {
  const filters = { page: 1, page_size: PAGE_SIZE };
  for (const [key, value] of params.entries()) {
    if (value === '') continue;
    if (key === 'page' || key === 'page_size') filters[key] = Number(value);
    else if (key === 'min_confidence') filters[key] = Number(value);
    else if (key === 'needs_review') filters[key] = value === 'true';
    else filters[key] = value;
  }
  return filters;
}

export function ContentPage() {
  const { code } = useCampaign();
  const [params, setParams] = useSearchParams();
  const [annotating, setAnnotating] = useState(null);

  const filters = useMemo(() => fromParams(params), [params]);
  const filtersKey = JSON.stringify(filters);

  // `days` NO viaja como tal a esta API: el listado se acota con date_from.
  // ALL_TIME (0) significa no mandar nada, y entonces el backend arranca en el
  // comentario mas antiguo de la campana.
  const [days, setDays] = useState(ALL_TIME);

  const dateFrom = useMemo(() => {
    if (days === ALL_TIME) return undefined;
    const desde = new Date();
    desde.setDate(desde.getDate() - days);
    return desde.toISOString();
  }, [days]);

  const inferences = useApi(
    ({ signal }) => listInferences(code, { ...filters, date_from: dateFrom }, { signal }),
    [code, filtersKey, dateFrom],
    { enabled: Boolean(code) },
  );

  const contenders = useApi(
    ({ signal }) => getContenders(code, { days: ALL_TIME_DAYS }, { signal }),
    [code],
    { enabled: Boolean(code) },
  );

  const applyFilters = useCallback((next) => {
    const clean = {};
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === null || value === '') continue;
      clean[key] = String(value);
    }
    setParams(clean, { replace: true });
  }, [setParams]);

  if (!code) return <EmptyState title="Seleccione una campana" />;

  const page = inferences.data?.page || filters.page || 1;
  const pageSize = inferences.data?.page_size || PAGE_SIZE;

  return (
    <div className="stack animate-in">
      <PageHeader
        title="Contenidos"
        description={`Cada comentario analizado de ${periodLabel(days)}, con su clasificacion y la evidencia que la sostiene.`}
        days={days}
        onDaysChange={setDays}
        onReload={inferences.reload}
      />

      <ContentTable
        items={inferences.data?.items || []}
        total={inferences.data?.total || 0}
        page={page}
        pageSize={pageSize}
        filters={filters}
        contenders={contenders.data || []}
        loading={inferences.loading}
        error={inferences.error}
        onReload={inferences.reload}
        onFiltersChange={applyFilters}
        onPageChange={(nextPage) => applyFilters({ ...filters, page: nextPage })}
        onAnnotate={setAnnotating}
      />

      {annotating && (
        <AnnotationModal
          inference={annotating}
          contenders={contenders.data || []}
          onClose={() => setAnnotating(null)}
          onSaved={() => inferences.reload()}
        />
      )}
    </div>
  );
}

export default ContentPage;
