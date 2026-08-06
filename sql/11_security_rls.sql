-- =============================================================================
-- Análisis de Sentimientos · 11_security_rls.sql
-- Aislamiento multi-tenant por RLS, retención de datos y purga.
--
-- Modelo: la aplicación fija dos variables de sesión por transacción, tomadas
-- del token validado. Nunca de un parámetro de la petición.
--
--   SET LOCAL civicpulse.organization_id = '<uuid>';
--   SET LOCAL civicpulse.actor_sub       = '<sub>';
--
-- Con LOCAL para que expiren al terminar la transacción y no se filtren entre
-- peticiones que reutilizan la misma conexión del pool. Es el error clásico y
-- silencioso de RLS con pgbouncer.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_ops, public;

-- =============================================================================
-- 1. CONTEXTO DE SESIÓN
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_ops.current_org_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v TEXT;
BEGIN
    v := current_setting('civicpulse.organization_id', true);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'civicpulse.organization_id no es un UUID válido: %', v USING ERRCODE = '22P02';
END;
$$;

COMMENT ON FUNCTION civic_ops.current_org_id IS
    'Organización activa de la sesión. NULL significa "sin contexto": las políticas deniegan todo.';

-- Ayuda para la aplicación: fija el contexto completo en una sola llamada.
CREATE OR REPLACE FUNCTION civic_ops.set_session_context(
    p_organization_id UUID,
    p_actor_sub       TEXT DEFAULT NULL,
    p_actor_username  TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('civicpulse.organization_id', COALESCE(p_organization_id::text, ''), TRUE);
    PERFORM set_config('civicpulse.actor_sub',       COALESCE(p_actor_sub, ''),             TRUE);
    PERFORM set_config('civicpulse.actor_username',  COALESCE(p_actor_username, ''),        TRUE);
END;
$$;

COMMENT ON FUNCTION civic_ops.set_session_context IS
    'Fija organización y actor con alcance de transacción (is_local = TRUE). Llámela al inicio de cada petición.';

-- Campañas visibles para la organización activa.
--
-- Las tablas de detalle de inferencia (emociones, posturas, temas, entidades,
-- banderas) no arrastran organization_id —denormalizan campaign_id y
-- published_at, que es lo que necesitan sus agregaciones— así que su política
-- se apoya en esta función. Al ser STABLE, el planner la evalúa una sola vez
-- por consulta y no una vez por fila.
--
-- SECURITY DEFINER para que la subconsulta no vuelva a pasar por la RLS de
-- civic.campaigns, lo que provocaría recursión.
CREATE OR REPLACE FUNCTION civic_ops.current_org_campaign_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = civic, civic_ops, pg_temp
AS $$
    SELECT COALESCE(array_agg(c.id), ARRAY[]::UUID[])
    FROM   civic.campaigns c
    WHERE  c.organization_id = civic_ops.current_org_id();
$$;

COMMENT ON FUNCTION civic_ops.current_org_campaign_ids IS
    'Campañas de la organización activa. Base de la RLS en las tablas de detalle que no llevan organization_id.';

-- =============================================================================
-- 2. POLÍTICAS
--    Se activan sobre las tablas con datos de tenant. Los catálogos quedan
--    fuera: son públicos y compartidos entre organizaciones.
-- =============================================================================
DO $$
DECLARE
    t              TEXT;
    -- Tablas que llevan organization_id propio.
    v_by_org       TEXT[] := ARRAY[
        'campaigns','contenders','topics','sources','audience_segments',
        'ingestion_batches','contents','content_annotations','inferences',
        'analysis_jobs','alert_rules','alerts','alert_subscriptions',
        'eval_datasets','eval_runs'
    ];
    -- Tablas de detalle que sólo llevan campaign_id.
    v_by_campaign  TEXT[] := ARRAY[
        'inference_emotions','inference_stances','inference_topics',
        'inference_entities','inference_risk_flags','inference_keywords'
    ];
BEGIN
    -- 2.1 organizations: se filtra por su propio id.
    ALTER TABLE civic.organizations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE civic.organizations FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS p_tenant_isolation ON civic.organizations;
    CREATE POLICY p_tenant_isolation ON civic.organizations
        USING (id = civic_ops.current_org_id())
        WITH CHECK (id = civic_ops.current_org_id());

    -- 2.2 geo_areas: admite filas globales compartidas (organization_id NULL).
    ALTER TABLE civic.geo_areas ENABLE ROW LEVEL SECURITY;
    ALTER TABLE civic.geo_areas FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS p_tenant_isolation ON civic.geo_areas;
    CREATE POLICY p_tenant_isolation ON civic.geo_areas
        USING (organization_id IS NULL OR organization_id = civic_ops.current_org_id())
        WITH CHECK (organization_id = civic_ops.current_org_id());

    -- 2.3 Tablas con organization_id.
    FOREACH t IN ARRAY v_by_org LOOP
        EXECUTE format('ALTER TABLE civic.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE civic.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS p_tenant_isolation ON civic.%I', t);
        EXECUTE format($f$
            CREATE POLICY p_tenant_isolation ON civic.%I
            USING (organization_id = civic_ops.current_org_id())
            WITH CHECK (organization_id = civic_ops.current_org_id())
        $f$, t);
    END LOOP;

    -- 2.4 Tablas de detalle: se filtran por la campaña.
    FOREACH t IN ARRAY v_by_campaign LOOP
        EXECUTE format('ALTER TABLE civic.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE civic.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS p_tenant_isolation ON civic.%I', t);
        EXECUTE format($f$
            CREATE POLICY p_tenant_isolation ON civic.%I
            USING (campaign_id = ANY (civic_ops.current_org_campaign_ids()))
            WITH CHECK (campaign_id = ANY (civic_ops.current_org_campaign_ids()))
        $f$, t);
    END LOOP;

    RAISE NOTICE 'RLS habilitada en % tablas (% por organización, % por campaña, 2 especiales).',
        cardinality(v_by_org) + cardinality(v_by_campaign) + 2,
        cardinality(v_by_org), cardinality(v_by_campaign);
END
$$;

-- El dueño del esquema y los procesos de mantenimiento necesitan saltarse RLS.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civicpulse_owner') THEN
        ALTER ROLE civicpulse_owner BYPASSRLS;
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Sin privilegio para asignar BYPASSRLS a civicpulse_owner. Hágalo como superusuario.';
END
$$;

-- =============================================================================
-- 3. VISTA CON TEXTO REDACTADO PARA AUDITORÍA
--    El rol auditor necesita verificar el funcionamiento sin leer opiniones
--    individuales identificables. Se le da el metadato, no el texto.
-- =============================================================================
CREATE OR REPLACE VIEW civic_api.inferences_redacted AS
SELECT
    id, seq, campaign_id, campaign_code, content_id, published_at, analyzed_at,
    left(civic_ops.redact_pii(text), 120) || CASE WHEN length(text) > 120 THEN '…' ELSE '' END AS text_preview,
    length(text)        AS text_length,
    language_code, source_type, source_label,
    sentiment_code, sentiment_score, sentiment_confidence,
    intent_code, toxicity_score, sarcasm_score, overall_confidence,
    needs_review, review_status, model_name, pipeline,
    emotions, topics, risk_flags
FROM civic_api.inferences;

COMMENT ON VIEW civic_api.inferences_redacted IS
    'Vista para el rol auditor: metadatos completos, texto truncado y con PII enmascarada. '
    'Permite verificar el sistema sin exponer opiniones individuales completas.';

-- =============================================================================
-- 4. RETENCIÓN Y PURGA
-- =============================================================================

-- 4.1 Purga de la carga original (`raw`), que es lo más pesado y lo primero
--     que deja de ser necesario tras el análisis.
CREATE OR REPLACE FUNCTION civic_ops.purge_raw_payloads(p_older_than_days INTEGER DEFAULT 30)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, civic_ops, pg_temp
AS $$
DECLARE v_n BIGINT;
BEGIN
    UPDATE civic.contents
       SET raw = NULL
     WHERE raw IS NOT NULL
       AND processing_status = 'analyzed'
       AND collected_at < NOW() - (p_older_than_days || ' days')::interval;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    INSERT INTO civic_ops.audit_log (action, schema_name, table_name, context)
    VALUES ('PURGE_RAW', 'civic', 'contents',
            jsonb_build_object('rows', v_n, 'older_than_days', p_older_than_days));
    RETURN v_n;
END;
$$;

-- 4.2 Purga por retención. Elimina contenidos vencidos según purge_after.
--     Las inferencias caen en cascada por la FK.
CREATE OR REPLACE FUNCTION civic_ops.purge_expired_contents(
    p_batch_size INTEGER DEFAULT 10000,
    p_dry_run    BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (organization_id UUID, rows_affected BIGINT, dry_run BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, civic_ops, pg_temp
AS $$
DECLARE
    r     RECORD;
    v_n   BIGINT;
BEGIN
    FOR r IN
        SELECT ct.organization_id, count(*) AS n
        FROM   civic.contents ct
        WHERE  ct.purge_after IS NOT NULL AND ct.purge_after < CURRENT_DATE
        GROUP  BY ct.organization_id
    LOOP
        IF p_dry_run THEN
            organization_id := r.organization_id; rows_affected := r.n; dry_run := TRUE;
            RETURN NEXT;
            CONTINUE;
        END IF;

        DELETE FROM civic.contents ct
        WHERE ct.ctid IN (
            SELECT c2.ctid FROM civic.contents c2
            WHERE c2.organization_id = r.organization_id
              AND c2.purge_after < CURRENT_DATE
            LIMIT p_batch_size
        );
        GET DIAGNOSTICS v_n = ROW_COUNT;

        INSERT INTO civic_ops.audit_log (action, schema_name, table_name, context)
        VALUES ('PURGE_RETENTION', 'civic', 'contents',
                jsonb_build_object('organization_id', r.organization_id, 'rows', v_n));

        organization_id := r.organization_id; rows_affected := v_n; dry_run := FALSE;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION civic_ops.purge_expired_contents IS
    'Purga por retención. Por defecto en modo simulación: revise el conteo antes de ejecutar con p_dry_run = FALSE.';

-- 4.3 Derecho de supresión: borra todo lo asociado a un autor.
CREATE OR REPLACE FUNCTION civic_ops.erase_author(
    p_organization_id UUID,
    p_author_hash     BYTEA,
    p_reason          TEXT DEFAULT 'solicitud del titular'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = civic, civic_ops, pg_temp
AS $$
DECLARE v_n BIGINT;
BEGIN
    IF p_author_hash IS NULL THEN
        RAISE EXCEPTION 'author_hash es obligatorio.' USING ERRCODE = '22004';
    END IF;

    DELETE FROM civic.contents
     WHERE organization_id = p_organization_id AND author_hash = p_author_hash;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    INSERT INTO civic_ops.audit_log (action, schema_name, table_name, context)
    VALUES ('ERASE_AUTHOR', 'civic', 'contents',
            jsonb_build_object('organization_id', p_organization_id,
                               'author_hash', encode(p_author_hash,'hex'),
                               'rows', v_n, 'reason', p_reason));
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION civic_ops.erase_author IS
    'Atiende el derecho de supresión: elimina todo el contenido de un autor y deja constancia en la bitácora. '
    'Las inferencias asociadas se borran en cascada.';

-- =============================================================================
-- 5. PANEL DE CUMPLIMIENTO
--    Una sola consulta para responder a una auditoría.
-- =============================================================================
CREATE OR REPLACE VIEW civic_ops.v_compliance_status AS
SELECT
    o.id                        AS organization_id,
    o.name                      AS organization,
    o.pii_policy,
    o.data_retention_days,
    o.dpo_contact IS NOT NULL   AS has_dpo_contact,
    (SELECT count(*) FROM civic.sources s
      JOIN civic_cat.source_types st ON st.code = s.type_code
     WHERE s.organization_id = o.id AND st.requires_consent AND s.legal_basis IS NULL)
                                AS sources_missing_legal_basis,
    (SELECT count(*) FROM civic.contents c
     WHERE c.organization_id = o.id AND c.purge_after < CURRENT_DATE)
                                AS contents_past_retention,
    (SELECT count(*) FROM civic.contents c
     WHERE c.organization_id = o.id AND c.author_display IS NOT NULL)
                                AS contents_with_author_identity,
    (SELECT count(*) FROM civic.contents c
     WHERE c.organization_id = o.id AND c.raw IS NOT NULL
       AND c.collected_at < NOW() - INTERVAL '30 days')
                                AS stale_raw_payloads,
    (SELECT count(*) FROM civic.alert_subscriptions s
     WHERE s.organization_id = o.id AND s.is_active
       AND s.channel IN ('whatsapp','email') AND s.consent_given_at IS NULL)
                                AS subscriptions_without_consent,
    (SELECT count(*) FROM civic.inference_risk_flags f
      JOIN civic_cat.risk_flags rf ON rf.code = f.flag_code
      JOIN civic.campaigns cm ON cm.id = f.campaign_id
     WHERE cm.organization_id = o.id AND rf.requires_human_review
       AND f.review_state = 'pending')
                                AS risk_flags_pending_review,
    (SELECT count(*) FROM civic.model_providers mp
      JOIN civic.ai_models m ON m.provider_id = mp.id
     WHERE m.status = 'active' AND mp.kind = 'llm_api' AND NOT mp.no_training_clause)
                                AS active_providers_without_no_training_clause
FROM civic.organizations o
WHERE o.status = 'active';

COMMENT ON VIEW civic_ops.v_compliance_status IS
    'Estado de cumplimiento por organización. Todas las columnas de conteo deben ser 0 en operación normal.';

-- =============================================================================
-- 6. PROGRAMACIÓN DE MANTENIMIENTO
-- =============================================================================
DO $$
BEGIN
    IF civic_ops.has_ext('pg_cron') THEN
        PERFORM cron.schedule('oeste-sentimientos-purge-raw',  '0 4 * * *',
                              'SELECT civic_ops.purge_raw_payloads(30)');
        PERFORM cron.schedule('oeste-sentimientos-purge-retention', '0 5 * * 0',
                              'SELECT * FROM civic_ops.purge_expired_contents(50000, false)');
        RAISE NOTICE 'pg_cron: purga de payloads diaria 04:00, purga por retención semanal domingo 05:00.';
    ELSE
        RAISE NOTICE 'Sin pg_cron. Programe externamente:';
        RAISE NOTICE '  0 4 * * *  psql -c "SELECT civic_ops.purge_raw_payloads(30)"';
        RAISE NOTICE '  0 5 * * 0  psql -c "SELECT * FROM civic_ops.purge_expired_contents(50000,false)"';
    END IF;
END
$$;

-- =============================================================================
-- 6b. SECURITY INVOKER EN LAS VISTAS DE LA API
--
--     Debe ejecutarse DESPUÉS de crear todas las vistas de civic_api, incluida
--     inferences_redacted de la sección 3. Una vista sin security_invoker se
--     evalúa con los permisos de su dueño y saltaría la RLS del llamante, que
--     es exactamente el agujero que este archivo pretende cerrar.
-- =============================================================================
DO $$
DECLARE v RECORD; v_n INTEGER := 0;
BEGIN
    IF current_setting('server_version_num')::int >= 150000 THEN
        FOR v IN SELECT table_name FROM information_schema.views WHERE table_schema = 'civic_api' LOOP
            EXECUTE format('ALTER VIEW civic_api.%I SET (security_invoker = true)', v.table_name);
            v_n := v_n + 1;
        END LOOP;
        RAISE NOTICE 'security_invoker activado en % vistas de civic_api: respetan la RLS del llamante.', v_n;
    ELSE
        RAISE WARNING 'PostgreSQL < 15: las vistas de civic_api NO propagan RLS. '
                      'Filtre por organización en la capa de aplicación o actualice el servidor.';
    END IF;
END
$$;

-- =============================================================================
-- 7. COMPROBACIÓN DEL AISLAMIENTO
--
--    PostgreSQL NO aplica RLS a los superusuarios ni a los roles con BYPASSRLS.
--    Es comportamiento documentado, y es la forma más común de que un despliegue
--    con RLS "activa" no aísle absolutamente nada: la aplicación se conecta con
--    el usuario `postgres` del contenedor y ve todos los tenants.
--
--    Esta función lo detecta. Llámela desde el arranque de cada servicio.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_ops.check_isolation()
RETURNS TABLE (check_name TEXT, status TEXT, detail TEXT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_super   BOOLEAN;
    v_bypass  BOOLEAN;
    v_tables  INTEGER;
    v_no_rls  TEXT;
    v_ctx     UUID;
BEGIN
    SELECT rolsuper, rolbypassrls INTO v_super, v_bypass
      FROM pg_roles WHERE rolname = current_user;

    -- 1. El rol de conexión no debe poder saltarse RLS.
    check_name := 'rol_sin_bypass_rls';
    IF v_super OR v_bypass THEN
        status := 'FALLO';
        detail := format(
            'El rol "%s" es %s y por tanto IGNORA la RLS: verá los datos de todas las organizaciones. '
            'Cree un rol de aplicación con NOSUPERUSER NOBYPASSRLS y conéctese con él.',
            current_user,
            CASE WHEN v_super THEN 'superusuario' ELSE 'BYPASSRLS' END);
    ELSE
        status := 'OK';
        detail := format('El rol "%s" está sujeto a RLS.', current_user);
    END IF;
    RETURN NEXT;

    -- 2. Todas las tablas de dominio deben tener RLS habilitada.
    SELECT count(*) INTO v_tables FROM pg_tables
     WHERE schemaname = 'civic' AND rowsecurity;

    SELECT string_agg(tablename, ', ') INTO v_no_rls
      FROM pg_tables
     WHERE schemaname = 'civic' AND NOT rowsecurity
       AND tablename IN (
           'organizations','campaigns','contenders','topics','sources','contents',
           'inferences','alerts','alert_rules','analysis_jobs');

    check_name := 'rls_habilitada';
    IF v_no_rls IS NULL THEN
        status := 'OK';
        detail := format('%s tablas con RLS activa.', v_tables);
    ELSE
        status := 'FALLO';
        detail := format('Sin RLS: %s', v_no_rls);
    END IF;
    RETURN NEXT;

    -- 3. Las vistas de civic_api deben respetar la RLS del llamante.
    check_name := 'vistas_security_invoker';
    IF current_setting('server_version_num')::int < 150000 THEN
        status := 'ADVERTENCIA';
        detail := 'PostgreSQL < 15: las vistas no propagan RLS. Filtre por organización en la aplicación.';
    ELSIF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'civic_api' AND c.relkind = 'v'
          AND NOT COALESCE((c.reloptions::text[] @> ARRAY['security_invoker=true']), FALSE)
    ) THEN
        status := 'FALLO';
        detail := 'Alguna vista de civic_api no tiene security_invoker: podría exponer datos de otros tenants.';
    ELSE
        status := 'OK';
        detail := 'Todas las vistas de civic_api son security_invoker.';
    END IF;
    RETURN NEXT;

    -- 4. Contexto de sesión presente.
    v_ctx := civic_ops.current_org_id();
    check_name := 'contexto_de_sesion';
    IF v_ctx IS NULL THEN
        status := 'INFO';
        detail := 'Sin organización activa en esta sesión: toda consulta devolverá cero filas. '
               || 'Llame a civic_ops.set_session_context() al inicio de cada transacción.';
    ELSE
        status := 'OK';
        detail := format('Organización activa: %s', v_ctx);
    END IF;
    RETURN NEXT;

    -- 5. Pepper de seudonimización.
    check_name := 'pepper_configurado';
    IF COALESCE(current_setting('civicpulse.author_pepper', true), '') = '' THEN
        status := 'FALLO';
        detail := 'civicpulse.author_pepper sin configurar: los hashes de autor son reversibles por fuerza bruta. '
               || 'Ejecute: ALTER DATABASE <base> SET civicpulse.author_pepper = ''<secreto>'';';
    ELSE
        status := 'OK';
        detail := 'Pepper configurado.';
    END IF;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION civic_ops.check_isolation IS
    'Verifica que el aislamiento multi-tenant esté realmente activo. Ejecútela desde el arranque '
    'de cada servicio y aborte si algún resultado es FALLO. El caso más frecuente y más silencioso '
    'es conectarse con un superusuario: PostgreSQL no le aplica RLS y la aplicación ve todos los tenants.';

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE
    v_n     INTEGER;
    v_super BOOLEAN;
BEGIN
    SELECT count(*) INTO v_n FROM pg_tables WHERE schemaname = 'civic' AND rowsecurity;
    SELECT rolsuper INTO v_super FROM pg_roles WHERE rolname = current_user;

    RAISE NOTICE '── RLS activa en % tablas ──', v_n;
    RAISE NOTICE '   Fije el contexto en CADA transacción:';
    RAISE NOTICE '     SELECT civic_ops.set_session_context(''<org-uuid>'', ''<sub>'', ''<usuario>'');';
    RAISE NOTICE '   Compruebe el aislamiento con: SELECT * FROM civic_ops.check_isolation();';

    IF v_super THEN
        RAISE WARNING 'La sesión actual (%) es superusuario: PostgreSQL NO le aplica RLS.', current_user;
        RAISE WARNING 'Está bien para instalar el esquema, pero la APLICACIÓN debe conectarse con un';
        RAISE WARNING 'rol NOSUPERUSER NOBYPASSRLS. De lo contrario cada tenant verá los datos de todos.';
    END IF;
END
$$;
