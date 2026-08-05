# =============================================================================
# CivicPulse · reports-api (8002)
# =============================================================================
FROM node:20-alpine

RUN apk add --no-cache wget tini

ENV NODE_ENV=production \
    PORT=8002 \
    REPORTS_STORAGE_DIR=/var/lib/civicpulse/reports

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src

# El directorio de informes se crea con el dueño correcto ANTES de bajar de
# privilegios: si se crea después, el usuario node no puede escribir en él.
RUN mkdir -p "$REPORTS_STORAGE_DIR" && chown -R node:node "$REPORTS_STORAGE_DIR"

VOLUME ["/var/lib/civicpulse/reports"]

USER node

EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8002/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
