#!/bin/sh
# =============================================================================
# Análisis de Sentimientos · scripts/diagnose.sh
#
# Responde a «no veo datos y no hay error». Recorre la cadena completa desde el
# token hasta la fila en la base, e indica en qué eslabón se corta.
#
#   sh scripts/diagnose.sh                 # sin token: sólo revisa la base
#   sh scripts/diagnose.sh <access_token>  # además comprueba el claim y el cruce
#
# El caso habitual es que todo esté bien configurado y simplemente no haya
# datos cargados: sin organización, sin campaña o sin contenidos, el tablero
# está vacío y eso es correcto, no un fallo.
# =============================================================================
set -u

TOKEN="${1:-}"
[ -f .env ] && . ./.env 2>/dev/null

PGCONN="${DATABASE_URL:-}"
psql() { command psql ${PGCONN:+"$PGCONN"} "$@"; }

echo ''
echo '════════════════════════════════════════════════════════════'
echo '  Diagnóstico: por qué no aparecen datos'
echo '════════════════════════════════════════════════════════════'

# ── 1. Contenedores ─────────────────────────────────────────────────────────
echo ''
echo '▸ 1. Contenedores'
docker compose -f docker-compose.prod.yml ps --format '  {{.Service}}: {{.Status}}' 2>/dev/null \
  || echo '  (no se pudo consultar docker compose)'

huerfanos=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^(civicpulse|oeste-sentimientos)-' \
            | grep -v "$(docker compose -f docker-compose.prod.yml ps -a --format '{{.Name}}' 2>/dev/null | tr '\n' '|' | sed 's/|$//')" 2>/dev/null)
if [ -n "$huerfanos" ]; then
    echo '  ⚠️  Contenedores huérfanos de un despliegue anterior:'
    echo "$huerfanos" | sed 's/^/       /'
    echo '       Elimínelos:  docker rm -f '"$(echo "$huerfanos" | tr '\n' ' ')"
fi

# ── 2. Token ────────────────────────────────────────────────────────────────
echo ''
echo '▸ 2. Token'
if [ -z "$TOKEN" ]; then
    echo '  (sin token; pásela como argumento para comprobar el claim)'
    ORG_TOKEN=''
else
    # El payload es la segunda parte, en base64url sin relleno.
    PAYLOAD=$(printf '%s' "$TOKEN" | cut -d. -f2 | tr '_-' '/+')
    case $(( ${#PAYLOAD} % 4 )) in 2) PAYLOAD="${PAYLOAD}==";; 3) PAYLOAD="${PAYLOAD}=";; esac
    JSON=$(printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null)

    ORG_TOKEN=$(printf '%s' "$JSON" | sed -n 's/.*"organization_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    ROLES=$(printf '%s' "$JSON" | sed -n 's/.*"realm_access":{"roles":\[\([^]]*\)\].*/\1/p' | tr -d '"')
    USR=$(printf '%s' "$JSON" | sed -n 's/.*"preferred_username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    ISS=$(printf '%s' "$JSON" | sed -n 's/.*"iss"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

    echo "  usuario  : ${USR:-?}"
    echo "  emisor   : ${ISS:-?}"
    echo "  roles    : ${ROLES:-ninguno}"
    if [ -n "$ORG_TOKEN" ]; then
        echo "  ✅ organization_id: $ORG_TOKEN"
    else
        echo '  ❌ SIN organization_id en el access token.'
        echo '     Falta el protocol mapper en el cliente, o no está marcado'
        echo '     «Add to access token». Añadir el atributo al usuario no basta.'
    fi
fi

# ── 3. Base de datos ────────────────────────────────────────────────────────
echo ''
echo '▸ 3. Contenido de la base'
if ! psql -tAc 'SELECT 1' >/dev/null 2>&1; then
    echo '  ❌ Sin conexión. Exporte DATABASE_URL o ejecute desde el directorio del proyecto.'
    exit 1
fi

# El conteo se hace SIN contexto de RLS. Si el usuario de conexión no es
# superusuario, las políticas devolverían cero y el diagnóstico mentiría; por
# eso se avisa del caso.
SUPER=$(psql -tAc 'SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user' | tr -d ' ')
if [ "$SUPER" != "t" ]; then
    echo '  ⚠️  El usuario de conexión está sujeto a RLS: los conteos de abajo'
    echo '      saldrán en 0 aunque existan filas. Es lo correcto en producción;'
    echo '      para este diagnóstico use un usuario con BYPASSRLS.'
fi

printf '  organizaciones : %s\n' "$(psql -tAc 'SELECT count(*) FROM civic.organizations' 2>/dev/null | tr -d ' ')"
printf '  campañas       : %s\n' "$(psql -tAc 'SELECT count(*) FROM civic.campaigns'     2>/dev/null | tr -d ' ')"
printf '  contendientes  : %s\n' "$(psql -tAc 'SELECT count(*) FROM civic.contenders'    2>/dev/null | tr -d ' ')"
printf '  fuentes        : %s\n' "$(psql -tAc 'SELECT count(*) FROM civic.sources'       2>/dev/null | tr -d ' ')"
printf '  contenidos     : %s\n' "$(psql -tAc 'SELECT count(*) FROM civic.contents'      2>/dev/null | tr -d ' ')"
printf '  inferencias    : %s\n' "$(psql -tAc 'SELECT count(*) FROM civic.inferences'    2>/dev/null | tr -d ' ')"

echo ''
echo '  Organizaciones registradas:'
psql -tAc "SELECT '    ' || id || '  ' || name FROM civic.organizations" 2>/dev/null \
  | grep -v '^\s*$' || echo '    (ninguna)'

# ── 4. Cruce token ↔ base ───────────────────────────────────────────────────
if [ -n "$ORG_TOKEN" ]; then
    echo ''
    echo '▸ 4. ¿El organization_id del token existe en la base?'
    HIT=$(psql -tAc "SELECT count(*) FROM civic.organizations WHERE id = '${ORG_TOKEN}'" 2>/dev/null | tr -d ' ')
    if [ "$HIT" = "1" ]; then
        echo '  ✅ Coincide con una organización real.'
        echo ''
        echo '  Campañas visibles para esa organización:'
        psql -tAc "SELECT '    ' || code || '  ' || name || '  [' || status || ']'
                   FROM civic.campaigns WHERE organization_id = '${ORG_TOKEN}'" 2>/dev/null \
          | grep -v '^\s*$' || echo '    (ninguna) ← el tablero estará vacío'
    else
        echo "  ❌ El UUID ${ORG_TOKEN} NO existe en civic.organizations."
        echo '     El token es válido y pasa la autorización, pero RLS filtra todo'
        echo '     y cada consulta devuelve cero filas. Sin error, sin datos.'
        echo '     Corrija el atributo del usuario con un UUID de la lista de arriba.'
    fi
fi

# ── 5. Veredicto ────────────────────────────────────────────────────────────
echo ''
echo '════════════════════════════════════════════════════════════'
ORGS=$(psql -tAc 'SELECT count(*) FROM civic.organizations' 2>/dev/null | tr -d ' ')
CAMPS=$(psql -tAc 'SELECT count(*) FROM civic.campaigns'    2>/dev/null | tr -d ' ')
CONTS=$(psql -tAc 'SELECT count(*) FROM civic.contents'     2>/dev/null | tr -d ' ')

if [ "${ORGS:-0}" = "0" ]; then
    echo '  No hay ninguna organización. Ese es el motivo.'
    echo '  → Descomente el BLOQUE 1 de sql/seed_example.sql y ejecútelo.'
elif [ "${CAMPS:-0}" = "0" ]; then
    echo '  Hay organización pero ninguna campaña. El tablero no tiene qué mostrar.'
    echo '  → Descomente el BLOQUE 3 de sql/seed_example.sql.'
elif [ "${CONTS:-0}" = "0" ]; then
    echo '  Configuración completa, pero SIN CONTENIDOS cargados.'
    echo '  El tablero está vacío porque todavía no se ha ingerido nada:'
    echo '  las fuentes no recolectan solas, hace falta el worker de ingesta'
    echo '  o una carga manual en civic.contents.'
else
    echo '  Hay datos. Si el tablero sigue vacío, revise la consola del navegador'
    echo '  y los logs:  docker compose -f docker-compose.prod.yml logs sentiment-api'
fi
echo '════════════════════════════════════════════════════════════'
echo ''
