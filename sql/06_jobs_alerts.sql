-- =============================================================================
-- Análisis de Sentimientos · 06_jobs_alerts.sql
-- Trabajos de análisis, reglas de alerta, alertas y entregas.
--
-- Corrige la carencia principal del sistema base: allí las reglas se guardaban
-- pero nada las evaluaba. Aquí la evaluación vive en la base de datos
-- (civic.evaluate_alert_rules), que es donde están los datos, y el servicio de
-- alertas sólo la invoca y difunde el resultado.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_ops, public;

-- =============================================================================
-- 1. TRABAJOS DE ANÁLISIS
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.analysis_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq             BIGINT GENERATED ALWAYS AS IDENTITY,
    organization_id UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id     UUID            NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    source_id       UUID            REFERENCES civic.sources(id)   ON DELETE SET NULL,
    model_id        UUID            REFERENCES civic.ai_models(id) ON DELETE SET NULL,
    prompt_version_id UUID          REFERENCES civic.prompt_versions(id) ON DELETE SET NULL,

    -- Denormalizado para la vista de compatibilidad y para reportes históricos
    -- que deben seguir siendo legibles si se renombra el modelo.
    model_name      TEXT,
    campaign_code   civic.public_code NOT NULL,

    job_type        TEXT            NOT NULL DEFAULT 'batch'
                    CHECK (job_type IN ('batch','stream','backfill','reprocess','evaluation','shadow')),
    status_code     civic.slug_code NOT NULL DEFAULT 'queued'
                    REFERENCES civic_cat.job_statuses(code),
    priority        TEXT            NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),

    config          JSONB           NOT NULL DEFAULT '{}'::jsonb,
    progress_pct    SMALLINT        NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),

    total_items     INTEGER         NOT NULL DEFAULT 0 CHECK (total_items  >= 0),
    processed_items INTEGER         NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
    failed_items    INTEGER         NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
    skipped_items   INTEGER         NOT NULL DEFAULT 0 CHECK (skipped_items >= 0),

    total_cost_usd  NUMERIC(12,6)   NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
    stats           JSONB           NOT NULL DEFAULT '{}'::jsonb,

    scheduled_at    TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    -- Reintentos con backoff. El worker respeta next_retry_at.
    attempt         SMALLINT        NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts    SMALLINT        NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    next_retry_at   TIMESTAMPTZ,
    error_message   TEXT,

    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by      TEXT,

    CONSTRAINT ck_job_times CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS ix_jobs_campaign_created ON civic.analysis_jobs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_runnable
    ON civic.analysis_jobs (priority, scheduled_at)
    WHERE status_code IN ('queued','paused');
CREATE INDEX IF NOT EXISTS ix_jobs_retry ON civic.analysis_jobs (next_retry_at)
    WHERE status_code = 'failed' AND next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_jobs_code ON civic.analysis_jobs (campaign_code, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_seq  ON civic.analysis_jobs (seq);

-- Rellena campaign_code y model_name automáticamente.
CREATE OR REPLACE FUNCTION civic.job_denormalize()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.campaign_code IS NULL OR NEW.campaign_code = '' THEN
        SELECT code INTO NEW.campaign_code FROM civic.campaigns WHERE id = NEW.campaign_id;
    END IF;
    IF NEW.model_name IS NULL AND NEW.model_id IS NOT NULL THEN
        SELECT name INTO NEW.model_name FROM civic.ai_models WHERE id = NEW.model_id;
    END IF;
    IF NEW.total_items > 0 THEN
        NEW.progress_pct := LEAST(100, ROUND(100.0 * NEW.processed_items / NEW.total_items))::smallint;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_jobs_denorm ON civic.analysis_jobs;
CREATE TRIGGER tg_jobs_denorm
    BEFORE INSERT OR UPDATE ON civic.analysis_jobs
    FOR EACH ROW EXECUTE FUNCTION civic.job_denormalize();

CREATE TABLE IF NOT EXISTS civic.job_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id      UUID        NOT NULL REFERENCES civic.analysis_jobs(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level       TEXT        NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
    message     TEXT        NOT NULL,
    context     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_job_events_job ON civic.job_events (job_id, occurred_at DESC);

-- =============================================================================
-- 2. REGLAS DE ALERTA
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.alert_rules (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id       UUID            NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    campaign_code     civic.public_code NOT NULL,

    name              TEXT            NOT NULL,
    alert_type_code   civic.slug_code NOT NULL REFERENCES civic_cat.alert_types(code),
    severity_code     civic.slug_code NOT NULL REFERENCES civic_cat.severity_levels(code),

    -- ── Definición de la condición ──────────────────────────────────────────
    -- La métrica debe existir en civic_kpi.metric_registry (10_indicators.sql).
    metric            TEXT            NOT NULL,
    operator          TEXT            NOT NULL CHECK (operator IN ('gt','gte','lt','lte','eq','neq')),
    threshold         NUMERIC         NOT NULL,
    -- Ventana de evaluación en minutos.
    window_minutes    INTEGER         NOT NULL DEFAULT 60 CHECK (window_minutes > 0),
    -- Volumen mínimo para que la regla dispare. Sin esto, 2 comentarios negativos
    -- de 2 totales darían 100 % de negatividad y una alerta crítica falsa.
    min_sample_size   INTEGER         NOT NULL DEFAULT 30 CHECK (min_sample_size >= 0),

    -- ── Alcance opcional ────────────────────────────────────────────────────
    contender_id      UUID            REFERENCES civic.contenders(id) ON DELETE CASCADE,
    source_id         UUID            REFERENCES civic.sources(id)    ON DELETE CASCADE,
    topic_category    civic.slug_code REFERENCES civic_cat.topic_categories(code),
    geo_area_id       UUID            REFERENCES civic.geo_areas(id)  ON DELETE CASCADE,

    -- ── Control de ruido ────────────────────────────────────────────────────
    -- Minutos de silencio tras disparar. Evita la avalancha que hace que el
    -- equipo desactive las notificaciones.
    cooldown_minutes  INTEGER         NOT NULL DEFAULT 120 CHECK (cooldown_minutes >= 0),
    -- Evaluaciones consecutivas en condición antes de disparar.
    consecutive_hits  SMALLINT        NOT NULL DEFAULT 1 CHECK (consecutive_hits >= 1),
    -- Máximo de disparos por día.
    max_per_day       SMALLINT        NOT NULL DEFAULT 12 CHECK (max_per_day > 0),
    -- Suspender durante la veda electoral.
    respect_blackout  BOOLEAN         NOT NULL DEFAULT TRUE,
    -- Franja horaria de notificación (hora local de la campaña).
    quiet_hours_start SMALLINT        CHECK (quiet_hours_start BETWEEN 0 AND 23),
    quiet_hours_end   SMALLINT        CHECK (quiet_hours_end   BETWEEN 0 AND 23),

    channels          TEXT[]          NOT NULL DEFAULT ARRAY['sse']::TEXT[],
    recipients        JSONB           NOT NULL DEFAULT '[]'::jsonb,
    message_template  TEXT,

    is_enabled        BOOLEAN         NOT NULL DEFAULT TRUE,
    -- Telemetría de la propia regla: reglas que nunca disparan o disparan
    -- siempre son reglas mal calibradas.
    current_streak    SMALLINT        NOT NULL DEFAULT 0,
    last_evaluated_at TIMESTAMPTZ,
    last_triggered_at TIMESTAMPTZ,
    trigger_count     INTEGER         NOT NULL DEFAULT 0 CHECK (trigger_count >= 0),

    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by        TEXT,

    CONSTRAINT ck_rule_channels CHECK (channels <@ ARRAY['sse','email','whatsapp','webhook','slack']::TEXT[])
);

COMMENT ON COLUMN civic.alert_rules.min_sample_size IS
    'Volumen mínimo en la ventana. Es la salvaguarda más importante contra alertas falsas por muestras diminutas.';
COMMENT ON COLUMN civic.alert_rules.consecutive_hits IS
    'Histéresis: exige N evaluaciones seguidas en condición. Filtra el ruido de una sola lectura anómala.';

CREATE INDEX IF NOT EXISTS ix_rules_campaign ON civic.alert_rules (campaign_id) WHERE is_enabled;
CREATE INDEX IF NOT EXISTS ix_rules_code     ON civic.alert_rules (campaign_code) WHERE is_enabled;

-- =============================================================================
-- 3. ALERTAS
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.alerts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq               BIGINT GENERATED ALWAYS AS IDENTITY,
    organization_id   UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id       UUID            NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    campaign_code     civic.public_code NOT NULL,
    rule_id           UUID            REFERENCES civic.alert_rules(id) ON DELETE SET NULL,

    alert_type_code   civic.slug_code NOT NULL REFERENCES civic_cat.alert_types(code),
    severity_code     civic.slug_code NOT NULL REFERENCES civic_cat.severity_levels(code),

    title             TEXT            NOT NULL,
    message           TEXT            NOT NULL,
    -- Valores que dispararon la alerta. Sin esto no se puede auditar si fue justificada.
    metric            TEXT,
    observed_value    NUMERIC,
    threshold_value   NUMERIC,
    sample_size       INTEGER,
    window_start      TIMESTAMPTZ,
    window_end        TIMESTAMPTZ,

    contender_id      UUID            REFERENCES civic.contenders(id) ON DELETE SET NULL,
    source_id         UUID            REFERENCES civic.sources(id)    ON DELETE SET NULL,
    topic_category    civic.slug_code REFERENCES civic_cat.topic_categories(code),
    geo_area_id       UUID            REFERENCES civic.geo_areas(id)  ON DELETE SET NULL,

    -- Muestra de contenidos representativos. Convierte la alerta en algo
    -- accionable en lugar de un número sin contexto.
    evidence          JSONB           NOT NULL DEFAULT '[]'::jsonb,
    context           JSONB           NOT NULL DEFAULT '{}'::jsonb,

    -- ── Ciclo de vida ───────────────────────────────────────────────────────
    status            TEXT            NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','acknowledged','in_progress','resolved','dismissed','expired')),
    is_read           BOOLEAN         NOT NULL DEFAULT FALSE,
    acknowledged_by   TEXT,
    acknowledged_at   TIMESTAMPTZ,
    resolved_by       TEXT,
    resolved_at       TIMESTAMPTZ,
    resolution_note   TEXT,
    -- Si al revisar resultó ser ruido, se marca. Alimenta la recalibración de reglas.
    was_false_positive BOOLEAN,

    -- Generada durante la veda electoral: los reportes deben señalarlo.
    during_blackout   BOOLEAN         NOT NULL DEFAULT FALSE,

    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_alert_resolved CHECK (status <> 'resolved' OR resolved_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_alerts_campaign_created ON civic.alerts (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_code_created     ON civic.alerts (campaign_code, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_open             ON civic.alerts (campaign_id, severity_code, created_at DESC)
    WHERE status IN ('open','acknowledged','in_progress');
CREATE INDEX IF NOT EXISTS ix_alerts_unread           ON civic.alerts (campaign_id) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS ix_alerts_seq              ON civic.alerts (seq);
CREATE INDEX IF NOT EXISTS ix_alerts_rule             ON civic.alerts (rule_id, created_at DESC);

-- Marca la alerta si nace durante la veda electoral.
CREATE OR REPLACE FUNCTION civic.alert_mark_blackout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_start DATE; v_end DATE; v_code civic.public_code;
BEGIN
    SELECT blackout_starts_on, blackout_ends_on, code
      INTO v_start, v_end, v_code
      FROM civic.campaigns WHERE id = NEW.campaign_id;

    IF NEW.campaign_code IS NULL OR NEW.campaign_code = '' THEN
        NEW.campaign_code := v_code;
    END IF;

    NEW.during_blackout := v_start IS NOT NULL
                       AND CURRENT_DATE BETWEEN v_start AND COALESCE(v_end, v_start);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_alerts_blackout ON civic.alerts;
CREATE TRIGGER tg_alerts_blackout
    BEFORE INSERT ON civic.alerts
    FOR EACH ROW EXECUTE FUNCTION civic.alert_mark_blackout();

-- =============================================================================
-- 4. ENTREGAS
--    Una alerta puede notificarse por varios canales. Registrar cada intento
--    permite saber si el equipo se enteró, que es distinto de si se generó.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.alert_deliveries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id      UUID        NOT NULL REFERENCES civic.alerts(id) ON DELETE CASCADE,
    channel       TEXT        NOT NULL CHECK (channel IN ('sse','email','whatsapp','webhook','slack')),
    recipient     TEXT,
    status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','read','failed','suppressed')),
    -- suppressed: no se envió por veda, horario silencioso o cooldown.
    suppression_reason TEXT,
    attempt       SMALLINT    NOT NULL DEFAULT 0,
    error_message TEXT,
    provider_ref  TEXT,       -- id del mensaje en el proveedor
    sent_at       TIMESTAMPTZ,
    delivered_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_deliveries_alert   ON civic.alert_deliveries (alert_id);
CREATE INDEX IF NOT EXISTS ix_deliveries_pending ON civic.alert_deliveries (created_at)
    WHERE status = 'pending';

-- =============================================================================
-- 5. SUSCRIPTORES
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.alert_subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID        NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id     UUID        NOT NULL REFERENCES civic.campaigns(id)     ON DELETE CASCADE,
    campaign_code   civic.public_code NOT NULL,
    channel         TEXT        NOT NULL CHECK (channel IN ('email','whatsapp','webhook','slack')),
    -- Destino seudonimizado en el índice; el valor en claro es necesario para enviar.
    destination     TEXT        NOT NULL,
    display_name    TEXT,
    -- Severidad mínima que quiere recibir.
    min_severity    civic.slug_code NOT NULL DEFAULT 'medium'
                    REFERENCES civic_cat.severity_levels(code),
    alert_types     civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],  -- vacío = todos

    -- Consentimiento para recibir notificaciones. Obligatorio en WhatsApp y correo.
    consent_given_at TIMESTAMPTZ,
    consent_source   TEXT,
    opted_out_at     TIMESTAMPTZ,

    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (campaign_id, channel, destination)
);

COMMENT ON COLUMN civic.alert_subscriptions.consent_given_at IS
    'Fecha del consentimiento. Sin este dato no debe enviarse a WhatsApp ni correo.';

-- Bloquea envíos sin consentimiento en canales que lo exigen.
CREATE OR REPLACE FUNCTION civic.enforce_subscription_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.is_active
       AND NEW.channel IN ('whatsapp','email')
       AND NEW.consent_given_at IS NULL THEN
        RAISE EXCEPTION 'La suscripción por % requiere consent_given_at.', NEW.channel
            USING ERRCODE = '23514';
    END IF;
    IF NEW.opted_out_at IS NOT NULL THEN
        NEW.is_active := FALSE;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_subs_consent ON civic.alert_subscriptions;
CREATE TRIGGER tg_subs_consent
    BEFORE INSERT OR UPDATE ON civic.alert_subscriptions
    FOR EACH ROW EXECUTE FUNCTION civic.enforce_subscription_consent();

-- =============================================================================
-- 6. TRIGGERS DE updated_at
-- =============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['analysis_jobs','alert_rules','alerts','alert_deliveries','alert_subscriptions'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_%s_updated_at ON civic.%I', t, t);
        EXECUTE format('CREATE TRIGGER tg_%s_updated_at BEFORE UPDATE ON civic.%I
                        FOR EACH ROW EXECUTE FUNCTION civic_ops.set_updated_at()', t, t);
    END LOOP;
END
$$;

DROP TRIGGER IF EXISTS tg_alert_rules_audit ON civic.alert_rules;
CREATE TRIGGER tg_alert_rules_audit
    AFTER INSERT OR UPDATE OR DELETE ON civic.alert_rules
    FOR EACH ROW EXECUTE FUNCTION civic_ops.audit_trigger();

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE '── Trabajos y alertas creados. El evaluador de reglas se define en 10_indicators.sql ──';
END
$$;
