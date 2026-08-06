"""Autenticación con Keycloak (RS256 contra JWKS) y autorización por rol.

Dos decisiones que conviene no revertir:

1. La organización NUNCA sale de la petición. Se toma del claim
   `organization_id` o, si el realm no lo emite, de `civic.memberships`. Un
   parámetro `?org_id=` sería un salto de tenant de un solo carácter.
2. El JWKS se cachea por `kid` con TTL corto y se refresca a la fuerza ante un
   `kid` desconocido: es lo que hace que una rotación de llaves en Keycloak no
   tumbe el servicio ni obligue a reiniciarlo.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt
from jose.exceptions import JWTError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.logging import get_logger

log = get_logger(__name__)

# Roles del modelo (civic.memberships.role). El rango sólo ordena la escalera
# de gestión; `auditor` es lectura ampliada, no un escalón superior a analyst.
ROLE_OWNER = "owner"
ROLE_ADMIN = "admin"
ROLE_STRATEGIST = "strategist"
ROLE_ANALYST = "analyst"
ROLE_VIEWER = "viewer"
ROLE_AUDITOR = "auditor"

KNOWN_ROLES: frozenset[str] = frozenset(
    {ROLE_OWNER, ROLE_ADMIN, ROLE_STRATEGIST, ROLE_ANALYST, ROLE_VIEWER, ROLE_AUDITOR}
)

ROLE_RANK: dict[str, int] = {
    ROLE_VIEWER: 10,
    ROLE_AUDITOR: 15,
    ROLE_ANALYST: 20,
    ROLE_STRATEGIST: 30,
    ROLE_ADMIN: 40,
    ROLE_OWNER: 50,
}

_bearer = HTTPBearer(auto_error=False)


# =============================================================================
# Usuario autenticado
# =============================================================================
@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    """Identidad resuelta del token. Es lo único en lo que confía la capa SQL."""

    sub: str
    username: str
    email: str | None
    organization_id: uuid.UUID
    roles: frozenset[str] = field(default_factory=frozenset)

    @property
    def max_rank(self) -> int:
        return max((ROLE_RANK.get(r, 0) for r in self.roles), default=0)

    def has_any(self, roles: frozenset[str]) -> bool:
        return bool(self.roles & roles)


# =============================================================================
# Caché de JWKS
# =============================================================================
class JwksCache:
    """Llaves públicas del realm indexadas por `kid`, con TTL de 300 s."""

    TTL_SECONDS = 300
    # Suelo entre refrescos forzados: un token con `kid` basura no debe poder
    # convertirse en una tormenta de peticiones contra Keycloak.
    MIN_REFRESH_INTERVAL = 10

    def __init__(self) -> None:
        self._keys: dict[str, dict[str, Any]] = {}
        self._fetched_at: float = 0.0
        self._last_attempt: float = 0.0

    @property
    def _is_stale(self) -> bool:
        return (time.monotonic() - self._fetched_at) > self.TTL_SECONDS

    async def _fetch(self) -> None:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(settings.jwks_url)
            response.raise_for_status()
            payload = response.json()

        keys = {k["kid"]: k for k in payload.get("keys", []) if "kid" in k}
        if not keys:
            raise ValueError("El JWKS del realm no devolvió ninguna llave con kid.")

        self._keys = keys
        self._fetched_at = time.monotonic()
        log.info("jwks.refreshed", key_count=len(keys), url=settings.jwks_url)

    async def get_key(self, kid: str) -> dict[str, Any]:
        """Llave del `kid`, refrescando si hace falta.

        Un `kid` ausente se trata como rotación de llaves, no como error: se
        vuelve a pedir el JWKS antes de rechazar el token.
        """
        if not self._keys or self._is_stale:
            await self._safe_refresh()

        if kid not in self._keys:
            await self._safe_refresh(force=True)

        key = self._keys.get(kid)
        if key is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="La llave que firma el token no pertenece al realm.",
            )
        return key

    async def _safe_refresh(self, force: bool = False) -> None:
        now = time.monotonic()
        if force and (now - self._last_attempt) < self.MIN_REFRESH_INTERVAL:
            return
        self._last_attempt = now
        try:
            await self._fetch()
        except Exception as exc:  # httpx, JSON o realm mal configurado
            log.error("jwks.fetch_failed", error=str(exc))
            if not self._keys:
                # Sin llaves en caché no hay forma de validar nada.
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="No se pudo obtener el JWKS del proveedor de identidad.",
                ) from exc


jwks_cache = JwksCache()


# =============================================================================
# Extracción de claims
# =============================================================================
def _extract_roles(claims: dict[str, Any]) -> set[str]:
    """Roles del realm y del cliente, filtrados contra el catálogo conocido."""
    roles: set[str] = set()
    roles.update(claims.get("realm_access", {}).get("roles", []) or [])

    resource_access = claims.get("resource_access", {}) or {}
    for client in {settings.KC_AUDIENCE, "oeste-sentimientos-api"}:
        roles.update(resource_access.get(client, {}).get("roles", []) or [])

    # Keycloak emite además roles técnicos (offline_access, uma_authorization).
    return {r for r in roles if r in KNOWN_ROLES}


async def _resolve_organization(
    db: AsyncSession, claims: dict[str, Any], sub: str
) -> tuple[uuid.UUID, set[str]]:
    """Organización y rol del usuario.

    Prioridad: claim `organization_id` del token; si el realm no lo mapea, se
    resuelve por `keycloak_sub` contra las membresías vigentes. `app_users` y
    `memberships` no tienen RLS, así que se pueden leer sin contexto de sesión
    (que es justo lo que aún no se puede fijar en este punto).
    """
    claim_org = claims.get("organization_id") or claims.get("org_id")

    row = (
        await db.execute(
            text(
                """
                SELECT m.organization_id, m.role
                FROM   civic.memberships m
                JOIN   civic.app_users   u ON u.id = m.user_id
                WHERE  u.keycloak_sub = :sub
                  AND  u.is_active
                  AND  m.revoked_at IS NULL
                ORDER  BY m.created_at
                LIMIT  1
                """
            ),
            {"sub": sub},
        )
    ).first()

    db_roles: set[str] = set()
    if row is not None and row.role in KNOWN_ROLES:
        db_roles.add(row.role)

    if claim_org:
        try:
            return uuid.UUID(str(claim_org)), db_roles
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="El claim organization_id no es un UUID válido.",
            ) from exc

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="El usuario no pertenece a ninguna organización activa.",
        )
    return row.organization_id, db_roles


# =============================================================================
# Dependencia principal
# =============================================================================
async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AuthenticatedUser:
    """Valida el token y devuelve la identidad con su organización y roles."""
    if settings.AUTH_DISABLED:
        # Sólo desarrollo. El arranque del servicio deja constancia en el log.
        return AuthenticatedUser(
            sub="dev-sub",
            username="dev",
            email="dev@localhost",
            organization_id=uuid.UUID(settings.DEV_ORG_ID),
            roles=frozenset(KNOWN_ROLES),
        )

    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Falta la credencial Bearer.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token ilegible."
        ) from exc

    if header.get("alg") != "RS256":
        # Rechazo explícito: aceptar el `alg` del propio token es la puerta de
        # entrada al ataque de confusión de algoritmo (alg=none, HS256).
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Algoritmo de firma no admitido; se exige RS256.",
        )

    kid = header.get("kid")
    if not kid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no declara kid."
        )

    key = await jwks_cache.get_key(kid)
    options = {"verify_aud": bool(settings.KC_AUDIENCE)}

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.KC_AUDIENCE or None,
            issuer=settings.token_issuer,
            options=options,
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token inválido: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no trae sub."
        )

    organization_id, db_roles = await _resolve_organization(db, claims, sub)
    roles = _extract_roles(claims) | db_roles

    if not roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="El usuario no tiene ningún rol de Análisis de Sentimientos asignado.",
        )

    return AuthenticatedUser(
        sub=sub,
        username=claims.get("preferred_username") or claims.get("email") or sub,
        email=claims.get("email"),
        organization_id=organization_id,
        roles=frozenset(roles),
    )


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


# =============================================================================
# Autorización
# =============================================================================
def require_roles(*roles: str) -> Callable[..., Awaitable[AuthenticatedUser]]:
    """Exige pertenecer a alguno de los roles indicados (coincidencia exacta).

    Úsese cuando el permiso no es una escalera: `/ops/compliance` lo pueden ver
    auditor y admin, pero no strategist, que está "por encima" de auditor en
    gestión y no tiene por qué ver la bitácora de cumplimiento.
    """
    unknown = set(roles) - KNOWN_ROLES
    if unknown:
        raise ValueError(f"Roles desconocidos en require_roles: {sorted(unknown)}")
    allowed = frozenset(roles)

    async def _dependency(user: CurrentUser) -> AuthenticatedUser:
        if not user.has_any(allowed):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "Se requiere alguno de los roles: "
                    f"{', '.join(sorted(allowed))}."
                ),
            )
        return user

    return _dependency


def require_min_role(role: str) -> Callable[..., Awaitable[AuthenticatedUser]]:
    """Exige ese rol o uno superior en la escalera de gestión ("analyst+")."""
    if role not in ROLE_RANK:
        raise ValueError(f"Rol desconocido en require_min_role: {role}")
    minimum = ROLE_RANK[role]

    async def _dependency(user: CurrentUser) -> AuthenticatedUser:
        if user.max_rank < minimum:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Se requiere el rol {role} o superior.",
            )
        return user

    return _dependency
