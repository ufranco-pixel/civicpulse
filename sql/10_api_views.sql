-- =============================================================================
-- CivicPulse · 10_api_views.sql
-- Esquema civic_api: el único contrato que consume la capa de aplicación.
--
-- Regla de arquitectura: los microservicios NO consultan civic.* directamente.
-- Leen de civic_api.*. Así el modelo interno puede evolucionar —renombrar
-- columnas, cambiar el particionado, normalizar más— sin romper la API.
--
-- Incluye además el bloque de compatibilidad con la nomenclatura del sistema
-- base (project_code, analysis_inferences, day, positive_count...), para que un
-- despliegue existente pueda apuntar a esta base sin reescribir sus consultas.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_api, civic_ops, public;

-- =============================================================================
-- 1. CAMPAÑAS
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.campaigns AS
SELECT
    c.id,
    c.code,
    c.name,
    c.slug,
    c.objective,
    c.campaign_kind,
    c.contest_label,
    c.status,
    c.default_language,
    c.languages,
    c.timezone,
    c.starts_on,
    c.ends_on,
    c.election_date,
    CASE WHEN c.election_date IS NULL THEN NULL
         ELSE (c.election_date - CURRENT_DATE)::int END          AS days_to_election,
    c.blackout_starts_on,
    c.blackout_ends_on,
    (c.blackout_starts_on IS NOT NULL
     AND CURRENT_DATE BETWEEN c.blackout_starts_on
                          AND COALESCE(c.blackout_ends_on, c.blackout_starts_on)) AS in_blackout,
    c.thresholds,
    c.organization_id,
    o.name                                                        AS organization_name,
    o.slug                                                        AS organization_slug,
    g.name                                                        AS geo_area_name,
    (SELECT count(*) FROM civic.contenders ct
      WHERE ct.campaign_id = c.id AND ct.status = 'active')       AS contender_count,
    (SELECT count(*) FROM civic.sources s
      WHERE s.campaign_id = c.id AND s.status = 'active')         AS active_source_count,
    c.created_at,
    c.updated_at
FROM civic.campaigns     c
JOIN civic.organizations o ON o.id = c.organization_id
LEFT JOIN civic.geo_areas g ON g.id = c.geo_area_id;

COMMENT ON VIEW civic_api.campaigns IS
    'Campañas con métricas de configuración y bandera de veda electoral ya calculada.';

-- =============================================================================
-- 2. CONTENDIENTES
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.contenders AS
SELECT
    ct.id,
    ct.campaign_id,
    c.code                AS campaign_code,
    ct.type_code,
    tt.label_es           AS type_label,
    ct.name,
    ct.slug,
    ct.short_name,
    ct.is_own,
    ct.affiliation,
    ct.parent_id,
    ct.aliases,
    ct.handles,
    ct.color_hex,
    ct.avatar_url,
    ct.display_order,
    ct.baseline_support_pct,
    ct.baseline_source,
    ct.baseline_date,
    ct.status,
    ct.created_at
FROM civic.contenders ct
JOIN civic.campaigns  c  ON c.id = ct.campaign_id
JOIN civic_cat.contender_types tt ON tt.code = ct.type_code;

-- =============================================================================
-- 3. FUENTES CON SALUD
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.sources AS
SELECT
    s.id,
    s.campaign_id,
    c.code                     AS campaign_code,
    s.type_code,
    st.label_es                AS type_label,
    st.family                  AS type_family,
    st.icon,
    st.color_token,
    st.is_public_data,
    s.name,
    s.slug,
    s.status,
    s.collection_mode,
    s.collection_schedule,
    s.legal_basis,
    s.last_collected_at,
    s.last_success_at,
    s.consecutive_errors,
    s.last_error,
    s.total_collected,
    COALESCE(h.volume_24h, 0)  AS volume_24h,
    COALESCE(h.volume_7d, 0)   AS volume_7d,
    h.avg_daily_7d,
    h.lag_minutes,
    COALESCE(h.health, 'unknown') AS health,
    s.created_at
FROM civic.sources s
JOIN civic.campaigns c ON c.id = s.campaign_id
JOIN civic_cat.source_types st ON st.code = s.type_code
LEFT JOIN civic_kpi.mv_source_health h ON h.source_id = s.id;

-- =============================================================================
-- 4. INFERENCIAS ENRIQUECIDAS
--    Vista de lectura para la tabla de contenidos del tablero. Trae el texto,
--    la clasificación y los ejes multivaluados ya agregados en arreglos.
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.inferences AS
SELECT
    i.id,
    i.seq,
    i.campaign_id,
    c.code                        AS campaign_code,
    i.content_id,
    i.published_at,
    i.analyzed_at,

    ct.body                       AS text,
    ct.title,
    ct.url,
    ct.content_type_code,
    ct.language_code,
    ct.likes_count,
    ct.shares_count,
    ct.replies_count,
    ct.views_count,
    ct.reach_estimate,
    ct.author_verified,
    ct.author_followers,
    ct.author_bot_score,
    ct.has_media,

    i.source_id,
    s.name                        AS source_name,
    s.type_code                   AS source_type,
    stc.label_es                  AS source_label,
    stc.color_token               AS source_color,

    i.sentiment_code,
    sen.label_es                  AS sentiment_label,
    sen.color_token               AS sentiment_color,
    i.sentiment_score,
    i.sentiment_confidence,
    i.sentiment_probs,

    i.intent_code,
    it.label_es                   AS intent_label,
    it.is_actionable              AS intent_actionable,

    i.toxicity_score,
    i.sarcasm_score,
    i.subjectivity_score,
    i.overall_confidence,
    i.needs_review,
    i.review_status,
    i.summary,

    i.model_name_snapshot         AS model_name,
    i.pipeline,
    i.prompt_version_id,

    -- Emociones ordenadas por intensidad.
    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'code', e.emotion_code, 'label', et.label_es,
                   'score', e.score, 'dominant', e.is_dominant)
                 ORDER BY e.score DESC)
        FROM civic.inference_emotions e
        JOIN civic_cat.emotion_types et ON et.code = e.emotion_code
        WHERE e.inference_id = i.id AND e.analyzed_at = i.analyzed_at
    ), '[]'::jsonb)               AS emotions,

    -- Posturas hacia cada contendiente mencionado.
    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'contender_id', st.contender_id, 'contender', cd.name,
                   'stance', st.stance_code, 'score', st.stance_score,
                   'confidence', st.confidence, 'method', st.match_method,
                   'evidence', st.evidence_span)
                 ORDER BY st.confidence DESC)
        FROM civic.inference_stances st
        JOIN civic.contenders cd ON cd.id = st.contender_id
        WHERE st.inference_id = i.id AND st.analyzed_at = i.analyzed_at
    ), '[]'::jsonb)               AS stances,

    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'category', tp.category_code, 'label', tc2.label_es,
                   'relevance', tp.relevance, 'sentiment', tp.topic_sentiment,
                   'primary', tp.is_primary)
                 ORDER BY tp.relevance DESC)
        FROM civic.inference_topics tp
        JOIN civic_cat.topic_categories tc2 ON tc2.code = tp.category_code
        WHERE tp.inference_id = i.id AND tp.analyzed_at = i.analyzed_at
    ), '[]'::jsonb)               AS topics,

    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'text', en.entity_text, 'type', en.entity_type_code,
                   'sentiment', en.entity_sentiment)
                 ORDER BY en.mention_count DESC)
        FROM civic.inference_entities en
        WHERE en.inference_id = i.id AND en.analyzed_at = i.analyzed_at
    ), '[]'::jsonb)               AS entities,

    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'code', f.flag_code, 'label', rf.label_es,
                   'score', f.score, 'severity', rf.default_severity,
                   'review_state', f.review_state)
                 ORDER BY f.score DESC)
        FROM civic.inference_risk_flags f
        JOIN civic_cat.risk_flags rf ON rf.code = f.flag_code
        WHERE f.inference_id = i.id AND f.analyzed_at = i.analyzed_at
    ), '[]'::jsonb)               AS risk_flags

FROM civic.inferences i
JOIN civic.campaigns  c   ON c.id  = i.campaign_id
JOIN civic.contents   ct  ON ct.id = i.content_id AND ct.published_at = i.published_at
JOIN civic.sources    s   ON s.id  = i.source_id
JOIN civic_cat.source_types    stc ON stc.code = s.type_code
JOIN civic_cat.sentiment_types sen ON sen.code = i.sentiment_code
LEFT JOIN civic_cat.intent_types it ON it.code = i.intent_code
WHERE NOT i.is_superseded
  AND NOT ct.is_duplicate
  AND NOT ct.is_excluded;

COMMENT ON VIEW civic_api.inferences IS
    'Inferencia con su contenido y todos los ejes agregados en JSON. Es la vista de la tabla de '
    'contenidos del tablero. Filtre siempre por campaign_code y rango de published_at: sin eso '
    'no hay poda de particiones y la consulta recorre todo el histórico.';

-- =============================================================================
-- 5. ALERTAS
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.alerts AS
SELECT
    a.id,
    a.seq,
    a.campaign_id,
    a.campaign_code,
    a.rule_id,
    r.name                    AS rule_name,
    a.alert_type_code,
    at.label_es               AS alert_type_label,
    a.severity_code,
    sv.label_es               AS severity_label,
    sv.rank                   AS severity_rank,
    sv.color_token            AS severity_color,
    sv.sla_minutes,
    a.title,
    a.message,
    a.metric,
    mr.label_es               AS metric_label,
    mr.unit                   AS metric_unit,
    mr.caveat                 AS metric_caveat,
    a.observed_value,
    a.threshold_value,
    a.sample_size,
    a.window_start,
    a.window_end,
    a.contender_id,
    cd.name                   AS contender_name,
    a.source_id,
    s.name                    AS source_name,
    a.topic_category,
    a.evidence,
    a.context,
    a.status,
    a.is_read,
    a.acknowledged_by,
    a.acknowledged_at,
    a.resolved_by,
    a.resolved_at,
    a.resolution_note,
    a.was_false_positive,
    a.during_blackout,
    -- Minutos transcurridos frente al SLA de la severidad.
    CASE WHEN sv.sla_minutes IS NULL OR a.status NOT IN ('open','acknowledged','in_progress')
         THEN NULL
         ELSE round(EXTRACT(EPOCH FROM (NOW() - a.created_at)) / 60)::int - sv.sla_minutes
    END                       AS sla_overdue_minutes,
    a.created_at,
    a.updated_at
FROM civic.alerts a
JOIN civic_cat.alert_types     at ON at.code = a.alert_type_code
JOIN civic_cat.severity_levels sv ON sv.code = a.severity_code
LEFT JOIN civic.alert_rules    r  ON r.id  = a.rule_id
LEFT JOIN civic.contenders     cd ON cd.id = a.contender_id
LEFT JOIN civic.sources        s  ON s.id  = a.source_id
LEFT JOIN civic_kpi.metric_registry mr ON mr.code = a.metric;

-- =============================================================================
-- 6. TRABAJOS
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.jobs AS
SELECT
    j.id,
    j.seq,
    j.campaign_id,
    j.campaign_code,
    j.job_type,
    j.status_code,
    js.label_es      AS status_label,
    js.is_terminal,
    js.color_token   AS status_color,
    j.priority,
    j.model_name,
    j.progress_pct,
    j.total_items,
    j.processed_items,
    j.failed_items,
    j.skipped_items,
    j.total_cost_usd,
    j.attempt,
    j.max_attempts,
    j.error_message,
    j.stats,
    j.scheduled_at,
    j.started_at,
    j.completed_at,
    CASE WHEN j.started_at IS NOT NULL
         THEN round(EXTRACT(EPOCH FROM (COALESCE(j.completed_at, NOW()) - j.started_at)))::int
    END              AS duration_seconds,
    j.created_at
FROM civic.analysis_jobs j
JOIN civic_cat.job_statuses js ON js.code = j.status_code;

-- =============================================================================
-- 7. CATÁLOGOS EXPUESTOS
--    Un solo endpoint puede devolver todos los catálogos que la interfaz
--    necesita para pintar etiquetas y colores sin tenerlos codificados.
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.catalogs AS
SELECT 'sentiment_types' AS catalog, code::text, label_es, label_en,
       color_token, sort_order, to_jsonb(t) - 'code' AS extra
FROM civic_cat.sentiment_types t WHERE is_active
UNION ALL
SELECT 'emotion_types', code::text, label_es, label_en, color_token, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.emotion_types t WHERE is_active
UNION ALL
SELECT 'intent_types', code::text, label_es, label_en, NULL, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.intent_types t WHERE is_active
UNION ALL
SELECT 'stance_types', code::text, label_es, label_en, color_token, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.stance_types t WHERE is_active
UNION ALL
SELECT 'entity_types', code::text, label_es, label_en, color_token, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.entity_types t WHERE is_active
UNION ALL
SELECT 'topic_categories', code::text, label_es, label_en, color_token, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.topic_categories t WHERE is_active
UNION ALL
SELECT 'source_types', code::text, label_es, label_en, color_token, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.source_types t WHERE is_active
UNION ALL
SELECT 'contender_types', code::text, label_es, label_en, NULL, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.contender_types t WHERE is_active
UNION ALL
SELECT 'severity_levels', code::text, label_es, label_en, color_token, rank, to_jsonb(t) - 'code'
FROM civic_cat.severity_levels t WHERE is_active
UNION ALL
SELECT 'alert_types', code::text, label_es, label_en, NULL, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.alert_types t WHERE is_active
UNION ALL
SELECT 'risk_flags', code::text, label_es, label_en, NULL, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.risk_flags t WHERE is_active
UNION ALL
SELECT 'job_statuses', code::text, label_es, label_en, color_token, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.job_statuses t
UNION ALL
SELECT 'nlp_tasks', code::text, label_es, label_en, NULL, sort_order, to_jsonb(t) - 'code'
FROM civic_cat.nlp_tasks t WHERE is_active;

COMMENT ON VIEW civic_api.catalogs IS
    'Todos los catálogos en un solo resultado. Permite que el frontend no lleve etiquetas ni colores '
    'codificados: los pide una vez al arrancar.';

-- Registro de indicadores expuesto tal cual: la interfaz muestra definición y
-- advertencia junto a cada número.
CREATE OR REPLACE VIEW civic_api.metrics AS
SELECT code, label_es, label_en, family, definition, formula, unit,
       range_min, range_max, higher_is_better, min_sample_size, caveat,
       is_alertable, sort_order
FROM civic_kpi.metric_registry
WHERE is_active
ORDER BY family, sort_order;

-- =============================================================================
-- 8. COLA DE REVISIÓN HUMANA
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.review_queue AS
SELECT
    i.id                AS inference_id,
    i.campaign_id,
    c.code              AS campaign_code,
    i.content_id,
    i.published_at,
    i.analyzed_at,
    ct.body             AS text,
    ct.url,
    s.type_code         AS source_type,
    i.sentiment_code,
    i.sentiment_score,
    i.overall_confidence,
    i.sarcasm_score,
    i.toxicity_score,
    i.review_status,
    -- Prioridad de revisión: primero lo que puede hacer daño, luego lo dudoso.
    (CASE WHEN EXISTS (
            SELECT 1 FROM civic.inference_risk_flags f
            JOIN civic_cat.risk_flags rf ON rf.code = f.flag_code
            WHERE f.inference_id = i.id AND f.analyzed_at = i.analyzed_at
              AND rf.default_severity IN ('high','critical')
              AND f.review_state = 'pending')
          THEN 1000 ELSE 0 END
     + CASE WHEN COALESCE(ct.reach_estimate,0) > 10000 THEN 200 ELSE 0 END
     + round((1 - i.overall_confidence) * 100)::int
    )                   AS review_priority,
    ct.reach_estimate
FROM civic.inferences i
JOIN civic.campaigns c  ON c.id = i.campaign_id
JOIN civic.contents  ct ON ct.id = i.content_id AND ct.published_at = i.published_at
JOIN civic.sources   s  ON s.id = i.source_id
WHERE i.needs_review
  AND i.review_status IN ('pending','in_review')
  AND NOT i.is_superseded;

COMMENT ON VIEW civic_api.review_queue IS
    'Cola de revisión ordenable por review_priority: primero banderas graves, luego alcance alto, '
    'luego baja confianza. Revisar por orden de llegada desperdicia el tiempo del analista.';

-- =============================================================================
-- 9. COMPATIBILIDAD CON LA NOMENCLATURA DEL SISTEMA BASE
--    Permite apuntar un despliegue existente a esta base sin tocar sus queries.
--    Marcadas como obsoletas: sirven para migrar, no para construir encima.
-- =============================================================================

-- projects → campaigns
CREATE OR REPLACE VIEW civic_api.projects AS
SELECT id, code, name, slug, objective, status,
       default_language, timezone, organization_id, created_at, updated_at
FROM civic.campaigns;

-- analysis_jobs con project_code
CREATE OR REPLACE VIEW civic_api.analysis_jobs AS
SELECT j.seq          AS id,
       j.id           AS job_uuid,
       j.campaign_code AS project_code,
       j.model_name,
       j.status_code  AS status,
       j.created_at,
       j.completed_at
FROM civic.analysis_jobs j;

-- analysis_inferences con id entero y metadata en JSON
CREATE OR REPLACE VIEW civic_api.analysis_inferences AS
SELECT
    i.seq                       AS id,
    i.id                        AS inference_uuid,
    j.seq                       AS job_id,
    i.campaign_code             AS project_code,
    i.text                      AS source_text,
    i.sentiment_code::text      AS sentiment_label,
    i.sentiment_score,
    i.model_name,
    i.analyzed_at               AS created_at,
    jsonb_build_object(
        'source',      i.source_type,
        'url',         i.url,
        'published_at',i.published_at,
        'confidence',  i.overall_confidence,
        'emotions',    i.emotions,
        'topics',      i.topics,
        'stances',     i.stances
    )                           AS metadata
FROM civic_api.inferences i
LEFT JOIN civic.analysis_jobs j ON j.campaign_id = i.campaign_id AND j.id IS NOT NULL;

-- mv_sentiment_daily con la forma que espera la API heredada
CREATE OR REPLACE VIEW civic_api.mv_sentiment_daily AS
SELECT campaign_code   AS project_code,
       day,
       sum(positive_count)::bigint AS positive_count,
       sum(neutral_count)::bigint  AS neutral_count,
       sum(negative_count)::bigint AS negative_count,
       sum(mixed_count)::bigint    AS mixed_count,
       sum(total_count)::bigint    AS total_count,
       round(sum(avg_score * total_count) / NULLIF(sum(total_count),0), 5) AS avg_score
FROM civic_kpi.mv_sentiment_daily
GROUP BY campaign_code, day;

-- mv_entity_frequency con project_code
CREATE OR REPLACE VIEW civic_api.mv_entity_frequency AS
SELECT campaign_code AS project_code,
       entity_text,
       entity_type_code AS entity_type,
       sum(frequency)::bigint AS frequency,
       round(sum(avg_sentiment * frequency) / NULLIF(sum(frequency),0), 5) AS avg_sentiment
FROM civic_kpi.mv_entity_frequency
GROUP BY campaign_code, entity_text, entity_type_code;

COMMENT ON VIEW civic_api.projects IS
    'OBSOLETA. Compatibilidad con la nomenclatura del sistema base. Use civic_api.campaigns.';
COMMENT ON VIEW civic_api.analysis_inferences IS
    'OBSOLETA. Compatibilidad con la nomenclatura del sistema base. Use civic_api.inferences.';

-- =============================================================================
-- 10. PERMISOS
-- =============================================================================
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['civicpulse_app','civicpulse_reader'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA civic_api TO %I', r);
            EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA civic_kpi TO %I', r);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA civic_api GRANT SELECT ON TABLES TO %I', r);
            EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA civic_kpi TO %I', r);
        END IF;
    END LOOP;

    -- La app además escribe en las tablas operativas.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civicpulse_app') THEN
        GRANT SELECT, INSERT, UPDATE ON
            civic.alerts, civic.alert_rules, civic.alert_deliveries,
            civic.alert_subscriptions, civic.analysis_jobs, civic.job_events,
            civic.content_annotations, civic.eval_runs, civic.eval_predictions,
            civic.eval_metrics, civic.eval_confusion
        TO civicpulse_app;
        GRANT SELECT ON ALL TABLES IN SCHEMA civic TO civicpulse_app;
        GRANT EXECUTE ON FUNCTION civic.evaluate_alert_rules(civic.public_code, boolean) TO civicpulse_app;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civicpulse_ingest') THEN
        GRANT SELECT, INSERT, UPDATE ON
            civic.contents, civic.inferences, civic.inference_emotions,
            civic.inference_stances, civic.inference_topics, civic.inference_entities,
            civic.inference_risk_flags, civic.inference_keywords,
            civic.ingestion_batches, civic.analysis_jobs, civic.job_events
        TO civicpulse_ingest;
        GRANT SELECT ON ALL TABLES IN SCHEMA civic     TO civicpulse_ingest;
        GRANT SELECT ON ALL TABLES IN SCHEMA civic_cat TO civicpulse_ingest;
    END IF;
END
$$;

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_n INTEGER;
BEGIN
    SELECT count(*) INTO v_n FROM information_schema.views WHERE table_schema = 'civic_api';
    RAISE NOTICE '── % vistas expuestas en civic_api (contrato de la aplicación) ──', v_n;
END
$$;
