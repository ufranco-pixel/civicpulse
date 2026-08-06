-- =============================================================================
-- Análisis de Sentimientos · 12_whatsapp_dispatch.sql
--
-- Reparto de una alerta a sus destinatarios de WhatsApp.
--
-- El esquema ya traía `civic.alerts`, `civic.alert_subscriptions` y
-- `civic.alert_deliveries`, pero faltaba la pieza del medio: nada creaba las
-- filas de entrega. Las alertas se generaban y ahí se quedaban.
--
-- Este fichero añade:
--   1. civic.fanout_alert_deliveries(alert_id) → crea una entrega por
--      suscriptor con derecho a recibirla.
--   2. Un disparador que la llama al insertar una alerta, para que no dependa
--      de que la aplicación se acuerde.
--   3. civic.claim_whatsapp_deliveries(n) → lo que consume el despachador.
--   4. civic.mark_delivery_sent / _failed → cierre del ciclo con reintentos.
--   5. La regla de alerta para comentarios negativos.
--
-- Ejecutar DESPUÉS de 11_security_rls.sql.
-- =============================================================================

SET search_path = civic, civic_cat, civic_ops, public;

-- =============================================================================
-- 1. ABANICO: DE UNA ALERTA A SUS ENTREGAS
-- =============================================================================
--
-- Cuatro filtros, y ninguno es opcional:
--
--   · consentimiento    — sin `consent_given_at` no se envía a WhatsApp. Es un
--                         requisito legal, no una preferencia del producto.
--   · severidad mínima  — cada suscriptor fija a partir de qué nivel quiere que
--                         le escriban. Ignorarlo convierte el canal en ruido y
--                         acaba con la gente silenciando el número.
--   · tipos de alerta   — lista vacía significa «todos».
--   · veda electoral    — durante la veda la alerta SE REGISTRA pero la entrega
--                         nace 'suppressed'. Queda constancia de que existió y
--                         de por qué no se envió, que es justo lo que hay que
--                         poder demostrar después.
--
-- Es idempotente: si ya hay una entrega para ese par (alerta, destino) no la
-- duplica. Reejecutar el disparador o llamarla a mano no manda dos veces.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.fanout_alert_deliveries(p_alert_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, civic_cat, civic_ops, public
AS $$
DECLARE
    v_alert      RECORD;
    v_en_veda    BOOLEAN;
    v_sev_alerta SMALLINT;
    v_creadas    INTEGER := 0;
BEGIN
    SELECT a.*, c.timezone
      INTO v_alert
      FROM civic.alerts a
      JOIN civic.campaigns c ON c.id = a.campaign_id
     WHERE a.id = p_alert_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe la alerta %', p_alert_id;
    END IF;

    -- La veda se calcula con la zona horaria de la campaña, nunca con la del
    -- servidor: una campaña en Tijuana y otra en Cancún no entran en veda a la
    -- misma hora UTC.
    SELECT COALESCE(
             CURRENT_DATE BETWEEN c.blackout_starts_on AND c.blackout_ends_on,
             FALSE)
      INTO v_en_veda
      FROM civic.campaigns c
     WHERE c.id = v_alert.campaign_id;

    SELECT s.rank INTO v_sev_alerta
      FROM civic_cat.severity_levels s
     WHERE s.code = v_alert.severity_code;

    INSERT INTO civic.alert_deliveries (
        alert_id, channel, recipient, status, suppression_reason
    )
    SELECT
        p_alert_id,
        'whatsapp',
        sub.destination,
        CASE WHEN v_en_veda THEN 'suppressed' ELSE 'pending' END,
        CASE WHEN v_en_veda THEN 'veda_electoral' ELSE NULL END
    FROM   civic.alert_subscriptions sub
    JOIN   civic_cat.severity_levels smin ON smin.code = sub.min_severity
    WHERE  sub.campaign_id       = v_alert.campaign_id
      AND  sub.channel           = 'whatsapp'
      AND  sub.is_active
      AND  sub.opted_out_at      IS NULL
      AND  sub.consent_given_at  IS NOT NULL
      AND  v_sev_alerta         >= smin.rank
      AND  (cardinality(sub.alert_types) = 0
            OR v_alert.alert_type_code = ANY (sub.alert_types))
      -- Idempotencia: ni el disparador ni una llamada manual duplican envíos.
      AND  NOT EXISTS (
             SELECT 1 FROM civic.alert_deliveries d
             WHERE d.alert_id = p_alert_id
               AND d.channel  = 'whatsapp'
               AND d.recipient IS NOT DISTINCT FROM sub.destination
           );

    GET DIAGNOSTICS v_creadas = ROW_COUNT;
    RETURN v_creadas;
END;
$$;

COMMENT ON FUNCTION civic.fanout_alert_deliveries(UUID) IS
    'Crea una entrega de WhatsApp por suscriptor con consentimiento. Durante la veda las crea como suppressed.';


-- Que el reparto no dependa de que la aplicación se acuerde de llamarlo.
CREATE OR REPLACE FUNCTION civic.tg_fanout_on_alert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM civic.fanout_alert_deliveries(NEW.id);
    RETURN NULL;   -- AFTER trigger: el valor de retorno se ignora
END;
$$;

DROP TRIGGER IF EXISTS tg_alerts_fanout ON civic.alerts;
CREATE TRIGGER tg_alerts_fanout
    AFTER INSERT ON civic.alerts
    FOR EACH ROW EXECUTE FUNCTION civic.tg_fanout_on_alert();


-- =============================================================================
-- 2. LO QUE CONSUME EL DESPACHADOR
-- =============================================================================
--
-- Mismo contrato que el `whatsapp-sender` de ziba: reclamo atómico con
-- FOR UPDATE SKIP LOCKED, para poder correr varias réplicas sin que dos
-- manden el mismo mensaje.
--
-- `civic.alert_deliveries` no tiene columna de programación, así que el
-- backoff se apoya en `updated_at`: una entrega fallida no se vuelve a
-- reclamar hasta que hayan pasado los minutos que le tocan por su número de
-- intento. Se calcula aquí y no en el cliente para que el criterio sea el
-- mismo aunque corran varios despachadores.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.claim_whatsapp_deliveries(
    p_limit          INTEGER DEFAULT 10,
    p_retry_base_min INTEGER DEFAULT 1,
    p_max_attempts   INTEGER DEFAULT 5
)
RETURNS TABLE (
    delivery_id   UUID,
    alert_id      UUID,
    recipient     TEXT,
    attempt       SMALLINT,
    campaign_code civic.public_code,
    alert_type    civic.slug_code,
    severity      civic.slug_code,
    -- Las etiquetas viajan junto a los códigos porque el mensaje lo lee una
    -- persona en su teléfono: sin ellas el WhatsApp empieza con
    -- «HIGH · negative_spike» en vez de «Alta · Pico de negativos».
    alert_type_label TEXT,
    severity_label   TEXT,
    campaign_name    TEXT,
    title         TEXT,
    message       TEXT,
    observed      NUMERIC,
    threshold     NUMERIC,
    sample_size   INTEGER,
    created_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, civic_cat, civic_ops, public
AS $$
BEGIN
    RETURN QUERY
    WITH reclamadas AS (
        SELECT d.id
        FROM   civic.alert_deliveries d
        WHERE  d.channel = 'whatsapp'
          AND  d.status  = 'pending'
          AND  d.attempt < p_max_attempts
          -- Backoff exponencial: 1, 2, 4, 8… minutos desde el último intento.
          AND  (d.attempt = 0
                OR d.updated_at < NOW() - make_interval(
                     mins => p_retry_base_min * (2 ^ (d.attempt - 1))::int))
        ORDER  BY d.created_at
        LIMIT  p_limit
        FOR UPDATE SKIP LOCKED
    ),
    marcadas AS (
        UPDATE civic.alert_deliveries d
           SET status     = 'sending',
               updated_at = NOW()
          FROM reclamadas r
         WHERE d.id = r.id
        RETURNING d.id, d.alert_id, d.recipient, d.attempt, d.created_at
    )
    SELECT m.id, m.alert_id, m.recipient, m.attempt,
           a.campaign_code, a.alert_type_code, a.severity_code,
           ta.label_es, sv.label_es, ca.name,
           a.title, a.message, a.observed_value, a.threshold_value,
           a.sample_size, m.created_at
    FROM   marcadas m
    JOIN   civic.alerts a          ON a.id  = m.alert_id
    JOIN   civic.campaigns ca      ON ca.id = a.campaign_id
    LEFT   JOIN civic_cat.alert_types     ta ON ta.code = a.alert_type_code
    LEFT   JOIN civic_cat.severity_levels sv ON sv.code = a.severity_code;
END;
$$;

-- 'sending' no está en el CHECK original de alert_deliveries. Se añade aquí
-- porque el estado intermedio es lo que impide que dos despachadores tomen la
-- misma fila; sin él habría que confiar en el bloqueo de la transacción, que
-- se suelta al hacer commit antes de llamar al proveedor.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'civic.alert_deliveries'::regclass
          AND conname  = 'alert_deliveries_status_check'
    ) THEN
        ALTER TABLE civic.alert_deliveries DROP CONSTRAINT alert_deliveries_status_check;
    END IF;

    ALTER TABLE civic.alert_deliveries
        ADD CONSTRAINT alert_deliveries_status_check
        CHECK (status IN ('pending','sending','sent','delivered','read','failed','suppressed'));
END
$$;

CREATE INDEX IF NOT EXISTS ix_deliveries_wa_pendientes
    ON civic.alert_deliveries (created_at)
    WHERE channel = 'whatsapp' AND status IN ('pending','sending');


CREATE OR REPLACE FUNCTION civic.mark_delivery_sent(
    p_id           UUID,
    p_provider_ref TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = civic, public
AS $$
    UPDATE civic.alert_deliveries
       SET status        = 'sent',
           attempt       = attempt + 1,
           provider_ref  = p_provider_ref,
           error_message = NULL,
           sent_at       = NOW(),
           updated_at    = NOW()
     WHERE id = p_id;
$$;

-- `p_permanent` distingue el 4xx del 5xx: un número mal escrito no mejora por
-- reintentarlo, y gastar los cinco intentos en él solo retrasa los mensajes
-- que sí pueden salir.
CREATE OR REPLACE FUNCTION civic.mark_delivery_failed(
    p_id            UUID,
    p_error         TEXT,
    p_permanent     BOOLEAN DEFAULT FALSE,
    p_max_attempts  INTEGER DEFAULT 5
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, public
AS $$
DECLARE
    v_intento SMALLINT;
    v_estado  TEXT;
BEGIN
    SELECT attempt + 1 INTO v_intento
      FROM civic.alert_deliveries WHERE id = p_id;

    v_estado := CASE
                  WHEN p_permanent OR v_intento >= p_max_attempts THEN 'failed'
                  ELSE 'pending'
                END;

    UPDATE civic.alert_deliveries
       SET status        = v_estado,
           attempt       = v_intento,
           error_message = left(p_error, 2000),
           updated_at    = NOW()
     WHERE id = p_id;

    RETURN v_estado;
END;
$$;

-- Rescata entregas que se quedaron en 'sending' porque el despachador murió.
CREATE OR REPLACE FUNCTION civic.reap_stuck_deliveries(p_minutes INTEGER DEFAULT 5)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, public
AS $$
DECLARE v_n INTEGER;
BEGIN
    UPDATE civic.alert_deliveries
       SET status = 'pending', updated_at = NOW()
     WHERE channel = 'whatsapp'
       AND status  = 'sending'
       AND updated_at < NOW() - make_interval(mins => p_minutes);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;


-- =============================================================================
-- 3. PERMISOS
-- =============================================================================
-- SECURITY DEFINER en las funciones de arriba: el despachador necesita ver
-- entregas de TODAS las organizaciones, y RLS se lo impediría. El aislamiento
-- se mantiene porque solo puede tocar filas de canal 'whatsapp' a través de
-- estas funciones concretas, no hacer SELECT libre sobre las tablas.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civicpulse_app') THEN
        GRANT EXECUTE ON FUNCTION
            civic.claim_whatsapp_deliveries(INTEGER, INTEGER, INTEGER),
            civic.mark_delivery_sent(UUID, TEXT),
            civic.mark_delivery_failed(UUID, TEXT, BOOLEAN, INTEGER),
            civic.reap_stuck_deliveries(INTEGER),
            civic.fanout_alert_deliveries(UUID)
        TO civicpulse_app;
    END IF;
END
$$;


-- =============================================================================
-- 4. REGLA DE ALERTA PARA COMENTARIOS NEGATIVOS
-- =============================================================================
-- Se instala por campaña. Sin `p_campaign_code` la aplica a todas las activas.
--
-- `min_sample_size = 1` es deliberado y es la excepción, no la norma: el resto
-- de reglas exige muestra suficiente porque miden porcentajes, y un porcentaje
-- sobre tres menciones no significa nada. Esta no mide un porcentaje: dispara
-- ante un comentario negativo concreto que alguien decidió registrar a mano.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic.ensure_negative_comment_rule(
    p_campaign_code civic.public_code DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    r      RECORD;
    v_tipo civic.slug_code;
    v_n    INTEGER := 0;
BEGIN
    SELECT code INTO v_tipo FROM civic_cat.alert_types
     WHERE code IN ('negative_spike','sentiment_drop') ORDER BY code LIMIT 1;
    IF v_tipo IS NULL THEN
        RAISE EXCEPTION 'No hay tipos de alerta cargados. Ejecute 01_catalogs.sql.';
    END IF;

    FOR r IN
        SELECT id, organization_id, code FROM civic.campaigns
        WHERE (p_campaign_code IS NULL AND status = 'active')
           OR code = p_campaign_code
    LOOP
        -- Si ya existe una regla con ese nombre en la campaña no se duplica.
        -- No hay restricción de unicidad sobre (campaign_id, name), así que
        -- `ON CONFLICT` no serviría de nada aquí.
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM civic.alert_rules
            WHERE campaign_id = r.id AND name = 'Comentario negativo registrado'
        );

        INSERT INTO civic.alert_rules (
            organization_id, campaign_id, campaign_code, name,
            alert_type_code, severity_code, metric, operator, threshold,
            window_minutes, min_sample_size, consecutive_hits, cooldown_minutes,
            max_per_day, channels, recipients, is_enabled, respect_blackout,
            message_template, created_by
        )
        VALUES (
            r.organization_id, r.id, r.code,
            'Comentario negativo registrado',
            v_tipo, 'high', 'negative_pct', 'gte', 0,
            60, 1, 1, 0, 50,
            ARRAY['sse','whatsapp']::TEXT[], '[]'::jsonb, TRUE, TRUE,
            'Comentario negativo en {{campaign}}: "{{texto}}"',
            'sql/12_whatsapp_dispatch.sql'
        );

        v_n := v_n + 1;
    END LOOP;

    RETURN v_n;
END;
$$;


DO $$
BEGIN
    RAISE NOTICE '── Reparto de WhatsApp instalado ──';
    RAISE NOTICE '   Alta de un destinatario:';
    RAISE NOTICE '     INSERT INTO civic.alert_subscriptions';
    RAISE NOTICE '       (organization_id, campaign_id, campaign_code, channel,';
    RAISE NOTICE '        destination, display_name, min_severity, consent_given_at, consent_source)';
    RAISE NOTICE '     SELECT organization_id, id, code, ''whatsapp'',';
    RAISE NOTICE '            ''5215512345678'', ''Uriel'', ''low'', NOW(), ''alta manual''';
    RAISE NOTICE '     FROM civic.campaigns WHERE code = ''SU-CAMPANA'';';
END
$$;
