"""Punto de entrada de sentiment-api.

Tres cosas se deciden aquí y no en otro sitio:

1. Dónde se monta cada router. Los de negocio cuelgan de `settings.API_PREFIX`;
   `/health` y `/ready` NO, porque son el contrato del orquestador y no deben
   moverse cuando se versiona la API.
2. Cómo se traduce un error de PostgreSQL a HTTP. La base usa los SQLSTATE
   como parte del contrato (`P0002` cuando una campaña no existe, `23514` en
   los CHECK de consentimiento y umbrales, `22023` cuando se pide una métrica
   desconocida). Devolver 500 ante cualquiera de ellos oculta justo la
   información que el operador necesita.
3. El identificador de petición. Se genera o se hereda del proxy y viaja en el
   `ContextVar` del logger, de modo que toda línea escrita durante la petición
   sale correlacionada.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.core.config import settings
from app.core.database import dispose_engine
from app.core.logging import configure_logging, get_logger, request_id_ctx
from app.routers import (
    alerts,
    campaigns,
    catalogs,
    evaluation,
    inferences,
    jobs,
    ops,
)
from app.schemas.common import ErrorResponse

log = get_logger(__name__)

REQUEST_ID_HEADER = "X-Request-ID"

DESCRIPTION = """
API analítica de Análisis de Sentimientos.

**Aviso metodológico**: los indicadores miden *conversación pública digital*,
no intención de voto. Quien publica no es una muestra representativa del
electorado. Todo número viaja con su tamaño de muestra y su advertencia
(`caveat`) tomados de `civic_kpi.metric_registry`.
"""


# =============================================================================
# Ciclo de vida
# =============================================================================
@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    configure_logging(settings.LOG_LEVEL)
    log.info(
        "sentiment_api.startup",
        version=__version__,
        api_prefix=settings.API_PREFIX,
        cors_origins=settings.cors_origins_list,
        classifier_enabled=settings.CLASSIFIER_ENABLED,
    )
    if settings.AUTH_DISABLED:
        # A gritos: con esto encendido cualquiera es dueño de DEV_ORG_ID.
        log.error(
            "sentiment_api.auth_disabled",
            dev_org_id=settings.DEV_ORG_ID,
            aviso="AUTH_DISABLED=true; NO debe usarse fuera de desarrollo.",
        )
    if "*" in settings.cors_origins_list:
        log.warning("sentiment_api.cors_wildcard", aviso="CORS_ORIGINS='*' en uso.")

    try:
        yield
    finally:
        await dispose_engine()
        log.info("sentiment_api.shutdown")


app = FastAPI(
    title="Análisis de Sentimientos Sentiment API",
    description=DESCRIPTION,
    version=__version__,
    lifespan=lifespan,
    docs_url=f"{settings.API_PREFIX}/docs",
    redoc_url=f"{settings.API_PREFIX}/redoc",
    openapi_url=f"{settings.API_PREFIX}/openapi.json",
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)


# =============================================================================
# Middleware
# =============================================================================
# Lista blanca explícita. Con `allow_credentials=True` reflejar el Origin
# recibido equivale a no tener CORS, así que nunca se refleja.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", REQUEST_ID_HEADER],
    expose_headers=[REQUEST_ID_HEADER],
    max_age=600,
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next: Any) -> Any:
    """Fija el id de petición y registra el acceso.

    Si el proxy ya generó uno se respeta: generar otro en cada salto haría
    imposible seguir una petición que atraviesa tablero → API → base. Se acota
    la longitud porque el valor entra de fuera y acaba en los registros.
    """
    incoming = request.headers.get(REQUEST_ID_HEADER, "")
    request_id = incoming if 0 < len(incoming) <= 128 else str(uuid.uuid4())

    token = request_id_ctx.set(request_id)
    request.state.request_id = request_id
    try:
        response = await call_next(request)
    finally:
        request_id_ctx.reset(token)

    response.headers[REQUEST_ID_HEADER] = request_id
    return response


# =============================================================================
# Traducción de errores
# =============================================================================
# SQLSTATE → (código HTTP, código de error del contrato, mensaje por defecto).
# Sólo los que la base emite a propósito; el resto cae en 500.
_SQLSTATE_MAP: dict[str, tuple[int, str, str]] = {
    # RAISE ... USING ERRCODE = 'P0002' en las funciones de civic_kpi cuando la
    # campaña no existe o no es visible para la organización activa.
    "P0002": (status.HTTP_404_NOT_FOUND, "NOT_FOUND", "El recurso solicitado no existe."),
    "23514": (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "CHECK_VIOLATION",
        "La operación viola una restricción del modelo.",
    ),
    "23505": (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "DUPLICATE",
        "Ya existe un registro con esos valores únicos.",
    ),
    "22023": (
        status.HTTP_400_BAD_REQUEST,
        "INVALID_PARAMETER",
        "Parámetro no admitido por la función de base de datos.",
    ),
}


def _sqlstate_of(exc: BaseException) -> str | None:
    """SQLSTATE del error original, venga de asyncpg o de otro driver.

    asyncpg lo expone en `sqlstate`; psycopg y el resto usan `pgcode`. Se mira
    tanto la excepción como su `orig` porque SQLAlchemy envuelve la del driver.
    """
    for candidate in (getattr(exc, "orig", None), exc):
        if candidate is None:
            continue
        code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if code:
            return str(code)
    return None


def _pg_message(exc: BaseException) -> str | None:
    """Mensaje que escribió el RAISE de la base, sin el resto del contexto.

    Es lo único del error de PostgreSQL que se expone al cliente, y sólo en los
    SQLSTATE mapeados: el texto del CHECK está redactado para leerse.
    """
    orig = getattr(exc, "orig", None) or exc
    message = getattr(orig, "message", None)
    if message:
        return str(message).strip()
    text = str(orig).strip()
    return text.splitlines()[0] if text else None


def _error_response(
    request: Request, status_code: int, detail: str, code: str | None = None
) -> JSONResponse:
    body = ErrorResponse(
        detail=detail,
        code=code,
        request_id=getattr(request.state, "request_id", None),
    )
    return JSONResponse(status_code=status_code, content=body.model_dump())


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Da a los errores de FastAPI la misma forma que a los demás."""
    response = _error_response(request, exc.status_code, str(exc.detail), "HTTP_ERROR")
    # Sin esto un 401 pierde el WWW-Authenticate que exige el estándar.
    for key, value in (exc.headers or {}).items():
        response.headers[key] = value
    return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """422 con el detalle campo a campo: el formulario del tablero lo necesita."""
    body = {
        "detail": "La solicitud no superó la validación.",
        "code": "VALIDATION_FAILED",
        "request_id": getattr(request.state, "request_id", None),
        "errors": [
            {
                "field": ".".join(str(p) for p in err.get("loc", ())) or "(raíz)",
                "message": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in exc.errors()
        ],
    }
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=body)


@app.exception_handler(SQLAlchemyError)
async def database_exception_handler(
    request: Request, exc: SQLAlchemyError
) -> JSONResponse:
    """Traduce el SQLSTATE a HTTP; lo no mapeado sale como 500 opaco."""
    sqlstate = _sqlstate_of(exc) if isinstance(exc, DBAPIError) else None
    mapped = _SQLSTATE_MAP.get(sqlstate or "")

    if mapped is None:
        log.error(
            "database.unhandled_error",
            sqlstate=sqlstate,
            path=request.url.path,
            error=str(exc),
            exc_info=True,
        )
        return _error_response(
            request,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Error interno del servicio.",
            "INTERNAL_ERROR",
        )

    http_status, code, fallback = mapped
    detail = _pg_message(exc) or fallback
    log.warning(
        "database.mapped_error",
        sqlstate=sqlstate,
        code=code,
        path=request.url.path,
        detail=detail,
    )
    return _error_response(request, http_status, detail, code)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Última red. Nada del interior sale al cliente: nombres de tablas, rutas
    y cadenas de conexión aparecen con frecuencia en los mensajes de error."""
    log.error(
        "request.unhandled_error",
        path=request.url.path,
        method=request.method,
        error=str(exc),
        exc_info=True,
    )
    return _error_response(
        request,
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "Error interno del servicio.",
        "INTERNAL_ERROR",
    )


# =============================================================================
# Montaje de routers
# =============================================================================
# Sondas del orquestador: fuera del prefijo de versión, a propósito.
app.include_router(ops.public_router)

for _router in (
    campaigns.router,
    inferences.router,
    alerts.router,
    jobs.router,
    evaluation.router,
    catalogs.router,
    ops.router,
):
    app.include_router(_router, prefix=settings.API_PREFIX)


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {
        "service": "sentiment-api",
        "version": __version__,
        "docs": f"{settings.API_PREFIX}/docs",
        "health": "/health",
    }


if __name__ == "__main__":  # pragma: no cover - sólo para ejecución directa
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",  # noqa: S104 - dentro del contenedor es lo correcto
        port=settings.PORT,
        log_config=None,  # el formato JSON lo define configure_logging
    )
