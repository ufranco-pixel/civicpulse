# CivicPulse · sentiment-api

API analítica de lectura sobre la base CivicPulse. Consume el contrato
`civic_api.*` y las funciones de `civic_kpi.*`; el modelo interno `civic.*`
sólo se toca para las escrituras operativas (anotaciones, revisión, reglas de
alerta, trabajos y evaluación).

> **Aviso metodológico.** Los indicadores miden **conversación pública
> digital**, no intención de voto. Quien publica no es una muestra
> representativa del electorado. Cada número que devuelve la API arrastra su
> tamaño de muestra y su advertencia (`caveat`) desde
> `civic_kpi.metric_registry`; la interfaz debe mostrarlos.

## Requisitos

- Python 3.12
- PostgreSQL con el esquema CivicPulse instalado (`sql/install.sql`)
- Keycloak con el realm configurado (o `AUTH_DISABLED=true` en local)

## Puesta en marcha

### Local

```bash
cd backend/sentiment-api
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # y ajuste DATABASE_URL, KC_URL, CORS_ORIGINS
uvicorn app.main:app --reload --port 8000
```

Documentación interactiva en `http://localhost:8000/v1/docs`.

### Contenedor

```bash
docker build -t civicpulse/sentiment-api:1.0.0 .
docker run --rm -p 8000:8000 --env-file .env civicpulse/sentiment-api:1.0.0
```

La imagen es multi-etapa, corre como usuario sin privilegios (`civicpulse`,
uid 10001) y su `HEALTHCHECK` usa el propio intérprete: `python:3.12-slim` no
trae `curl` ni `wget`.

## Variables de entorno

Todas se leen en `app/core/config.py` y están documentadas en `.env.example`.
Resumen de las que no tienen valor por defecto usable en producción:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | DSN asíncrono. **Debe** empezar con `postgresql+asyncpg://`. |
| `POOL_SIZE` / `MAX_OVERFLOW` | Tamaño del pool (10 / 5). |
| `STATEMENT_TIMEOUT_MS` | Corte de consultas en el servidor (15000). |
| `KC_URL` / `KC_REALM` / `KC_AUDIENCE` | Emisor OIDC, realm y audiencia esperada. |
| `API_PREFIX` | Prefijo de versión de los endpoints de negocio (`/v1`). |
| `PORT` / `LOG_LEVEL` | Puerto y nivel de registro. |
| `CORS_ORIGINS` | Lista blanca separada por comas. |
| `AUTH_DISABLED` / `DEV_ORG_ID` | Sólo desarrollo. Inyecta un usuario ficticio. |
| `CLASSIFIER_ENABLED`, `LLM_*` | Clasificador por LLM: proveedor, modelo, referencia al secreto y tiempo de espera. |

`LLM_API_KEY_REF` guarda una **referencia** al secreto (`vault://...`), no el
secreto.

## Autenticación y multiinquilino

- Token RS256 verificado contra el JWKS del realm; el algoritmo nunca se toma
  del propio token.
- La organización sale **exclusivamente** del claim `organization_id` o, si el
  realm no lo emite, de `civic.memberships`. No hay parámetro `?org_id=`.
- Toda ruta de negocio depende de `Ctx` (`app/core/context.py`), que abre la
  transacción y llama a `civic_ops.set_session_context(...)`. Sin eso las
  políticas de RLS ven `organization_id = NULL` y todo devuelve cero filas.
- Roles: `viewer`, `auditor`, `analyst`, `strategist`, `admin`, `owner`.

## Errores

Forma única de respuesta: `{ "detail": ..., "code": ..., "request_id": ... }`.
Los SQLSTATE que la base usa como contrato se traducen en `app/main.py`:

| SQLSTATE | HTTP | Significado |
|---|---|---|
| `P0002` | 404 | Campaña o recurso inexistente (o no visible para la organización). |
| `23514` | 422 | Violación de CHECK. Se devuelve el mensaje del `RAISE`. |
| `23505` | 422 | Duplicado en una restricción única. |
| `22023` | 400 | Parámetro no admitido por una función de `civic_kpi`. |
| resto | 500 | Mensaje genérico; el detalle sólo va al registro. |

Cada respuesta lleva la cabecera `X-Request-ID` (se hereda del proxy si ya
existe) y toda línea de registro de esa petición la incluye.

## Endpoints

`/health` y `/ready` van **fuera** del prefijo de versión: son contrato del
orquestador. El resto cuelga de `API_PREFIX` (`/v1` por defecto).

### Sondas (públicas)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Vivacidad. No toca la base. |
| GET | `/ready` | Disponibilidad. Comprueba PostgreSQL. |

### Campañas e indicadores

| Método | Ruta |
|---|---|
| GET | `/v1/campaigns` |
| GET | `/v1/campaigns/{code}` |
| GET | `/v1/campaigns/{code}/overview` |
| GET | `/v1/campaigns/{code}/timeseries` |
| GET | `/v1/campaigns/{code}/contenders` |
| GET | `/v1/campaigns/{code}/topics` |
| GET | `/v1/campaigns/{code}/crisis` |
| GET | `/v1/campaigns/{code}/coordination` |
| GET | `/v1/campaigns/{code}/entities` |
| GET | `/v1/campaigns/{code}/emotions` |
| GET | `/v1/campaigns/{code}/sources` |

### Inferencias y revisión humana

| Método | Ruta |
|---|---|
| GET | `/v1/campaigns/{code}/inferences` |
| GET | `/v1/inferences/{inference_id}` |
| GET | `/v1/campaigns/{code}/review-queue` |
| POST | `/v1/inferences/{inference_id}/annotate` |
| PATCH | `/v1/inferences/{inference_id}/review` |

Toda consulta a `civic_api.inferences` exige `campaign_code` y rango de
`published_at`: la tabla está particionada por fecha y sin rango no hay poda de
particiones.

### Alertas y reglas

| Método | Ruta |
|---|---|
| GET | `/v1/campaigns/{code}/alerts` |
| PATCH | `/v1/alerts/{alert_id}` |
| GET | `/v1/campaigns/{code}/alert-rules` |
| POST | `/v1/campaigns/{code}/alert-rules` |
| PATCH | `/v1/alert-rules/{rule_id}` |
| DELETE | `/v1/alert-rules/{rule_id}` |
| POST | `/v1/campaigns/{code}/evaluate-rules` |

### Trabajos

| Método | Ruta |
|---|---|
| GET | `/v1/campaigns/{code}/jobs` |
| POST | `/v1/campaigns/{code}/jobs` |
| GET | `/v1/jobs/{job_id}` |
| PATCH | `/v1/jobs/{job_id}` |

### Evaluación de modelos

| Método | Ruta |
|---|---|
| GET / POST | `/v1/evaluation/datasets` |
| POST | `/v1/evaluation/datasets/{dataset_id}/freeze` |
| POST | `/v1/evaluation/datasets/{dataset_id}/items` |
| GET / POST | `/v1/evaluation/runs` |
| GET | `/v1/evaluation/runs/{run_id}` |
| POST | `/v1/evaluation/runs/{run_id}/compute-metrics` |
| GET | `/v1/evaluation/runs/{run_id}/metrics` |
| GET | `/v1/evaluation/runs/{run_id}/confusion` |
| GET | `/v1/evaluation/runs/{run_id}/compare` |
| GET | `/v1/evaluation/runs/{run_id}/gate` |
| GET | `/v1/evaluation/runs/{run_id}/errors` |

### Catálogos y operación

| Método | Ruta | Rol |
|---|---|---|
| GET | `/v1/catalogs` | cualquiera |
| GET | `/v1/metrics` | cualquiera |
| GET | `/v1/ops/compliance` | `auditor`, `admin`, `owner` |
| POST | `/v1/ops/refresh-kpis` | `admin`+ |

## Estructura

```
app/
  main.py            montaje, CORS, request-id, traducción de errores
  core/              config, database, auth, context (RLS), logging, sql
  routers/           los siete routers HTTP
  schemas/           modelos Pydantic de entrada y salida
  services/          clasificador por LLM y registro de prompts
```
