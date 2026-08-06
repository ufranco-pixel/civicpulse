-- =============================================================================
-- Análisis de Sentimientos · 02_core.sql
-- Modelo de dominio: organizaciones, usuarios, campañas, contendientes,
-- geografía, temas y fuentes.
--
-- Multi-tenant por organization_id. Toda tabla de dominio lo arrastra de forma
-- explícita (aunque sea derivable por JOIN) para que RLS filtre con un índice
-- y no con una subconsulta. Es redundancia deliberada.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_ops, public;

-- =============================================================================
-- 1. ORGANIZACIONES (tenant raíz)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.organizations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT            NOT NULL,
    slug                civic.slug_code NOT NULL UNIQUE,
    legal_name          TEXT,
    org_type            TEXT            NOT NULL DEFAULT 'other'
                        CHECK (org_type IN ('party','campaign_team','government','media',
                                            'consultancy','ngo','academic','other')),
    -- Sin país fijo: se declara al alta y sólo sirve para husos horarios y formato.
    country_code        CHAR(2)         CHECK (country_code ~ '^[A-Z]{2}$'),
    timezone            TEXT            NOT NULL DEFAULT 'UTC',
    default_language    civic.lang_code NOT NULL DEFAULT 'es'
                        REFERENCES civic_cat.languages(code),
    plan_type           TEXT            NOT NULL DEFAULT 'standard'
                        CHECK (plan_type IN ('trial','standard','professional','enterprise')),
    status              TEXT            NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','archived')),

    -- Límites del plan. Se validan en la aplicación y en triggers de cuota.
    max_campaigns       INTEGER         NOT NULL DEFAULT 5   CHECK (max_campaigns  > 0),
    max_sources         INTEGER         NOT NULL DEFAULT 25  CHECK (max_sources    > 0),
    max_monthly_contents BIGINT         NOT NULL DEFAULT 1000000,

    -- Gobernanza de datos. No es decorativo: 11_security_rls.sql y las rutinas
    -- de purga leen estos campos.
    data_retention_days INTEGER         NOT NULL DEFAULT 730 CHECK (data_retention_days BETWEEN 30 AND 3650),
    pii_policy          TEXT            NOT NULL DEFAULT 'pseudonymize'
                        CHECK (pii_policy IN ('pseudonymize','redact','store_with_consent')),
    dpo_contact         TEXT,           -- responsable de protección de datos

    settings            JSONB           NOT NULL DEFAULT '{}'::jsonb,
    branding            JSONB           NOT NULL DEFAULT '{}'::jsonb,

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by          TEXT,           -- claim `sub` de Keycloak
    archived_at         TIMESTAMPTZ,

    CONSTRAINT ck_org_archived CHECK (status <> 'archived' OR archived_at IS NOT NULL)
);

COMMENT ON TABLE  civic.organizations IS 'Tenant raíz. Todo dato de dominio pertenece a exactamente una organización.';
COMMENT ON COLUMN civic.organizations.pii_policy IS
    'pseudonymize: hash de autor (default). redact: además enmascara PII en el texto. '
    'store_with_consent: conserva identificadores, sólo válido con base legal documentada.';

CREATE INDEX IF NOT EXISTS ix_org_status ON civic.organizations (status) WHERE status = 'active';

-- =============================================================================
-- 2. USUARIOS Y MEMBRESÍAS
--    La identidad vive en Keycloak. Aquí sólo se refleja lo necesario para
--    autorización por organización y para atribuir acciones.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.app_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_sub  TEXT        NOT NULL UNIQUE,   -- claim `sub`, identidad canónica
    -- TEXT + índice funcional sobre lower() en lugar de CITEXT: evita depender
    -- de una extensión que no todas las instancias gestionadas tienen.
    username      TEXT        NOT NULL,
    email         TEXT,
    display_name  TEXT,
    locale        civic.lang_code NOT NULL DEFAULT 'es',
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE civic.app_users IS
    'Espejo mínimo del usuario de Keycloak. No almacena credenciales ni es fuente de verdad de identidad.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower
    ON civic.app_users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_users_username_lower
    ON civic.app_users (lower(username));

CREATE TABLE IF NOT EXISTS civic.memberships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES civic.app_users(id)     ON DELETE CASCADE,
    role            TEXT NOT NULL
                    CHECK (role IN ('owner','admin','strategist','analyst','viewer','auditor')),
    -- Restricción opcional del alcance: NULL = todas las campañas de la org.
    campaign_scope  UUID[],
    invited_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,
    UNIQUE (organization_id, user_id)
);

COMMENT ON COLUMN civic.memberships.role IS
    'owner/admin: gestión total. strategist: define campañas y reglas. analyst: lee y anota. '
    'viewer: sólo lectura. auditor: lectura + acceso a la bitácora, sin ver texto sin redactar.';

CREATE INDEX IF NOT EXISTS ix_memberships_user ON civic.memberships (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_memberships_org  ON civic.memberships (organization_id) WHERE revoked_at IS NULL;

-- =============================================================================
-- 3. GEOGRAFÍA
--    Árbol autoreferenciado y agnóstico de país. Se puebla al configurar la
--    instancia con el nivel de detalle que cada organización necesite.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.geo_areas (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID     REFERENCES civic.organizations(id) ON DELETE CASCADE,
    parent_id       UUID     REFERENCES civic.geo_areas(id)     ON DELETE CASCADE,
    level_code      civic.slug_code NOT NULL REFERENCES civic_cat.geo_levels(code),
    name            TEXT     NOT NULL,
    -- Código oficial del área en la nomenclatura del país (INEGI, IBGE, NUTS...).
    official_code   TEXT,
    iso_code        TEXT,
    -- Ruta materializada: acelera consultas "todo lo que cuelga de X".
    path            TEXT     NOT NULL DEFAULT '',
    centroid_lat    NUMERIC(9,6)  CHECK (centroid_lat  BETWEEN -90  AND 90),
    centroid_lon    NUMERIC(9,6)  CHECK (centroid_lon  BETWEEN -180 AND 180),
    population      BIGINT   CHECK (population >= 0),
    -- Padrón o lista nominal. Denominador de los indicadores per cápita.
    electorate_size BIGINT   CHECK (electorate_size >= 0),
    metadata        JSONB    NOT NULL DEFAULT '{}'::jsonb,
    is_active       BOOLEAN  NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- organization_id NULL = área global compartida (p.ej. catálogo de países).
    CONSTRAINT ck_geo_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

COMMENT ON COLUMN civic.geo_areas.path IS
    'Ruta de ancestros separada por "/" (ids). Mantenida por trigger. Permite prefix-match con índice.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_geo_org_level_code
    ON civic.geo_areas (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        level_code, official_code)
    WHERE official_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_geo_parent ON civic.geo_areas (parent_id);
-- Prefix-match sobre la ruta materializada: funciona con B-tree y text_pattern_ops,
-- sin necesidad de pg_trgm.
CREATE INDEX IF NOT EXISTS ix_geo_path   ON civic.geo_areas (path text_pattern_ops);

-- Búsqueda difusa por nombre: sólo si pg_trgm está disponible.
DO $$
BEGIN
    IF civic_ops.has_ext('pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS ix_geo_name_trgm
            ON civic.geo_areas USING GIN (name gin_trgm_ops);
    ELSE
        CREATE INDEX IF NOT EXISTS ix_geo_name_lower
            ON civic.geo_areas (lower(civic_ops.deaccent(name)));
    END IF;
END
$$;

-- =============================================================================
-- 4. CAMPAÑAS
--    Equivalente al "project" del sistema base. Se conserva la columna `code`
--    porque es el identificador público que consume la API y el frontend.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.campaigns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID              NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    code                civic.public_code NOT NULL,   -- identificador público, p.ej. 'CAMP-2027-A'
    name                TEXT              NOT NULL,
    slug                civic.slug_code   NOT NULL,
    objective           TEXT,

    -- Naturaleza del ejercicio de monitoreo.
    campaign_kind       TEXT              NOT NULL DEFAULT 'electoral'
                        CHECK (campaign_kind IN ('electoral','referendum','governance',
                                                 'issue_advocacy','reputation','pre_campaign','post_election')),
    -- Cargo o pregunta en disputa. Texto libre: no se asume sistema electoral.
    contest_label       TEXT,
    -- Territorio bajo observación.
    geo_area_id         UUID              REFERENCES civic.geo_areas(id) ON DELETE SET NULL,

    default_language    civic.lang_code   NOT NULL DEFAULT 'es' REFERENCES civic_cat.languages(code),
    languages           civic.lang_code[] NOT NULL DEFAULT ARRAY['es']::civic.lang_code[],
    timezone            TEXT              NOT NULL DEFAULT 'UTC',

    status              TEXT              NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','paused','closed','archived')),

    -- Ventana de observación. election_date permite calcular "días para la elección",
    -- eje temporal natural de todos los tableros de campaña.
    starts_on           DATE,
    ends_on             DATE,
    election_date       DATE,
    -- Periodo de veda / silencio electoral: durante estas fechas se suspenden
    -- las notificaciones proactivas y se marca el contenido generado.
    blackout_starts_on  DATE,
    blackout_ends_on    DATE,

    -- Umbrales que consume el motor de alertas cuando la regla no los define.
    thresholds          JSONB             NOT NULL DEFAULT jsonb_build_object(
                            'negative_pct',        35.0,
                            'net_sentiment_min',  -0.20,
                            'volume_zscore',       3.0,
                            'toxicity_avg',        0.55,
                            'min_confidence',      0.60,
                            'sov_drop_pct',        20.0
                        ),
    settings            JSONB             NOT NULL DEFAULT '{}'::jsonb,

    created_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    created_by          TEXT,
    owner_sub           TEXT,
    archived_at         TIMESTAMPTZ,

    UNIQUE (organization_id, code),
    UNIQUE (organization_id, slug),
    CONSTRAINT ck_campaign_dates    CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT ck_campaign_blackout CHECK (blackout_ends_on IS NULL OR blackout_starts_on IS NULL
                                           OR blackout_ends_on >= blackout_starts_on)
);

COMMENT ON TABLE  civic.campaigns IS 'Unidad de monitoreo. Sustituye a "projects" del sistema base; conserva `code` por compatibilidad de API.';
COMMENT ON COLUMN civic.campaigns.blackout_starts_on IS
    'Veda electoral. La plataforma sigue midiendo, pero suspende envíos proactivos y marca los reportes.';

-- `code` es único global además de por organización: la API legacy resuelve
-- campañas sólo por code, sin tenant en la ruta.
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_code_global ON civic.campaigns (code);
CREATE INDEX IF NOT EXISTS ix_campaigns_org_status ON civic.campaigns (organization_id, status);
CREATE INDEX IF NOT EXISTS ix_campaigns_active     ON civic.campaigns (id) WHERE status = 'active';

-- =============================================================================
-- 5. CONTENDIENTES
--    Los actores medidos. Es la diferencia estructural con el sistema base:
--    allí se medía UNA marca; aquí se comparan N actores en competencia.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.contenders (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id       UUID            NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    type_code         civic.slug_code NOT NULL REFERENCES civic_cat.contender_types(code),

    name              TEXT            NOT NULL,
    slug              civic.slug_code NOT NULL,
    short_name        TEXT,
    -- Actor propio vs. contrincante. Cambia la lectura de todos los indicadores.
    is_own            BOOLEAN         NOT NULL DEFAULT FALSE,
    -- Afiliación declarada. Texto libre para no imponer un sistema de partidos.
    affiliation       TEXT,
    parent_id         UUID            REFERENCES civic.contenders(id) ON DELETE SET NULL,

    -- Cómo se reconoce a este actor en el texto. Es el insumo del matcher.
    aliases           TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    handles           JSONB           NOT NULL DEFAULT '{}'::jsonb,  -- {"x_twitter":"@...","tiktok":"..."}
    -- Términos que NO deben atribuirse a este actor pese a parecerse.
    negative_terms    TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],

    color_hex         CHAR(7)         CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    avatar_url        TEXT,
    display_order     SMALLINT        NOT NULL DEFAULT 0,

    -- Línea base externa (encuesta de referencia) para contrastar el dato digital
    -- contra intención de voto medida con metodología probabilística.
    baseline_support_pct NUMERIC(5,2) CHECK (baseline_support_pct BETWEEN 0 AND 100),
    baseline_source      TEXT,
    baseline_date        DATE,

    status            TEXT            NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','withdrawn','inactive')),
    metadata          JSONB           NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by        TEXT,

    UNIQUE (campaign_id, slug),
    CONSTRAINT ck_contender_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

COMMENT ON TABLE  civic.contenders IS 'Actores comparados dentro de una campaña: candidaturas, partidos, coaliciones o instituciones.';
COMMENT ON COLUMN civic.contenders.negative_terms IS
    'Desambiguación. Si el texto contiene alguno de estos términos, no se atribuye la mención a este actor.';
COMMENT ON COLUMN civic.contenders.baseline_support_pct IS
    'Apoyo medido por encuesta probabilística. El dato digital NO es representativo: sirve para contrastar tendencia, no nivel.';

CREATE INDEX IF NOT EXISTS ix_contenders_campaign ON civic.contenders (campaign_id, status);
CREATE INDEX IF NOT EXISTS ix_contenders_own      ON civic.contenders (campaign_id) WHERE is_own;
CREATE INDEX IF NOT EXISTS ix_contenders_aliases  ON civic.contenders USING GIN (aliases);

-- =============================================================================
-- 6. TEMAS DE LA CAMPAÑA
--    Instancia local de la taxonomía global: cada campaña elige qué temas
--    sigue y con qué términos los detecta.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.topics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id     UUID            NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    category_code   civic.slug_code NOT NULL REFERENCES civic_cat.topic_categories(code),

    name            TEXT            NOT NULL,
    slug            civic.slug_code NOT NULL,
    description     TEXT,
    keywords        TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Prioridad estratégica: los temas "propios" son en los que se quiere competir.
    is_owned_issue  BOOLEAN         NOT NULL DEFAULT FALSE,
    priority        SMALLINT        NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    color_hex       CHAR(7)         CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    UNIQUE (campaign_id, slug)
);

COMMENT ON COLUMN civic.topics.is_owned_issue IS
    'Tema en el que el actor propio busca ser identificado. Perder terreno aquí es más grave que en un tema ajeno.';

CREATE INDEX IF NOT EXISTS ix_topics_campaign ON civic.topics (campaign_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_topics_keywords ON civic.topics USING GIN (keywords);

-- =============================================================================
-- 7. FUENTES DE DATOS
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.sources (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id         UUID            NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    type_code           civic.slug_code NOT NULL REFERENCES civic_cat.source_types(code),

    name                TEXT            NOT NULL,
    slug                civic.slug_code NOT NULL,
    status              TEXT            NOT NULL DEFAULT 'inactive'
                        CHECK (status IN ('active','paused','inactive','error')),

    -- Configuración de recolección. Estructura libre por tipo de fuente; el
    -- esquema esperado se documenta en docs/SOURCES.md.
    config              JSONB           NOT NULL DEFAULT '{}'::jsonb,
    -- NUNCA credenciales en claro: sólo la referencia al gestor de secretos.
    credentials_ref     TEXT,
    collection_schedule TEXT,           -- expresión cron
    collection_mode     TEXT            NOT NULL DEFAULT 'polling'
                        CHECK (collection_mode IN ('streaming','webhook','polling','manual','batch')),

    -- Base legal del tratamiento. Obligatoria en fuentes con requires_consent.
    legal_basis         TEXT            CHECK (legal_basis IN
                        ('public_interest','legitimate_interest','consent','contract','legal_obligation')),
    terms_url           TEXT,

    -- Telemetría de salud de la fuente. La alimenta el worker de ingesta y la
    -- consume la alerta `ingestion_failure`.
    last_collected_at   TIMESTAMPTZ,
    last_success_at     TIMESTAMPTZ,
    last_error          TEXT,
    consecutive_errors  INTEGER         NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
    total_collected     BIGINT          NOT NULL DEFAULT 0 CHECK (total_collected >= 0),
    -- Minutos sin datos tras los cuales la fuente se considera caída.
    lag_alert_minutes   INTEGER         NOT NULL DEFAULT 120 CHECK (lag_alert_minutes > 0),

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by          TEXT,

    UNIQUE (campaign_id, slug)
);

COMMENT ON COLUMN civic.sources.credentials_ref IS
    'Referencia al gestor de secretos, p.ej. vault://campaign-x/twitter. Jamás la credencial en sí.';
COMMENT ON COLUMN civic.sources.legal_basis IS
    'Base legal del tratamiento. Requerida cuando source_types.requires_consent es TRUE.';

CREATE INDEX IF NOT EXISTS ix_sources_campaign ON civic.sources (campaign_id, status);
CREATE INDEX IF NOT EXISTS ix_sources_stale    ON civic.sources (last_success_at)
    WHERE status = 'active';

-- Regla de cumplimiento: fuentes privadas exigen base legal declarada.
CREATE OR REPLACE FUNCTION civic.enforce_source_legal_basis()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_requires BOOLEAN;
BEGIN
    SELECT requires_consent INTO v_requires
    FROM civic_cat.source_types WHERE code = NEW.type_code;

    IF v_requires AND NEW.legal_basis IS NULL THEN
        RAISE EXCEPTION
            'La fuente "%" es de tipo % (canal privado) y requiere legal_basis declarada.',
            NEW.name, NEW.type_code
            USING ERRCODE = '23514',
                  HINT = 'Asigne legal_basis: consent | contract | legitimate_interest | ...';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_sources_legal_basis ON civic.sources;
CREATE TRIGGER tg_sources_legal_basis
    BEFORE INSERT OR UPDATE OF type_code, legal_basis ON civic.sources
    FOR EACH ROW EXECUTE FUNCTION civic.enforce_source_legal_basis();

-- =============================================================================
-- 8. SEGMENTOS DE AUDIENCIA
--    Agrupaciones analíticas definidas por la organización (p.ej. "jóvenes
--    urbanos"). Se asignan a nivel de contenido, nunca a personas identificadas.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.audience_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id     UUID            REFERENCES civic.campaigns(id) ON DELETE CASCADE,
    name            TEXT            NOT NULL,
    slug            civic.slug_code NOT NULL,
    description     TEXT,
    -- Criterio declarativo evaluado por el pipeline de ingesta.
    rule            JSONB           NOT NULL DEFAULT '{}'::jsonb,
    color_hex       CHAR(7)         CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- UNIQUE sobre expresión: campaign_id NULL significa "segmento de toda la
-- organización", y NULL no colisiona en un UNIQUE ordinario.
CREATE UNIQUE INDEX IF NOT EXISTS ux_segments_org_campaign_slug
    ON civic.audience_segments (
        organization_id,
        COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid),
        slug
    );

COMMENT ON TABLE civic.audience_segments IS
    'Segmentación analítica agregada. No se construyen perfiles de individuos identificables.';

-- =============================================================================
-- 9. TRIGGERS DE updated_at
-- =============================================================================
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'organizations','app_users','memberships','geo_areas','campaigns',
        'contenders','topics','sources','audience_segments'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_%s_updated_at ON civic.%I', t, t);
        EXECUTE format(
            'CREATE TRIGGER tg_%s_updated_at BEFORE UPDATE ON civic.%I
             FOR EACH ROW EXECUTE FUNCTION civic_ops.set_updated_at()', t, t
        );
    END LOOP;
END
$$;

-- =============================================================================
-- 10. MANTENIMIENTO DE LA RUTA GEOGRÁFICA
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.geo_maintain_path()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_parent_path TEXT;
BEGIN
    IF NEW.parent_id IS NULL THEN
        NEW.path := NEW.id::text;
    ELSE
        SELECT path INTO v_parent_path FROM civic.geo_areas WHERE id = NEW.parent_id;
        IF v_parent_path IS NULL THEN
            RAISE EXCEPTION 'Área padre % inexistente.', NEW.parent_id USING ERRCODE = '23503';
        END IF;
        IF position(NEW.id::text IN v_parent_path) > 0 THEN
            RAISE EXCEPTION 'Ciclo detectado en la jerarquía geográfica.' USING ERRCODE = '23514';
        END IF;
        NEW.path := v_parent_path || '/' || NEW.id::text;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_geo_path ON civic.geo_areas;
CREATE TRIGGER tg_geo_path
    BEFORE INSERT OR UPDATE OF parent_id ON civic.geo_areas
    FOR EACH ROW EXECUTE FUNCTION civic.geo_maintain_path();

-- =============================================================================
-- 11. AUDITORÍA SOBRE TABLAS SENSIBLES
-- =============================================================================
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['organizations','memberships','campaigns','contenders','sources']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_%s_audit ON civic.%I', t, t);
        EXECUTE format(
            'CREATE TRIGGER tg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON civic.%I
             FOR EACH ROW EXECUTE FUNCTION civic_ops.audit_trigger()', t, t
        );
    END LOOP;
END
$$;

-- =============================================================================
-- 12. CUOTAS DE PLAN
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.enforce_campaign_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_max   INTEGER;
    v_count INTEGER;
BEGIN
    SELECT max_campaigns INTO v_max FROM civic.organizations WHERE id = NEW.organization_id;
    SELECT count(*) INTO v_count
      FROM civic.campaigns
     WHERE organization_id = NEW.organization_id AND status <> 'archived';

    IF v_count >= v_max THEN
        RAISE EXCEPTION 'Límite de campañas alcanzado para la organización (% de %).', v_count, v_max
            USING ERRCODE = '23505', HINT = 'Archive campañas o amplíe el plan.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_campaigns_quota ON civic.campaigns;
CREATE TRIGGER tg_campaigns_quota
    BEFORE INSERT ON civic.campaigns
    FOR EACH ROW EXECUTE FUNCTION civic.enforce_campaign_quota();

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_n INTEGER;
BEGIN
    SELECT count(*) INTO v_n
    FROM information_schema.tables
    WHERE table_schema = 'civic' AND table_type = 'BASE TABLE';
    RAISE NOTICE '── Núcleo de dominio creado: % tablas en el esquema civic ──', v_n;
END
$$;
