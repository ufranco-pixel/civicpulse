# =============================================================================
# Análisis de Sentimientos · whatsapp-bot (8001)
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

# WA_SESSION_PATH debe ser LA MISMA ruta que monta docker-compose.
#
# Antes aquí decía /var/lib/oeste-sentimientos/wa-session mientras el compose
# montaba el volumen en /app/wa-session. La carpeta que se preparaba con dueño
# `node` no era la que se usaba, y sobre la que sí se usaba Docker creaba el
# punto de montaje como root. De ahí el «EACCES: permission denied, mkdir».
#
# El comentario va fuera de la instrucción, no dentro de la continuación de
# línea: los comentarios intercalados en un ENV de varias líneas dependen del
# motor de construcción y no merece la pena arriesgarse.
ENV NODE_ENV=production \
    PORT=8001 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    WA_SESSION_PATH=/app/wa-session

WORKDIR /app

# Copiar primero los manifiestos aprovecha la caché de capas: sólo se reinstala
# cuando cambian las dependencias, no en cada cambio de código.
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src

# El directorio de sesión DEBE existir en la imagen y con dueño `node`.
#
# No es solo para que node pueda escribir: es lo que determina el dueño del
# volumen. Cuando Docker monta un volumen con nombre vacío sobre una ruta que
# YA existe en la imagen, copia su contenido y sus permisos. Si la ruta no
# existe, Docker la crea como root:root y el usuario sin privilegios no puede
# ni crear la subcarpeta de la sesión.
#
# Chromium también necesita escribir su perfil aquí, así que 0700 no basta si
# algún día cambia el uid.
RUN mkdir -p "$WA_SESSION_PATH" \
 && chown -R node:node "$WA_SESSION_PATH" \
 && chmod 0770 "$WA_SESSION_PATH"

# Sin VOLUME aquí a propósito: docker-compose ya declara `wasession` y lo monta
# en esta ruta. Un VOLUME en el Dockerfile crearía además un volumen anónimo
# en cada `docker run` suelto, que nadie limpia y ocupa disco en silencio.

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
