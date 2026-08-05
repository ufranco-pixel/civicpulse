# =============================================================================
# CivicPulse · sentiment-api (8000)
# =============================================================================

# ── Etapa 1: dependencias ────────────────────────────────────────────────────
# Se compilan aquí (asyncpg y cryptography traen extensiones en C) y sólo se
# copia el resultado a la imagen final: el compilador no viaja a producción.
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar sólo el manifiesto aprovecha la caché de capas: la instalación se
# repite cuando cambian las dependencias, no en cada cambio de código.
COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install -r requirements.txt


# ── Etapa 2: ejecución ───────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8000

# tini para que SIGTERM llegue al proceso de Python y el cierre del pool se
# ejecute de verdad; uvicorn como PID 1 no reenvía señales a los trabajadores.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin civicpulse

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=civicpulse:civicpulse app ./app

# El servicio no escribe en disco ni necesita raíz para nada.
USER civicpulse

EXPOSE 8000

# curl y wget NO existen en python:3.12-slim y añadirlos sólo para la sonda
# suma superficie de ataque. El intérprete ya está aquí.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else sys.exit(1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--proxy-headers", "--forwarded-allow-ips", "*"]
