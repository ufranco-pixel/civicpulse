"""Utilidades de acceso a datos.

Todo el SQL del servicio se escribe con `text()` y parámetros nombrados. Las
cláusulas WHERE dinámicas se arman concatenando ÚNICAMENTE fragmentos fijos
definidos en el propio código; los valores siempre viajan como parámetros.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Sequence, TypeVar

from fastapi import HTTPException, status
from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession

from pydantic import BaseModel

M = TypeVar("M", bound=BaseModel)

# Tope duro de la ventana consultable sobre `civic_api.inferences`. Sin límite,
# una petición sin fechas recorrería todas las particiones del histórico.
MAX_WINDOW_DAYS = 400

# Tope cuando se pide explícitamente «todo el periodo». Es más alto porque en
# ese caso el arranque NO es arbitrario: sale de la fecha del contenido más
# antiguo de la campaña, así que la ventana se ajusta sola a los datos reales.
MAX_ALL_TIME_DAYS = 1825  # 5 años


async def fetch_all(
    session: AsyncSession, sql: str, params: dict[str, Any] | None = None
) -> Sequence[Row[Any]]:
    result = await session.execute(text(sql), params or {})
    return result.fetchall()


async def fetch_one(
    session: AsyncSession, sql: str, params: dict[str, Any] | None = None
) -> Row[Any] | None:
    result = await session.execute(text(sql), params or {})
    return result.first()


async def fetch_scalar(
    session: AsyncSession, sql: str, params: dict[str, Any] | None = None
) -> Any:
    result = await session.execute(text(sql), params or {})
    return result.scalar()


async def execute(
    session: AsyncSession, sql: str, params: dict[str, Any] | None = None
) -> int:
    """Ejecuta una sentencia de escritura y devuelve las filas afectadas.

    No confirma: el commit lo hace `db_ctx` al cerrar la petición, de modo que
    toda la petición es una sola transacción con el contexto de RLS vigente.
    """
    result = await session.execute(text(sql), params or {})
    return result.rowcount or 0


def to_models(model_cls: type[M], rows: Sequence[Row[Any]]) -> list[M]:
    """Convierte filas de SQLAlchemy en modelos Pydantic (`from_attributes`)."""
    return [model_cls.model_validate(row, from_attributes=True) for row in rows]


def to_model(model_cls: type[M], row: Row[Any] | None) -> M | None:
    return None if row is None else model_cls.model_validate(row, from_attributes=True)


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=what)


async def campaign_data_start(session: AsyncSession, code: str) -> datetime | None:
    """Fecha del contenido más antiguo de la campaña, o None si no hay ninguno.

    Es lo que da sentido a la opción «todo el periodo»: en vez de inventar una
    ventana fija se acota al rango que la campaña realmente cubre, de modo que
    la poda de particiones sigue funcionando.

    No se usa `campaigns.starts_on` a propósito: es opcional y en la práctica
    suele venir vacío, además de que el contenido cargado puede ser anterior al
    arranque formal de la campaña. La fecha del dato es el único límite que no
    miente.

    Se consulta a través de `civic_api.inferences`, no de las tablas base, para
    que RLS aplique igual que en el listado.
    """
    value = await fetch_scalar(
        session,
        "SELECT min(published_at) FROM civic_api.inferences WHERE campaign_code = :code",
        {"code": code},
    )
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def resolve_window(
    date_from: datetime | None,
    date_to: datetime | None,
    default_days: int = 30,
    max_days: int = MAX_WINDOW_DAYS,
) -> tuple[datetime, datetime]:
    """Rango de `published_at` con valores por defecto.

    Es obligatorio acotar: `civic.inferences` está particionada por fecha y sin
    rango no hay poda de particiones, con lo que la consulta recorre todo el
    histórico y agota el `statement_timeout`.
    """
    now = datetime.now(timezone.utc)
    end = date_to or now
    start = date_from or (end - timedelta(days=default_days))

    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    if start > end:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="date_from no puede ser posterior a date_to.",
        )
    if (end - start).days > max_days:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"La ventana no puede exceder {max_days} días.",
        )
    return start, end


async def assert_campaign_visible(session: AsyncSession, code: str) -> Any:
    """Comprueba que la campaña existe y es visible para la organización activa.

    Con RLS, una campaña de otra organización simplemente no aparece: se
    responde 404 y no 403, para no confirmar su existencia.
    """
    row = await fetch_one(
        session,
        """
        SELECT id, code, timezone
        FROM   civic_api.campaigns
        WHERE  code = :code
        """,
        {"code": code},
    )
    if row is None:
        raise not_found(f"Campaña '{code}' no encontrada.")
    return row
