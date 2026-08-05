# =============================================================================
# CivicPulse · alerts-api (8003)
# =============================================================================
FROM node:20-alpine

# wget para el HEALTHCHECK; tini para que las señales lleguen al proceso node
# y el cierre ordenado de los streams SSE se ejecute de verdad.
RUN apk add --no-cache wget tini

ENV NODE_ENV=production \
    PORT=8003

WORKDIR /app

# Copiar primero los manifiestos aprovecha la caché de capas: sólo se reinstala
# cuando cambian las dependencias, no en cada cambio de código.
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src

# El servicio no necesita raíz para nada.
USER node

EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8003/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
