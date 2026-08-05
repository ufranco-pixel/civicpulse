#!/bin/sh
# =============================================================================
# CivicPulse · scripts/db-preflight.sh
#
# Sustituye a db-init.sh en despliegues sobre una base de datos EXTERNA.
#
# Al quitar el contenedor de PostgreSQL se perdió el `healthcheck` que
# encadenaba el arranque: sin él, los servicios levantan aunque la base no
# responda y fallan en la primera petición con un error opaco. Este script
# recupera esa garantía y, de paso, comprueba lo que un contenedor propio nos
# daba gratis y una base gestionada no: parámetros de servidor, extensiones y
# privilegios.
#
# Sale con código distinto de cero si algo impide operar. docker-compose usa
# `service_completed_successfully`, así que un fallo aquí detiene el despliegue
# en lugar de dejarlo a medias.
#
# Uso fuera de Docker:
#   DATABASE_URL='postgresql://user:pass@host:5432/db?sslmode=require' \
#     sh scripts/db-preflight.sh
# =============================================================================
set -eu

# Toda llamada a psql usa la URL de conexión. Se envuelve en una función para
# no repetirla en cada invocación; `command psql` evita la recursión.
# Si DATABASE_URL viene vacía, libpq cae en las variables PG* estándar.
PGCONN="${DATABASE_URL:-}"
psql() { command psql ${PGCONN:+"$PGCONN"} "$@"; }

FAIL=0
WARN=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; WARN=$((WARN + 1)); }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL + 1)); }

say ''
say '════════════════════════════════════════════════════════════'
say '  CivicPulse · verificación de la base de datos externa'
say '════════════════════════════════════════════════════════════'

# ── 1. Conectividad ─────────────────────────────────────────────────────────
# Sin `depends_on` a un contenedor de base de datos, la red puede no estar
# lista todavía o el cortafuegos puede no permitir la salida. Se reintenta.
say ''
say '▸ Conectividad'

ATTEMPTS="${DB_WAIT_ATTEMPTS:-30}"
i=0
until psql -tAc 'SELECT 1' >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$ATTEMPTS" ]; then
        bad "No hay conexión tras $((ATTEMPTS * 2)) s."
        say ''
        say '  Revise, en este orden:'
        say '    · DATABASE_URL en .env (host, puerto, base, usuario, contraseña)'
        say '    · sslmode: la mayoría de bases gestionadas exige sslmode=require'
        say '    · Si la base corre en su máquina, el host desde el contenedor'
        say '      NO es localhost sino host.docker.internal'
        say '    · Lista blanca de IP del proveedor (RDS, Neon, Supabase…)'
        say ''
        psql -c 'SELECT 1' 2>&1 | sed 's/^/    /' | head -5
        exit 1
    fi
    printf '  esperando a la base... (%s/%s)\n' "$i" "$ATTEMPTS"
    sleep 2
done

SERVER_VERSION=$(psql -tAc 'SHOW server_version' 2>/dev/null | tr -d ' ')
VERSION_NUM=$(psql -tAc 'SHOW server_version_num' 2>/dev/null | tr -d ' ')
ok "Conectado. PostgreSQL ${SERVER_VERSION}"

if [ "${VERSION_NUM:-0}" -lt 140000 ]; then
    bad "CivicPulse requiere PostgreSQL 14 o superior."
fi

CURRENT_USER=$(psql -tAc 'SELECT current_user' | tr -d ' ')
CURRENT_DB=$(psql -tAc 'SELECT current_database()' | tr -d ' ')
say "  Base: ${CURRENT_DB} · Usuario: ${CURRENT_USER}"

# ── 2. Parámetros de servidor ───────────────────────────────────────────────
# El contenedor que se retiró fijaba max_locks_per_transaction=256. Una base
# externa trae el valor por defecto, 64.
#
# El esquema crea ~1900 particiones. Una consulta sin filtro de fecha, un
# REFRESH MATERIALIZED VIEW o un VACUUM sobre la tabla padre toma un lock por
# partición, agota la tabla de locks compartida y aborta con «out of shared
# memory». No es un aviso teórico: pasa la primera vez que alguien pide el
# histórico completo.
say ''
say '▸ Parámetros de servidor'

MAX_LOCKS=$(psql -tAc 'SHOW max_locks_per_transaction' | tr -d ' ')
if [ "${MAX_LOCKS:-0}" -lt 256 ]; then
    warn "max_locks_per_transaction = ${MAX_LOCKS} (recomendado ≥ 256)"
    say  "     El esquema usa particionado mensual. Con este valor, las consultas"
    say  "     que abarcan muchos meses pueden fallar con «out of shared memory»."
    say  "     Ajústelo en su proveedor y reinicie la instancia:"
    say  "       ALTER SYSTEM SET max_locks_per_transaction = 256;   -- autoalojado"
    say  "       RDS/Aurora → parameter group · Neon/Supabase → soporte o panel"
else
    ok "max_locks_per_transaction = ${MAX_LOCKS}"
fi

TIMEZONE=$(psql -tAc 'SHOW timezone' | tr -d ' ')
say "  timezone del servidor: ${TIMEZONE} (irrelevante: el esquema usa TIMESTAMPTZ y la zona de la campaña)"

# ── 3. Privilegios ──────────────────────────────────────────────────────────
say ''
say '▸ Privilegios'

CAN_CREATE=$(psql -tAc "SELECT has_database_privilege(current_user, current_database(), 'CREATE')" | tr -d ' ')
[ "$CAN_CREATE" = "t" ] && ok "Puede crear esquemas en ${CURRENT_DB}" \
                        || bad "Sin privilegio CREATE sobre ${CURRENT_DB}: no se puede instalar el esquema."

IS_SUPER=$(psql -tAc 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user' | tr -d ' ')
IS_OWNER=$(psql -tAc "SELECT pg_get_userbyid(datdba) = current_user FROM pg_database WHERE datname = current_database()" | tr -d ' ')

if [ "$IS_SUPER" = "t" ]; then
    warn "El usuario de conexión es SUPERUSUARIO."
    say  "     PostgreSQL no aplica RLS a los superusuarios: el aislamiento entre"
    say  "     organizaciones queda anulado aunque las políticas estén activas."
    say  "     Cree un rol de aplicación y conéctese con él:"
    say  "       CREATE ROLE civicpulse_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';"
    say  "       GRANT USAGE ON SCHEMA civic, civic_cat, civic_api, civic_kpi, civic_ops TO civicpulse_app;"
elif [ "$IS_OWNER" = "t" ]; then
    ok "Usuario no privilegiado y dueño de la base. Correcto."
else
    ok "Usuario no privilegiado (sujeto a RLS)."
fi

# ── 4. Extensiones ──────────────────────────────────────────────────────────
# Ninguna es obligatoria, pero conviene saber con qué se cuenta. En bases
# gestionadas suelen estar disponibles pero no instaladas.
say ''
say '▸ Extensiones opcionales'

for ext in pg_trgm unaccent pgcrypto pg_cron; do
    INSTALLED=$(psql -tAc "SELECT count(*) FROM pg_extension WHERE extname = '${ext}'" | tr -d ' ')
    if [ "$INSTALLED" = "1" ]; then
        ok "${ext} instalada"
    else
        AVAILABLE=$(psql -tAc "SELECT count(*) FROM pg_available_extensions WHERE name = '${ext}'" | tr -d ' ')
        if [ "$AVAILABLE" = "1" ]; then
            say "  ○ ${ext} disponible pero no instalada — CREATE EXTENSION ${ext};"
        else
            say "  ○ ${ext} no disponible en este servidor (el esquema funciona igual)"
        fi
    fi
done

# ── 5. Esquema ──────────────────────────────────────────────────────────────
say ''
say '▸ Esquema'

HAS_SCHEMA=$(psql -tAc "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'civic'" | tr -d ' ')

if [ "$HAS_SCHEMA" = "0" ]; then
    if [ "${DB_AUTO_INSTALL:-false}" = "true" ]; then
        say '  Esquema ausente. DB_AUTO_INSTALL=true: instalando…'
        ( cd /sql && psql -v ON_ERROR_STOP=1 -q -f install.sql ) || {
            bad 'Falló la instalación del esquema.'
            exit 1
        }
        ok 'Esquema instalado.'
        psql -v ON_ERROR_STOP=1 -q -f /prompts/load_prompts.sql && ok 'Prompts cargados (en estado draft).'
        # Se recalcula: las comprobaciones posteriores dependen de esta bandera
        # y quedarían saltadas en la corrida que instala.
        HAS_SCHEMA=1
    else
        bad 'El esquema «civic» no existe en esta base.'
        say  '     Instálelo antes de arrancar:'
        say  '       cd sql && psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f install.sql'
        say  '       psql "$DATABASE_URL" -f prompts/load_prompts.sql'
        say  '     O bien arranque una vez con DB_AUTO_INSTALL=true.'
        exit 1
    fi
else
    TABLES=$(psql -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'civic' AND c.relkind IN ('r','p') AND NOT c.relispartition" | tr -d ' ')
    PARTS=$(psql -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'civic' AND c.relispartition" | tr -d ' ')
    VIEWS=$(psql -tAc "SELECT count(*) FROM information_schema.views WHERE table_schema = 'civic_api'" | tr -d ' ')
    MVS=$(psql -tAc "SELECT count(*) FROM pg_matviews WHERE schemaname = 'civic_kpi'" | tr -d ' ')
    ok "${TABLES} tablas · ${PARTS} particiones · ${VIEWS} vistas de API · ${MVS} vistas materializadas"

    [ "${TABLES:-0}" -lt 30 ] && bad "Se esperaban al menos 30 tablas: la instalación parece incompleta."
    [ "${VIEWS:-0}"  -lt 14 ] && bad "Faltan vistas en civic_api: la API no funcionará."
fi

# ── 6. Particiones al día ───────────────────────────────────────────────────
# Sin pg_cron nadie crea las particiones futuras. Si falta la del mes que
# viene, la ingesta empezará a caer en la partición por defecto.
say ''
say '▸ Particiones'

if [ "$HAS_SCHEMA" = "1" ]; then
    ORPHANS=$(psql -tAc 'SELECT orphan_rows FROM civic_ops.v_default_partition_health' 2>/dev/null | tr -d ' ')
    [ "${ORPHANS:-0}" -gt 0 ] \
        && warn "Hay ${ORPHANS} filas en la partición por defecto: faltan particiones para esas fechas." \
        || ok 'Partición por defecto vacía.'

    NEXT_MONTH=$(date -u -d "+1 month" +%Y%m 2>/dev/null || date -u -v+1m +%Y%m 2>/dev/null || echo '')
    if [ -n "$NEXT_MONTH" ]; then
        HAS_NEXT=$(psql -tAc "SELECT count(*) FROM pg_class WHERE relname = 'contents_p${NEXT_MONTH}'" | tr -d ' ')
        if [ "$HAS_NEXT" = "1" ]; then
            ok "Partición del próximo mes (${NEXT_MONTH}) creada."
        else
            warn "Falta la partición de ${NEXT_MONTH}. Ejecutando ensure_partitions()…"
            psql -q -c 'SELECT civic_ops.ensure_partitions(false)' >/dev/null 2>&1 \
                && ok 'Particiones creadas.' || bad 'No se pudieron crear.'
        fi
    fi
fi

# ── 7. Pepper de seudonimización ────────────────────────────────────────────
# En una base gestionada ALTER DATABASE puede estar vetado. Hay dos rutas
# alternativas y el script elige la que funcione.
say ''
say '▸ Seudonimización de autores'

PEPPER_SET=$(psql -tAc "SELECT coalesce(current_setting('civicpulse.author_pepper', true), '')" | tr -d ' ')

if [ -n "$PEPPER_SET" ]; then
    ok 'Pepper ya configurado en la base.'
elif [ -n "${AUTHOR_PEPPER:-}" ] && [ "${AUTHOR_PEPPER}" != "CAMBIAR_generar_con_openssl_rand_hex_32" ]; then
    if psql -q -c "ALTER DATABASE \"${CURRENT_DB}\" SET civicpulse.author_pepper = '${AUTHOR_PEPPER}';" 2>/dev/null; then
        ok 'Pepper fijado a nivel de base (ALTER DATABASE).'
    elif psql -q -c "ALTER ROLE \"${CURRENT_USER}\" IN DATABASE \"${CURRENT_DB}\" SET civicpulse.author_pepper = '${AUTHOR_PEPPER}';" 2>/dev/null; then
        ok 'Pepper fijado a nivel de rol (ALTER ROLE … IN DATABASE).'
        say '     Aplica sólo a este usuario. Repítalo para cada rol que escriba contenidos.'
    else
        warn 'Sin privilegio para persistir el pepper en la base.'
        say  '     La aplicación lo fijará por sesión. Funciona, pero cualquier proceso'
        say  '     que escriba sin pasar por la API generaría hashes distintos.'
    fi
else
    bad 'AUTHOR_PEPPER sin configurar o con el valor de ejemplo.'
    say  '     Los hashes de autor serían reversibles por fuerza bruta: el espacio de'
    say  '     identificadores de una red social se recorre en minutos.'
    say  '     Genere uno con: openssl rand -hex 32'
fi

# ── 8. Aislamiento ──────────────────────────────────────────────────────────
if [ "$HAS_SCHEMA" = "1" ]; then
    say ''
    say '▸ Aislamiento multi-tenant'
    psql -tAc "SELECT '  ' || CASE status WHEN 'OK' THEN '✅' WHEN 'FALLO' THEN '❌' ELSE '⚠️ ' END
                      || ' ' || check_name || ': ' || left(detail, 90)
               FROM civic_ops.check_isolation()
               WHERE check_name <> 'contexto_de_sesion'" 2>/dev/null || \
        warn 'No se pudo ejecutar civic_ops.check_isolation().'
fi

# ── Resumen ─────────────────────────────────────────────────────────────────
say ''
say '════════════════════════════════════════════════════════════'
if [ "$FAIL" -gt 0 ]; then
    say "  ${FAIL} problema(s) BLOQUEANTE(S) · ${WARN} advertencia(s)"
    say '  El despliegue se detiene aquí.'
    say '════════════════════════════════════════════════════════════'
    exit 1
fi
if [ "$WARN" -gt 0 ]; then
    say "  Base de datos utilizable, con ${WARN} advertencia(s) que conviene atender."
else
    say '  Base de datos lista.'
fi
say '════════════════════════════════════════════════════════════'
say ''
exit 0
