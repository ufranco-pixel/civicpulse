-- =============================================================================
-- Análisis de Sentimientos · 03_content.sql
-- Contenidos crudos (comentarios, publicaciones, notas) sobre campañas.
--
-- Tabla particionada por RANGE mensual sobre published_at. Es la tabla que
-- crece sin límite: en un monitoreo electoral serio son decenas de millones de
-- filas por ciclo. Particionar permite podar por retención con DROP TABLE en
-- lugar de DELETE masivo, y limita el tamaño de cada índice.
--
-- Minimización de datos: el autor se almacena seudonimizado por defecto. El
-- identificador crudo sólo se conserva si la organización declara
-- pii_policy = 'store_with_consent'.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_ops, public;

-- =============================================================================
-- 1. LOTES DE INGESTA
--    Agrupan lo recolectado en una corrida. Permiten reprocesar o revertir una
--    ingesta defectuosa sin tocar el resto.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.ingestion_batches (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID        NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id       UUID        NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    source_id         UUID        NOT NULL REFERENCES civic.sources(id)       ON DELETE CASCADE,

    status_code       civic.slug_code NOT NULL DEFAULT 'queued'
                      REFERENCES civic_cat.job_statuses(code),
    -- Ventana temporal cubierta por el lote.
    window_start      TIMESTAMPTZ,
    window_end        TIMESTAMPTZ,
    -- Marca de agua para ingesta incremental.
    watermark         TEXT,

    fetched_count     INTEGER     NOT NULL DEFAULT 0 CHECK (fetched_count   >= 0),
    inserted_count    INTEGER     NOT NULL DEFAULT 0 CHECK (inserted_count  >= 0),
    duplicate_count   INTEGER     NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    rejected_count    INTEGER     NOT NULL DEFAULT 0 CHECK (rejected_count  >= 0),

    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    error_message     TEXT,
    stats             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_batch_window CHECK (window_end IS NULL OR window_start IS NULL OR window_end >= window_start)
);

CREATE INDEX IF NOT EXISTS ix_batches_source_created ON civic.ingestion_batches (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_batches_open           ON civic.ingestion_batches (campaign_id)
    WHERE status_code IN ('queued','running');

-- =============================================================================
-- 2. CONTENIDOS (particionada)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.contents (
    id                  UUID            NOT NULL DEFAULT gen_random_uuid(),
    -- Clave de partición. Momento de publicación en origen, no de recolección:
    -- es el eje temporal con el que se lee cualquier tablero de campaña.
    published_at        TIMESTAMPTZ     NOT NULL,

    organization_id     UUID            NOT NULL,
    campaign_id         UUID            NOT NULL,
    source_id           UUID            NOT NULL,
    batch_id            UUID,
    content_type_code   civic.slug_code NOT NULL,

    -- ── Identidad en la plataforma de origen ────────────────────────────────
    external_id         TEXT,
    parent_external_id  TEXT,           -- comentario padre / post comentado
    thread_external_id  TEXT,           -- hilo o conversación
    url                 TEXT,

    -- ── Texto ───────────────────────────────────────────────────────────────
    -- body es el texto que la plataforma expone y analiza. Según pii_policy de
    -- la organización puede venir ya redactado por civic_ops.redact_pii().
    body                TEXT            NOT NULL,
    -- Título de nota o asunto, cuando aplica.
    title               TEXT,
    body_length         INTEGER         GENERATED ALWAYS AS (length(body)) STORED,
    language_code       civic.lang_code NOT NULL DEFAULT 'und',
    language_confidence civic.unit_score,
    -- Huella del texto normalizado: base de la deduplicación y de la detección
    -- de mensajes replicados en bloque (indicio de coordinación).
    fingerprint         BYTEA           NOT NULL,

    -- ── Autor (seudonimizado) ───────────────────────────────────────────────
    author_hash         BYTEA,          -- civic_ops.pseudonymize_author(...)
    author_display      TEXT,           -- sólo con pii_policy = store_with_consent
    author_followers    INTEGER         CHECK (author_followers >= 0),
    author_verified     BOOLEAN,
    author_account_age_days INTEGER     CHECK (author_account_age_days >= 0),
    -- Probabilidad de automatización. Se usa para ponderar, no para censurar.
    author_bot_score    civic.unit_score,

    -- ── Geografía ───────────────────────────────────────────────────────────
    geo_area_id         UUID,
    geo_confidence      civic.unit_score,
    geo_method          TEXT            CHECK (geo_method IN
                        ('declared','gps','profile','text_inference','ip','manual','unknown')),

    -- ── Difusión ────────────────────────────────────────────────────────────
    likes_count         INTEGER         CHECK (likes_count    >= 0),
    shares_count        INTEGER         CHECK (shares_count   >= 0),
    replies_count       INTEGER         CHECK (replies_count  >= 0),
    views_count         BIGINT          CHECK (views_count    >= 0),
    reactions           JSONB           NOT NULL DEFAULT '{}'::jsonb,
    -- Alcance estimado por la fuente. Es una estimación, no una medición.
    reach_estimate      BIGINT          CHECK (reach_estimate >= 0),
    -- Peso de amplificación: cuánto pondera este contenido en los agregados.
    -- Evita que una cuenta con millones de seguidores y una con diez cuenten igual.
    amplification_weight NUMERIC(8,4)   NOT NULL DEFAULT 1.0
                        CHECK (amplification_weight >= 0 AND amplification_weight <= 1000),

    -- ── Estado de procesamiento ─────────────────────────────────────────────
    processing_status   TEXT            NOT NULL DEFAULT 'pending'
                        CHECK (processing_status IN ('pending','processing','analyzed','skipped','failed')),
    is_duplicate        BOOLEAN         NOT NULL DEFAULT FALSE,
    duplicate_of        UUID,
    -- Contenido excluido del análisis por decisión humana (spam, fuera de alcance).
    is_excluded         BOOLEAN         NOT NULL DEFAULT FALSE,
    exclusion_reason    TEXT,

    -- ── Cumplimiento ────────────────────────────────────────────────────────
    is_pii_redacted     BOOLEAN         NOT NULL DEFAULT FALSE,
    -- Fecha a partir de la cual el registro debe purgarse. La calcula un trigger
    -- con data_retention_days de la organización.
    purge_after         DATE,

    segment_ids         UUID[]          NOT NULL DEFAULT ARRAY[]::UUID[],
    has_media           BOOLEAN         NOT NULL DEFAULT FALSE,
    media               JSONB           NOT NULL DEFAULT '[]'::jsonb,
    -- Carga original de la API de origen, para reprocesos. Se puede purgar antes
    -- que el resto del registro.
    raw                 JSONB,

    collected_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    -- La clave primaria debe incluir la columna de partición.
    PRIMARY KEY (id, published_at),

    CONSTRAINT ck_contents_body_not_blank CHECK (btrim(body) <> ''),
    CONSTRAINT ck_contents_dup            CHECK (NOT is_duplicate OR duplicate_of IS NOT NULL),
    CONSTRAINT ck_contents_excluded       CHECK (NOT is_excluded  OR exclusion_reason IS NOT NULL)
) PARTITION BY RANGE (published_at);

COMMENT ON TABLE  civic.contents IS
    'Contenidos públicos recolectados. Particionada mensualmente por published_at.';
COMMENT ON COLUMN civic.contents.amplification_weight IS
    'Ponderador de alcance. Los KPIs ofrecen versión cruda (1 contenido = 1 voto) y ponderada. '
    'Nunca mezclar ambas en la misma gráfica: miden cosas distintas.';
COMMENT ON COLUMN civic.contents.author_hash IS
    'SHA-256 con pepper del identificador de autor. Permite contar autores únicos y detectar '
    'coordinación sin conservar identidades.';
COMMENT ON COLUMN civic.contents.raw IS
    'Payload original. Sujeto a purga temprana: contiene campos que la plataforma no necesita.';

-- Claves foráneas. Se declaran a nivel de tabla particionada (PG 12+).
--
-- ALTER TABLE ... ADD CONSTRAINT no admite IF NOT EXISTS, así que se envuelve
-- en un bucle que consulta pg_constraint. Sin esto, reejecutar install.sql
-- sobre una base ya instalada aborta aquí.
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('fk_contents_org',      'FOREIGN KEY (organization_id)   REFERENCES civic.organizations(id) ON DELETE CASCADE'),
        ('fk_contents_campaign', 'FOREIGN KEY (campaign_id)       REFERENCES civic.campaigns(id)     ON DELETE CASCADE'),
        ('fk_contents_source',   'FOREIGN KEY (source_id)         REFERENCES civic.sources(id)       ON DELETE CASCADE'),
        ('fk_contents_batch',    'FOREIGN KEY (batch_id)          REFERENCES civic.ingestion_batches(id) ON DELETE SET NULL'),
        ('fk_contents_ctype',    'FOREIGN KEY (content_type_code) REFERENCES civic_cat.content_types(code)'),
        ('fk_contents_lang',     'FOREIGN KEY (language_code)     REFERENCES civic_cat.languages(code)'),
        ('fk_contents_geo',      'FOREIGN KEY (geo_area_id)       REFERENCES civic.geo_areas(id)     ON DELETE SET NULL')
    ) AS t(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint pc
            JOIN pg_class cl ON cl.oid = pc.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE pc.conname = c.name AND n.nspname = 'civic' AND cl.relname = 'contents'
        ) THEN
            EXECUTE format('ALTER TABLE civic.contents ADD CONSTRAINT %I %s', c.name, c.definition);
        END IF;
    END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 2.1 Índices
--     Todos incluyen published_at o son locales a cada partición: el planner
--     hace partition pruning primero y luego usa el índice local.
-- -----------------------------------------------------------------------------

-- Deduplicación dura: mismo id externo en la misma fuente.
CREATE UNIQUE INDEX IF NOT EXISTS ux_contents_source_external
    ON civic.contents (source_id, external_id, published_at)
    WHERE external_id IS NOT NULL;

-- Acceso principal del tablero: campaña + tiempo.
CREATE INDEX IF NOT EXISTS ix_contents_campaign_time
    ON civic.contents (campaign_id, published_at DESC)
    WHERE NOT is_duplicate AND NOT is_excluded;

-- Cola de procesamiento NLP.
CREATE INDEX IF NOT EXISTS ix_contents_pending
    ON civic.contents (campaign_id, published_at)
    WHERE processing_status = 'pending' AND NOT is_duplicate AND NOT is_excluded;

CREATE INDEX IF NOT EXISTS ix_contents_source_time  ON civic.contents (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_contents_fingerprint  ON civic.contents (campaign_id, fingerprint);
CREATE INDEX IF NOT EXISTS ix_contents_author       ON civic.contents (campaign_id, author_hash, published_at DESC)
    WHERE author_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_contents_geo          ON civic.contents (geo_area_id, published_at DESC)
    WHERE geo_area_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_contents_purge        ON civic.contents (purge_after)
    WHERE purge_after IS NOT NULL;

-- Búsqueda de texto completo. Se indexa con la configuración 'simple' para no
-- atarse a un diccionario por idioma: la campaña puede recibir varios a la vez.
CREATE INDEX IF NOT EXISTS ix_contents_body_fts
    ON civic.contents USING GIN (to_tsvector('simple', body));

-- Búsqueda difusa del buscador libre del tablero: requiere pg_trgm.
DO $$
BEGIN
    IF civic_ops.has_ext('pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS ix_contents_body_trgm
            ON civic.contents USING GIN (body gin_trgm_ops);
    ELSE
        RAISE NOTICE 'pg_trgm ausente: el buscador libre usará full-text en lugar de coincidencia difusa.';
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_contents_segments     ON civic.contents USING GIN (segment_ids);

-- -----------------------------------------------------------------------------
-- 2.2 Triggers
-- -----------------------------------------------------------------------------

-- Calcula fingerprint, aplica política de PII y fija la fecha de purga.
CREATE OR REPLACE FUNCTION civic.contents_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_policy    TEXT;
    v_retention INTEGER;
BEGIN
    SELECT pii_policy, data_retention_days
      INTO v_policy, v_retention
      FROM civic.organizations
     WHERE id = NEW.organization_id;

    IF v_policy IS NULL THEN
        RAISE EXCEPTION 'Organización % inexistente.', NEW.organization_id USING ERRCODE = '23503';
    END IF;

    -- Redacción de PII en el cuerpo cuando la política lo exige.
    IF v_policy = 'redact' AND NOT NEW.is_pii_redacted THEN
        NEW.body            := civic_ops.redact_pii(NEW.body);
        NEW.title           := civic_ops.redact_pii(NEW.title);
        NEW.is_pii_redacted := TRUE;
    END IF;

    -- Nombre visible del autor sólo con base legal explícita.
    IF v_policy <> 'store_with_consent' THEN
        NEW.author_display := NULL;
    END IF;

    -- Huella siempre derivada del texto final.
    NEW.fingerprint := civic_ops.content_fingerprint(NEW.body);

    -- Fecha de purga según la retención de la organización.
    IF NEW.purge_after IS NULL THEN
        NEW.purge_after := (NEW.published_at + (v_retention || ' days')::interval)::date;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_contents_before_write ON civic.contents;
CREATE TRIGGER tg_contents_before_write
    BEFORE INSERT OR UPDATE OF body, title, organization_id ON civic.contents
    FOR EACH ROW EXECUTE FUNCTION civic.contents_before_write();

DROP TRIGGER IF EXISTS tg_contents_updated_at ON civic.contents;
CREATE TRIGGER tg_contents_updated_at
    BEFORE UPDATE ON civic.contents
    FOR EACH ROW EXECUTE FUNCTION civic_ops.set_updated_at();

-- =============================================================================
-- 3. ANOTACIONES HUMANAS
--    Correcciones manuales de analistas. Cumplen dos funciones: corregir el
--    tablero y alimentar el conjunto de evaluación (07_evaluation.sql).
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.content_annotations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID        NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id       UUID        NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    content_id        UUID        NOT NULL,
    content_published_at TIMESTAMPTZ NOT NULL,

    annotator_sub     TEXT        NOT NULL,
    -- Etiquetas de referencia asignadas por la persona.
    sentiment_code    civic.slug_code REFERENCES civic_cat.sentiment_types(code),
    stance_code       civic.slug_code REFERENCES civic_cat.stance_types(code),
    stance_target_id  UUID        REFERENCES civic.contenders(id) ON DELETE CASCADE,
    intent_code       civic.slug_code REFERENCES civic_cat.intent_types(code),
    emotion_codes     civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    topic_codes       civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    risk_flag_codes   civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],

    -- Confianza del propio anotador. Los casos de baja confianza son los que
    -- conviene enviar a doble anotación.
    annotator_confidence civic.unit_score,
    is_gold           BOOLEAN     NOT NULL DEFAULT FALSE,
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- FK compuesta hacia la tabla particionada.
    CONSTRAINT fk_annotation_content
        FOREIGN KEY (content_id, content_published_at)
        REFERENCES civic.contents (id, published_at) ON DELETE CASCADE,

    -- Un anotador, una anotación por contenido y objetivo de postura.
    UNIQUE (content_id, annotator_sub, stance_target_id)
);

COMMENT ON TABLE  civic.content_annotations IS
    'Etiquetado humano. Corrige el dato mostrado y constituye la verdad de referencia para evaluar el clasificador.';
COMMENT ON COLUMN civic.content_annotations.is_gold IS
    'Marca la anotación como parte del conjunto dorado: revisada y consensuada, apta para medir el modelo.';

CREATE INDEX IF NOT EXISTS ix_annotations_campaign ON civic.content_annotations (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_annotations_gold     ON civic.content_annotations (campaign_id) WHERE is_gold;
CREATE INDEX IF NOT EXISTS ix_annotations_content  ON civic.content_annotations (content_id);

DROP TRIGGER IF EXISTS tg_annotations_updated_at ON civic.content_annotations;
CREATE TRIGGER tg_annotations_updated_at
    BEFORE UPDATE ON civic.content_annotations
    FOR EACH ROW EXECUTE FUNCTION civic_ops.set_updated_at();

-- =============================================================================
-- 4. REGISTRO DE PARTICIONES Y CREACIÓN INICIAL
-- =============================================================================
INSERT INTO civic_ops.partitioned_tables (schema_name, table_name, partition_column, retention_months, premake_months)
VALUES ('civic', 'contents', 'published_at', 36, 3)
ON CONFLICT (schema_name, table_name) DO UPDATE
   SET retention_months = EXCLUDED.retention_months,
       premake_months   = EXCLUDED.premake_months;

-- Particiones de 24 meses atrás a 12 adelante, más la partición por defecto.
--
-- La partición DEFAULT evita que un INSERT con fecha inesperada falle, pero
-- debe permanecer vacía: si acumula filas, PostgreSQL no podrá crear después
-- las particiones que cubran ese rango. La vista de control está más abajo.
SELECT civic_ops.bootstrap_partitions('civic', 'contents', 24, 12, TRUE);

-- Control de salud de la partición por defecto.
CREATE OR REPLACE VIEW civic_ops.v_default_partition_health AS
SELECT 'civic.contents_pdefault' AS partition_name,
       count(*)                  AS orphan_rows,
       min(published_at)         AS min_ts,
       max(published_at)         AS max_ts
FROM   civic.contents_pdefault;

COMMENT ON VIEW civic_ops.v_default_partition_health IS
    'orphan_rows debe ser 0. Si crece, faltan particiones para ese rango de fechas.';

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_parts INTEGER;
BEGIN
    SELECT count(*) INTO v_parts
    FROM   pg_inherits h JOIN pg_class p ON p.oid = h.inhparent
    JOIN   pg_namespace n ON n.oid = p.relnamespace
    WHERE  n.nspname = 'civic' AND p.relname = 'contents';
    RAISE NOTICE '── civic.contents creada con % particiones ──', v_parts;
END
$$;
