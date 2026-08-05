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
import PageHeader from '../components/PageHeader.jsx';
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

  const inferences = useApi(
    ({ signal }) => listInferences(code, filters, { signal }),
    [code, filtersKey],
    { enabled: Boolean(code) },
  );

  const contenders = useApi(
    ({ signal }) => getContenders(code, { days: 30 }, { signal }),
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
        description="Cada comentario analizado, con su clasificacion y la evidencia que la sostiene."
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
