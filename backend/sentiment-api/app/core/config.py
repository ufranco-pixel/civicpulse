"""Configuración del servicio.

Todo se lee del entorno: la imagen del contenedor es idéntica en cada ambiente
y sólo cambian las variables. Nada de valores por defecto que sirvan en
producción sin revisarlos (la clave del LLM y la cadena de conexión no tienen
un valor razonable "de fábrica").
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Variables de entorno del microservicio."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # ── Base de datos externa ────────────────────────────────────────────────
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://civicpulse_app@localhost:5432/civicpulse",
        description="DSN asíncrono. Debe usar asyncpg y NO llevar sslmode en la URL.",
    )
    # TLS. asyncpg no acepta sslmode en la cadena, así que se declara aparte y
    # app/core/database.py lo traduce a un SSLContext.
    DATABASE_SSL: bool = Field(
        default=True,
        description="Activa TLS. Déjelo en true salvo con una base en la misma red privada.",
    )
    DATABASE_SSL_ROOT_CERT: str = Field(
        default="",
        description="Ruta al certificado de la CA. Sólo con sslmode=verify-full o verify-ca.",
    )

    POOL_SIZE: int = Field(default=10, ge=1, le=100)
    MAX_OVERFLOW: int = Field(default=5, ge=0, le=100)
    # Contra una base externa el pool debe reciclar conexiones antes de que las
    # corte el balanceador o el NAT del proveedor. 1800 s va por debajo del
    # tiempo de inactividad habitual (normalmente 3600 s).
    POOL_RECYCLE_SEC: int = Field(default=1800, ge=60)
    # Corta en la base cualquier consulta que se desboque. Es la única defensa
    # real contra una consulta sin poda de particiones que bloquee el pool.
    STATEMENT_TIMEOUT_MS: int = Field(default=15_000, ge=1_000)

    # ── Identidad (Keycloak) ─────────────────────────────────────────────────
    KC_URL: str = Field(default="http://localhost:8080")
    KC_REALM: str = Field(default="civicpulse")
    KC_AUDIENCE: str = Field(
        default="civicpulse-api",
        description="Claim `aud` esperado. Vacío desactiva la verificación de audiencia.",
    )

    # ── Servicio HTTP ────────────────────────────────────────────────────────
    API_PREFIX: str = Field(default="/v1")
    PORT: int = Field(default=8000, ge=1, le=65535)
    LOG_LEVEL: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    CORS_ORIGINS: str = Field(
        default="http://localhost:5173",
        description="Orígenes permitidos separados por coma. '*' sólo en desarrollo.",
    )

    # ── Desarrollo ───────────────────────────────────────────────────────────
    # Con AUTH_DISABLED se inyecta un usuario ficticio. Existe para levantar el
    # tablero sin Keycloak; el arranque avisa a gritos si queda encendido.
    AUTH_DISABLED: bool = False
    DEV_ORG_ID: str = Field(
        default="00000000-0000-0000-0000-000000000000",
        description="Organización que se asume con AUTH_DISABLED=true.",
    )

    # ── Clasificador LLM ─────────────────────────────────────────────────────
    CLASSIFIER_ENABLED: bool = False
    LLM_PROVIDER: Literal["gemini", "openai", "anthropic"] = "gemini"

    # Google AI Studio: https://aistudio.google.com/apikey
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-flash-lite-latest"
    GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com"
    # v1beta expone responseMimeType y responseSchema, que son lo que permite
    # forzar salida JSON. v1 todavía no los soporta.
    GEMINI_API_VERSION: str = "v1beta"

    # Los filtros de seguridad de Gemini bloquean discurso político agresivo,
    # que es justo lo que este sistema debe clasificar. Si se bloquean esos
    # contenidos y se descartan en silencio, el tablero queda sesgado hacia lo
    # positivo. Con BLOCK_NONE el modelo analiza el texto sin generar contenido
    # dañino: sólo lo etiqueta. Requiere que la cuenta tenga permitido ese ajuste.
    GEMINI_SAFETY_THRESHOLD: Literal[
        "BLOCK_NONE", "BLOCK_ONLY_HIGH", "BLOCK_MEDIUM_AND_ABOVE", "BLOCK_LOW_AND_ABOVE"
    ] = "BLOCK_NONE"

    # Referencia al secreto para los demás proveedores. Admite «vault://…»,
    # «env:NOMBRE» o el valor literal en desarrollo.
    LLM_API_KEY_REF: str = ""
    LLM_MODEL: str = "gemini-flash-lite-latest"
    LLM_BASE_URL: str = ""
    LLM_TIMEOUT_MS: int = Field(default=30_000, ge=1_000)

    # Contenidos que toma cada corrida del clasificador. Equivale al
    # EVENTS_POST_LIMIT del proyecto de detección de eventos.
    CLASSIFIER_BATCH_LIMIT: int = Field(default=30, ge=1, le=500)
    # Umbral por defecto cuando la campaña no define el suyo en
    # civic.campaign_pipeline.min_confidence, que tiene prioridad.
    CLASSIFIER_MIN_CONFIDENCE: float = Field(default=0.6, ge=0.0, le=1.0)

    @field_validator("API_PREFIX")
    @classmethod
    def _normalize_prefix(cls, v: str) -> str:
        """FastAPI exige prefijo con barra inicial y sin barra final."""
        v = "/" + v.strip().strip("/")
        return "" if v == "/" else v

    @field_validator("DATABASE_URL")
    @classmethod
    def _require_async_driver(cls, v: str) -> str:
        # Con el driver síncrono el servicio arrancaría y bloquearía el bucle de
        # eventos en la primera consulta. Mejor fallar al construir la config.
        #
        # El error típico al migrar a una base externa es pegar la URL que da el
        # proveedor, que viene con el prefijo síncrono. El mensaje lo dice.
        if v.startswith(("postgresql://", "postgres://")):
            raise ValueError(
                "DATABASE_URL de sentiment-api debe usar el driver asíncrono. "
                "Cambie «postgresql://» por «postgresql+asyncpg://». "
                "Los servicios Node sí usan la forma síncrona: son dos variables distintas."
            )
        if not v.startswith("postgresql+asyncpg://"):
            raise ValueError("DATABASE_URL debe empezar con postgresql+asyncpg://")
        if "sslmode=" in v:
            raise ValueError(
                "asyncpg no admite «sslmode» en la URL. Quítelo y use DATABASE_SSL=true; "
                "el TLS se configura en el motor, no en la cadena."
            )
        return v

    # ── Propiedades derivadas ────────────────────────────────────────────────
    @property
    def token_issuer(self) -> str:
        """Emisor esperado en el claim `iss` del token."""
        return f"{self.KC_URL.rstrip('/')}/realms/{self.KC_REALM}"

    @property
    def jwks_url(self) -> str:
        """Endpoint de llaves públicas del realm."""
        return f"{self.token_issuer}/protocol/openid-connect/certs"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def llm_timeout_seconds(self) -> float:
        return self.LLM_TIMEOUT_MS / 1000.0

    @property
    def gemini_safety_settings(self) -> list[dict[str, str]]:
        """Ajustes de seguridad aplicados a cada llamada a Gemini.

        Se listan explícitamente las cuatro categorías: omitir una deja el
        umbral por defecto del proveedor, que sí bloquea. Un bloqueo silencioso
        significa que ese comentario no se clasifica, y como los bloqueados son
        casi siempre los agresivos, el agregado se desplaza hacia lo positivo.
        """
        return [
            {"category": c, "threshold": self.GEMINI_SAFETY_THRESHOLD}
            for c in (
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Instancia única. Se cachea para no releer el entorno en cada petición."""
    return Settings()


settings: Settings = get_settings()
