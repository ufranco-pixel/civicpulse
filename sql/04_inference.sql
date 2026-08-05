-- =============================================================================
-- CivicPulse · 04_inference.sql
-- Resultados del análisis: inferencias y sus tablas de detalle.
--
-- Decisión estructural: los ejes multivaluados (emociones, temas, posturas,
-- entidades, banderas) viven en tablas normalizadas, no en JSONB. La razón es
-- que TODOS los indicadores políticos agregan por esos ejes; con JSONB cada KPI
-- exigiría desanidar en tiempo de consulta.
--
-- Todas las tablas de este archivo están particionadas por analyzed_at y
-- denormalizan campaign_id y published_at para poder agregar sin JOIN.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_ops, public;

-- =============================================================================
-- 1. INFERENCIAS (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inferences (
    id                   UUID            NOT NULL DEFAULT gen_random_uuid(),
    analyzed_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),   -- clave de partición

    -- Identificador secuencial estable. Existe para los endpoints heredados que
    -- direccionan inferencias por entero; la clave real sigue siendo el UUID.
    seq                  BIGINT          GENERATED ALWAYS AS IDENTITY,

    organization_id      UUID            NOT NULL,
    campaign_id          UUID            NOT NULL,
    source_id            UUID            NOT NULL,
    content_id           UUID            NOT NULL,
    -- Denormalizado desde contents: permite series de tiempo por fecha de
    -- publicación sin tocar la tabla de contenidos.
    published_at         TIMESTAMPTZ     NOT NULL,
    job_id               UUID,

    -- ── Procedencia del resultado ───────────────────────────────────────────
    model_id             UUID            NOT NULL,
    prompt_version_id    UUID,
    -- Nombre del modelo congelado en el momento del análisis. Si el modelo se
    -- renombra o se borra, el histórico sigue siendo interpretable.
    model_name_snapshot  TEXT            NOT NULL,
    model_version_snapshot TEXT,
    pipeline             TEXT            NOT NULL DEFAULT 'llm'
                         CHECK (pipeline IN ('llm','transformer','ensemble','rule','human')),

    -- ── Sentimiento ─────────────────────────────────────────────────────────
    sentiment_code       civic.slug_code NOT NULL,
    -- Puntaje continuo en [-1,1]. Independiente de la etiqueta: permite medir
    -- intensidad y calcular sentimiento neto sin recodificar.
    sentiment_score      civic.polarity_score NOT NULL,
    sentiment_confidence civic.unit_score NOT NULL,
    -- Distribución completa devuelta por el clasificador. Necesaria para
    -- recalibrar umbrales sin reprocesar.
    sentiment_probs      JSONB,

    -- ── Intención ───────────────────────────────────────────────────────────
    intent_code          civic.slug_code,
    intent_confidence    civic.unit_score,

    -- ── Señales escalares ───────────────────────────────────────────────────
    toxicity_score       civic.unit_score,
    -- La ironía es la principal fuente de error en sentimiento político.
    -- Se mide aparte para poder excluir o revisar esos casos.
    sarcasm_score        civic.unit_score,
    subjectivity_score   civic.unit_score,

    detected_language    civic.lang_code,
    summary              TEXT,

    -- ── Calidad ─────────────────────────────────────────────────────────────
    overall_confidence   civic.unit_score NOT NULL,
    -- Marcado para revisión humana: baja confianza, ironía alta o bandera de riesgo.
    needs_review         BOOLEAN         NOT NULL DEFAULT FALSE,
    review_status        TEXT            NOT NULL DEFAULT 'not_required'
                         CHECK (review_status IN ('not_required','pending','in_review','confirmed','corrected','rejected')),
    reviewed_by          TEXT,
    reviewed_at          TIMESTAMPTZ,
    -- Se marca cuando una anotación humana contradice la etiqueta del modelo.
    is_superseded        BOOLEAN         NOT NULL DEFAULT FALSE,

    -- ── Trazabilidad y costo ────────────────────────────────────────────────
    raw_output           JSONB,
    latency_ms           INTEGER         CHECK (latency_ms >= 0),
    input_tokens         INTEGER         CHECK (input_tokens  >= 0),
    output_tokens        INTEGER         CHECK (output_tokens >= 0),
    cost_usd             NUMERIC(12,6)   CHECK (cost_usd >= 0),

    created_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    PRIMARY KEY (id, analyzed_at),
    CONSTRAINT ck_inf_reviewed CHECK (reviewed_at IS NULL OR reviewed_by IS NOT NULL)
) PARTITION BY RANGE (analyzed_at);

COMMENT ON TABLE  civic.inferences IS
    'Una fila por (contenido, modelo). Reanalizar el mismo contenido con otro modelo genera una fila nueva: el histórico nunca se sobrescribe.';
COMMENT ON COLUMN civic.inferences.sentiment_score IS
    'Polaridad continua en [-1,1]. Los promedios de sentimiento se calculan sobre esta columna, no sobre la etiqueta.';
COMMENT ON COLUMN civic.inferences.sarcasm_score IS
    'Probabilidad de ironía. Umbral > 0.5 recomienda excluir el registro de los agregados de sentimiento.';
COMMENT ON COLUMN civic.inferences.is_superseded IS
    'TRUE si una anotación humana reemplazó esta inferencia. Los KPIs la excluyen.';

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_inf_org', 'FOREIGN KEY (organization_id) REFERENCES civic.organizations(id) ON DELETE CASCADE'),
        ('fk_inf_campaign', 'FOREIGN KEY (campaign_id) REFERENCES civic.campaigns(id) ON DELETE CASCADE'),
        ('fk_inf_source', 'FOREIGN KEY (source_id) REFERENCES civic.sources(id) ON DELETE CASCADE'),
        ('fk_inf_content', 'FOREIGN KEY (content_id, published_at) REFERENCES civic.contents (id, published_at) ON DELETE CASCADE'),
        ('fk_inf_sentiment', 'FOREIGN KEY (sentiment_code) REFERENCES civic_cat.sentiment_types(code)'),
        ('fk_inf_intent', 'FOREIGN KEY (intent_code) REFERENCES civic_cat.intent_types(code)'),
        ('fk_inf_lang', 'FOREIGN KEY (detected_language) REFERENCES civic_cat.languages(code)')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inferences'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inferences ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

-- Índices
CREATE INDEX IF NOT EXISTS ix_inf_campaign_published
    ON civic.inferences (campaign_id, published_at DESC)
    WHERE NOT is_superseded;

CREATE INDEX IF NOT EXISTS ix_inf_campaign_sentiment
    ON civic.inferences (campaign_id, sentiment_code, published_at DESC)
    WHERE NOT is_superseded;

CREATE INDEX IF NOT EXISTS ix_inf_content     ON civic.inferences (content_id);
CREATE INDEX IF NOT EXISTS ix_inf_job         ON civic.inferences (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_inf_model       ON civic.inferences (model_id, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS ix_inf_review      ON civic.inferences (campaign_id, analyzed_at DESC)
    WHERE needs_review AND review_status IN ('pending','in_review');
CREATE INDEX IF NOT EXISTS ix_inf_seq         ON civic.inferences (seq);
CREATE INDEX IF NOT EXISTS ix_inf_source_time ON civic.inferences (source_id, published_at DESC);

-- Una sola inferencia vigente por contenido y modelo.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inf_content_model
    ON civic.inferences (content_id, model_id, analyzed_at);

-- =============================================================================
-- 2. EMOCIONES DETECTADAS (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inference_emotions (
    inference_id   UUID            NOT NULL,
    analyzed_at    TIMESTAMPTZ     NOT NULL,
    campaign_id    UUID            NOT NULL,
    published_at   TIMESTAMPTZ     NOT NULL,
    emotion_code   civic.slug_code NOT NULL,
    -- Intensidad en [0,1]. Multietiqueta: un texto puede tener varias.
    score          civic.unit_score NOT NULL,
    is_dominant    BOOLEAN         NOT NULL DEFAULT FALSE,

    PRIMARY KEY (inference_id, analyzed_at, emotion_code)
) PARTITION BY RANGE (analyzed_at);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_infemo_inference', 'FOREIGN KEY (inference_id, analyzed_at) REFERENCES civic.inferences (id, analyzed_at) ON DELETE CASCADE'),
        ('fk_infemo_emotion', 'FOREIGN KEY (emotion_code) REFERENCES civic_cat.emotion_types(code)')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inference_emotions'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inference_emotions ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS ix_infemo_campaign
    ON civic.inference_emotions (campaign_id, emotion_code, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_infemo_dominant
    ON civic.inference_emotions (campaign_id, published_at DESC) WHERE is_dominant;

COMMENT ON COLUMN civic.inference_emotions.is_dominant IS
    'Emoción de mayor score en la inferencia. Permite gráficas de "emoción principal" sin subconsulta.';

-- =============================================================================
-- 3. POSTURA POR CONTENDIENTE (particionada)
--    El eje central de la analítica electoral. Un comentario puede expresar
--    postura hacia varios actores a la vez, con signos opuestos.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inference_stances (
    inference_id   UUID            NOT NULL,
    analyzed_at    TIMESTAMPTZ     NOT NULL,
    campaign_id    UUID            NOT NULL,
    published_at   TIMESTAMPTZ     NOT NULL,
    contender_id   UUID            NOT NULL,
    stance_code    civic.slug_code NOT NULL,
    -- Puntaje continuo de apoyo en [-1,1], independiente del sentimiento del texto.
    stance_score   civic.polarity_score NOT NULL,
    confidence     civic.unit_score NOT NULL,
    -- Cómo se vinculó el texto con el actor: importa para auditar falsos positivos.
    match_method   TEXT            NOT NULL DEFAULT 'model'
                   CHECK (match_method IN ('handle','alias','model','manual','inherited')),
    -- Fragmento que sustenta la atribución. Hace auditable la decisión.
    evidence_span  TEXT,

    PRIMARY KEY (inference_id, analyzed_at, contender_id)
) PARTITION BY RANGE (analyzed_at);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_infsta_inference', 'FOREIGN KEY (inference_id, analyzed_at) REFERENCES civic.inferences (id, analyzed_at) ON DELETE CASCADE'),
        ('fk_infsta_contender', 'FOREIGN KEY (contender_id) REFERENCES civic.contenders(id) ON DELETE CASCADE'),
        ('fk_infsta_stance', 'FOREIGN KEY (stance_code) REFERENCES civic_cat.stance_types(code)')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inference_stances'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inference_stances ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS ix_infsta_contender_time
    ON civic.inference_stances (contender_id, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_infsta_campaign_time
    ON civic.inference_stances (campaign_id, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_infsta_stance
    ON civic.inference_stances (campaign_id, stance_code, published_at DESC);

COMMENT ON TABLE civic.inference_stances IS
    'Postura hacia cada contendiente mencionado. Es la base del share of voice, del apoyo neto y del ranking competitivo.';
COMMENT ON COLUMN civic.inference_stances.evidence_span IS
    'Fragmento textual que justifica la postura. Sin esto la atribución no es auditable.';

-- =============================================================================
-- 4. TEMAS DETECTADOS (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inference_topics (
    inference_id     UUID            NOT NULL,
    analyzed_at      TIMESTAMPTZ     NOT NULL,
    campaign_id      UUID            NOT NULL,
    published_at     TIMESTAMPTZ     NOT NULL,
    -- Categoría global del catálogo.
    category_code    civic.slug_code NOT NULL,
    -- Tema local de la campaña, si el matcher lo resolvió.
    topic_id         UUID,
    relevance        civic.unit_score NOT NULL,
    -- Sentimiento específico hacia ESE tema, que puede diferir del global.
    topic_sentiment  civic.polarity_score,
    is_primary       BOOLEAN         NOT NULL DEFAULT FALSE,

    PRIMARY KEY (inference_id, analyzed_at, category_code)
) PARTITION BY RANGE (analyzed_at);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_inftop_inference', 'FOREIGN KEY (inference_id, analyzed_at) REFERENCES civic.inferences (id, analyzed_at) ON DELETE CASCADE'),
        ('fk_inftop_category', 'FOREIGN KEY (category_code) REFERENCES civic_cat.topic_categories(code)'),
        ('fk_inftop_topic', 'FOREIGN KEY (topic_id) REFERENCES civic.topics(id) ON DELETE SET NULL')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inference_topics'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inference_topics ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS ix_inftop_campaign_cat
    ON civic.inference_topics (campaign_id, category_code, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_inftop_primary
    ON civic.inference_topics (campaign_id, published_at DESC) WHERE is_primary;
CREATE INDEX IF NOT EXISTS ix_inftop_topic
    ON civic.inference_topics (topic_id, published_at DESC) WHERE topic_id IS NOT NULL;

-- =============================================================================
-- 5. ENTIDADES RECONOCIDAS (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inference_entities (
    id               UUID            NOT NULL DEFAULT gen_random_uuid(),
    inference_id     UUID            NOT NULL,
    analyzed_at      TIMESTAMPTZ     NOT NULL,
    campaign_id      UUID            NOT NULL,
    published_at     TIMESTAMPTZ     NOT NULL,

    entity_type_code VARCHAR(24)     NOT NULL,
    -- Texto tal como aparece en el contenido.
    entity_text      TEXT            NOT NULL,
    -- Forma canónica para agrupar variantes ("AMLO", "Lopez Obrador" → una sola).
    entity_norm      TEXT            NOT NULL,
    -- Vínculo resuelto con un contendiente registrado, si aplica.
    contender_id     UUID,
    -- Sentimiento dirigido a esta entidad concreta.
    entity_sentiment civic.polarity_score,
    confidence       civic.unit_score,
    mention_count    SMALLINT        NOT NULL DEFAULT 1 CHECK (mention_count > 0),
    start_char       INTEGER         CHECK (start_char >= 0),
    end_char         INTEGER         CHECK (end_char   >= 0),

    PRIMARY KEY (id, analyzed_at),
    CONSTRAINT ck_ent_span CHECK (end_char IS NULL OR start_char IS NULL OR end_char >= start_char)
) PARTITION BY RANGE (analyzed_at);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_infent_inference', 'FOREIGN KEY (inference_id, analyzed_at) REFERENCES civic.inferences (id, analyzed_at) ON DELETE CASCADE'),
        ('fk_infent_type', 'FOREIGN KEY (entity_type_code) REFERENCES civic_cat.entity_types(code)'),
        ('fk_infent_contender', 'FOREIGN KEY (contender_id) REFERENCES civic.contenders(id) ON DELETE SET NULL')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inference_entities'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inference_entities ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS ix_infent_campaign_norm
    ON civic.inference_entities (campaign_id, entity_norm, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_infent_type
    ON civic.inference_entities (campaign_id, entity_type_code, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_infent_inference
    ON civic.inference_entities (inference_id);
DO $$
BEGIN
    IF civic_ops.has_ext('pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS ix_infent_text_trgm
            ON civic.inference_entities USING GIN (entity_norm gin_trgm_ops);
    END IF;
END
$$;

COMMENT ON COLUMN civic.inference_entities.entity_norm IS
    'Forma canónica en minúsculas sin acentos. Es la clave de agrupación de los rankings de entidades.';

-- =============================================================================
-- 6. BANDERAS DE RIESGO (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inference_risk_flags (
    inference_id   UUID            NOT NULL,
    analyzed_at    TIMESTAMPTZ     NOT NULL,
    campaign_id    UUID            NOT NULL,
    published_at   TIMESTAMPTZ     NOT NULL,
    flag_code      civic.slug_code NOT NULL,
    score          civic.unit_score NOT NULL,
    -- Objetivo del contenido riesgoso, si se identificó.
    target_contender_id UUID,
    -- Estado de la revisión humana obligatoria para banderas graves.
    review_state   TEXT            NOT NULL DEFAULT 'pending'
                   CHECK (review_state IN ('pending','confirmed','dismissed','escalated')),
    reviewed_by    TEXT,
    reviewed_at    TIMESTAMPTZ,

    PRIMARY KEY (inference_id, analyzed_at, flag_code)
) PARTITION BY RANGE (analyzed_at);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_infrisk_inference', 'FOREIGN KEY (inference_id, analyzed_at) REFERENCES civic.inferences (id, analyzed_at) ON DELETE CASCADE'),
        ('fk_infrisk_flag', 'FOREIGN KEY (flag_code) REFERENCES civic_cat.risk_flags(code)'),
        ('fk_infrisk_target', 'FOREIGN KEY (target_contender_id) REFERENCES civic.contenders(id) ON DELETE SET NULL')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inference_risk_flags'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inference_risk_flags ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS ix_infrisk_campaign
    ON civic.inference_risk_flags (campaign_id, flag_code, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_infrisk_pending
    ON civic.inference_risk_flags (campaign_id, analyzed_at DESC) WHERE review_state = 'pending';

COMMENT ON TABLE civic.inference_risk_flags IS
    'Banderas de riesgo por inferencia. Finalidad: proteger al equipo y priorizar respuesta. '
    'No debe usarse para identificar ni tomar acciones contra autores individuales.';

-- =============================================================================
-- 7. PALABRAS CLAVE (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.inference_keywords (
    inference_id  UUID        NOT NULL,
    analyzed_at   TIMESTAMPTZ NOT NULL,
    campaign_id   UUID        NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL,
    keyword       TEXT        NOT NULL,
    weight        civic.unit_score NOT NULL DEFAULT 1.0,

    PRIMARY KEY (inference_id, analyzed_at, keyword)
) PARTITION BY RANGE (analyzed_at);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_infkw_inference', 'FOREIGN KEY (inference_id, analyzed_at) REFERENCES civic.inferences (id, analyzed_at) ON DELETE CASCADE')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'inference_keywords'
        ) THEN
            EXECUTE format('ALTER TABLE civic.inference_keywords ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS ix_infkw_campaign
    ON civic.inference_keywords (campaign_id, keyword, published_at DESC);

-- =============================================================================
-- 8. TRIGGER: coherencia entre etiqueta y puntaje de sentimiento
--    Un score de +0.8 etiquetado como 'negative' indica un fallo de mapeo en el
--    pipeline. Vale más fallar en la escritura que contaminar meses de KPIs.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.validate_sentiment_coherence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_polarity SMALLINT;
BEGIN
    SELECT polarity INTO v_polarity
      FROM civic_cat.sentiment_types WHERE code = NEW.sentiment_code;

    IF v_polarity = 1 AND NEW.sentiment_score < -0.15 THEN
        RAISE EXCEPTION
            'Incoherencia: etiqueta "positive" con score %. Revise el mapeo de etiquetas del modelo %.',
            NEW.sentiment_score, NEW.model_name_snapshot
            USING ERRCODE = '23514';
    ELSIF v_polarity = -1 AND NEW.sentiment_score > 0.15 THEN
        RAISE EXCEPTION
            'Incoherencia: etiqueta "negative" con score %. Revise el mapeo de etiquetas del modelo %.',
            NEW.sentiment_score, NEW.model_name_snapshot
            USING ERRCODE = '23514';
    END IF;

    -- Marcado automático para revisión humana.
    IF NEW.overall_confidence < 0.55
       OR COALESCE(NEW.sarcasm_score, 0) > 0.60 THEN
        NEW.needs_review := TRUE;
        IF NEW.review_status = 'not_required' THEN
            NEW.review_status := 'pending';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_inf_sentiment_coherence ON civic.inferences;
CREATE TRIGGER tg_inf_sentiment_coherence
    BEFORE INSERT OR UPDATE OF sentiment_code, sentiment_score, overall_confidence, sarcasm_score
    ON civic.inferences
    FOR EACH ROW EXECUTE FUNCTION civic.validate_sentiment_coherence();

-- =============================================================================
-- 9. TRIGGER: marcar el contenido como analizado
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.mark_content_analyzed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE civic.contents
       SET processing_status = 'analyzed'
     WHERE id = NEW.content_id
       AND published_at = NEW.published_at
       AND processing_status <> 'analyzed';
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tg_inf_mark_content ON civic.inferences;
CREATE TRIGGER tg_inf_mark_content
    AFTER INSERT ON civic.inferences
    FOR EACH ROW EXECUTE FUNCTION civic.mark_content_analyzed();

-- =============================================================================
-- 10. REGISTRO Y CREACIÓN DE PARTICIONES
-- =============================================================================
INSERT INTO civic_ops.partitioned_tables (schema_name, table_name, partition_column, retention_months, premake_months)
VALUES
    ('civic', 'inferences',          'analyzed_at', 36, 3),
    ('civic', 'inference_emotions',  'analyzed_at', 36, 3),
    ('civic', 'inference_stances',   'analyzed_at', 36, 3),
    ('civic', 'inference_topics',    'analyzed_at', 36, 3),
    ('civic', 'inference_entities',  'analyzed_at', 36, 3),
    ('civic', 'inference_risk_flags','analyzed_at', 60, 3),   -- retención mayor: valor probatorio
    ('civic', 'inference_keywords',  'analyzed_at', 24, 3)
ON CONFLICT (schema_name, table_name) DO UPDATE
   SET retention_months = EXCLUDED.retention_months;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'inferences','inference_emotions','inference_stances','inference_topics',
        'inference_entities','inference_risk_flags','inference_keywords'
    ]
    LOOP
        PERFORM civic_ops.bootstrap_partitions('civic', t, 24, 12, TRUE);
    END LOOP;
END
$$;

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_n INTEGER;
BEGIN
    SELECT count(*) INTO v_n
    FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'civic' AND c.relkind = 'r' AND c.relname LIKE 'inference%_p%';
    RAISE NOTICE '── Capa de inferencias creada: % particiones ──', v_n;
END
$$;
