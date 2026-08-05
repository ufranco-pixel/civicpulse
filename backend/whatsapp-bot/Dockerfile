# =============================================================================
# CivicPulse · whatsapp-bot (8001)
# =============================================================================
FROM node:20-alpine

# Chromium del sistema. puppeteer descargaría el suyo (unos 300 MB, y además
# compilado con glibc: en Alpine ni siquiera arranca), así que se le prohíbe.
# Las fuentes no son opcional estético: sin ellas WhatsApp Web renderiza cajas
# vacías y la sesión falla al leer el QR.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto \
      font-noto-emoji \
      wget \
      tini

ENV NODE_ENV=production \
    PORT=8001 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    WA_SESSION_PATH=/var/lib/civicpulse/wa-session

WORKDIR /app

# Copiar primero los manifiestos aprovecha la caché de capas: sólo se reinstala
# cuando cambian las dependencias, no en cada cambio de código.
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src

# El directorio de sesión se crea con el dueño correcto ANTES de bajar de
# privilegios: si se crea después, node no puede escribir y LocalAuth pide QR
# en cada arranque.
RUN mkdir -p "$WA_SESSION_PATH" && chown -R node:node "$WA_SESSION_PATH"

# Volumen para la sesión de WhatsApp. Sin persistencia hay que escanear el QR
# en cada despliegue, lo que en la práctica significa que el canal se cae.
VOLUME ["/var/lib/civicpulse/wa-session"]

# La versión anterior corría como root: un Chromium con --no-sandbox ejecutando
# contenido remoto y con uid 0 es la peor combinación posible del sistema.
USER node

EXPOSE 8001

# La sonda mira /health, que responde aunque WhatsApp esté desvinculado: si
# dependiera de la sesión, el orquestador reiniciaría el contenedor y con él la
# única forma de ver el QR nuevo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8001/health || exit 1

# tini reapea los procesos de Chromium: sin él los zombis se acumulan en el
# contenedor hasta agotar la tabla de procesos.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
