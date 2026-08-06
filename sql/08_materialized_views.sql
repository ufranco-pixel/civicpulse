-- =============================================================================
-- Análisis de Sentimientos · 08_materialized_views.sql
-- Vistas materializadas de agregación diaria.
--
-- Criterio: agregar por DÍA y por las dimensiones que el tablero cruza. Con eso
-- cualquier granularidad mayor (semana, mes) se obtiene sumando, y la consulta
-- del día en curso se resuelve contra la tabla viva y se une por UNION ALL.
-- Es el patrón "lambda" clásico: histórico precalculado + cola en tiempo real.
--
-- Todas llevan índice único para permitir REFRESH ... CONCURRENTLY, que no
-- bloquea lecturas. Sin ese índice, cada refresco congelaría el tablero.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_ops, public;

-- =============================================================================
-- 1. SENTIMIENTO DIARIO POR CAMPAÑA
--    La MV base del tablero. Se agrega también por fuente porque "el sentimiento
--    global" sin desglose por canal es un promedio que no significa nada:
--    X y TikTok se comportan de forma radicalmente distinta.
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_sentiment_daily CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_sentiment_daily AS
SELECT
    i.campaign_id,
    c.code                                    AS campaign_code,
    i.source_id,
    s.type_code                               AS source_type,
    (i.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS day,

    count(*)                                                       AS total_count,
    count(*) FILTER (WHERE i.sentiment_code = 'positive')          AS positive_count,
    count(*) FILTER (WHERE i.sentiment_code = 'neutral')           AS neutral_count,
    count(*) FILTER (WHERE i.sentiment_code = 'negative')          AS negative_count,
    count(*) FILTER (WHERE i.sentiment_code = 'mixed')             AS mixed_count,

    round(avg(i.sentiment_score), 5)                               AS avg_score,
    round(avg(i.sentiment_confidence), 5)                          AS avg_confidence,
    round(stddev_samp(i.sentiment_score), 5)                       AS stddev_score,
    -- Polarización: proporción de opiniones en los extremos. Una media de 0 con
    -- polarización alta describe una conversación partida, no una tibia.
    round(
        count(*) FILTER (WHERE abs(i.sentiment_score) > 0.6)::numeric
        / NULLIF(count(*), 0), 5)                                  AS extremity_ratio,

    round(avg(i.toxicity_score), 5)                                AS avg_toxicity,
    count(*) FILTER (WHERE i.toxicity_score > 0.5)                 AS toxic_count,
    count(*) FILTER (WHERE i.needs_review)                         AS review_count,

    -- Versión ponderada por alcance: cuenta la misma conversación medida por
    -- exposición en lugar de por número de mensajes.
    round(sum(i.sentiment_score * ct.amplification_weight)
          / NULLIF(sum(ct.amplification_weight), 0), 5)            AS weighted_avg_score,
    sum(COALESCE(ct.reach_estimate, 0))                            AS total_reach,
    count(DISTINCT ct.author_hash)                                 AS unique_authors,
    sum(COALESCE(ct.likes_count,0) + COALESCE(ct.shares_count,0)
        + COALESCE(ct.replies_count,0))                            AS total_engagement,

    max(i.analyzed_at)                                             AS last_analyzed_at
FROM civic.inferences i
JOIN civic.campaigns  c  ON c.id = i.campaign_id
JOIN civic.sources    s  ON s.id = i.source_id
JOIN civic.contents   ct ON ct.id = i.content_id AND ct.published_at = i.published_at
WHERE NOT i.is_superseded
  AND NOT ct.is_duplicate
  AND NOT ct.is_excluded
  -- La ironía alta contamina el promedio de sentimiento más que cualquier otra cosa.
  AND COALESCE(i.sarcasm_score, 0) <= 0.6
GROUP BY i.campaign_id, c.code, i.source_id, s.type_code,
         (i.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_sentiment_daily
    ON civic_kpi.mv_sentiment_daily (campaign_id, source_id, day);
CREATE INDEX ix_mv_sentiment_daily_code
    ON civic_kpi.mv_sentiment_daily (campaign_code, day DESC);

COMMENT ON MATERIALIZED VIEW civic_kpi.mv_sentiment_daily IS
    'Sentimiento diario por campaña y fuente. Excluye duplicados, contenido excluido, inferencias '
    'reemplazadas por anotación humana e ironía con score > 0.6.';

-- =============================================================================
-- 2. POSTURA DIARIA POR CONTENDIENTE
--    La MV que sostiene el análisis competitivo: share of voice, apoyo neto y
--    momentum salen todos de aquí.
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_contender_daily CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_contender_daily AS
SELECT
    st.campaign_id,
    c.code                                    AS campaign_code,
    st.contender_id,
    ct.name                                   AS contender_name,
    ct.is_own,
    (st.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS day,

    count(*)                                                    AS mentions,
    count(*) FILTER (WHERE st.stance_code IN ('favor','lean_favor'))       AS favor_count,
    count(*) FILTER (WHERE st.stance_code = 'neutral')                     AS neutral_count,
    count(*) FILTER (WHERE st.stance_code IN ('against','lean_against'))   AS against_count,
    count(*) FILTER (WHERE st.stance_code = 'undecided')                   AS undecided_count,
    count(*) FILTER (WHERE st.stance_code = 'unclear')                     AS unclear_count,

    -- Apoyo neto ponderado por el peso de cada postura.
    round(avg(st.stance_score), 5)                              AS avg_stance_score,
    round(sum(CASE WHEN sc.weight > 0 THEN sc.weight ELSE 0 END)
          - sum(CASE WHEN sc.weight < 0 THEN -sc.weight ELSE 0 END), 3) AS net_support_raw,
    round(avg(st.confidence), 5)                                AS avg_confidence,

    -- Sentimiento del texto donde aparece el actor. Distinto de la postura:
    -- un mensaje de apoyo puede tener sentimiento negativo hacia un tercero.
    round(avg(inf.sentiment_score), 5)                          AS avg_text_sentiment,

    count(DISTINCT cont.author_hash)                            AS unique_authors,
    sum(COALESCE(cont.reach_estimate, 0))                       AS total_reach,
    sum(COALESCE(cont.likes_count,0) + COALESCE(cont.shares_count,0)
        + COALESCE(cont.replies_count,0))                       AS total_engagement,
    -- Proporción de menciones atribuidas por el modelo y no por handle o alias:
    -- si es alta, la atribución merece auditoría.
    round(count(*) FILTER (WHERE st.match_method = 'model')::numeric
          / NULLIF(count(*), 0), 4)                             AS model_attribution_ratio
FROM civic.inference_stances st
JOIN civic.campaigns        c    ON c.id  = st.campaign_id
JOIN civic.contenders       ct   ON ct.id = st.contender_id
JOIN civic_cat.stance_types sc   ON sc.code = st.stance_code
JOIN civic.inferences       inf  ON inf.id = st.inference_id AND inf.analyzed_at = st.analyzed_at
JOIN civic.contents         cont ON cont.id = inf.content_id AND cont.published_at = inf.published_at
WHERE NOT inf.is_superseded
  AND NOT cont.is_duplicate
  AND NOT cont.is_excluded
GROUP BY st.campaign_id, c.code, st.contender_id, ct.name, ct.is_own,
         (st.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_contender_daily
    ON civic_kpi.mv_contender_daily (campaign_id, contender_id, day);
CREATE INDEX ix_mv_contender_daily_code
    ON civic_kpi.mv_contender_daily (campaign_code, day DESC);

COMMENT ON MATERIALIZED VIEW civic_kpi.mv_contender_daily IS
    'Postura diaria hacia cada contendiente. Base del share of voice, el apoyo neto y el momentum.';

-- =============================================================================
-- 3. AGENDA DIARIA (TEMAS)
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_topic_daily CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_topic_daily AS
SELECT
    tp.campaign_id,
    c.code                                    AS campaign_code,
    tp.category_code,
    tc.dimension,
    tp.topic_id,
    (tp.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS day,

    count(*)                                              AS mentions,
    round(avg(tp.relevance), 5)                           AS avg_relevance,
    round(avg(tp.topic_sentiment), 5)                     AS avg_topic_sentiment,
    count(*) FILTER (WHERE tp.topic_sentiment < -0.2)     AS negative_mentions,
    count(*) FILTER (WHERE tp.topic_sentiment >  0.2)     AS positive_mentions,
    count(*) FILTER (WHERE tp.is_primary)                 AS primary_mentions,
    count(DISTINCT cont.author_hash)                      AS unique_authors,
    sum(COALESCE(cont.reach_estimate, 0))                 AS total_reach
FROM civic.inference_topics       tp
JOIN civic.campaigns              c   ON c.id = tp.campaign_id
JOIN civic_cat.topic_categories   tc  ON tc.code = tp.category_code
JOIN civic.inferences             inf ON inf.id = tp.inference_id AND inf.analyzed_at = tp.analyzed_at
JOIN civic.contents               cont ON cont.id = inf.content_id AND cont.published_at = inf.published_at
WHERE NOT inf.is_superseded AND NOT cont.is_duplicate AND NOT cont.is_excluded
GROUP BY tp.campaign_id, c.code, tp.category_code, tc.dimension, tp.topic_id,
         (tp.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_topic_daily
    ON civic_kpi.mv_topic_daily (campaign_id, category_code,
        COALESCE(topic_id, '00000000-0000-0000-0000-000000000000'::uuid), day);
CREATE INDEX ix_mv_topic_daily_code ON civic_kpi.mv_topic_daily (campaign_code, day DESC);

-- =============================================================================
-- 4. EMOCIONES DIARIAS
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_emotion_daily CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_emotion_daily AS
SELECT
    e.campaign_id,
    c.code                                    AS campaign_code,
    e.emotion_code,
    et.valence,
    et.arousal,
    (e.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS day,

    count(*)                                  AS occurrences,
    count(*) FILTER (WHERE e.is_dominant)     AS dominant_count,
    round(avg(e.score), 5)                    AS avg_intensity,
    round(max(e.score), 5)                    AS max_intensity
FROM civic.inference_emotions   e
JOIN civic.campaigns            c   ON c.id = e.campaign_id
JOIN civic_cat.emotion_types    et  ON et.code = e.emotion_code
JOIN civic.inferences           inf ON inf.id = e.inference_id AND inf.analyzed_at = e.analyzed_at
WHERE NOT inf.is_superseded
GROUP BY e.campaign_id, c.code, e.emotion_code, et.valence, et.arousal,
         (e.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_emotion_daily
    ON civic_kpi.mv_emotion_daily (campaign_id, emotion_code, day);
CREATE INDEX ix_mv_emotion_daily_code ON civic_kpi.mv_emotion_daily (campaign_code, day DESC);

-- =============================================================================
-- 5. FRECUENCIA DE ENTIDADES
--    Agregada por mes: los rankings de entidades no se leen por día y agregar
--    diario multiplicaría las filas sin aportar señal.
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_entity_frequency CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_entity_frequency AS
SELECT
    en.campaign_id,
    c.code                                    AS campaign_code,
    en.entity_type_code,
    en.entity_norm,
    -- Variante textual más frecuente: es la que se muestra en el tablero.
    mode() WITHIN GROUP (ORDER BY en.entity_text)  AS entity_text,
    date_trunc('month', en.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS month,

    sum(en.mention_count)                     AS frequency,
    count(DISTINCT en.inference_id)           AS document_count,
    round(avg(en.entity_sentiment), 5)        AS avg_sentiment,
    count(*) FILTER (WHERE en.entity_sentiment < -0.2) AS negative_count,
    count(*) FILTER (WHERE en.entity_sentiment >  0.2) AS positive_count,
    en.contender_id
FROM civic.inference_entities en
JOIN civic.campaigns          c   ON c.id = en.campaign_id
JOIN civic.inferences         inf ON inf.id = en.inference_id AND inf.analyzed_at = en.analyzed_at
WHERE NOT inf.is_superseded
GROUP BY en.campaign_id, c.code, en.entity_type_code, en.entity_norm,
         date_trunc('month', en.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date,
         en.contender_id
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_entity_frequency
    ON civic_kpi.mv_entity_frequency (campaign_id, entity_type_code, entity_norm, month,
        COALESCE(contender_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX ix_mv_entity_freq_code ON civic_kpi.mv_entity_frequency (campaign_code, frequency DESC);

-- =============================================================================
-- 6. ACTIVIDAD DIARIA POR GEOGRAFÍA
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_geo_daily CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_geo_daily AS
SELECT
    i.campaign_id,
    c.code                                    AS campaign_code,
    ct.geo_area_id,
    g.name                                    AS geo_name,
    g.level_code,
    g.electorate_size,
    (i.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS day,

    count(*)                                              AS total_count,
    count(*) FILTER (WHERE i.sentiment_code = 'positive') AS positive_count,
    count(*) FILTER (WHERE i.sentiment_code = 'negative') AS negative_count,
    round(avg(i.sentiment_score), 5)                      AS avg_score,
    count(DISTINCT ct.author_hash)                        AS unique_authors,
    -- Intensidad relativa al padrón: permite comparar territorios de tamaños
    -- muy distintos sin que las zonas grandes dominen todo.
    round(count(*)::numeric * 100000 / NULLIF(g.electorate_size, 0), 4) AS mentions_per_100k
FROM civic.inferences i
JOIN civic.campaigns  c  ON c.id = i.campaign_id
JOIN civic.contents   ct ON ct.id = i.content_id AND ct.published_at = i.published_at
JOIN civic.geo_areas  g  ON g.id = ct.geo_area_id
WHERE NOT i.is_superseded AND NOT ct.is_duplicate AND NOT ct.is_excluded
  AND COALESCE(ct.geo_confidence, 0) >= 0.5   -- geolocalización dudosa no entra al mapa
GROUP BY i.campaign_id, c.code, ct.geo_area_id, g.name, g.level_code, g.electorate_size,
         (i.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_geo_daily ON civic_kpi.mv_geo_daily (campaign_id, geo_area_id, day);

COMMENT ON MATERIALIZED VIEW civic_kpi.mv_geo_daily IS
    'Actividad por territorio. Sólo incluye contenido con geo_confidence >= 0.5: un mapa construido '
    'con inferencia geográfica débil induce a error con apariencia de precisión.';

-- =============================================================================
-- 7. SALUD DE FUENTES
--    No es un KPI de campaña sino de operación, pero es el primero que hay que
--    mirar: una caída de sentimiento suele ser una fuente que dejó de reportar.
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS civic_kpi.mv_source_health CASCADE;
CREATE MATERIALIZED VIEW civic_kpi.mv_source_health AS
WITH recent AS (
    SELECT source_id,
           count(*) FILTER (WHERE published_at >= NOW() - INTERVAL '24 hours') AS last_24h,
           count(*) FILTER (WHERE published_at >= NOW() - INTERVAL '7 days')   AS last_7d,
           max(collected_at)                                                   AS last_content_at
    FROM   civic.contents
    WHERE  published_at >= NOW() - INTERVAL '30 days'
    GROUP  BY source_id
)
SELECT
    s.id                       AS source_id,
    s.campaign_id,
    c.code                     AS campaign_code,
    s.name                     AS source_name,
    s.type_code,
    s.status,
    COALESCE(r.last_24h, 0)    AS volume_24h,
    COALESCE(r.last_7d, 0)     AS volume_7d,
    round(COALESCE(r.last_7d, 0)::numeric / 7, 2) AS avg_daily_7d,
    r.last_content_at,
    s.last_success_at,
    s.consecutive_errors,
    s.lag_alert_minutes,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(r.last_content_at, s.last_success_at))) / 60 AS lag_minutes,
    CASE
        WHEN s.status <> 'active' THEN 'inactive'
        WHEN s.consecutive_errors >= 3 THEN 'failing'
        WHEN COALESCE(r.last_content_at, s.last_success_at) IS NULL THEN 'never_reported'
        WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(r.last_content_at, s.last_success_at))) / 60
             > s.lag_alert_minutes THEN 'stale'
        ELSE 'healthy'
    END AS health
FROM civic.sources   s
JOIN civic.campaigns c ON c.id = s.campaign_id
LEFT JOIN recent     r ON r.source_id = s.id
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_source_health ON civic_kpi.mv_source_health (source_id);

-- =============================================================================
-- 8. REFRESCO
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_ops.mv_refresh_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    view_name     TEXT        NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INTEGER,
    row_count     BIGINT,
    concurrent    BOOLEAN     NOT NULL DEFAULT TRUE,
    success       BOOLEAN,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS ix_mv_refresh_log_view
    ON civic_ops.mv_refresh_log (view_name, started_at DESC);

CREATE OR REPLACE FUNCTION civic_kpi.refresh_all(p_concurrent BOOLEAN DEFAULT TRUE)
RETURNS TABLE (view_name TEXT, duration_ms INTEGER, rows BIGINT, ok BOOLEAN, err TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
    v          TEXT;
    v_views    TEXT[] := ARRAY[
        'mv_sentiment_daily','mv_contender_daily','mv_topic_daily',
        'mv_emotion_daily','mv_entity_frequency','mv_geo_daily','mv_source_health'
    ];
    v_start    TIMESTAMPTZ;
    v_ms       INTEGER;
    v_rows     BIGINT;
    v_populated BOOLEAN;
    v_log_id   BIGINT;
BEGIN
    FOREACH v IN ARRAY v_views LOOP
        v_start := clock_timestamp();

        INSERT INTO civic_ops.mv_refresh_log (view_name, concurrent)
        VALUES (v, p_concurrent) RETURNING id INTO v_log_id;

        BEGIN
            -- CONCURRENTLY exige que la vista ya tenga datos. En el primer
            -- refresco tras la instalación hay que poblarla sin concurrencia.
            SELECT ispopulated INTO v_populated
              FROM pg_matviews WHERE schemaname = 'civic_kpi' AND matviewname = v;

            IF p_concurrent AND COALESCE(v_populated, FALSE) THEN
                EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY civic_kpi.%I', v);
            ELSE
                EXECUTE format('REFRESH MATERIALIZED VIEW civic_kpi.%I', v);
            END IF;

            EXECUTE format('SELECT count(*) FROM civic_kpi.%I', v) INTO v_rows;
            v_ms := (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::int;

            UPDATE civic_ops.mv_refresh_log
               SET finished_at = NOW(), duration_ms = v_ms, row_count = v_rows, success = TRUE
             WHERE id = v_log_id;

            view_name := v; duration_ms := v_ms; rows := v_rows; ok := TRUE; err := NULL;
            RETURN NEXT;

        EXCEPTION WHEN OTHERS THEN
            UPDATE civic_ops.mv_refresh_log
               SET finished_at = NOW(), success = FALSE, error_message = SQLERRM
             WHERE id = v_log_id;

            view_name := v; duration_ms := NULL; rows := NULL; ok := FALSE; err := SQLERRM;
            RETURN NEXT;
        END;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION civic_kpi.refresh_all IS
    'Refresca todas las MVs registrando duración y resultado. Detecta sola si puede usar CONCURRENTLY.';

-- Programación con pg_cron cuando esté disponible.
DO $$
BEGIN
    IF civic_ops.has_ext('pg_cron') THEN
        PERFORM cron.schedule('oeste-sentimientos-refresh-kpis', '*/15 * * * *',
                              'SELECT civic_kpi.refresh_all(true)');
        PERFORM cron.schedule('oeste-sentimientos-ensure-partitions', '30 3 * * *',
                              'SELECT civic_ops.ensure_partitions(true)');
        RAISE NOTICE 'pg_cron: refresco cada 15 min y mantenimiento de particiones a las 03:30.';
    ELSE
        RAISE NOTICE 'Sin pg_cron. Programe externamente:';
        RAISE NOTICE '  */15 * * * *  psql -c "SELECT civic_kpi.refresh_all(true)"';
        RAISE NOTICE '  30 3   * * *  psql -c "SELECT civic_ops.ensure_partitions(true)"';
    END IF;
END
$$;

-- Poblado inicial (vacío, pero deja las MVs en estado "populated" para que el
-- primer refresco concurrente funcione).
SELECT * FROM civic_kpi.refresh_all(FALSE);

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_n INTEGER;
BEGIN
    SELECT count(*) INTO v_n FROM pg_matviews WHERE schemaname = 'civic_kpi';
    RAISE NOTICE '── % vistas materializadas creadas y pobladas ──', v_n;
END
$$;
