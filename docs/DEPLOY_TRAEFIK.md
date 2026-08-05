# Despliegue en producción con Traefik

Para un Traefik **ya montado** en otra red de Docker. CivicPulse se une a esa red y se
anuncia con etiquetas; no toca la configuración de su Traefik.

---

## Su infraestructura (valores ya aplicados)

Tomados del stack de `ziba-calendar`. `.env.prod.example` ya viene con ellos.

| Dato | Valor | Dónde se usa |
|---|---|---|
| Red de Traefik | `web-network` (externa) | `TRAEFIK_NETWORK` |
| Entrypoint HTTPS | `websecure` | `TRAEFIK_ENTRYPOINT` |
| Cert resolver | `myresolver` | `TRAEFIK_CERTRESOLVER` |
| Keycloak | `https://auth.oeste.mx` | `KC_URL`, `OIDC_ISSUER` |
| PostgreSQL | `172.31.46.37:5432` | `DATABASE_URL` |
| Dominio | `*.oeste.mx` | `APP_DOMAIN` |

Sólo queda por decidir el subdominio. `.env.prod.example` propone
`civicpulse.oeste.mx`.

### Lo único que aún me falta de usted

**El `respondingTimeouts` del entrypoint `websecure`.** Es el único dato que no se deduce
del compose que me pasó, y afecta al stream de alertas:

```bash
docker inspect traefik --format '{{json .Args}}' | tr ',' '\n' | grep -i timeout
# o busque en su traefik.yml:
#   entryPoints:
#     websecure:
#       transport:
#         respondingTimeouts:
#           writeTimeout: …
```

El tablero mantiene una conexión SSE abierta de forma indefinida. Si `writeTimeout` tiene
un valor distinto de cero, Traefik corta el stream cada N segundos y el cliente reconecta
en bucle: el indicador de «en vivo» parpadea sin parar y cada reconexión abre una consulta
nueva contra la base.

- `writeTimeout: 0s` → correcto, nada que hacer.
- Distinto de cero → súbalo a `0s` para este entrypoint, o baje `SSE_HEARTBEAT_MS`
  por debajo de `idleTimeout` (viene en 25 s, que aguanta un `idleTimeout` ≥ 30 s).

`ziba-calendar` no usa SSE, así que es probable que nadie lo haya revisado todavía.

### Y dos cosas que conviene revisar de `ziba-calendar`

**1. La clave de Gemini está expuesta al público.** En su compose va como build arg del
frontend:

```yaml
VITE_GEMINI_API_KEY: 'AQ.Ab8RN6KQSsOxZD_wIJeRYKlknBY2hQd2rh-HKgoBnEGXqCj3rA'
```

Vite inlinea los build args en el JavaScript que descarga el navegador. Cualquiera que abra
`zibareservaciones.oeste.mx` y mire el bundle puede extraerla y gastar su cuota. Conviene
rotarla en AI Studio y mover las llamadas a Gemini al backend.

En CivicPulse la clave sólo la conoce `sentiment-api`; el navegador nunca habla con Gemini.
Aun así, **use una clave distinta** para poder revocar una sin tumbar la otra.

**2. `admin:admin` y `CORS_ORIGINS: '*'`.** Para CivicPulse no reutilice ese usuario: el
aislamiento multi-tenant depende de RLS, y PostgreSQL no se la aplica a los superusuarios.
Con `admin` conectado, cada organización vería los datos de todas. El `.env` incluye el SQL
para crear un rol propio sin privilegios.

---

## Requisitos previos, en orden

1. **DNS.** `civicpulse.oeste.mx` apuntando al servidor de Traefik. Let's Encrypt
   valida por HTTP: si el DNS no resuelve todavía, la emisión falla y Traefik entra en el
   límite de peticiones de ACME.

2. **Base de datos alcanzable desde el servidor.** Compruébelo antes de desplegar:
   ```bash
   docker run --rm --network web-network postgres:16-alpine \
     psql "postgresql://civicpulse_app:CLAVE@172.31.46.37:5432/civicpulse" -c 'SELECT version()'
   ```
   Si el proveedor filtra por IP, añada la del servidor a la lista blanca.

3. **`max_locks_per_transaction ≥ 256`** en el servidor de base de datos. Requiere
   reinicio. Ver [`EXTERNAL_DB.md`](EXTERNAL_DB.md).

4. **Esquema instalado.** En producción `db-preflight` no autoinstala: se despliega a mano,
   revisando la salida.
   ```bash
   cd sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f install.sql
   psql "$DATABASE_URL" -f ../prompts/load_prompts.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f smoke_test.sql   # crea, prueba y revierte
   ```

5. **Realm en su Keycloak.** En `auth.oeste.mx` → Create realm → Import →
   `docs/keycloak/civicpulse-realm.json`. Ajuste en el cliente
   `civicpulse-frontend` los redirect URIs y web origins a
   `https://civicpulse.oeste.mx`, y borre los tres usuarios demo.

6. **Rol de aplicación sin privilegios.** No conecte con un superusuario: PostgreSQL no le
   aplica RLS y el aislamiento entre organizaciones queda anulado.
   ```sql
   CREATE ROLE civicpulse_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';
   GRANT USAGE ON SCHEMA civic, civic_cat, civic_api, civic_kpi, civic_ops TO civicpulse_app;
   GRANT SELECT ON ALL TABLES IN SCHEMA civic_api, civic_cat, civic_kpi TO civicpulse_app;
   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA civic TO civicpulse_app;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA civic_kpi, civic_ops TO civicpulse_app;
   ```

---

## Despliegue

```bash
cd civicpulse
cp .env.prod.example .env
# Ya viene con web-network, websecure, myresolver, auth.oeste.mx y la base.
# Edite sólo: APP_DOMAIN, la contraseña de las dos DATABASE_URL,
#             CIVICPULSE_AUTHOR_PEPPER y GEMINI_API_KEY

docker compose -f docker-compose.prod.yml config >/dev/null   # valida las variables
docker compose -f docker-compose.prod.yml up -d --build

docker compose -f docker-compose.prod.yml logs -f db-preflight
```

`db-preflight` corre primero y aborta el despliegue si algo bloquea. Los demás servicios
esperan a que termine bien.

### Verificación

```bash
curl -sI https://civicpulse.oeste.mx/                 # 200, index del frontend
curl -s  https://civicpulse.oeste.mx/api/health       # {"status":"ok"}
curl -s  https://civicpulse.oeste.mx/alerts/health    # {"status":"ok"}
curl -s  https://civicpulse.oeste.mx/reports/health   # {"status":"ok"}
curl -s  https://auth.oeste.mx/realms/civicpulse/.well-known/openid-configuration | head -c 200

# El stream SSE debe quedarse abierto y latir cada 25 s, no cerrarse.
curl -N -H "Authorization: Bearer <token>" https://civicpulse.oeste.mx/alerts/alerts/stream
```

Ese último es el que más vale la pena mirar: si se cierra solo a los pocos segundos, revise
el `writeTimeout` del entrypoint.

---

## Cambiar el dominio después

`APP_DOMAIN` y `AUTH_DOMAIN` entran en el bundle del frontend en tiempo de compilación:
Vite los inlinea. Reiniciar no basta.

```bash
# 1. Editar APP_DOMAIN / AUTH_DOMAIN en .env
# 2. Reconstruir SOLO el frontend
docker compose -f docker-compose.prod.yml up -d --build frontend
# 3. Recrear el resto para que tomen el CORS y el emisor nuevos
docker compose -f docker-compose.prod.yml up -d --force-recreate sentiment-api alerts-api reports-api
# 4. Actualizar en Keycloak los redirect URIs y web origins del cliente
```

El paso 4 se olvida siempre: si no lo hace, el login redirige a `invalid_redirect_uri`.

---

## Ruta a ruta

| Ruta | Servicio | Middleware | Prioridad |
|---|---|---|---|
| `https://civicpulse.oeste.mx/api/*` | sentiment-api:8000 | stripprefix `/api` | 100 |
| `https://civicpulse.oeste.mx/alerts/*` | alerts-api:8003 | stripprefix `/alerts` | 100 |
| `https://civicpulse.oeste.mx/reports/*` | reports-api:8002 | stripprefix `/reports` | 100 |
| `https://civicpulse.oeste.mx/*` | frontend:8080 | cabeceras de seguridad | 1 |
| `https://auth.oeste.mx/*` | su Keycloak existente | — | fuera de este compose |
| — | whatsapp-bot:8001 | sin ruta pública | — |

Las prioridades son explícitas a propósito. Traefik ordena por longitud de regla cuando no
se indican, así que *funcionaría* igual, pero con la prioridad escrita nadie tiene que
razonar sobre longitudes de cadena para saber por qué `/api` no cae en el frontend.

El bot de WhatsApp no se expone: sólo lo consumen los demás servicios por la red interna.
Publicarlo daría acceso externo al envío de mensajes.

---

## Dos etiquetas que evitan los fallos más comunes

**`traefik.docker.network`.** Los contenedores están en dos redes (`civicnet` y la de
Traefik). Sin esta etiqueta, Traefik puede elegir la IP de `civicnet`, a la que no llega, y
la ruta devuelve 504 de forma intermitente. Es el fallo más difícil de diagnosticar en este
tipo de despliegue.

**`traefik.enable: "false"`** en `db-preflight` y `whatsapp-bot`. Con
`exposedByDefault=true` en su Traefik, sin esto quedarían publicados.

---

## Diagnóstico

| Síntoma | Causa |
|---|---|
| 404 en todo | La red de `TRAEFIK_NETWORK` no coincide, o `exposedByDefault=false` sin `traefik.enable=true` |
| 504 intermitente | Falta `traefik.docker.network` con dos redes |
| `/api` devuelve el HTML del frontend | Prioridades invertidas o falta el router de la API |
| API responde 404 en todas sus rutas | Falta el `stripprefix`: el servicio recibe `/api/v1/…` en vez de `/v1/…` |
| SSE reconecta en bucle | `writeTimeout` distinto de 0 en el entrypoint |
| SSE conecta pero no llega ningún evento | Un middleware `compress` o de buffering en la ruta `/alerts` |
| `invalid_redirect_uri` al entrar | Los redirect URIs del cliente en Keycloak no incluyen el dominio |
| Keycloak redirige a `http://` | Falta `KC_PROXY_HEADERS=xforwarded` |
| Se pierden usuarios al reiniciar | Keycloak arrancado con `start-dev` (H2 en memoria) en vez de `start` |
| Token rechazado por la API | `OIDC_ISSUER` con la URL interna en vez de la pública |
| Todos ven los datos de todos | El usuario de base de datos es superusuario |

```bash
docker compose -f docker-compose.prod.yml logs -f
docker exec civicpulse-sentiment-api python -c "from app.core.config import settings; print(settings.token_issuer)"
docker run --rm --network web-network curlimages/curl -s http://civicpulse-sentiment-api:8000/health
```

---

## Tareas programadas

Sin `pg_cron` en la base gestionada hay que programarlas fuera. Añada al crontab del
servidor:

```cron
*/15 * * * *  docker exec civicpulse-db-preflight true 2>/dev/null || docker run --rm --network civicpulse_civicnet -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql "$DATABASE_URL" -c "SELECT civic_kpi.refresh_all(true)"
```

Más limpio: un contenedor `ofelia` o un `systemd timer` que ejecute

```bash
psql "$DATABASE_URL" -c "SELECT civic_kpi.refresh_all(true)"       # cada 15 min
psql "$DATABASE_URL" -c "SELECT civic_ops.ensure_partitions(true)" # diario 03:30
psql "$DATABASE_URL" -c "SELECT civic_ops.purge_raw_payloads(30)"  # diario 04:00
```

El crítico es `ensure_partitions`: si nadie lo ejecuta, llega un mes sin partición y toda
la ingesta cae en la partición por defecto. No se pierde nada, pero después ya no se pueden
crear las particiones de ese rango sin vaciarla primero.

---

## Antes de dar acceso a quien tome decisiones

El despliegue técnico no es el último paso.

1. Construya un conjunto dorado de al menos 300 comentarios anotados por personas.
2. Evalúe el clasificador: `civic_kpi.compute_eval_metrics()`.
3. Revise la equidad entre fuentes y **entre contendientes** — un sesgo ahí invalida todo
   el tablero competitivo.
4. Sólo promueva la versión del prompt si `civic_kpi.evaluate_promotion_gate()` aprueba.
5. Recién entonces ponga `CLASSIFIER_ENABLED=true`.

Sin eso el tablero produce números con apariencia de dato y origen desconocido.
