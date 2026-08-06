-- =============================================================================
-- Análisis de Sentimientos · 09_indicators.sql
-- Biblioteca de indicadores políticos: registro, funciones y evaluador de reglas.
--
-- Principio rector: un indicador no es una consulta suelta en el frontend. Es un
-- objeto con nombre, definición, unidad, dirección deseable, tamaño mínimo de
-- muestra y advertencias de interpretación. Todo eso vive en metric_registry y
-- viaja junto al número hasta la interfaz.
--
-- ADVERTENCIA METODOLÓGICA que atraviesa todo este archivo:
--   Estos indicadores miden CONVERSACIÓN PÚBLICA DIGITAL, no intención de voto.
--   Quien publica no es una muestra representativa del electorado: sobre-
--   representa a los muy motivados, a los urbanos y a los conectados. Sirven
--   para detectar tendencias, temas emergentes y crisis en tiempo real. No
--   sustituyen a una encuesta probabilística y no deben presentarse como
--   pronóstico electoral.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_ops, public;

-- =============================================================================
-- 1. REGISTRO DE INDICADORES
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_kpi.metric_registry (
    code             TEXT PRIMARY KEY,
    label_es         TEXT     NOT NULL,
    label_en         TEXT     NOT NULL,
    -- Agrupación en el tablero.
    family           TEXT     NOT NULL
                     CHECK (family IN ('volume','sentiment','competitive','agenda',
                                       'risk','audience','operational','quality')),
    definition       TEXT     NOT NULL,
    formula          TEXT,
    unit             TEXT     NOT NULL
                     CHECK (unit IN ('count','percent','ratio','score','index','minutes','zscore')),
    -- Rango teórico. La interfaz lo usa para escalar ejes y semáforos.
    range_min        NUMERIC,
    range_max        NUMERIC,
    -- ¿Subir es bueno? Determina el color del delta. NULL = depende del contexto.
    higher_is_better BOOLEAN,
    -- Volumen mínimo para que el número sea publicable.
    min_sample_size  INTEGER  NOT NULL DEFAULT 30,
    -- Advertencia que la interfaz DEBE mostrar junto al indicador.
    caveat           TEXT,
    is_alertable     BOOLEAN  NOT NULL DEFAULT FALSE,
    sort_order       SMALLINT NOT NULL DEFAULT 0,
    is_active        BOOLEAN  NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE civic_kpi.metric_registry IS
    'Definición canónica de cada indicador. La API lo expone junto al valor para que ningún número '
    'llegue al usuario sin su unidad, su rango y su advertencia de interpretación.';
COMMENT ON COLUMN civic_kpi.metric_registry.min_sample_size IS
    'Por debajo de este volumen el indicador se marca como no confiable y no debe graficarse como tendencia.';

INSERT INTO civic_kpi.metric_registry
    (code, label_es, label_en, family, definition, formula, unit,
     range_min, range_max, higher_is_better, min_sample_size, caveat, is_alertable, sort_order) VALUES

-- ── Volumen ─────────────────────────────────────────────────────────────────
('mention_volume', 'Volumen de menciones', 'Mention volume', 'volume',
 'Número de contenidos analizados en la ventana, sin duplicados ni excluidos.',
 'count(inferences)', 'count', 0, NULL, NULL, 1,
 'El volumen depende de la cobertura de las fuentes activas. Una caída suele ser una fuente caída, no menos conversación.',
 TRUE, 1),

('volume_zscore', 'Anomalía de volumen', 'Volume anomaly', 'volume',
 'Desviaciones estándar del volumen del periodo respecto a la media móvil de 14 días.',
 '(v - media_14d) / desv_14d', 'zscore', -10, 10, NULL, 14,
 'Requiere al menos 14 días de historia. Antes de eso no hay media contra la cual comparar.',
 TRUE, 2),

('unique_authors', 'Autores únicos', 'Unique authors', 'volume',
 'Cuentas distintas que participaron, contadas sobre el hash seudonimizado.',
 'count(distinct author_hash)', 'count', 0, NULL, TRUE, 1,
 'Una persona con varias cuentas se cuenta varias veces. Es una cota superior, no un conteo de personas.',
 FALSE, 3),

('amplification_ratio', 'Razón de amplificación', 'Amplification ratio', 'volume',
 'Menciones divididas entre autores únicos. Valores altos indican pocos autores publicando mucho.',
 'menciones / autores_unicos', 'ratio', 0, NULL, NULL, 30,
 'Por encima de 3 conviene revisar coordinación o bots antes de leer el sentimiento como opinión pública.',
 TRUE, 4),

-- ── Sentimiento ─────────────────────────────────────────────────────────────
('net_sentiment', 'Sentimiento neto', 'Net sentiment', 'sentiment',
 'Proporción de positivos menos proporción de negativos, en puntos porcentuales.',
 '(pos - neg) / total * 100', 'percent', -100, 100, TRUE, 30,
 'Ignora los neutrales. Una conversación 50/50 positiva-negativa y una 100% neutral dan cero, y son muy distintas: mire también polarización.',
 TRUE, 10),

('avg_sentiment_score', 'Puntaje medio de sentimiento', 'Average sentiment score', 'sentiment',
 'Promedio de la polaridad continua en el rango -1 a 1.',
 'avg(sentiment_score)', 'score', -1, 1, TRUE, 30,
 'Más estable que el neto porque usa la intensidad, no sólo la etiqueta.',
 TRUE, 11),

('negative_pct', 'Porcentaje negativo', 'Negative percentage', 'sentiment',
 'Proporción de contenidos clasificados como negativos.',
 'neg / total * 100', 'percent', 0, 100, FALSE, 30,
 'El nivel base varía enormemente por plataforma. Compare contra la propia historia del canal, no contra un umbral absoluto.',
 TRUE, 12),

('polarization_index', 'Índice de polarización', 'Polarization index', 'sentiment',
 'Proporción de opiniones en los extremos (|score| > 0.6) menos la proporción moderada. '
 'Mide cuán partida está la conversación, con independencia de hacia dónde se inclina.',
 '(extremos - moderados) / total', 'index', -1, 1, FALSE, 50,
 'Polarización alta con sentimiento neto cero significa dos bloques enfrentados, no indiferencia.',
 TRUE, 13),

('sentiment_momentum', 'Momentum de sentimiento', 'Sentiment momentum', 'sentiment',
 'Diferencia entre el sentimiento medio de la ventana actual y el de la ventana previa de igual duración.',
 'avg_actual - avg_previo', 'score', -2, 2, TRUE, 30,
 'La dirección importa más que el nivel: es la señal temprana que anticipa el cambio de tendencia.',
 TRUE, 14),

-- ── Competitivo ─────────────────────────────────────────────────────────────
('share_of_voice', 'Participación en la conversación', 'Share of voice', 'competitive',
 'Proporción de menciones de un contendiente sobre el total de menciones a todos los contendientes.',
 'menciones_actor / menciones_todos * 100', 'percent', 0, 100, TRUE, 50,
 'Visibilidad no es apoyo. Un escándalo dispara el share of voice y hunde el apoyo neto al mismo tiempo.',
 TRUE, 20),

('net_support', 'Apoyo neto', 'Net support', 'competitive',
 'Menciones a favor menos menciones en contra, sobre el total de menciones con postura definida.',
 '(favor - contra) / con_postura * 100', 'percent', -100, 100, TRUE, 50,
 'Mide postura declarada en texto público. NO es intención de voto ni sustituye una encuesta probabilística.',
 TRUE, 21),

('support_wilson_lb', 'Apoyo neto (cota conservadora)', 'Net support (Wilson LB)', 'competitive',
 'Cota inferior del intervalo de Wilson al 95 % para la proporción de apoyo. '
 'Penaliza a los actores con pocas menciones.',
 'wilson_lower_bound(favor, con_postura)', 'ratio', 0, 1, TRUE, 10,
 'Úsela para ordenar rankings: evita que un actor con 5 menciones y 100 % de apoyo encabece la tabla.',
 FALSE, 22),

('competitive_momentum', 'Momentum competitivo', 'Competitive momentum', 'competitive',
 'Cambio del apoyo neto de un contendiente respecto al periodo anterior, en puntos porcentuales.',
 'apoyo_neto_actual - apoyo_neto_previo', 'percent', -200, 200, TRUE, 50,
 'Es el indicador que más se acerca a "quién va ganando la conversación", y aun así no predice el resultado.',
 TRUE, 23),

('attention_share', 'Cuota de atención', 'Attention share', 'competitive',
 'Participación en el alcance estimado total, no en el número de menciones.',
 'alcance_actor / alcance_total * 100', 'percent', 0, 100, TRUE, 50,
 'El alcance es una estimación de la plataforma de origen, con metodologías distintas entre canales.',
 FALSE, 24),

-- ── Agenda ──────────────────────────────────────────────────────────────────
('topic_share', 'Peso del tema', 'Topic share', 'agenda',
 'Proporción de la conversación dedicada a un tema.',
 'menciones_tema / menciones_totales * 100', 'percent', 0, 100, NULL, 50,
 'Que un tema domine no dice si beneficia o perjudica: cruce siempre con el sentimiento del tema.',
 FALSE, 30),

('topic_growth', 'Crecimiento del tema', 'Topic growth', 'agenda',
 'Variación porcentual de las menciones de un tema respecto al periodo previo.',
 '(actual - previo) / previo * 100', 'percent', -100, NULL, NULL, 20,
 'Sobre bases pequeñas produce porcentajes enormes sin significado. Exija volumen mínimo absoluto.',
 TRUE, 31),

('issue_ownership', 'Apropiación del tema', 'Issue ownership', 'agenda',
 'Participación de un contendiente en las menciones de un tema concreto. '
 'Mide si el actor es el referente del asunto.',
 'menciones_actor_en_tema / menciones_tema * 100', 'percent', 0, 100, TRUE, 40,
 'Ser el referente de un tema con sentimiento negativo es una desventaja, no una fortaleza.',
 FALSE, 32),

('agenda_alignment', 'Alineación de agenda', 'Agenda alignment', 'agenda',
 'Similitud entre la distribución de temas que impulsa la campaña y la que discute el público.',
 '1 - distancia_de_variacion_total', 'index', 0, 1, TRUE, 100,
 'Baja alineación significa que la campaña habla de algo que a nadie le interesa, o al revés.',
 FALSE, 33),

-- ── Riesgo ──────────────────────────────────────────────────────────────────
('toxicity_avg', 'Toxicidad media', 'Average toxicity', 'risk',
 'Puntaje medio de toxicidad de los contenidos de la ventana.',
 'avg(toxicity_score)', 'score', 0, 1, FALSE, 30,
 'Sirve para proteger al equipo de comunicación y priorizar moderación, no para clasificar personas.',
 TRUE, 40),

('crisis_risk_index', 'Índice de riesgo de crisis', 'Crisis risk index', 'risk',
 'Índice compuesto de cuatro señales: anomalía de volumen, caída de sentimiento, '
 'toxicidad y banderas de riesgo graves.',
 '0.3*z_volumen + 0.3*caida_sentimiento + 0.2*toxicidad + 0.2*banderas', 'index', 0, 100, FALSE, 50,
 'Es una señal de atención, no un diagnóstico. Siempre revise la evidencia adjunta antes de actuar.',
 TRUE, 41),

('threat_count', 'Amenazas detectadas', 'Threats detected', 'risk',
 'Contenidos con bandera de amenaza de violencia o violencia política de género.',
 'count(risk_flags in (threat_violence, gender_violence))', 'count', 0, NULL, FALSE, 1,
 'Cualquier valor mayor que cero exige revisión humana inmediata y, en su caso, canalización legal.',
 TRUE, 42),

('disinfo_count', 'Señalamientos de desinformación', 'Disinformation flags', 'risk',
 'Contenidos marcados como desinformación o medio manipulado.',
 'count(risk_flags in (disinformation, manipulated_media))', 'count', 0, NULL, FALSE, 1,
 'Marcado automático: siempre requiere verificación humana antes de cualquier respuesta pública.',
 TRUE, 43),

('coordination_score', 'Indicio de coordinación', 'Coordination signal', 'risk',
 'Proporción de contenidos con texto casi idéntico publicados por autores distintos en la misma ventana.',
 'contenidos_en_huellas_repetidas / total', 'ratio', 0, 1, FALSE, 100,
 'Indicio, no prueba. Los mensajes de campaña legítimos también se replican textualmente.',
 TRUE, 44),

-- ── Operacional y calidad ───────────────────────────────────────────────────
('source_lag_minutes', 'Retraso de fuente', 'Source lag', 'operational',
 'Minutos transcurridos desde el último contenido recolectado por una fuente.',
 'now() - max(collected_at)', 'minutes', 0, NULL, FALSE, 1,
 'Es lo primero que hay que revisar ante cualquier caída inexplicable de volumen.',
 TRUE, 50),

('confidence_avg', 'Confianza media del modelo', 'Model confidence', 'quality',
 'Confianza promedio declarada por el clasificador.',
 'avg(overall_confidence)', 'score', 0, 1, TRUE, 30,
 'Una caída sostenida indica deriva: el lenguaje de la conversación se alejó de aquello con lo que se calibró el modelo.',
 TRUE, 51),

('review_backlog', 'Pendientes de revisión', 'Review backlog', 'quality',
 'Inferencias marcadas para revisión humana que siguen sin resolver.',
 'count(needs_review and review_status in (pending, in_review))', 'count', 0, NULL, FALSE, 1,
 'Un rezago creciente degrada la calidad del tablero de forma silenciosa.',
 TRUE, 52),

('human_agreement', 'Concordancia con anotación humana', 'Human agreement', 'quality',
 'Proporción de casos revisados en que la persona confirmó la etiqueta del modelo.',
 'confirmadas / revisadas', 'ratio', 0, 1, TRUE, 30,
 'Es la medición continua de calidad en producción, complementaria a la evaluación sobre conjunto dorado.',
 TRUE, 53)

ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, definition = EXCLUDED.definition,
       caveat = EXCLUDED.caveat, min_sample_size = EXCLUDED.min_sample_size;

-- =============================================================================
-- 2. RESUMEN GENERAL DE CAMPAÑA
--    Alimenta la pantalla principal en una sola llamada.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.campaign_overview(
    p_campaign_code civic.public_code,
    p_days          INTEGER DEFAULT 30
)
RETURNS TABLE (
    campaign_code        TEXT,
    campaign_name        TEXT,
    period_start         DATE,
    period_end           DATE,
    days_to_election     INTEGER,
    total_mentions       BIGINT,
    unique_authors       BIGINT,
    total_reach          BIGINT,
    positive_count       BIGINT,
    neutral_count        BIGINT,
    negative_count       BIGINT,
    mixed_count          BIGINT,
    positive_pct         NUMERIC,
    neutral_pct          NUMERIC,
    negative_pct         NUMERIC,
    net_sentiment        NUMERIC,
    avg_sentiment_score  NUMERIC,
    sentiment_momentum   NUMERIC,
    polarization_index   NUMERIC,
    avg_toxicity         NUMERIC,
    avg_confidence       NUMERIC,
    open_alerts          BIGINT,
    critical_alerts      BIGINT,
    review_backlog       BIGINT,
    sources_healthy      BIGINT,
    sources_total        BIGINT,
    is_reliable          BOOLEAN,
    last_updated         TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
-- Ante un nombre ambiguo, resolver como columna y no como parámetro de salida:
-- varios OUT parameters (mentions, contender_id...) coinciden con columnas de las CTE.
#variable_conflict use_column
DECLARE
    v_campaign_id UUID;
    v_from DATE := CURRENT_DATE - p_days;
    v_to   DATE := CURRENT_DATE;
BEGIN
    SELECT id INTO v_campaign_id FROM civic.campaigns WHERE code = p_campaign_code;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'Campaña % no encontrada.', p_campaign_code USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    WITH current_window AS (
        SELECT
            sum(m.total_count)                                  AS total,
            sum(m.positive_count)                               AS pos,
            sum(m.neutral_count)                                AS neu,
            sum(m.negative_count)                               AS neg,
            sum(m.mixed_count)                                  AS mix,
            sum(m.unique_authors)                               AS authors,
            sum(m.total_reach)                                  AS reach,
            -- Promedio ponderado por volumen: promediar promedios diarios
            -- daría el mismo peso a un día de 10 mensajes y a uno de 10 000.
            sum(m.avg_score * m.total_count)
                / NULLIF(sum(m.total_count), 0)                 AS avg_score,
            sum(m.avg_confidence * m.total_count)
                / NULLIF(sum(m.total_count), 0)                 AS avg_conf,
            sum(m.avg_toxicity * m.total_count)
                / NULLIF(sum(m.total_count), 0)                 AS avg_tox,
            sum(m.extremity_ratio * m.total_count)
                / NULLIF(sum(m.total_count), 0)                 AS extremity,
            max(m.last_analyzed_at)                             AS last_run
        FROM civic_kpi.mv_sentiment_daily m
        WHERE m.campaign_id = v_campaign_id AND m.day BETWEEN v_from AND v_to
    ),
    previous_window AS (
        SELECT sum(m.avg_score * m.total_count) / NULLIF(sum(m.total_count), 0) AS avg_score
        FROM civic_kpi.mv_sentiment_daily m
        WHERE m.campaign_id = v_campaign_id
          AND m.day BETWEEN v_from - p_days AND v_from - 1
    ),
    alert_stats AS (
        SELECT
            count(*) FILTER (WHERE a.status IN ('open','acknowledged','in_progress')) AS open_n,
            count(*) FILTER (WHERE a.status IN ('open','acknowledged','in_progress')
                                AND a.severity_code = 'critical')                     AS crit_n
        FROM civic.alerts a
        WHERE a.campaign_id = v_campaign_id AND a.created_at >= NOW() - (p_days || ' days')::interval
    ),
    review_stats AS (
        SELECT count(*) AS backlog
        FROM civic.inferences i
        WHERE i.campaign_id = v_campaign_id
          AND i.needs_review AND i.review_status IN ('pending','in_review')
          AND i.analyzed_at >= NOW() - (p_days || ' days')::interval
    ),
    source_stats AS (
        SELECT count(*) FILTER (WHERE h.health = 'healthy') AS healthy_n,
               count(*)                                     AS total_n
        FROM civic_kpi.mv_source_health h
        WHERE h.campaign_id = v_campaign_id
    )
    SELECT
        p_campaign_code::text,
        c.name,
        v_from,
        v_to,
        CASE WHEN c.election_date IS NULL THEN NULL
             ELSE (c.election_date - CURRENT_DATE)::int END,
        COALESCE(cw.total, 0)::bigint,
        COALESCE(cw.authors, 0)::bigint,
        COALESCE(cw.reach, 0)::bigint,
        COALESCE(cw.pos, 0)::bigint,
        COALESCE(cw.neu, 0)::bigint,
        COALESCE(cw.neg, 0)::bigint,
        COALESCE(cw.mix, 0)::bigint,
        round(100.0 * COALESCE(cw.pos,0) / NULLIF(cw.total, 0), 2),
        round(100.0 * COALESCE(cw.neu,0) / NULLIF(cw.total, 0), 2),
        round(100.0 * COALESCE(cw.neg,0) / NULLIF(cw.total, 0), 2),
        round(100.0 * (COALESCE(cw.pos,0) - COALESCE(cw.neg,0)) / NULLIF(cw.total, 0), 2),
        round(cw.avg_score, 4),
        round(cw.avg_score - pw.avg_score, 4),
        -- Polarización: extremos menos moderados, normalizado a [-1, 1].
        round(2 * cw.extremity - 1, 4),
        round(cw.avg_tox, 4),
        round(cw.avg_conf, 4),
        COALESCE(a.open_n, 0)::bigint,
        COALESCE(a.crit_n, 0)::bigint,
        COALESCE(r.backlog, 0)::bigint,
        COALESCE(ss.healthy_n, 0)::bigint,
        COALESCE(ss.total_n, 0)::bigint,
        -- Bandera de fiabilidad: la interfaz debe atenuar el tablero si es FALSE.
        (COALESCE(cw.total, 0) >= 30),
        cw.last_run
    FROM civic.campaigns c
    CROSS JOIN current_window  cw
    CROSS JOIN previous_window pw
    CROSS JOIN alert_stats     a
    CROSS JOIN review_stats    r
    CROSS JOIN source_stats    ss
    WHERE c.id = v_campaign_id;
END;
$$;

COMMENT ON FUNCTION civic_kpi.campaign_overview IS
    'Resumen de la campaña en una llamada. is_reliable es FALSE si el volumen no alcanza el mínimo: '
    'la interfaz debe advertirlo en lugar de mostrar los porcentajes como si fueran sólidos.';

-- =============================================================================
-- 3. SERIE TEMPORAL DE SENTIMIENTO
--    Une histórico materializado con el día en curso leído en vivo.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.sentiment_timeseries(
    p_campaign_code civic.public_code,
    p_days          INTEGER DEFAULT 30,
    p_granularity   TEXT    DEFAULT 'day',
    p_source_id     UUID    DEFAULT NULL
)
RETURNS TABLE (
    period          DATE,
    total_count     BIGINT,
    positive_count  BIGINT,
    neutral_count   BIGINT,
    negative_count  BIGINT,
    mixed_count     BIGINT,
    positive_pct    NUMERIC,
    negative_pct    NUMERIC,
    net_sentiment   NUMERIC,
    avg_score       NUMERIC,
    rolling_avg_7   NUMERIC,
    volume_zscore   NUMERIC,
    is_spike        BOOLEAN,
    is_reliable     BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $$
-- Ante un nombre ambiguo, resolver como columna y no como parámetro de salida:
-- varios OUT parameters (mentions, contender_id...) coinciden con columnas de las CTE.
#variable_conflict use_column
DECLARE
    v_campaign_id UUID;
BEGIN
    IF p_granularity NOT IN ('day','week','month') THEN
        RAISE EXCEPTION 'Granularidad inválida: %. Use day, week o month.', p_granularity
            USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_campaign_id FROM civic.campaigns WHERE code = p_campaign_code;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'Campaña % no encontrada.', p_campaign_code USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    WITH historical AS (
        -- Todo lo anterior a hoy sale de la vista materializada.
        SELECT m.day, m.total_count, m.positive_count, m.neutral_count,
               m.negative_count, m.mixed_count, m.avg_score
        FROM   civic_kpi.mv_sentiment_daily m
        WHERE  m.campaign_id = v_campaign_id
          AND  m.day >= CURRENT_DATE - p_days
          AND  m.day <  CURRENT_DATE
          AND  (p_source_id IS NULL OR m.source_id = p_source_id)
    ),
    today_live AS (
        -- El día en curso se lee de la tabla viva: el tablero debe reflejar
        -- lo que está pasando ahora, no lo que había en el último refresco.
        SELECT
            (i.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date AS day,
            count(*)                                              AS total_count,
            count(*) FILTER (WHERE i.sentiment_code = 'positive')  AS positive_count,
            count(*) FILTER (WHERE i.sentiment_code = 'neutral')   AS neutral_count,
            count(*) FILTER (WHERE i.sentiment_code = 'negative')  AS negative_count,
            count(*) FILTER (WHERE i.sentiment_code = 'mixed')     AS mixed_count,
            avg(i.sentiment_score)                                 AS avg_score
        FROM civic.inferences i
        JOIN civic.campaigns  c ON c.id = i.campaign_id
        WHERE i.campaign_id = v_campaign_id
          AND (i.published_at AT TIME ZONE COALESCE(c.timezone,'UTC'))::date = CURRENT_DATE
          AND NOT i.is_superseded
          AND COALESCE(i.sarcasm_score, 0) <= 0.6
          AND (p_source_id IS NULL OR i.source_id = p_source_id)
        GROUP BY 1
    ),
    combined AS (
        SELECT * FROM historical
        UNION ALL
        SELECT * FROM today_live
    ),
    bucketed AS (
        SELECT
            CASE p_granularity
                WHEN 'day'   THEN cb.day
                WHEN 'week'  THEN date_trunc('week',  cb.day)::date
                ELSE              date_trunc('month', cb.day)::date
            END                                       AS period,
            sum(cb.total_count)::bigint               AS total_count,
            sum(cb.positive_count)::bigint            AS positive_count,
            sum(cb.neutral_count)::bigint             AS neutral_count,
            sum(cb.negative_count)::bigint            AS negative_count,
            sum(cb.mixed_count)::bigint               AS mixed_count,
            sum(cb.avg_score * cb.total_count)
                / NULLIF(sum(cb.total_count), 0)      AS avg_score
        FROM combined cb
        GROUP BY 1
    ),
    windowed AS (
        SELECT b.*,
               avg(b.avg_score) OVER w7                        AS roll7,
               avg(b.total_count) OVER w14                     AS vol_mean14,
               stddev_samp(b.total_count) OVER w14             AS vol_sd14
        FROM bucketed b
        WINDOW w7  AS (ORDER BY b.period ROWS BETWEEN 6  PRECEDING AND CURRENT ROW),
               w14 AS (ORDER BY b.period ROWS BETWEEN 14 PRECEDING AND 1 PRECEDING)
    )
    SELECT
        w.period,
        w.total_count,
        w.positive_count,
        w.neutral_count,
        w.negative_count,
        w.mixed_count,
        round(100.0 * w.positive_count / NULLIF(w.total_count, 0), 2),
        round(100.0 * w.negative_count / NULLIF(w.total_count, 0), 2),
        round(100.0 * (w.positive_count - w.negative_count) / NULLIF(w.total_count, 0), 2),
        round(w.avg_score, 4),
        round(w.roll7, 4),
        civic_ops.safe_zscore(w.total_count, w.vol_mean14, w.vol_sd14),
        (civic_ops.safe_zscore(w.total_count, w.vol_mean14, w.vol_sd14) > 3),
        (w.total_count >= 30)
    FROM windowed w
    ORDER BY w.period;
END;
$$;

COMMENT ON FUNCTION civic_kpi.sentiment_timeseries IS
    'Serie de sentimiento con media móvil de 7 periodos y detección de picos por z-score de 14. '
    'Combina histórico materializado con el día en curso leído en vivo.';

-- =============================================================================
-- 4. TABLERO COMPETITIVO
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.contender_scoreboard(
    p_campaign_code civic.public_code,
    p_days          INTEGER DEFAULT 14
)
RETURNS TABLE (
    contender_id        UUID,
    contender_name      TEXT,
    is_own              BOOLEAN,
    mentions            BIGINT,
    share_of_voice      NUMERIC,
    unique_authors      BIGINT,
    total_reach         BIGINT,
    attention_share     NUMERIC,
    favor_count         BIGINT,
    against_count       BIGINT,
    neutral_count       BIGINT,
    undecided_count     BIGINT,
    net_support         NUMERIC,
    support_wilson_lb   NUMERIC,
    avg_stance_score    NUMERIC,
    avg_text_sentiment  NUMERIC,
    prev_net_support    NUMERIC,
    competitive_momentum NUMERIC,
    baseline_support_pct NUMERIC,
    model_attribution_ratio NUMERIC,
    is_reliable         BOOLEAN,
    rank_by_wilson      INTEGER
)
LANGUAGE plpgsql
STABLE
AS $$
-- Ante un nombre ambiguo, resolver como columna y no como parámetro de salida:
-- varios OUT parameters (mentions, contender_id...) coinciden con columnas de las CTE.
#variable_conflict use_column
DECLARE
    v_campaign_id UUID;
BEGIN
    SELECT id INTO v_campaign_id FROM civic.campaigns WHERE code = p_campaign_code;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'Campaña % no encontrada.', p_campaign_code USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    WITH cur AS (
        SELECT m.contender_id, m.contender_name, m.is_own,
               sum(m.mentions)::bigint        AS mentions,
               sum(m.favor_count)::bigint     AS favor,
               sum(m.against_count)::bigint   AS against,
               sum(m.neutral_count)::bigint   AS neutral,
               sum(m.undecided_count)::bigint AS undecided,
               sum(m.unique_authors)::bigint  AS authors,
               sum(m.total_reach)::bigint     AS reach,
               sum(m.avg_stance_score   * m.mentions) / NULLIF(sum(m.mentions),0) AS stance_score,
               sum(m.avg_text_sentiment * m.mentions) / NULLIF(sum(m.mentions),0) AS text_sent,
               sum(m.model_attribution_ratio * m.mentions) / NULLIF(sum(m.mentions),0) AS model_ratio
        FROM civic_kpi.mv_contender_daily m
        WHERE m.campaign_id = v_campaign_id
          AND m.day >= CURRENT_DATE - p_days
        GROUP BY m.contender_id, m.contender_name, m.is_own
    ),
    prev AS (
        SELECT m.contender_id,
               sum(m.favor_count)::bigint   AS favor,
               sum(m.against_count)::bigint AS against,
               sum(m.favor_count + m.against_count + m.neutral_count)::bigint AS with_stance
        FROM civic_kpi.mv_contender_daily m
        WHERE m.campaign_id = v_campaign_id
          AND m.day >= CURRENT_DATE - (p_days * 2)
          AND m.day <  CURRENT_DATE - p_days
        GROUP BY m.contender_id
    ),
    totals AS (
        SELECT sum(mentions) AS all_mentions, sum(reach) AS all_reach FROM cur
    )
    SELECT
        c.contender_id,
        c.contender_name,
        c.is_own,
        c.mentions,
        round(100.0 * c.mentions / NULLIF(t.all_mentions, 0), 2),
        c.authors,
        c.reach,
        round(100.0 * c.reach / NULLIF(t.all_reach, 0), 2),
        c.favor,
        c.against,
        c.neutral,
        c.undecided,
        round(100.0 * (c.favor - c.against)
              / NULLIF(c.favor + c.against + c.neutral, 0), 2),
        civic_ops.wilson_lower_bound(c.favor, c.favor + c.against + c.neutral),
        round(c.stance_score, 4),
        round(c.text_sent, 4),
        round(100.0 * (p.favor - p.against) / NULLIF(p.with_stance, 0), 2),
        round(100.0 * (c.favor - c.against) / NULLIF(c.favor + c.against + c.neutral, 0), 2)
            - round(100.0 * (p.favor - p.against) / NULLIF(p.with_stance, 0), 2),
        ct.baseline_support_pct,
        round(c.model_ratio, 4),
        (c.mentions >= 50),
        -- El ranking usa Wilson, no el porcentaje crudo: es la diferencia entre
        -- un orden estable y uno que baila con cada mención nueva.
        rank() OVER (ORDER BY civic_ops.wilson_lower_bound(
                                  c.favor, c.favor + c.against + c.neutral) DESC)::int
    FROM cur c
    CROSS JOIN totals t
    LEFT JOIN prev p             ON p.contender_id = c.contender_id
    LEFT JOIN civic.contenders ct ON ct.id = c.contender_id
    ORDER BY civic_ops.wilson_lower_bound(c.favor, c.favor + c.against + c.neutral) DESC;
END;
$$;

COMMENT ON FUNCTION civic_kpi.contender_scoreboard IS
    'Comparativa entre contendientes. El orden usa la cota de Wilson para no premiar volúmenes bajos. '
    'baseline_support_pct trae la encuesta de referencia: contraste siempre el dato digital contra ella.';

-- =============================================================================
-- 5. AGENDA PÚBLICA
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.topic_agenda(
    p_campaign_code civic.public_code,
    p_days          INTEGER DEFAULT 14,
    p_limit         INTEGER DEFAULT 20
)
RETURNS TABLE (
    category_code    TEXT,
    label_es         TEXT,
    dimension        TEXT,
    mentions         BIGINT,
    topic_share      NUMERIC,
    avg_sentiment    NUMERIC,
    negative_pct     NUMERIC,
    unique_authors   BIGINT,
    prev_mentions    BIGINT,
    topic_growth     NUMERIC,
    is_emerging      BOOLEAN,
    is_owned_issue   BOOLEAN,
    is_reliable      BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $$
-- Ante un nombre ambiguo, resolver como columna y no como parámetro de salida:
-- varios OUT parameters (mentions, contender_id...) coinciden con columnas de las CTE.
#variable_conflict use_column
DECLARE v_campaign_id UUID;
BEGIN
    SELECT id INTO v_campaign_id FROM civic.campaigns WHERE code = p_campaign_code;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'Campaña % no encontrada.', p_campaign_code USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    WITH cur AS (
        SELECT m.category_code, m.dimension,
               sum(m.mentions)::bigint          AS mentions,
               sum(m.negative_mentions)::bigint AS negatives,
               sum(m.unique_authors)::bigint    AS authors,
               sum(m.avg_topic_sentiment * m.mentions) / NULLIF(sum(m.mentions),0) AS avg_sent
        FROM civic_kpi.mv_topic_daily m
        WHERE m.campaign_id = v_campaign_id AND m.day >= CURRENT_DATE - p_days
        GROUP BY m.category_code, m.dimension
    ),
    prev AS (
        SELECT m.category_code, sum(m.mentions)::bigint AS mentions
        FROM civic_kpi.mv_topic_daily m
        WHERE m.campaign_id = v_campaign_id
          AND m.day >= CURRENT_DATE - (p_days * 2) AND m.day < CURRENT_DATE - p_days
        GROUP BY m.category_code
    ),
    total AS (SELECT sum(mentions) AS all_mentions FROM cur)
    SELECT
        c.category_code::text,
        tc.label_es,
        c.dimension,
        c.mentions,
        round(100.0 * c.mentions / NULLIF(t.all_mentions, 0), 2),
        round(c.avg_sent, 4),
        round(100.0 * c.negatives / NULLIF(c.mentions, 0), 2),
        c.authors,
        COALESCE(p.mentions, 0),
        CASE WHEN COALESCE(p.mentions, 0) = 0 THEN NULL
             ELSE round(100.0 * (c.mentions - p.mentions) / p.mentions, 2) END,
        -- "Emergente" exige crecimiento porcentual ALTO y volumen absoluto
        -- suficiente. Sin la segunda condición, pasar de 2 a 8 menciones
        -- aparecería como un tema explosivo.
        (COALESCE(p.mentions,0) > 0
         AND c.mentions >= 50
         AND c.mentions > p.mentions * 2),
        COALESCE(ot.owned, FALSE),
        (c.mentions >= 50)
    FROM cur c
    CROSS JOIN total t
    LEFT JOIN prev p ON p.category_code = c.category_code
    JOIN civic_cat.topic_categories tc ON tc.code = c.category_code
    LEFT JOIN LATERAL (
        SELECT bool_or(tp.is_owned_issue) AS owned
        FROM civic.topics tp
        WHERE tp.campaign_id = v_campaign_id AND tp.category_code = c.category_code
    ) ot ON TRUE
    ORDER BY c.mentions DESC
    LIMIT p_limit;
END;
$$;

-- =============================================================================
-- 6. ÍNDICE DE RIESGO DE CRISIS
--    Compuesto de cuatro señales normalizadas a [0,100].
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.crisis_risk(
    p_campaign_code civic.public_code,
    p_hours         INTEGER DEFAULT 24
)
RETURNS TABLE (
    risk_index          NUMERIC,
    risk_level          TEXT,
    volume_component    NUMERIC,
    sentiment_component NUMERIC,
    toxicity_component  NUMERIC,
    flags_component     NUMERIC,
    sample_size         BIGINT,
    is_reliable         BOOLEAN,
    explanation         TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
-- Ante un nombre ambiguo, resolver como columna y no como parámetro de salida:
-- varios OUT parameters (mentions, contender_id...) coinciden con columnas de las CTE.
#variable_conflict use_column
DECLARE
    v_campaign_id UUID;
    v_vol         NUMERIC := 0;
    v_sent        NUMERIC := 0;
    v_tox         NUMERIC := 0;
    v_flags       NUMERIC := 0;
    v_n           BIGINT  := 0;
    v_index       NUMERIC;
    v_parts       TEXT[]  := ARRAY[]::TEXT[];
BEGIN
    SELECT id INTO v_campaign_id FROM civic.campaigns WHERE code = p_campaign_code;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'Campaña % no encontrada.', p_campaign_code USING ERRCODE = 'P0002';
    END IF;

    -- Componente 1: anomalía de volumen frente a la media horaria de 14 días.
    WITH win AS (
        SELECT count(*)::numeric AS n
        FROM civic.inferences
        WHERE campaign_id = v_campaign_id
          AND published_at >= NOW() - (p_hours || ' hours')::interval
          AND NOT is_superseded
    ),
    base AS (
        SELECT avg(h.c) AS mean_c, stddev_samp(h.c) AS sd_c
        FROM (
            SELECT date_trunc('hour', published_at) AS hr, count(*)::numeric AS c
            FROM civic.inferences
            WHERE campaign_id = v_campaign_id
              AND published_at BETWEEN NOW() - INTERVAL '14 days'
                                   AND NOW() - (p_hours || ' hours')::interval
              AND NOT is_superseded
            GROUP BY 1
        ) h
    )
    SELECT
        win.n,
        LEAST(100, GREATEST(0,
            civic_ops.safe_zscore(win.n / GREATEST(p_hours,1), base.mean_c, base.sd_c) * 20))
    INTO v_n, v_vol
    FROM win, base;

    -- Componente 2: caída de sentimiento contra la ventana previa.
    WITH cur AS (
        SELECT avg(sentiment_score) AS s
        FROM civic.inferences
        WHERE campaign_id = v_campaign_id
          AND published_at >= NOW() - (p_hours || ' hours')::interval
          AND NOT is_superseded AND COALESCE(sarcasm_score,0) <= 0.6
    ),
    prv AS (
        SELECT avg(sentiment_score) AS s
        FROM civic.inferences
        WHERE campaign_id = v_campaign_id
          AND published_at BETWEEN NOW() - (p_hours * 2 || ' hours')::interval
                               AND NOW() - (p_hours || ' hours')::interval
          AND NOT is_superseded AND COALESCE(sarcasm_score,0) <= 0.6
    )
    -- Una caída de 1.0 en la escala [-1,1] equivale a 100 puntos de componente.
    SELECT LEAST(100, GREATEST(0, (COALESCE(prv.s,0) - COALESCE(cur.s,0)) * 100))
    INTO v_sent FROM cur, prv;

    -- Componente 3: toxicidad media escalada.
    SELECT LEAST(100, GREATEST(0, COALESCE(avg(toxicity_score), 0) * 150))
    INTO v_tox
    FROM civic.inferences
    WHERE campaign_id = v_campaign_id
      AND published_at >= NOW() - (p_hours || ' hours')::interval
      AND NOT is_superseded;

    -- Componente 4: banderas graves. Cada una pesa 12 puntos; 8 saturan.
    SELECT LEAST(100, count(*) * 12)
    INTO v_flags
    FROM civic.inference_risk_flags f
    JOIN civic_cat.risk_flags rf ON rf.code = f.flag_code
    WHERE f.campaign_id = v_campaign_id
      AND f.published_at >= NOW() - (p_hours || ' hours')::interval
      AND rf.default_severity IN ('high','critical')
      AND f.review_state <> 'dismissed';

    v_index := round(0.30 * v_vol + 0.30 * v_sent + 0.20 * v_tox + 0.20 * v_flags, 2);

    IF v_vol   >= 40 THEN v_parts := v_parts || format('volumen anómalo (%s/100)', round(v_vol)); END IF;
    IF v_sent  >= 40 THEN v_parts := v_parts || format('caída de sentimiento (%s/100)', round(v_sent)); END IF;
    IF v_tox   >= 40 THEN v_parts := v_parts || format('toxicidad elevada (%s/100)', round(v_tox)); END IF;
    IF v_flags >= 24 THEN v_parts := v_parts || format('banderas de riesgo graves (%s/100)', round(v_flags)); END IF;

    RETURN QUERY SELECT
        v_index,
        CASE WHEN v_index >= 70 THEN 'critical'
             WHEN v_index >= 50 THEN 'high'
             WHEN v_index >= 30 THEN 'medium'
             WHEN v_index >= 15 THEN 'low'
             ELSE 'normal' END,
        round(v_vol, 2), round(v_sent, 2), round(v_tox, 2), round(v_flags, 2),
        v_n,
        (v_n >= 50),
        CASE WHEN cardinality(v_parts) = 0
             THEN 'Sin señales por encima del umbral de atención.'
             ELSE 'Contribuyen: ' || array_to_string(v_parts, ', ') || '.'
        END;
END;
$$;

COMMENT ON FUNCTION civic_kpi.crisis_risk IS
    'Índice compuesto 0-100 con desglose por componente y explicación en texto. '
    'Es una señal de atención: siempre revise la evidencia antes de responder públicamente.';

-- =============================================================================
-- 7. DETECCIÓN DE COORDINACIÓN
--    Mensajes casi idénticos publicados por autores distintos en poco tiempo.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.coordination_signals(
    p_campaign_code civic.public_code,
    p_hours         INTEGER DEFAULT 24,
    p_min_authors   INTEGER DEFAULT 3
)
RETURNS TABLE (
    fingerprint_hex TEXT,
    sample_text     TEXT,
    copies          BIGINT,
    distinct_authors BIGINT,
    first_seen      TIMESTAMPTZ,
    last_seen       TIMESTAMPTZ,
    spread_minutes  NUMERIC,
    sources         TEXT[],
    -- Publicaciones por minuto: un patrón orgánico se difunde en horas, no en segundos.
    burst_rate      NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
-- Ante un nombre ambiguo, resolver como columna y no como parámetro de salida:
-- varios OUT parameters (mentions, contender_id...) coinciden con columnas de las CTE.
#variable_conflict use_column
DECLARE v_campaign_id UUID;
BEGIN
    SELECT id INTO v_campaign_id FROM civic.campaigns WHERE code = p_campaign_code;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'Campaña % no encontrada.', p_campaign_code USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    SELECT
        encode(ct.fingerprint, 'hex'),
        min(left(ct.body, 200)),
        count(*)::bigint,
        count(DISTINCT ct.author_hash)::bigint,
        min(ct.published_at),
        max(ct.published_at),
        round(EXTRACT(EPOCH FROM (max(ct.published_at) - min(ct.published_at))) / 60, 2),
        array_agg(DISTINCT s.type_code::text),
        round(count(*)::numeric
              / GREATEST(EXTRACT(EPOCH FROM (max(ct.published_at) - min(ct.published_at))) / 60, 1), 2)
    FROM civic.contents ct
    JOIN civic.sources  s ON s.id = ct.source_id
    WHERE ct.campaign_id = v_campaign_id
      AND ct.published_at >= NOW() - (p_hours || ' hours')::interval
      AND NOT ct.is_excluded
      AND ct.author_hash IS NOT NULL
      AND length(ct.body) >= 40      -- textos cortos coinciden por azar
    GROUP BY ct.fingerprint
    HAVING count(DISTINCT ct.author_hash) >= p_min_authors
    ORDER BY count(*) DESC
    LIMIT 100;
END;
$$;

COMMENT ON FUNCTION civic_kpi.coordination_signals IS
    'Textos idénticos difundidos por autores distintos. Indicio de coordinación, no prueba: '
    'las consignas legítimas de campaña también se replican palabra por palabra.';

-- =============================================================================
-- 8. EVALUADOR DE REGLAS DE ALERTA
--    Vive en la base de datos porque aquí están los datos. El servicio de
--    alertas lo invoca periódicamente y difunde lo que devuelva.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.metric_value(
    p_campaign_id    UUID,
    p_metric         TEXT,
    p_window_minutes INTEGER,
    p_contender_id   UUID DEFAULT NULL,
    p_source_id      UUID DEFAULT NULL,
    p_topic_category TEXT DEFAULT NULL
)
RETURNS TABLE (value NUMERIC, sample_size BIGINT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_from TIMESTAMPTZ := NOW() - (p_window_minutes || ' minutes')::interval;
    v_prev TIMESTAMPTZ := NOW() - (p_window_minutes * 2 || ' minutes')::interval;
BEGIN
    CASE p_metric

    WHEN 'mention_volume' THEN
        RETURN QUERY
        SELECT count(*)::numeric, count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id AND i.published_at >= v_from
          AND NOT i.is_superseded
          AND (p_source_id IS NULL OR i.source_id = p_source_id);

    WHEN 'negative_pct' THEN
        RETURN QUERY
        SELECT round(100.0 * count(*) FILTER (WHERE i.sentiment_code = 'negative')
                     / NULLIF(count(*), 0), 2),
               count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id AND i.published_at >= v_from
          AND NOT i.is_superseded AND COALESCE(i.sarcasm_score,0) <= 0.6
          AND (p_source_id IS NULL OR i.source_id = p_source_id);

    WHEN 'net_sentiment' THEN
        RETURN QUERY
        SELECT round(100.0 * (count(*) FILTER (WHERE i.sentiment_code = 'positive')
                            - count(*) FILTER (WHERE i.sentiment_code = 'negative'))
                     / NULLIF(count(*), 0), 2),
               count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id AND i.published_at >= v_from
          AND NOT i.is_superseded AND COALESCE(i.sarcasm_score,0) <= 0.6
          AND (p_source_id IS NULL OR i.source_id = p_source_id);

    WHEN 'avg_sentiment_score' THEN
        RETURN QUERY
        SELECT round(avg(i.sentiment_score), 4), count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id AND i.published_at >= v_from
          AND NOT i.is_superseded AND COALESCE(i.sarcasm_score,0) <= 0.6;

    WHEN 'net_sentiment_delta' THEN
        RETURN QUERY
        WITH cur AS (
            SELECT avg(sentiment_score) s, count(*) n FROM civic.inferences
            WHERE campaign_id = p_campaign_id AND published_at >= v_from AND NOT is_superseded
        ), prv AS (
            SELECT avg(sentiment_score) s FROM civic.inferences
            WHERE campaign_id = p_campaign_id
              AND published_at BETWEEN v_prev AND v_from AND NOT is_superseded
        )
        SELECT round(COALESCE(cur.s,0) - COALESCE(prv.s,0), 4), cur.n::bigint FROM cur, prv;

    WHEN 'volume_zscore' THEN
        RETURN QUERY
        WITH cur AS (
            SELECT count(*)::numeric n FROM civic.inferences
            WHERE campaign_id = p_campaign_id AND published_at >= v_from AND NOT is_superseded
        ), base AS (
            SELECT avg(c) m, stddev_samp(c) sd FROM (
                SELECT count(*)::numeric c FROM civic.inferences
                WHERE campaign_id = p_campaign_id
                  AND published_at BETWEEN NOW() - INTERVAL '14 days' AND v_from
                  AND NOT is_superseded
                GROUP BY floor(EXTRACT(EPOCH FROM (NOW() - published_at)) / (p_window_minutes * 60))
            ) x
        )
        SELECT civic_ops.safe_zscore(cur.n, base.m, base.sd), cur.n::bigint FROM cur, base;

    WHEN 'toxicity_avg' THEN
        RETURN QUERY
        SELECT round(avg(i.toxicity_score), 4), count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id AND i.published_at >= v_from
          AND NOT i.is_superseded AND i.toxicity_score IS NOT NULL;

    WHEN 'confidence_avg' THEN
        RETURN QUERY
        SELECT round(avg(i.overall_confidence), 4), count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id AND i.analyzed_at >= v_from AND NOT i.is_superseded;

    WHEN 'threat_count' THEN
        RETURN QUERY
        SELECT count(*)::numeric, count(*)::bigint
        FROM civic.inference_risk_flags f
        WHERE f.campaign_id = p_campaign_id AND f.published_at >= v_from
          AND f.flag_code IN ('threat_violence','gender_violence','electoral_crime')
          AND f.review_state <> 'dismissed';

    WHEN 'disinfo_count' THEN
        RETURN QUERY
        SELECT count(*)::numeric, count(*)::bigint
        FROM civic.inference_risk_flags f
        WHERE f.campaign_id = p_campaign_id AND f.published_at >= v_from
          AND f.flag_code IN ('disinformation','manipulated_media','misinformation')
          AND f.review_state <> 'dismissed';

    WHEN 'coordination_score' THEN
        RETURN QUERY
        WITH dup AS (
            SELECT ct.fingerprint, count(*) c, count(DISTINCT ct.author_hash) a
            FROM civic.contents ct
            WHERE ct.campaign_id = p_campaign_id AND ct.published_at >= v_from
              AND length(ct.body) >= 40 AND ct.author_hash IS NOT NULL
            GROUP BY ct.fingerprint
        ), tot AS (
            SELECT count(*)::numeric n FROM civic.contents
            WHERE campaign_id = p_campaign_id AND published_at >= v_from
        )
        SELECT round(COALESCE(sum(dup.c) FILTER (WHERE dup.a >= 3), 0) / NULLIF(tot.n, 0), 4),
               tot.n::bigint
        FROM dup, tot GROUP BY tot.n;

    WHEN 'sov_pct' THEN
        RETURN QUERY
        WITH t AS (
            SELECT count(*)::numeric total,
                   count(*) FILTER (WHERE st.contender_id = p_contender_id)::numeric mine
            FROM civic.inference_stances st
            WHERE st.campaign_id = p_campaign_id AND st.published_at >= v_from
        )
        SELECT round(100.0 * mine / NULLIF(total, 0), 2), total::bigint FROM t;

    WHEN 'competitor_net_delta' THEN
        RETURN QUERY
        WITH cur AS (
            SELECT sum(sc.weight) s, count(*) n
            FROM civic.inference_stances st
            JOIN civic_cat.stance_types sc ON sc.code = st.stance_code
            WHERE st.campaign_id = p_campaign_id AND st.published_at >= v_from
              AND (p_contender_id IS NULL OR st.contender_id = p_contender_id)
        ), prv AS (
            SELECT sum(sc.weight) s, count(*) n
            FROM civic.inference_stances st
            JOIN civic_cat.stance_types sc ON sc.code = st.stance_code
            WHERE st.campaign_id = p_campaign_id
              AND st.published_at BETWEEN v_prev AND v_from
              AND (p_contender_id IS NULL OR st.contender_id = p_contender_id)
        )
        SELECT round(100.0 * (COALESCE(cur.s,0)/NULLIF(cur.n,0)
                            - COALESCE(prv.s,0)/NULLIF(prv.n,0)), 2),
               cur.n::bigint
        FROM cur, prv;

    WHEN 'topic_growth' THEN
        RETURN QUERY
        WITH cur AS (
            SELECT count(*)::numeric n FROM civic.inference_topics
            WHERE campaign_id = p_campaign_id AND published_at >= v_from
              AND (p_topic_category IS NULL OR category_code = p_topic_category::civic.slug_code)
        ), prv AS (
            SELECT count(*)::numeric n FROM civic.inference_topics
            WHERE campaign_id = p_campaign_id AND published_at BETWEEN v_prev AND v_from
              AND (p_topic_category IS NULL OR category_code = p_topic_category::civic.slug_code)
        )
        SELECT round(100.0 * (cur.n - prv.n) / NULLIF(prv.n, 0), 2), cur.n::bigint FROM cur, prv;

    WHEN 'source_lag_minutes' THEN
        RETURN QUERY
        SELECT round(EXTRACT(EPOCH FROM (NOW() - max(ct.collected_at))) / 60, 2), count(*)::bigint
        FROM civic.contents ct
        WHERE ct.campaign_id = p_campaign_id
          AND (p_source_id IS NULL OR ct.source_id = p_source_id)
          AND ct.collected_at >= NOW() - INTERVAL '7 days';

    WHEN 'review_backlog' THEN
        RETURN QUERY
        SELECT count(*)::numeric, count(*)::bigint
        FROM civic.inferences i
        WHERE i.campaign_id = p_campaign_id
          AND i.needs_review AND i.review_status IN ('pending','in_review');

    ELSE
        RAISE EXCEPTION 'Métrica desconocida: %. Consulte civic_kpi.metric_registry.', p_metric
            USING ERRCODE = '22023';
    END CASE;
END;
$$;

COMMENT ON FUNCTION civic_kpi.metric_value IS
    'Calcula una métrica del registro sobre una ventana. Devuelve también el tamaño de muestra, '
    'que el evaluador usa para descartar alertas sobre volúmenes insuficientes.';

-- Evaluador principal. Recorre las reglas activas y crea alertas.
CREATE OR REPLACE FUNCTION civic.evaluate_alert_rules(
    p_campaign_code civic.public_code DEFAULT NULL,
    p_dry_run       BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    rule_id        UUID,
    rule_name      TEXT,
    metric         TEXT,
    observed       NUMERIC,
    threshold      NUMERIC,
    sample_size    BIGINT,
    condition_met  BOOLEAN,
    fired          BOOLEAN,
    skip_reason    TEXT,
    alert_id       UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
    r            RECORD;
    v_val        NUMERIC;
    v_n          BIGINT;
    v_met        BOOLEAN;
    v_fire       BOOLEAN;
    v_skip       TEXT;
    v_alert_id   UUID;
    v_today_n    INTEGER;
    v_blackout   BOOLEAN;
    v_local_hour SMALLINT;
    v_evidence   JSONB;
BEGIN
    FOR r IN
        SELECT ar.*, c.timezone, c.blackout_starts_on, c.blackout_ends_on,
               mr.label_es AS metric_label, mr.unit
        FROM   civic.alert_rules ar
        JOIN   civic.campaigns   c  ON c.id = ar.campaign_id
        LEFT JOIN civic_kpi.metric_registry mr ON mr.code = ar.metric
        WHERE  ar.is_enabled
          AND  c.status = 'active'
          AND  (p_campaign_code IS NULL OR ar.campaign_code = p_campaign_code)
    LOOP
        v_skip := NULL; v_fire := FALSE; v_alert_id := NULL;

        -- 1. Calcular la métrica.
        BEGIN
            SELECT m.value, m.sample_size INTO v_val, v_n
            FROM civic_kpi.metric_value(
                r.campaign_id, r.metric, r.window_minutes,
                r.contender_id, r.source_id, r.topic_category::text
            ) m;
        EXCEPTION WHEN OTHERS THEN
            rule_id := r.id; rule_name := r.name; metric := r.metric;
            observed := NULL; threshold := r.threshold; sample_size := NULL;
            condition_met := FALSE; fired := FALSE;
            skip_reason := 'error al calcular: ' || SQLERRM; alert_id := NULL;
            RETURN NEXT;
            CONTINUE;
        END;

        -- 2. Evaluar la condición.
        v_met := CASE r.operator
                   WHEN 'gt'  THEN v_val >  r.threshold
                   WHEN 'gte' THEN v_val >= r.threshold
                   WHEN 'lt'  THEN v_val <  r.threshold
                   WHEN 'lte' THEN v_val <= r.threshold
                   WHEN 'eq'  THEN v_val =  r.threshold
                   WHEN 'neq' THEN v_val <> r.threshold
                 END;
        v_met := COALESCE(v_met, FALSE);

        -- 3. Histéresis: contar rachas consecutivas.
        IF NOT p_dry_run THEN
            UPDATE civic.alert_rules
               SET current_streak    = CASE WHEN v_met THEN current_streak + 1 ELSE 0 END,
                   last_evaluated_at = NOW()
             WHERE id = r.id
            RETURNING current_streak INTO v_today_n;
        ELSE
            v_today_n := CASE WHEN v_met THEN r.current_streak + 1 ELSE 0 END;
        END IF;

        -- 4. Guardas antes de disparar.
        IF NOT v_met THEN
            v_skip := 'condición no cumplida';

        ELSIF v_n < r.min_sample_size THEN
            -- La guarda más importante: sin volumen, el porcentaje es ruido.
            v_skip := format('muestra insuficiente (%s < %s)', v_n, r.min_sample_size);

        ELSIF v_today_n < r.consecutive_hits THEN
            v_skip := format('racha %s de %s requeridas', v_today_n, r.consecutive_hits);

        ELSIF r.last_triggered_at IS NOT NULL
              AND r.last_triggered_at > NOW() - (r.cooldown_minutes || ' minutes')::interval THEN
            v_skip := format('en periodo de silencio (%s min)', r.cooldown_minutes);

        ELSE
            -- Tope diario.
            SELECT count(*) INTO v_today_n
            FROM civic.alerts a
            WHERE a.rule_id = r.id AND a.created_at >= date_trunc('day', NOW());

            v_blackout := r.blackout_starts_on IS NOT NULL
                      AND CURRENT_DATE BETWEEN r.blackout_starts_on
                                           AND COALESCE(r.blackout_ends_on, r.blackout_starts_on);

            v_local_hour := EXTRACT(HOUR FROM (NOW() AT TIME ZONE COALESCE(r.timezone,'UTC')))::smallint;

            IF v_today_n >= r.max_per_day THEN
                v_skip := format('tope diario alcanzado (%s)', r.max_per_day);
            ELSIF r.respect_blackout AND v_blackout THEN
                -- Durante la veda la alerta SÍ se registra, pero no se notifica.
                v_skip := 'veda electoral: se registra sin notificar';
                v_fire := TRUE;
            ELSIF r.quiet_hours_start IS NOT NULL
                  AND v_local_hour >= r.quiet_hours_start
                  AND v_local_hour <  COALESCE(r.quiet_hours_end, 24)
                  AND r.severity_code <> 'critical' THEN
                v_skip := 'horario silencioso: se registra sin notificar';
                v_fire := TRUE;
            ELSE
                v_fire := TRUE;
            END IF;
        END IF;

        -- 5. Crear la alerta.
        IF v_fire AND NOT p_dry_run THEN
            -- Evidencia: hasta 5 contenidos representativos de la ventana.
            SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_evidence
            FROM (
                SELECT jsonb_build_object(
                           'content_id',   ct.id,
                           'text',         left(ct.body, 280),
                           'published_at', ct.published_at,
                           'url',          ct.url,
                           'sentiment',    i.sentiment_code,
                           'score',        i.sentiment_score
                       ) AS e
                FROM civic.inferences i
                JOIN civic.contents  ct ON ct.id = i.content_id AND ct.published_at = i.published_at
                WHERE i.campaign_id = r.campaign_id
                  AND i.published_at >= NOW() - (r.window_minutes || ' minutes')::interval
                  AND NOT i.is_superseded
                ORDER BY i.sentiment_score ASC, ct.reach_estimate DESC NULLS LAST
                LIMIT 5
            ) s;

            INSERT INTO civic.alerts (
                organization_id, campaign_id, campaign_code, rule_id,
                alert_type_code, severity_code, title, message,
                metric, observed_value, threshold_value, sample_size,
                window_start, window_end,
                contender_id, source_id, topic_category, geo_area_id,
                evidence, context
            ) VALUES (
                r.organization_id, r.campaign_id, r.campaign_code, r.id,
                r.alert_type_code, r.severity_code,
                r.name,
                COALESCE(
                    r.message_template,
                    format('%s: %s (umbral %s %s) sobre %s observaciones en %s minutos.',
                           COALESCE(r.metric_label, r.metric), v_val,
                           CASE r.operator WHEN 'gt' THEN '>' WHEN 'gte' THEN '>='
                                           WHEN 'lt' THEN '<' WHEN 'lte' THEN '<='
                                           WHEN 'eq' THEN '=' ELSE '<>' END,
                           r.threshold, v_n, r.window_minutes)
                ),
                r.metric, v_val, r.threshold, v_n,
                NOW() - (r.window_minutes || ' minutes')::interval, NOW(),
                r.contender_id, r.source_id, r.topic_category, r.geo_area_id,
                v_evidence,
                jsonb_build_object('unit', r.unit, 'streak', r.current_streak + 1)
            )
            RETURNING id INTO v_alert_id;

            UPDATE civic.alert_rules
               SET last_triggered_at = NOW(),
                   trigger_count     = trigger_count + 1,
                   current_streak    = 0
             WHERE id = r.id;

            -- Encolar entregas por cada canal configurado.
            INSERT INTO civic.alert_deliveries (alert_id, channel, status, suppression_reason)
            SELECT v_alert_id, ch,
                   CASE WHEN v_skip IS NULL THEN 'pending' ELSE 'suppressed' END,
                   v_skip
            FROM unnest(r.channels) AS ch;
        END IF;

        rule_id := r.id; rule_name := r.name; metric := r.metric;
        observed := v_val; threshold := r.threshold; sample_size := v_n;
        condition_met := v_met; fired := v_fire;
        skip_reason := v_skip; alert_id := v_alert_id;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION civic.evaluate_alert_rules IS
    'Evalúa todas las reglas activas y crea alertas. Aplica cuatro guardas contra el ruido: '
    'muestra mínima, histéresis por rachas, periodo de silencio y tope diario. '
    'Respeta veda electoral y horario silencioso registrando la alerta sin notificarla. '
    'Con p_dry_run = TRUE reporta qué habría pasado sin escribir nada.';

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_n INTEGER;
BEGIN
    SELECT count(*) INTO v_n FROM civic_kpi.metric_registry WHERE is_active;
    RAISE NOTICE '── % indicadores registrados. Evaluador de reglas activo. ──', v_n;
END
$$;
