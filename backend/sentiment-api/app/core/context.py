"""Contexto de transacción con RLS aplicada.

`civic_ops.set_session_context` fija las variables con alcance de transacción
(`set_config(..., is_local => TRUE)`). Por eso hay que llamarla en CADA
transacción y no una vez por conexión: el pool reutiliza conexiones entre
peticiones y un contexto persistente filtraría datos de otra organización.

Sin la llamada, las políticas de RLS ven `organization_id = NULL` y todas las
consultas devuelven cero filas. Un endpoint que "no trae datos" casi siempre es
un endpoint que se olvidó de `db_ctx`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.database import get_db

_SET_CONTEXT = text(
    "SELECT civic_ops.set_session_context(CAST(:org_id AS uuid), :sub, :username)"
)


@dataclass(frozen=True, slots=True)
class DbContext:
    """Sesión con contexto de organización ya fijado, más el usuario del token."""

    session: AsyncSession
    user: AuthenticatedUser


async def db_ctx(
    session: Annotated[AsyncSession, Depends(get_db)],
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
) -> AsyncIterator[DbContext]:
    """Abre la transacción, fija el contexto y confirma al terminar.

    El commit vive aquí y no en cada ruta: si un manejador confirmara a medias,
    la transacción siguiente arrancaría sin contexto y las consultas
    posteriores devolverían vacío en silencio.
    """
    await session.execute(
        _SET_CONTEXT,
        {
            "org_id": str(user.organization_id),
            "sub": user.sub,
            "username": user.username,
        },
    )
    try:
        yield DbContext(session=session, user=user)
        await session.commit()
    except Exception:
        await session.rollback()
        raise


Ctx = Annotated[DbContext, Depends(db_ctx)]
