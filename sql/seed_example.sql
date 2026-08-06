-- =============================================================================
-- Análisis de Sentimientos · seed_example.sql
-- PLANTILLA DE ALTA. No inserta nada tal como está.
--
-- Todo el archivo está comentado a propósito: usted pidió la instancia sin
-- datos semilla. Descomente los bloques, sustituya los valores entre << >> y
-- ejecute por partes, en este orden.
--
--   psql -d oeste-sentimientos -v ON_ERROR_STOP=1 -f sql/seed_example.sql
--
-- Cada bloque explica qué campos son críticos y por qué. Los que afectan a la
-- calidad de la medición están marcados con «CRÍTICO».
--
-- Los bloques van comentados línea a línea con «-- », no con /* */. La razón es
-- que las expresiones cron de las fuentes contienen la secuencia */ (como en
-- «*/30 * * * *»), que cierra un comentario de bloque a mitad de camino y hace
-- que el resto del archivo se interprete como SQL.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_ops, public;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '  Esta plantilla NO inserta datos. Descomente los bloques que'
\echo '  necesite y sustituya los valores entre << >>.'
\echo '════════════════════════════════════════════════════════════════'
\echo ''


-- =============================================================================
-- BLOQUE 1 · ORGANIZACIÓN
-- =============================================================================
-- pii_policy determina cómo se tratan los datos personales y NO es reversible
-- para los registros ya ingeridos:
--   pseudonymize      → hash del autor, sin nombre visible. Opción por defecto.
--   redact            → además enmascara correos y teléfonos dentro del texto.
--   store_with_consent→ conserva identificadores. Sólo con base legal documentada.
--
-- data_retention_days fija la fecha de purga de cada contenido al insertarlo.
-- Cambiarlo después no reescribe los ya cargados.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- INSERT INTO civic.organizations (
--     name, slug, legal_name, org_type, country_code, timezone,
--     default_language, plan_type, status,
--     max_campaigns, max_sources, data_retention_days, pii_policy, dpo_contact,
--     settings, branding
-- ) VALUES (
--     '<<Nombre de la organización>>',
--     '<<slug-de-la-organizacion>>',            -- minúsculas, guiones, único
--     '<<Razón social completa>>',
--     'consultancy',                            -- party|campaign_team|government|media|consultancy|ngo|academic|other
--     '<<MX>>',                                 -- ISO 3166-1 alpha-2, o NULL
--     '<<America/Mexico_City>>',                -- zona IANA
--     'es',
--     'professional',
--     'active',
--     10,                                       -- máximo de campañas
--     30,                                       -- máximo de fuentes
--     730,                                      -- retención en días (mín. 30, máx. 3650)
--     'pseudonymize',
--     '<<privacidad@ejemplo.mx>>',              -- responsable de protección de datos
--     jsonb_build_object(
--         'digest_frequency', 'daily',
--         'default_alert_channels', jsonb_build_array('sse','email')
--     ),
--     jsonb_build_object(
--         'primary_color', '#1F5FA8',
--         'logo_url', null
--     )
-- );
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 2 · GEOGRAFÍA (opcional pero recomendado)
-- =============================================================================
-- El árbol es agnóstico de país: usted define los niveles que necesite.
-- electorate_size es el denominador de los indicadores per cápita; sin él, el
-- mapa compara territorios de tamaños muy distintos y las zonas grandes dominan.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH org AS (SELECT id FROM civic.organizations WHERE slug = '<<slug-de-la-organizacion>>')
-- INSERT INTO civic.geo_areas (organization_id, parent_id, level_code, name, official_code, electorate_size)
-- SELECT org.id, NULL, 'country', '<<País>>', '<<MX>>', <<98000000>> FROM org;
--
-- -- Un nivel inferior, colgando del anterior:
-- WITH org    AS (SELECT id FROM civic.organizations WHERE slug = '<<slug-de-la-organizacion>>'),
--      parent AS (SELECT id FROM civic.geo_areas WHERE official_code = '<<MX>>')
-- INSERT INTO civic.geo_areas (organization_id, parent_id, level_code, name, official_code, electorate_size)
-- SELECT org.id, parent.id, 'state', '<<Nombre del estado>>', '<<clave-oficial>>', <<5000000>>
-- FROM org, parent;
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 3 · CAMPAÑA
-- =============================================================================
-- `code` es el identificador público: viaja en todas las URLs de la API y en
-- el frontend. Elíjalo estable y en mayúsculas; cambiarlo rompe los enlaces.
--
-- CRÍTICO — election_date: es el eje temporal de todos los tableros («faltan N días»).
-- CRÍTICO — blackout_*: durante la veda la plataforma sigue midiendo pero suspende
--           las notificaciones proactivas y marca los informes. Configúrelo.
-- CRÍTICO — thresholds: los umbrales por defecto de las alertas. Ajústelos tras
--           dos semanas de operación, cuando conozca la línea base real de sus
--           canales. Los valores iniciales son conservadores, no universales.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH org  AS (SELECT id FROM civic.organizations WHERE slug = '<<slug-de-la-organizacion>>'),
--      geo  AS (SELECT id FROM civic.geo_areas WHERE official_code = '<<clave-oficial>>')
-- INSERT INTO civic.campaigns (
--     organization_id, code, name, slug, objective,
--     campaign_kind, contest_label, geo_area_id,
--     default_language, languages, timezone, status,
--     starts_on, ends_on, election_date,
--     blackout_starts_on, blackout_ends_on,
--     thresholds
-- )
-- SELECT
--     org.id,
--     '<<CAMP-2027-01>>',                       -- MAYÚSCULAS, dígitos y guiones
--     '<<Nombre de la campaña>>',
--     '<<nombre-de-la-campana>>',
--     '<<Objetivo del monitoreo en una o dos frases.>>',
--     'electoral',                              -- electoral|referendum|governance|issue_advocacy|reputation|pre_campaign|post_election
--     '<<Cargo o pregunta en disputa>>',
--     geo.id,
--     'es',
--     ARRAY['es','en']::civic.lang_code[],
--     '<<America/Mexico_City>>',
--     'active',
--     '<<2027-03-01>>'::date,                   -- inicio del monitoreo
--     '<<2027-06-15>>'::date,
--     '<<2027-06-06>>'::date,                   -- día de la elección
--     '<<2027-06-03>>'::date,                   -- inicio de veda
--     '<<2027-06-06>>'::date,                   -- fin de veda
--     jsonb_build_object(
--         'negative_pct',      35.0,            -- alerta si el % negativo lo supera
--         'net_sentiment_min', -0.20,
--         'volume_zscore',      3.0,            -- desviaciones sobre la media móvil
--         'toxicity_avg',       0.55,
--         'min_confidence',     0.60,
--         'sov_drop_pct',      20.0
--     )
-- FROM org, geo;
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 4 · CONTENDIENTES
-- =============================================================================
-- CRÍTICO — Esta es la configuración que más determina la calidad del tablero
-- competitivo. Un actor con pocos alias aparecerá artificialmente poco y su
-- «share of voice» estará subestimado, lo que invalida toda comparación.
--
-- Reglas prácticas:
--   · aliases: incluya apodos, abreviaturas, errores ortográficos frecuentes,
--     nombre sin acentos, apellido solo, iniciales. Apunte a 6-10 por actor.
--   · negative_terms: nombres parecidos que NO son este actor. Sin esto, dos
--     personas con el mismo apellido se mezclan y ambos números quedan mal.
--   · handles: las cuentas propias. Permiten atribución por regla en lugar de
--     por inferencia, que es más precisa y auditable.
--   · baseline_support_pct: si tiene una encuesta probabilística, cárguela.
--     El dato digital NO es representativo; sirve para ver tendencia, no nivel.
--     Tenerla al lado evita que alguien lea el apoyo neto como intención de voto.
--
-- Marque is_own = true SOLO en su actor. Cambia la lectura de todos los
-- indicadores y activa la auditoría de sesgo hacia el actor propio.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH camp AS (SELECT id, organization_id FROM civic.campaigns WHERE code = '<<CAMP-2027-01>>')
-- INSERT INTO civic.contenders (
--     organization_id, campaign_id, type_code, name, slug, short_name,
--     is_own, affiliation, aliases, handles, negative_terms,
--     color_hex, display_order,
--     baseline_support_pct, baseline_source, baseline_date
-- )
-- SELECT camp.organization_id, camp.id, v.tipo, v.nombre, v.slug, v.corto,
--        v.propio, v.afiliacion, v.alias, v.cuentas::jsonb, v.negativos,
--        v.color, v.orden, v.base_pct, v.base_fuente, v.base_fecha::date
-- FROM camp, (VALUES
--   ('candidate', '<<Nombre Completo A>>', '<<nombre-a>>', '<<A>>', TRUE,
--    '<<Partido o coalición>>',
--    ARRAY['<<Apodo>>','<<Apellido>>','<<N. Completo>>','<<Nombre sin acentos>>'],
--    '{"x_twitter":"<<@cuenta>>","facebook":"<<pagina>>","tiktok":"<<@cuenta>>"}',
--    ARRAY['<<Homónimo que no es este actor>>'],
--    '#1F5FA8', 1, <<34.5>>, '<<Casa encuestadora, muestra n=1200>>', '<<2027-03-15>>'),
--
--   ('candidate', '<<Nombre Completo B>>', '<<nombre-b>>', '<<B>>', FALSE,
--    '<<Partido>>',
--    ARRAY['<<Apodo>>','<<Apellido>>'],
--    '{"x_twitter":"<<@cuenta>>"}',
--    ARRAY[]::text[],
--    '#C0392B', 2, <<28.1>>, '<<Misma encuesta>>', '<<2027-03-15>>')
-- ) AS v(tipo, nombre, slug, corto, propio, afiliacion, alias, cuentas,
--        negativos, color, orden, base_pct, base_fuente, base_fecha);
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 5 · TEMAS DE LA CAMPAÑA
-- =============================================================================
-- Instancia local de la taxonomía global. Marque is_owned_issue en los temas
-- donde su actor quiere ser el referente: perder terreno ahí es más grave que
-- en un tema ajeno, y el tablero lo señala distinto.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH camp AS (SELECT id, organization_id FROM civic.campaigns WHERE code = '<<CAMP-2027-01>>')
-- INSERT INTO civic.topics (organization_id, campaign_id, category_code, name, slug,
--                           keywords, is_owned_issue, priority)
-- SELECT camp.organization_id, camp.id, v.cat, v.nombre, v.slug, v.kw, v.propio, v.prio
-- FROM camp, (VALUES
--   ('security',       '<<Seguridad>>',      '<<seguridad>>',      ARRAY['<<término>>','<<término>>'], TRUE,  1),
--   ('economy',        '<<Economía>>',       '<<economia>>',       ARRAY['<<término>>'],               FALSE, 2),
--   ('social_programs','<<Apoyos>>',         '<<apoyos>>',         ARRAY['<<término>>'],               TRUE,  1)
-- ) AS v(cat, nombre, slug, kw, propio, prio);
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 6 · FUENTES
-- =============================================================================
-- CRÍTICO — legal_basis es obligatoria en canales privados (whatsapp, telegram,
-- sms, survey, call_center, email, crm). Un trigger rechaza el alta sin ella.
--
-- credentials_ref apunta al gestor de secretos, NUNCA la credencial en claro.
--
-- lag_alert_minutes define cuándo se considera caída la fuente. Ajústelo al
-- ritmo real de cada canal: una fuente de noticias puede pasar 6 h sin nada
-- nuevo y estar sana; un stream de X que calla 30 minutos, no.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH camp AS (SELECT id, organization_id FROM civic.campaigns WHERE code = '<<CAMP-2027-01>>')
-- INSERT INTO civic.sources (
--     organization_id, campaign_id, type_code, name, slug, status,
--     collection_mode, collection_schedule, credentials_ref, legal_basis,
--     lag_alert_minutes, config
-- )
-- SELECT camp.organization_id, camp.id, v.tipo, v.nombre, v.slug, 'inactive',
--        v.modo, v.cron, v.cred, v.base_legal, v.lag, v.conf::jsonb
-- FROM camp, (VALUES
--   ('x_twitter', '<<X — monitoreo>>', '<<x-monitoreo>>', 'streaming', NULL,
--    'vault://<<campana>>/x-api', 'public_interest', 60,
--    '{"keywords":["<<término>>"],"languages":["es"],"exclude_retweets":false,"batch_size":500}'),
--
--   ('facebook',  '<<Facebook — páginas>>', '<<facebook>>', 'webhook', '0 */6 * * *',
--    'vault://<<campana>>/facebook', 'public_interest', 360,
--    '{"pages":[{"page_id":"<<id>>","monitor":["posts","comments"]}]}'),
--
--   ('news_web',  '<<Medios digitales>>', '<<medios>>', 'polling', '*/30 * * * *',
--    NULL, 'public_interest', 180,
--    '{"feeds":["<<https://ejemplo.mx/rss>>"],"min_length_chars":200}')
-- ) AS v(tipo, nombre, slug, modo, cron, cred, base_legal, lag, conf);
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 7 · PIPELINE DE CLASIFICACIÓN
-- =============================================================================
-- Vincula cada tarea NLP con un modelo y una versión de prompt.
-- Los modelos vienen registrados como 'inactive' desde 05_ai_models.sql:
-- actívelos y ajuste model_identifier a lo que su proveedor exponga realmente.
--
-- min_confidence: por debajo, la inferencia va a revisión humana.
-- fallback_threshold: por debajo, se reintenta con el modelo de respaldo.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- -- 7.1 Activar los modelos que vaya a usar.
--     El primario es Gemini (gemini-flash-lite-latest). Si no va a configurar un
--     proveedor de respaldo distinto, active sólo el primario.
-- UPDATE civic.ai_models SET status = 'active'
--  WHERE code IN ('llm-classifier-primary');
--
--     Con respaldo en otro proveedor (recomendado: uno en la misma API cae con ella):
-- UPDATE civic.ai_models SET status = 'active'
--  WHERE code IN ('llm-classifier-primary', 'llm-classifier-fallback');
--
-- -- 7.2 Promover la versión de prompt (SÓLO tras evaluarla; ver prompts/02_evaluacion.md)
-- -- UPDATE civic.prompt_versions SET status = 'active', promoted_by = '<<su-usuario>>'
-- --  WHERE version = 'v1.0.0'
-- --    AND template_id = (SELECT id FROM civic.prompt_templates WHERE code = 'civic-comment-classifier');
--
-- -- 7.3 Configurar el pipeline de la campaña
-- WITH camp AS (SELECT id FROM civic.campaigns WHERE code = '<<CAMP-2027-01>>'),
--      m    AS (SELECT id FROM civic.ai_models WHERE code = 'llm-classifier-primary'),
--      fb   AS (SELECT id FROM civic.ai_models WHERE code = 'llm-classifier-fallback'),
--      pv   AS (SELECT v.id FROM civic.prompt_versions v
--               JOIN civic.prompt_templates t ON t.id = v.template_id
--               WHERE t.code = 'civic-comment-classifier' AND v.version = 'v1.0.0')
-- INSERT INTO civic.campaign_pipeline (campaign_id, task_code, model_id, prompt_version_id,
--                                      fallback_model_id, min_confidence, fallback_threshold)
-- SELECT camp.id, t.code, m.id, pv.id, fb.id, 0.60, 0.45   -- min_confidence, fallback_threshold
-- FROM camp, m, fb, pv,
--      unnest(ARRAY['sentiment','stance','emotions','intent','topics','ner','risk_flags']) AS t(code);
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 8 · REGLAS DE ALERTA
-- =============================================================================
-- CRÍTICO — min_sample_size es la guarda más importante contra falsas alarmas.
-- Sin ella, 2 comentarios negativos de 2 totales dan 100 % de negatividad y
-- disparan una alerta crítica. Nunca la ponga por debajo de 30.
--
-- consecutive_hits añade histéresis: exige N evaluaciones seguidas en condición.
-- cooldown_minutes evita la avalancha que hace que el equipo silencie el canal.
--
-- Las métricas válidas están en civic_kpi.metric_registry. Consúltelas con:
--   SELECT code, label_es, unit, min_sample_size, caveat FROM civic_kpi.metric_registry;

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH camp AS (SELECT id, organization_id, code FROM civic.campaigns WHERE code = '<<CAMP-2027-01>>')
-- INSERT INTO civic.alert_rules (
--     organization_id, campaign_id, campaign_code, name,
--     alert_type_code, severity_code, metric, operator, threshold,
--     window_minutes, min_sample_size, consecutive_hits, cooldown_minutes,
--     max_per_day, respect_blackout, quiet_hours_start, quiet_hours_end, channels
-- )
-- SELECT camp.organization_id, camp.id, camp.code, v.nombre,
--        v.tipo, v.sev, v.metrica, v.op, v.umbral,
--        v.ventana, v.muestra, v.rachas, v.enfriamiento,
--        v.tope, TRUE, 23, 7, v.canales
-- FROM camp, (VALUES
--   ('Pico de negatividad',      'negative_spike', 'high',     'negative_pct',        'gt',  40.0, 180,  50, 2, 180, 6, ARRAY['sse','email']),
--   ('Volumen anómalo',          'volume_spike',   'medium',   'volume_zscore',       'gt',   3.0,  60,  30, 1, 120, 8, ARRAY['sse']),
--   ('Caída de sentimiento',     'sentiment_drop', 'high',     'net_sentiment_delta', 'lt',  -0.20, 360, 100, 2, 240, 4, ARRAY['sse','email']),
--   ('Amenazas detectadas',      'threat_detected','critical', 'threat_count',        'gt',   0.0,  60,   1, 1,  30, 20, ARRAY['sse','email','whatsapp']),
--   ('Toxicidad elevada',        'toxicity',       'medium',   'toxicity_avg',        'gt',   0.55, 180,  50, 2, 240, 4, ARRAY['sse']),
--   ('Fuente sin reportar',      'ingestion_failure','high',   'source_lag_minutes',  'gt', 120.0,  60,   1, 1,  60, 6, ARRAY['sse','email']),
--   ('Deriva del clasificador',  'model_drift',    'medium',   'confidence_avg',      'lt',   0.65, 1440, 200, 1, 1440, 1, ARRAY['sse'])
-- ) AS v(nombre, tipo, sev, metrica, op, umbral, ventana, muestra, rachas, enfriamiento, tope, canales);
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 9 · SUSCRIPTORES DE ALERTAS
-- =============================================================================
-- CRÍTICO — consent_given_at es obligatorio en whatsapp y email. Un trigger
-- rechaza el alta sin él. Registre también de dónde salió el consentimiento.

-- ┌─ descomente desde aquí (quite el «-- ») ─────────────────────────────────
-- WITH camp AS (SELECT id, organization_id, code FROM civic.campaigns WHERE code = '<<CAMP-2027-01>>')
-- INSERT INTO civic.alert_subscriptions (
--     organization_id, campaign_id, campaign_code, channel, destination,
--     display_name, min_severity, consent_given_at, consent_source
-- )
-- SELECT camp.organization_id, camp.id, camp.code, 'email',
--        '<<responsable@ejemplo.mx>>', '<<Nombre>>', 'high',
--        NOW(), '<<Alta interna del equipo, registro en RRHH>>'
-- FROM camp;
-- └─ hasta aquí ────────────────────────────────────────────────────────────


-- =============================================================================
-- BLOQUE 10 · VERIFICACIÓN POSTERIOR AL ALTA
-- =============================================================================
-- Ejecute esto después de descomentar e insertar. Todas las columnas de conteo
-- del panel de cumplimiento deben ser 0.

\echo '── Organizaciones registradas ──'
SELECT name, slug, pii_policy, data_retention_days, dpo_contact IS NOT NULL AS tiene_dpo
FROM civic.organizations WHERE status = 'active';

\echo '── Campañas ──'
SELECT code, name, status, campaign_kind, election_date, days_to_election,
       in_blackout, contender_count, active_source_count
FROM civic_api.campaigns;

\echo '── Cumplimiento (todo debe ser 0) ──'
SELECT organization, sources_missing_legal_basis, subscriptions_without_consent,
       contents_past_retention, active_providers_without_no_training_clause
FROM civic_ops.v_compliance_status;

\echo '── Cobertura de alias por contendiente (desequilibrios sesgan el tablero) ──'
SELECT c.name, c.is_own, cardinality(c.aliases) AS n_alias,
       jsonb_object_keys_count.n AS n_cuentas
FROM civic.contenders c
CROSS JOIN LATERAL (SELECT count(*) AS n FROM jsonb_object_keys(c.handles)) jsonb_object_keys_count
WHERE c.status = 'active'
ORDER BY n_alias;

\echo '── Reglas de alerta y su guarda de muestra mínima ──'
SELECT name, metric, operator, threshold, window_minutes, min_sample_size,
       consecutive_hits, cooldown_minutes, channels
FROM civic.alert_rules WHERE is_enabled ORDER BY name;

\echo '── Estado del pipeline de clasificación ──'
SELECT p.task_code, m.name AS modelo, m.status AS estado_modelo,
       v.version AS prompt, v.status AS estado_prompt, p.min_confidence
FROM civic.campaign_pipeline p
JOIN civic.ai_models m ON m.id = p.model_id
LEFT JOIN civic.prompt_versions v ON v.id = p.prompt_version_id
ORDER BY p.task_code;

\echo ''
\echo '── Recordatorio ──'
\echo 'Antes de mostrar el tablero a nadie que tome decisiones:'
\echo '  1. Construya un conjunto dorado de al menos 300 casos anotados por personas.'
\echo '  2. Evalúe el clasificador y revise la equidad entre fuentes y entre actores.'
\echo '  3. Sólo promueva la versión de prompt si evaluate_promotion_gate() aprueba.'
\echo 'Sin eso, el tablero produce números con apariencia de dato y origen desconocido.'
