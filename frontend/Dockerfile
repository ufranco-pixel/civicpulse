# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# CivicPulse · frontend
#
# Vite congela las variables VITE_* en el bundle DURANTE la compilacion: no se
# pueden cambiar al arrancar el contenedor. Por eso todas ellas son ARG aqui.
# El sistema base declaraba solo dos y las demas quedaban apuntando a
# localhost en la imagen de produccion, con el tablero pidiendo datos a la
# maquina del usuario.
# ─────────────────────────────────────────────────────────────────────────────

# ── Etapa 1: compilacion ─────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Servicios
ARG VITE_SENTIMENT_API_URL=http://localhost:8000
ARG VITE_SENTIMENT_API_PREFIX=/v1
ARG VITE_ALERTS_API_URL=http://localhost:8003
ARG VITE_REPORTS_API_URL=http://localhost:8004
ARG VITE_WHATSAPP_API_URL=http://localhost:8005
ARG VITE_API_TIMEOUT_MS=20000
# Identidad
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ARG VITE_KEYCLOAK_REALM=civicpulse
ARG VITE_KEYCLOAK_CLIENT_ID=civicpulse-frontend
ARG VITE_TOKEN_MIN_VALIDITY=70
ARG VITE_AUTH_DISABLED=false
# Tiempo real
ARG VITE_SSE_RETRY_BASE_MS=2000
ARG VITE_SSE_RETRY_MAX_MS=60000
ARG VITE_SSE_SEVERITY_MIN=
# Marca
ARG VITE_BRAND_NAME=CivicPulse
ARG VITE_BRAND_SHORT_NAME=CP
ARG VITE_BRAND_PRODUCT_NAME=CivicPulse
ARG VITE_BRAND_TAGLINE=
ARG VITE_BRAND_PRIMARY_COLOR=
ARG VITE_BRAND_ACCENT_COLOR=
ARG VITE_BRAND_SUPPORT_EMAIL=
ARG VITE_BRAND_COPYRIGHT=
ARG VITE_BRAND_DISCLAIMER=

ENV VITE_SENTIMENT_API_URL=$VITE_SENTIMENT_API_URL \
    VITE_SENTIMENT_API_PREFIX=$VITE_SENTIMENT_API_PREFIX \
    VITE_ALERTS_API_URL=$VITE_ALERTS_API_URL \
    VITE_REPORTS_API_URL=$VITE_REPORTS_API_URL \
    VITE_WHATSAPP_API_URL=$VITE_WHATSAPP_API_URL \
    VITE_API_TIMEOUT_MS=$VITE_API_TIMEOUT_MS \
    VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL \
    VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM \
    VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID \
    VITE_TOKEN_MIN_VALIDITY=$VITE_TOKEN_MIN_VALIDITY \
    VITE_AUTH_DISABLED=$VITE_AUTH_DISABLED \
    VITE_SSE_RETRY_BASE_MS=$VITE_SSE_RETRY_BASE_MS \
    VITE_SSE_RETRY_MAX_MS=$VITE_SSE_RETRY_MAX_MS \
    VITE_SSE_SEVERITY_MIN=$VITE_SSE_SEVERITY_MIN \
    VITE_BRAND_NAME=$VITE_BRAND_NAME \
    VITE_BRAND_SHORT_NAME=$VITE_BRAND_SHORT_NAME \
    VITE_BRAND_PRODUCT_NAME=$VITE_BRAND_PRODUCT_NAME \
    VITE_BRAND_TAGLINE=$VITE_BRAND_TAGLINE \
    VITE_BRAND_PRIMARY_COLOR=$VITE_BRAND_PRIMARY_COLOR \
    VITE_BRAND_ACCENT_COLOR=$VITE_BRAND_ACCENT_COLOR \
    VITE_BRAND_SUPPORT_EMAIL=$VITE_BRAND_SUPPORT_EMAIL \
    VITE_BRAND_COPYRIGHT=$VITE_BRAND_COPYRIGHT \
    VITE_BRAND_DISCLAIMER=$VITE_BRAND_DISCLAIMER

# OJO: aqui NO va NODE_ENV=production.
#
# Con NODE_ENV=production, npm omite las devDependencies aunque no se le pase
# --omit=dev. Y vite, @vitejs/plugin-react y todo el tooling de compilacion son
# devDependencies: sin ellos `npm run build` falla con «vite: not found».
#
# Tampoco hace falta: `vite build` compila en modo produccion por si mismo, y
# la etapa 2 (nginx) sirve estaticos, no ejecuta Node.

# Las dependencias se instalan antes de copiar el codigo para aprovechar la
# cache de capas: cambiar un componente no reinstala node_modules.
COPY package.json package-lock.json* ./
# --include=dev explicito: deja documentado que esta etapa NECESITA el tooling,
# y protege frente a un NODE_ENV heredado del entorno de build.
RUN npm ci --include=dev --no-audit --fund=false \
 || npm install --include=dev --no-audit --fund=false

COPY . .
RUN npm run build

# Comprobacion de que la compilacion produjo algo. Sin esto, un `vite build`
# que falle en silencio genera una imagen que arranca y sirve un 404.
RUN test -f dist/index.html && test -d dist/assets \
 && echo "build ok: $(find dist -type f | wc -l) archivos"

# ── Etapa 2: servicio ────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Origenes que la CSP permite en connect-src / frame-src. Se sustituyen al
# arrancar, no al compilar: cambiar de entorno no exige reconstruir la imagen.
ENV CSP_CONNECT_SRC="'self' http://localhost:8000 http://localhost:8003 http://localhost:8004 http://localhost:8005 http://localhost:8080" \
    CSP_FRAME_SRC="'self' http://localhost:8080" \
    NGINX_ENVSUBST_FILTER="CSP_" \
    NGINX_ENVSUBST_TEMPLATE_SUFFIX=".template"

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# nginx escribe el pid, la config generada y sus caches; sin estos permisos el
# contenedor sin privilegios no arranca.
RUN sed -i 's|pid        /var/run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf \
 && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /etc/nginx/conf.d \
 && chmod -R g+w /etc/nginx/conf.d

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
