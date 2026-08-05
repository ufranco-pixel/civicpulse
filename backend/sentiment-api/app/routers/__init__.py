"""Routers HTTP de la API.

Cada módulo declara su propio `router` con el prefijo que le corresponde; el
montaje bajo `settings.API_PREFIX` lo hace `app.main`. `ops` expone además un
`public_router` con las sondas, que se montan FUERA del prefijo de versión.
"""

from app.routers import (
    alerts,
    campaigns,
    catalogs,
    evaluation,
    inferences,
    jobs,
    ops,
)

__all__ = [
    "alerts",
    "campaigns",
    "catalogs",
    "evaluation",
    "inferences",
    "jobs",
    "ops",
]
