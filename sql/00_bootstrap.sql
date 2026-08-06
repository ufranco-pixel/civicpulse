-- =============================================================================
-- Análisis de Sentimientos · 00_bootstrap.sql
-- Extensiones, esquemas, roles de base de datos y utilidades transversales.
--
-- Requisito mínimo: PostgreSQL 14+ SIN NINGUNA EXTENSIÓN.
--   gen_random_uuid() y sha256() son nativos desde PG 13 y PG 11.
--   Las extensiones opcionales (pg_trgm, unaccent, citext, pg_cron) mejoran la
--   búsqueda difusa y el refresco automático, pero su ausencia no bloquea nada:
--   el instalador detecta qué hay y activa la ruta correspondiente.
--
-- Idempotente: se puede ejecutar múltiples veces sin efectos secundarios.
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- 0. VERIFICACIÓN DE VERSIÓN
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF current_setting('server_version_num')::int < 140000 THEN
        RAISE EXCEPTION 'Análisis de Sentimientos requiere PostgreSQL 14 o superior. Versión actual: %',
            current_setting('server_version');
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 1. ESQUEMAS
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS civic;      -- modelo de dominio
CREATE SCHEMA IF NOT EXISTS civic_cat;  -- catálogos de referencia
CREATE SCHEMA IF NOT EXISTS civic_kpi;  -- vistas materializadas e indicadores
CREATE SCHEMA IF NOT EXISTS civic_api;  -- vistas de compatibilidad expuestas a la API
CREATE SCHEMA IF NOT EXISTS civic_ops;  -- auditoría, particiones, mantenimiento

COMMENT ON SCHEMA civic     IS 'Modelo de dominio: campañas, contendientes, contenidos, inferencias.';
COMMENT ON SCHEMA civic_cat IS 'Catálogos de referencia estables (sentimientos, emociones, fuentes, etc.).';
COMMENT ON SCHEMA civic_kpi IS 'Vistas materializadas y funciones de indicadores.';
COMMENT ON SCHEMA civic_api IS 'Contrato estable hacia la capa de aplicación. La API sólo lee de aquí.';
COMMENT ON SCHEMA civic_ops IS 'Auditoría, gestión de particiones y tareas de mantenimiento.';

SET search_path = civic, civic_cat, civic_kpi, civic_api, civic_ops, public;

-- -----------------------------------------------------------------------------
-- 2. DETECCIÓN DE EXTENSIONES OPCIONALES
--    Se intenta instalar cada una; si el paquete no está en el servidor, se
--    registra como no disponible y el resto del esquema se adapta.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS civic_ops.feature_flags (
    feature      TEXT PRIMARY KEY,
    is_available BOOLEAN     NOT NULL,
    detail       TEXT,
    checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE civic_ops.feature_flags IS
    'Capacidades detectadas en el servidor. El resto de scripts consulta esta tabla antes de crear objetos opcionales.';

DO $$
DECLARE
    ext  TEXT;
    exts TEXT[] := ARRAY['pgcrypto','pg_trgm','unaccent','citext','btree_gin','btree_gist','pg_cron'];
BEGIN
    FOREACH ext IN ARRAY exts LOOP
        BEGIN
            EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I', ext);
            INSERT INTO civic_ops.feature_flags (feature, is_available, detail)
            VALUES ('ext:' || ext, TRUE, 'instalada')
            ON CONFLICT (feature) DO UPDATE
               SET is_available = TRUE, detail = 'instalada', checked_at = NOW();
        EXCEPTION WHEN OTHERS THEN
            INSERT INTO civic_ops.feature_flags (feature, is_available, detail)
            VALUES ('ext:' || ext, FALSE, SQLERRM)
            ON CONFLICT (feature) DO UPDATE
               SET is_available = FALSE, detail = EXCLUDED.detail, checked_at = NOW();
            RAISE NOTICE 'Extensión % no disponible; se usará la ruta alterna.', ext;
        END;
    END LOOP;
END
$$;

-- Helper consultable desde cualquier script.
CREATE OR REPLACE FUNCTION civic_ops.has_ext(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = p_name);
$$;

-- -----------------------------------------------------------------------------
-- 3. ROLES DE APLICACIÓN
--    civicpulse_owner   → dueño del esquema (migraciones)
--    civicpulse_app     → microservicios (lectura + escritura acotada)
--    civicpulse_ingest  → workers de ingesta
--    civicpulse_reader  → BI y analistas (sólo lectura)
--
--    Sin contraseña ni LOGIN a propósito. Al desplegar:
--      ALTER ROLE civicpulse_app WITH LOGIN PASSWORD '...';
-- -----------------------------------------------------------------------------
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['civicpulse_owner','civicpulse_app','civicpulse_reader','civicpulse_ingest'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            BEGIN
                EXECUTE format('CREATE ROLE %I NOLOGIN', r);
                RAISE NOTICE 'Rol % creado (NOLOGIN: asignar password al desplegar).', r;
            EXCEPTION WHEN insufficient_privilege THEN
                RAISE NOTICE 'Sin privilegio para crear el rol %. Créelo manualmente.', r;
            END;
        END IF;
    END LOOP;
END
$$;

DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['civicpulse_app','civicpulse_reader','civicpulse_ingest'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('GRANT USAGE ON SCHEMA civic, civic_cat, civic_kpi, civic_api, civic_ops TO %I', r);
        END IF;
    END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. DOMINIOS (tipos con validación reutilizable)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    -- Polaridad continua en [-1, 1]: sentimiento y postura.
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.typname = 'polarity_score' AND n.nspname = 'civic') THEN
        CREATE DOMAIN civic.polarity_score AS NUMERIC(6,5)
            CHECK (VALUE >= -1 AND VALUE <= 1);
    END IF;

    -- Probabilidad o intensidad en [0, 1].
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.typname = 'unit_score' AND n.nspname = 'civic') THEN
        CREATE DOMAIN civic.unit_score AS NUMERIC(6,5)
            CHECK (VALUE >= 0 AND VALUE <= 1);
    END IF;

    -- Slug: minúsculas, dígitos, guion y guion bajo.
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.typname = 'slug_code' AND n.nspname = 'civic') THEN
        CREATE DOMAIN civic.slug_code AS VARCHAR(80)
            CHECK (VALUE ~ '^[a-z0-9][a-z0-9_-]{1,79}$');
    END IF;

    -- Código público en mayúsculas (campañas).
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.typname = 'public_code' AND n.nspname = 'civic') THEN
        CREATE DOMAIN civic.public_code AS VARCHAR(40)
            CHECK (VALUE ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$');
    END IF;

    -- ISO 639-1 con tolerancia a variantes regionales (pt-BR).
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.typname = 'lang_code' AND n.nspname = 'civic') THEN
        CREATE DOMAIN civic.lang_code AS VARCHAR(8)
            CHECK (VALUE ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,5})?$');
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. FUNCIONES UTILITARIAS
-- -----------------------------------------------------------------------------

-- 5.1 Trigger genérico para updated_at.
CREATE OR REPLACE FUNCTION civic_ops.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- 5.2 Eliminación de diacríticos.
--     Con unaccent instalado se usa el diccionario; si no, un translate() que
--     cubre el repertorio latino. La versión translate() es IMMUTABLE de verdad,
--     lo que permite indexarla — unaccent() sólo lo es con la firma de 2 args.
CREATE OR REPLACE FUNCTION civic_ops.deaccent(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT translate(
        COALESCE(p_text, ''),
        'áàâãäåÁÀÂÃÄÅéèêëÉÈÊËíìîïÍÌÎÏóòôõöÓÒÔÕÖúùûüÚÙÛÜñÑçÇýÿÝ',
        'aaaaaaAAAAAAeeeeEEEEiiiiIIIIooooo OOOOOuuuuUUUUnNcCyyY'
    );
$$;

COMMENT ON FUNCTION civic_ops.deaccent IS
    'Quita diacríticos con translate(). IMMUTABLE real: apta para índices funcionales, a diferencia de unaccent(text).';

-- 5.3 Normalización de texto para deduplicación y comparación.
CREATE OR REPLACE FUNCTION civic_ops.normalize_text(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT NULLIF(
        btrim(
            regexp_replace(
                regexp_replace(
                    regexp_replace(
                        lower(civic_ops.deaccent(COALESCE(p_text, ''))),
                        'https?://\S+', ' ', 'g'            -- URLs
                    ),
                    '[@#][[:alnum:]_]+', ' ', 'g'            -- menciones y hashtags
                ),
                '\s+', ' ', 'g'                              -- espacios múltiples
            )
        ),
        ''
    );
$$;

COMMENT ON FUNCTION civic_ops.normalize_text IS
    'Minúsculas, sin acentos, sin URLs ni handles, espacios colapsados. Base de la deduplicación.';

-- 5.4 Huella de contenido. sha256() es nativa desde PG 11: sin dependencia de pgcrypto.
CREATE OR REPLACE FUNCTION civic_ops.content_fingerprint(p_text TEXT)
RETURNS BYTEA
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT sha256(convert_to(COALESCE(civic_ops.normalize_text(p_text), ''), 'UTF8'));
$$;

COMMENT ON FUNCTION civic_ops.content_fingerprint IS
    'SHA-256 del texto normalizado. Detecta duplicados exactos y mensajes replicados en bloque.';

-- 5.5 Seudonimización de autores.
--     El pepper vive en la configuración del servidor, nunca en el código:
--       ALTER DATABASE oeste-sentimientos SET civicpulse.author_pepper = '<secreto>';
CREATE OR REPLACE FUNCTION civic_ops.pseudonymize_author(p_external_id TEXT)
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
    v_pepper TEXT;
BEGIN
    IF p_external_id IS NULL OR btrim(p_external_id) = '' THEN
        RETURN NULL;
    END IF;

    v_pepper := COALESCE(current_setting('civicpulse.author_pepper', true), '');

    IF v_pepper = '' THEN
        RAISE WARNING 'civicpulse.author_pepper sin configurar: los hashes de autor son vulnerables a fuerza bruta.';
    END IF;

    RETURN sha256(convert_to(v_pepper || ':' || btrim(p_external_id), 'UTF8'));
END;
$$;

COMMENT ON FUNCTION civic_ops.pseudonymize_author IS
    'Hash con pepper del identificador de autor. Permite contar autores únicos sin conservar identidades.';

-- 5.6 Redacción de datos personales en texto libre.
CREATE OR REPLACE FUNCTION civic_ops.redact_pii(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT CASE WHEN p_text IS NULL THEN NULL ELSE
        regexp_replace(
            regexp_replace(
                regexp_replace(
                    p_text,
                    '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[correo]', 'g'
                ),
                '(\+?\d[\d ().-]{7,}\d)', '[telefono]', 'g'
            ),
            '\m\d{10,20}\M', '[identificador]', 'g'
        )
    END;
$$;

COMMENT ON FUNCTION civic_ops.redact_pii IS
    'Enmascara correos, teléfonos e identificadores numéricos largos. Se aplica según organizations.pii_policy.';

-- 5.7 Truncado de periodo con granularidad validada.
--     Evita construir date_trunc con interpolación de cadena en la aplicación.
CREATE OR REPLACE FUNCTION civic_ops.period_trunc(
    p_granularity TEXT,
    p_ts          TIMESTAMPTZ,
    p_tz          TEXT DEFAULT 'UTC'
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
    IF p_granularity NOT IN ('hour','day','week','month','quarter','year') THEN
        RAISE EXCEPTION 'Granularidad inválida: %. Use hour|day|week|month|quarter|year.', p_granularity
            USING ERRCODE = '22023';
    END IF;
    RETURN date_trunc(p_granularity, p_ts AT TIME ZONE p_tz) AT TIME ZONE p_tz;
END;
$$;

-- 5.8 Puntuación z segura (evita división por cero en series planas).
CREATE OR REPLACE FUNCTION civic_ops.safe_zscore(p_value NUMERIC, p_mean NUMERIC, p_stddev NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT CASE
             WHEN p_stddev IS NULL OR p_stddev < 0.0001 THEN 0::numeric
             ELSE round((p_value - p_mean) / p_stddev, 4)
           END;
$$;

COMMENT ON FUNCTION civic_ops.safe_zscore IS
    'z-score con guarda para desviación cero. Una serie constante devuelve 0, no infinito.';

-- 5.9 Intervalo de Wilson para proporciones.
--     Un 100 % de comentarios positivos sobre 3 menciones no es lo mismo que
--     sobre 3 000. Wilson penaliza el volumen bajo y evita conclusiones falsas.
CREATE OR REPLACE FUNCTION civic_ops.wilson_lower_bound(
    p_successes BIGINT,
    p_total     BIGINT,
    p_z         NUMERIC DEFAULT 1.96   -- 95 % de confianza
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
    p     NUMERIC;
    z2    NUMERIC;
    denom NUMERIC;
BEGIN
    IF p_total IS NULL OR p_total = 0 THEN
        RETURN 0;
    END IF;

    p     := p_successes::numeric / p_total::numeric;
    z2    := p_z * p_z;
    denom := 1 + z2 / p_total;

    RETURN round(
        ((p + z2 / (2 * p_total))
         - p_z * sqrt((p * (1 - p) + z2 / (4 * p_total)) / p_total)
        ) / denom
    , 6);
END;
$$;

COMMENT ON FUNCTION civic_ops.wilson_lower_bound IS
    'Cota inferior de Wilson. Se usa en los rankings para que un actor con pocas menciones no encabece la tabla.';

-- 5.10 Similitud de Jaccard entre arreglos de etiquetas.
--      PostgreSQL no trae operadores de unión/intersección para arreglos
--      genéricos (los de intarray sólo aplican a integer[]). Se implementa aquí
--      porque toda métrica multietiqueta —emociones, temas, banderas— la usa.
CREATE OR REPLACE FUNCTION civic_ops.jaccard(p_a TEXT[], p_b TEXT[])
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    WITH a AS (SELECT DISTINCT unnest(COALESCE(p_a, ARRAY[]::TEXT[])) AS v),
         b AS (SELECT DISTINCT unnest(COALESCE(p_b, ARRAY[]::TEXT[])) AS v),
         i AS (SELECT count(*) AS n FROM a JOIN b USING (v)),
         u AS (SELECT count(*) AS n FROM (SELECT v FROM a UNION SELECT v FROM b) x)
    SELECT CASE WHEN u.n = 0 THEN 1.0            -- ambos vacíos: coincidencia total
                ELSE round(i.n::numeric / u.n::numeric, 4) END
    FROM i, u;
$$;

COMMENT ON FUNCTION civic_ops.jaccard IS
    'Intersección sobre unión entre dos conjuntos de etiquetas. Dos conjuntos vacíos devuelven 1: '
    'no predecir ninguna emoción cuando no había ninguna es un acierto, no un fallo.';

-- 5.11 Cardinalidad de la intersección: útil para precisión/exhaustividad multietiqueta.
CREATE OR REPLACE FUNCTION civic_ops.array_intersect_count(p_a TEXT[], p_b TEXT[])
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT count(*)::int
    FROM (SELECT DISTINCT unnest(COALESCE(p_a, ARRAY[]::TEXT[])) AS v) a
    JOIN (SELECT DISTINCT unnest(COALESCE(p_b, ARRAY[]::TEXT[])) AS v) b USING (v);
$$;

-- -----------------------------------------------------------------------------
-- 6. GESTOR DE PARTICIONES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS civic_ops.partitioned_tables (
    schema_name      TEXT        NOT NULL,
    table_name       TEXT        NOT NULL,
    partition_column TEXT        NOT NULL,
    retention_months INTEGER     NOT NULL DEFAULT 36 CHECK (retention_months > 0),
    premake_months   INTEGER     NOT NULL DEFAULT 3  CHECK (premake_months  >= 0),
    is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
    registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (schema_name, table_name)
);

COMMENT ON TABLE civic_ops.partitioned_tables IS
    'Tablas particionadas y su política de retención. Insumo de ensure_partitions().';

CREATE OR REPLACE FUNCTION civic_ops.create_month_partition(
    p_schema TEXT,
    p_table  TEXT,
    p_month  DATE
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_start     DATE := date_trunc('month', p_month)::date;
    v_end       DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
    v_part_name TEXT := format('%s_p%s', p_table, to_char(v_start, 'YYYYMM'));
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = p_schema AND c.relname = v_part_name
    ) THEN
        RETURN v_part_name;
    END IF;

    EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        p_schema, v_part_name, p_schema, p_table, v_start, v_end
    );
    RETURN v_part_name;
END;
$$;

CREATE OR REPLACE FUNCTION civic_ops.ensure_partitions(p_drop_expired BOOLEAN DEFAULT FALSE)
RETURNS TABLE (action TEXT, object_name TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
    t        RECORD;
    i        INTEGER;
    v_name   TEXT;
    v_cutoff DATE;
    v_part   RECORD;
BEGIN
    FOR t IN SELECT * FROM civic_ops.partitioned_tables WHERE is_active LOOP

        FOR i IN 0..t.premake_months LOOP
            v_name := civic_ops.create_month_partition(
                t.schema_name, t.table_name,
                (date_trunc('month', CURRENT_DATE) + (i || ' months')::interval)::date
            );
            action := 'ensured'; object_name := t.schema_name || '.' || v_name;
            RETURN NEXT;
        END LOOP;

        IF p_drop_expired THEN
            v_cutoff := date_trunc('month', CURRENT_DATE - (t.retention_months || ' months')::interval)::date;

            FOR v_part IN
                SELECT c.relname
                FROM   pg_class c
                JOIN   pg_namespace n      ON n.oid = c.relnamespace
                JOIN   pg_inherits  h      ON h.inhrelid = c.oid
                JOIN   pg_class     parent ON parent.oid = h.inhparent
                WHERE  n.nspname = t.schema_name
                  AND  parent.relname = t.table_name
                  AND  c.relname ~ ('^' || t.table_name || '_p[0-9]{6}$')
                  AND  to_date(right(c.relname, 6), 'YYYYMM') < v_cutoff
            LOOP
                EXECUTE format('DROP TABLE IF EXISTS %I.%I', t.schema_name, v_part.relname);
                action := 'dropped'; object_name := t.schema_name || '.' || v_part.relname;
                RETURN NEXT;
            END LOOP;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION civic_ops.ensure_partitions IS
    'Crea particiones mensuales anticipadas y, con p_drop_expired, poda las vencidas. Ejecutar a diario.';

-- Crea el rango completo de particiones de una tabla en una sola llamada.
CREATE OR REPLACE FUNCTION civic_ops.bootstrap_partitions(
    p_schema        TEXT,
    p_table         TEXT,
    p_months_back   INTEGER DEFAULT 24,
    p_months_ahead  INTEGER DEFAULT 12,
    p_with_default  BOOLEAN DEFAULT TRUE
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    i     INTEGER;
    v_cnt INTEGER := 0;
BEGIN
    IF p_with_default AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = p_schema AND c.relname = p_table || '_pdefault'
    ) THEN
        EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I DEFAULT',
                       p_schema, p_table || '_pdefault', p_schema, p_table);
    END IF;

    FOR i IN -p_months_back..p_months_ahead LOOP
        PERFORM civic_ops.create_month_partition(
            p_schema, p_table,
            (date_trunc('month', CURRENT_DATE) + (i || ' months')::interval)::date
        );
        v_cnt := v_cnt + 1;
    END LOOP;

    RETURN v_cnt;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. AUDITORÍA
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS civic_ops.audit_log (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_sub      TEXT,
    actor_username TEXT,
    action         TEXT        NOT NULL,
    schema_name    TEXT,
    table_name     TEXT,
    record_id      TEXT,
    old_data       JSONB,
    new_data       JSONB,
    ip_address     INET,
    user_agent     TEXT,
    context        JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_audit_log_occurred ON civic_ops.audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor    ON civic_ops.audit_log (actor_sub, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_table    ON civic_ops.audit_log (schema_name, table_name, occurred_at DESC);

COMMENT ON TABLE civic_ops.audit_log IS
    'Bitácora de cambios sensibles. El actor se toma del GUC civicpulse.actor_sub que fija la aplicación por transacción.';

CREATE OR REPLACE FUNCTION civic_ops.audit_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic_ops, pg_temp
AS $$
DECLARE
    v_old JSONB;
    v_new JSONB;
    v_id  TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_id  := COALESCE(v_old->>'id', '');
    ELSIF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        v_id  := COALESCE(v_new->>'id', '');
    ELSE
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
        v_id  := COALESCE(v_new->>'id', '');
        -- Ignorar cambios que sólo tocan updated_at: ruido puro.
        IF (v_old - 'updated_at') = (v_new - 'updated_at') THEN
            RETURN NEW;
        END IF;
    END IF;

    INSERT INTO civic_ops.audit_log (
        actor_sub, actor_username, action, schema_name, table_name, record_id, old_data, new_data
    ) VALUES (
        current_setting('civicpulse.actor_sub', true),
        current_setting('civicpulse.actor_username', true),
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, v_id, v_old, v_new
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. RESUMEN
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT;
BEGIN
    SELECT string_agg(replace(feature,'ext:',''), ', ' ORDER BY feature)
      INTO v_missing
      FROM civic_ops.feature_flags WHERE NOT is_available;

    RAISE NOTICE '── Análisis de Sentimientos bootstrap completado ──';
    RAISE NOTICE 'Base de datos     : %', current_database();
    RAISE NOTICE 'PostgreSQL        : %', current_setting('server_version');
    RAISE NOTICE 'Esquemas          : civic, civic_cat, civic_kpi, civic_api, civic_ops';
    IF v_missing IS NOT NULL THEN
        RAISE NOTICE 'Extensiones ausentes: %', v_missing;
        RAISE NOTICE '  → El esquema funciona igual. Con pg_trgm la búsqueda difusa es notablemente mejor.';
    ELSE
        RAISE NOTICE 'Extensiones       : todas disponibles';
    END IF;
END
$$;
