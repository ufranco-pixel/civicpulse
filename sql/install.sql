-- =============================================================================
-- CivicPulse · install.sql
-- Instalación completa del esquema en orden de dependencias.
--
-- Uso:
--   createdb civicpulse
--   psql -d civicpulse -v ON_ERROR_STOP=1 -f sql/install.sql
--
-- Requiere PostgreSQL 14+. No requiere ninguna extensión: las opcionales
-- (pg_trgm, unaccent, citext, pg_cron) se detectan y aprovechan si existen.
--
-- Es idempotente: puede reejecutarse sobre una base ya instalada.
-- Los objetos con datos (tablas) no se recrean; las funciones y vistas sí.
-- =============================================================================

\set ON_ERROR_STOP on
\timing on

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo '  CivicPulse — instalación del esquema'
\echo '════════════════════════════════════════════════════════════'
\echo ''

\echo '→ 00  Extensiones, esquemas, roles y utilidades'
\i 00_bootstrap.sql

\echo '→ 01  Catálogos de referencia'
\i 01_catalogs.sql

\echo '→ 02  Núcleo: organizaciones, campañas, contendientes, fuentes'
\i 02_core.sql

\echo '→ 03  Contenidos (particionado mensual)'
\i 03_content.sql

\echo '→ 04  Inferencias y detalle (particionado mensual)'
\i 04_inference.sql

\echo '→ 05  Proveedores, modelos y versionado de prompts'
\i 05_ai_models.sql

\echo '→ 06  Trabajos, reglas de alerta y entregas'
\i 06_jobs_alerts.sql

\echo '→ 07  Evaluación de clasificadores'
\i 07_evaluation.sql

\echo '→ 08  Vistas materializadas de KPIs'
\i 08_materialized_views.sql

\echo '→ 09  Registro de indicadores y evaluador de reglas'
\i 09_indicators.sql

\echo '→ 10  Vistas de API y compatibilidad'
\i 10_api_views.sql

\echo '→ 11  RLS, retención y cumplimiento'
\i 11_security_rls.sql

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo '  Resumen de la instalación'
\echo '════════════════════════════════════════════════════════════'

SELECT n.nspname                                              AS esquema,
       count(*) FILTER (WHERE c.relkind IN ('r','p') AND NOT c.relispartition) AS tablas,
       count(*) FILTER (WHERE c.relispartition)               AS particiones,
       count(*) FILTER (WHERE c.relkind = 'v')                AS vistas,
       count(*) FILTER (WHERE c.relkind = 'm')                AS vistas_mat
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname LIKE 'civic%'
GROUP  BY n.nspname
ORDER  BY n.nspname;

SELECT count(*) AS funciones
FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname LIKE 'civic%';

SELECT feature, is_available FROM civic_ops.feature_flags ORDER BY feature;

\echo ''
\echo '── Siguientes pasos ────────────────────────────────────────'
\echo ''
\echo '1. Fije el pepper de seudonimización (fuera de control de versiones):'
\echo '     ALTER DATABASE civicpulse SET civicpulse.author_pepper = ''<secreto-largo>'';'
\echo ''
\echo '2. Asigne contraseñas y LOGIN a los roles:'
\echo '     ALTER ROLE civicpulse_app    WITH LOGIN PASSWORD ''...'';'
\echo '     ALTER ROLE civicpulse_ingest WITH LOGIN PASSWORD ''...'';'
\echo '     ALTER ROLE civicpulse_reader WITH LOGIN PASSWORD ''...'';'
\echo ''
\echo '3. Cree su organización y su primera campaña:'
\echo '     \i seed_example.sql     -- plantilla comentada, no inserta nada por sí sola'
\echo ''
\echo '4. Cargue los prompts de clasificación y evaluación:'
\echo '     psql -f ../prompts/load_prompts.sql'
\echo ''
\echo '5. Programe el mantenimiento si no tiene pg_cron:'
\echo '     */15 * * * *  SELECT civic_kpi.refresh_all(true);'
\echo '     30 3   * * *  SELECT civic_ops.ensure_partitions(true);'
\echo '     0  4   * * *  SELECT civic_ops.purge_raw_payloads(30);'
\echo ''
\echo '6. Recuerde: la aplicación DEBE fijar el contexto en cada transacción:'
\echo '     SELECT civic_ops.set_session_context(''<org-uuid>'', ''<sub>'', ''<username>'');'
\echo ''
