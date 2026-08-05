"""Motor y sesión asíncrona de SQLAlchemy contra la base de datos externa.

El `statement_timeout` se fija en la conexión (no por consulta) para que
cualquier consulta que se salga de rango muera en la base y libere el pool.
"""

from __future__ import annotations

import ssl
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings


def _split_url_and_ssl(url: str) -> tuple[str, Any]:
    """Separa la configuración TLS de la URL de conexión.

    asyncpg NO acepta `sslmode` como parámetro de la URL —falla con
    «unexpected keyword argument 'sslmode'»— pero es justo lo que traen las
    cadenas de conexión que dan los proveedores gestionados. Copiar y pegar esa
    URL rompe el arranque con un error que no dice nada de TLS.

    Aquí se extrae `sslmode` (y `ssl`) de la URL, se traduce al objeto SSLContext
    que asyncpg sí entiende, y se devuelve la URL limpia.

    `verify-full` verifica además el nombre del host, que es lo que impide un
    intermediario. `require` cifra pero no valida el certificado: sirve contra
    escucha pasiva, no contra suplantación.
    """
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))

    sslmode = (query.pop("sslmode", "") or query.pop("ssl", "")).lower()
    clean_url = urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )

    # DATABASE_SSL fuerza TLS aunque la URL no lo pida.
    if not sslmode and settings.DATABASE_SSL:
        sslmode = "require"

    if sslmode in ("", "disable", "allow", "false", "0"):
        return clean_url, None

    if sslmode in ("verify-full", "verify-ca"):
        ctx = ssl.create_default_context()
        if settings.DATABASE_SSL_ROOT_CERT:
            ctx.load_verify_locations(cafile=settings.DATABASE_SSL_ROOT_CERT)
        if sslmode == "verify-ca":
            ctx.check_hostname = False
        return clean_url, ctx

    # require / prefer: cifra sin validar la cadena de certificación. Es lo que
    # hace psql con sslmode=require, y lo que aceptan casi todos los proveedores
    # gestionados sin necesidad de distribuir su CA.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return clean_url, ctx


_DB_URL, _SSL_CONTEXT = _split_url_and_ssl(settings.DATABASE_URL)

_connect_args: dict[str, Any] = {
    "server_settings": {
        "statement_timeout": str(settings.STATEMENT_TIMEOUT_MS),
        # Aparece en pg_stat_activity: hace evidente qué servicio consulta.
        # En una base externa compartida es la única forma de atribuir carga.
        "application_name": "civicpulse-sentiment-api",
        # El esquema interno NO va en la ruta de búsqueda: obliga a
        # calificar civic.* explícitamente y hace visible cualquier
        # consulta que se salte el contrato civic_api.
        "search_path": "civic_api,civic_kpi,public",
    },
    # El cacheo de sentencias preparadas es incompatible con pgbouncer en
    # modo transacción, que es como se despliega esto.
    "statement_cache_size": 0,
}

if _SSL_CONTEXT is not None:
    _connect_args["ssl"] = _SSL_CONTEXT

engine: AsyncEngine = create_async_engine(
    _DB_URL,
    echo=False,
    # Comprueba la conexión antes de entregarla: los cortes silenciosos del
    # pooler o del balanceador aparecen como "server closed the connection".
    # Con una base externa esto deja de ser opcional: entre la aplicación y el
    # servidor hay red, NAT y probablemente un balanceador con tiempo de espera.
    pool_pre_ping=True,
    pool_size=settings.POOL_SIZE,
    max_overflow=settings.MAX_OVERFLOW,
    # Recicla antes del corte típico de inactividad de pgbouncer/NAT.
    pool_recycle=settings.POOL_RECYCLE_SEC,
    pool_timeout=10,
    connect_args=_connect_args,
)

SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncIterator[AsyncSession]:
    """Sesión cruda, sin contexto de RLS.

    Sólo la usan `/ready` y la propia resolución de identidad (que consulta
    tablas sin RLS). Las rutas de negocio usan `db_ctx`.
    """
    async with SessionLocal() as session:
        yield session


async def dispose_engine() -> None:
    """Cierra el pool al apagar el servicio."""
    await engine.dispose()
