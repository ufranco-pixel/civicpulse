#!/usr/bin/env bash
# =============================================================================
# CivicPulse · scripts/verify-deploy.sh
# Comprueba que el despliegue quedó bien enrutado y respondiendo.
#
#   sh scripts/verify-deploy.sh                    # lee APP_DOMAIN de .env
#   sh scripts/verify-deploy.sh civicpulse.oeste.mx
#
# Verifica desde FUERA, contra el dominio público: es lo mismo que verá el
# navegador. Un contenedor sano al que Traefik no enruta bien sigue estando roto.
# =============================================================================
set -u

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ] && [ -f .env ]; then
    DOMAIN=$(grep -E '^APP_DOMAIN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
fi
AUTH=$(grep -E '^AUTH_DOMAIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
REALM=$(grep -E '^KC_REALM=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
REALM="${REALM:-civicpulse}"

if [ -z "$DOMAIN" ]; then
    echo "Uso: sh scripts/verify-deploy.sh <dominio>"; exit 1
fi

FAIL=0
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Verificación de https://${DOMAIN}"
echo "════════════════════════════════════════════════════════════"

check() {
    desc="$1"; url="$2"; expect="$3"
    code=$(curl -sS -o /tmp/_vd_body -w '%{http_code}' --max-time 15 "$url" 2>/tmp/_vd_err)
    if [ "$code" = "$expect" ]; then
        printf '  ✅ %-34s %s\n' "$desc" "$code"
    else
        printf '  ❌ %-34s %s (esperado %s)\n' "$desc" "${code:-sin respuesta}" "$expect"
        [ -s /tmp/_vd_err ] && sed 's/^/       /' /tmp/_vd_err | head -2
        [ -s /tmp/_vd_body ] && head -c 160 /tmp/_vd_body | sed 's/^/       /'
        echo ""
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "▸ Contenedores"
docker compose -f docker-compose.prod.yml ps --format '  {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null \
    || echo "  (ejecute desde el directorio del proyecto)"

echo ""
echo "▸ Certificado TLS"
exp=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN":443 2>/dev/null \
      | openssl x509 -noout -dates 2>/dev/null | grep notAfter | cut -d= -f2)
if [ -n "$exp" ]; then
    echo "  ✅ emitido, expira: $exp"
else
    echo "  ❌ sin certificado válido. Revise los logs de Traefik y el DNS."
    FAIL=$((FAIL + 1))
fi

echo ""
echo "▸ Rutas"
check "frontend  /"           "https://${DOMAIN}/"               200
check "API       /api/health" "https://${DOMAIN}/api/health"     200
check "alertas   /alerts/health"  "https://${DOMAIN}/alerts/health"  200
check "informes  /reports/health" "https://${DOMAIN}/reports/health" 200
[ -n "$AUTH" ] && check "keycloak  openid-config" \
    "https://${AUTH}/realms/${REALM}/.well-known/openid-configuration" 200

echo ""
echo "▸ Enrutamiento correcto"
# /api debe devolver JSON, no el HTML del frontend. Si devuelve HTML, la regla
# del frontend está capturando la ruta de la API: prioridades mal puestas.
ct=$(curl -sS -o /dev/null -w '%{content_type}' --max-time 15 "https://${DOMAIN}/api/health" 2>/dev/null)
case "$ct" in
    application/json*) echo "  ✅ /api devuelve JSON" ;;
    text/html*)        echo "  ❌ /api devuelve HTML: el router del frontend se está comiendo la ruta"; FAIL=$((FAIL+1)) ;;
    *)                 echo "  ⚠️  /api devuelve content-type inesperado: ${ct:-ninguno}" ;;
esac

# La API sin token debe responder 401, no 200. Un 200 significa que el servicio
# quedó con la autenticación desactivada.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/v1/campaigns" 2>/dev/null)
case "$code" in
    401|403) echo "  ✅ /api/v1/campaigns exige autenticación ($code)" ;;
    200)     echo "  ❌ /api/v1/campaigns responde 200 SIN token: AUTH_DISABLED quedó activo"; FAIL=$((FAIL+1)) ;;
    404)     echo "  ❌ 404: falta el stripprefix, el servicio recibe /api/v1/… en vez de /v1/…"; FAIL=$((FAIL+1)) ;;
    *)       echo "  ⚠️  /api/v1/campaigns → $code" ;;
esac

echo ""
echo "▸ Stream SSE (12 s)"
# Debe permanecer abierto. Si Traefik lo corta, el tablero reconecta en bucle.
tmp=$(mktemp)
curl -sN --max-time 12 "https://${DOMAIN}/alerts/alerts/stream" >"$tmp" 2>/dev/null &
pid=$!
sleep 12
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
bytes=$(wc -c <"$tmp" | tr -d ' ')
if grep -qi 'unauthorized\|401' "$tmp"; then
    echo "  ✅ el stream exige token (correcto: sin él debe rechazar)"
elif [ "$bytes" -gt 0 ]; then
    echo "  ✅ el stream se mantuvo abierto ($bytes bytes recibidos)"
else
    echo "  ⚠️  sin datos. Con token válido debería recibir 'event: connected'."
    echo "     Si con token tampoco llega nada, revise writeTimeout del entrypoint."
fi
rm -f "$tmp"

echo ""
echo "▸ Base de datos"
docker compose -f docker-compose.prod.yml logs db-preflight 2>/dev/null \
    | grep -E '✅|❌|⚠️' | tail -12 | sed 's/^/  /' \
    || echo "  (sin logs de db-preflight)"

echo ""
echo "════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
    echo "  Despliegue correcto."
    echo ""
    echo "  Siguiente: cree su organización y campaña con sql/seed_example.sql,"
    echo "  y asigne a cada usuario de Keycloak el atributo organization_id."
else
    echo "  ${FAIL} comprobación(es) fallida(s). Ver docs/DEPLOY_TRAEFIK.md → Diagnóstico."
fi
echo "════════════════════════════════════════════════════════════"
echo ""
exit "$FAIL"
