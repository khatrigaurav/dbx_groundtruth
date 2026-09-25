"""Database configuration: Lakebase (PostgreSQL/pg8000) with SQLite for local dev.

Backend is chosen by DATABASE_ENV:
- DATABASE_ENV=postgres  → Lakebase Postgres with per-connection OAuth token injection
- DATABASE_ENV=sqlite    → SQLite (default; used for local development)

Ported from the VibeScaler app's proven Lakebase wiring, trimmed of the SQLite→UC-Volume
rescue. Keeps the two hard-won fixes:
  1. pg8000 has no `sslmode` URL param — SSL is an `ssl_context` connect arg.
  2. `search_path` must be COMMITTED in the connect event, else the pool's
     reset-on-return ROLLBACK reverts it and reads fail with "relation does not exist".

Reference: https://docs.databricks.com/aws/en/lakebase/connect/custom-app.html
"""

from __future__ import annotations

import logging
import os
import re
import ssl
import time
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

_DEFAULT_APP_NAME = "groundtruth"


class DatabaseBackend(Enum):
    SQLITE = "sqlite"
    POSTGRESQL = "postgresql"


def _clean_identifier_part(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_]+", "_", value).strip("_").lower()
    return cleaned or "app"


def get_lakebase_schema_name(config: "LakebaseConfig | None" = None) -> str:
    """Stable Lakebase schema name (LAKEBASE_SCHEMA_NAME wins, else app name)."""
    explicit = os.getenv("LAKEBASE_SCHEMA_NAME")
    if explicit:
        return _clean_identifier_part(explicit)[:63]
    app_name = config.app_name if config else os.getenv("PGAPPNAME", _DEFAULT_APP_NAME)
    return _clean_identifier_part(app_name)[:63]


@dataclass
class LakebaseConfig:
    host: str
    database: str
    user: str
    port: int = 5432
    sslmode: str = "require"
    app_name: str = _DEFAULT_APP_NAME

    @classmethod
    def from_env(cls) -> "LakebaseConfig | None":
        host = os.getenv("PGHOST")
        database = os.getenv("PGDATABASE")
        user = os.getenv("PGUSER")
        if not all([host, database, user]):
            return None
        return cls(
            host=host,  # type: ignore[arg-type]
            database=database,  # type: ignore[arg-type]
            user=user,  # type: ignore[arg-type]
            port=int(os.getenv("PGPORT", "5432")),
            sslmode=os.getenv("PGSSLMODE", "require"),
            app_name=os.getenv("PGAPPNAME", _DEFAULT_APP_NAME),
        )


class LakebaseCredentialManager:
    """Caches a Lakebase credential and refreshes 2 min before its 1-hour expiry.

    Only consulted when the pool creates a NEW physical connection (via the
    SQLAlchemy `do_connect` event); existing pooled connections stay valid.
    """

    _EXPIRY_BUFFER_SECONDS = 120

    def __init__(self):
        self._token: str | None = None
        self._token_expiry: float = 0.0
        self._workspace_client = None

    def _get_workspace_client(self):
        if self._workspace_client is None:
            from databricks.sdk import WorkspaceClient

            self._workspace_client = WorkspaceClient()
        return self._workspace_client

    def get_password(self, endpoint_name: str | None) -> str:
        if not endpoint_name:
            raise RuntimeError(
                "ENDPOINT_NAME is required for DATABASE_ENV=postgres but is unset. "
                "Bind the Lakebase resource in app.yaml and set ENDPOINT_NAME to the "
                "endpoint path (projects/<db>/branches/<branch>/endpoints/<endpoint>)."
            )
        now = time.time()
        if self._token is not None and now < (self._token_expiry - self._EXPIRY_BUFFER_SECONDS):
            return self._token
        client = self._get_workspace_client()
        try:
            cred = client.postgres.generate_database_credential(endpoint=endpoint_name)
            token = cred.token
            if not token:
                raise RuntimeError(f"generate_database_credential returned empty token (endpoint={endpoint_name})")
            self._token = token
            try:
                self._token_expiry = cred.expire_time.seconds
            except (AttributeError, TypeError):
                self._token_expiry = now + 3600
            logger.info("Refreshed Lakebase credential (expires in %.0fs)", self._token_expiry - now)
        except Exception as e:
            logger.error("Failed to refresh Lakebase credential: %s", e)
            if self._token is None:
                raise RuntimeError(f"Cannot obtain Lakebase credential: {e}") from e
            logger.warning("Using potentially stale Lakebase credential")
        return self._token


def make_ssl_context(sslmode: str) -> ssl.SSLContext | None:
    """SSL context matching libpq sslmode semantics (pg8000 has no sslmode param)."""
    mode = (sslmode or "require").lower()
    if mode == "disable":
        return None
    if mode == "verify-full":
        return ssl.create_default_context()
    context = ssl.create_default_context()
    if mode == "verify-ca":
        context.check_hostname = False
        return context
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def pg_connect_args(config: "LakebaseConfig | None" = None) -> dict:
    if config is None:
        config = LakebaseConfig.from_env()
    if config is None:
        return {}
    args: dict = {"application_name": config.app_name}
    context = make_ssl_context(config.sslmode)
    if context is not None:
        args["ssl_context"] = context
    return args


_credential_manager: LakebaseCredentialManager | None = None


def get_credential_manager() -> LakebaseCredentialManager:
    global _credential_manager
    if _credential_manager is None:
        _credential_manager = LakebaseCredentialManager()
    return _credential_manager


def detect_database_backend() -> DatabaseBackend:
    database_env = os.getenv("DATABASE_ENV", "sqlite").lower()
    if database_env == "postgres":
        if LakebaseConfig.from_env() is not None:
            return DatabaseBackend.POSTGRESQL
        # PG* connection vars aren't present. Inside a deployed Databricks App this means the
        # `database` resource binding isn't injecting them — refuse to silently fall back to
        # ephemeral SQLite, which loses all data on every restart. Fail loud instead.
        missing = ", ".join(v for v in ("PGHOST", "PGDATABASE", "PGUSER") if not os.getenv(v)) or "PG*"
        if os.getenv("DATABRICKS_APP_NAME"):
            raise RuntimeError(
                f"DATABASE_ENV=postgres but Lakebase connection vars are missing ({missing}). "
                "Refusing to fall back to ephemeral SQLite inside a Databricks App — that silently "
                "loses data on every restart. Verify the app's `database` resource binding injects "
                "PG* (check the app's Environment tab) and redeploy/restart the app."
            )
        logger.warning("DATABASE_ENV=postgres but Lakebase env vars missing (%s); falling back to SQLite (local dev).", missing)
    return DatabaseBackend.SQLITE


def get_database_url() -> str:
    if detect_database_backend() == DatabaseBackend.SQLITE:
        return os.getenv("DATABASE_URL", "sqlite:///./groundtruth.db")
    return "postgresql+pg8000://"


def get_schema_name() -> str | None:
    if detect_database_backend() == DatabaseBackend.POSTGRESQL:
        return get_lakebase_schema_name(LakebaseConfig.from_env())
    return None


def create_engine_for_backend(backend: DatabaseBackend) -> "Engine":
    from sqlalchemy import create_engine, event

    if backend == DatabaseBackend.SQLITE:
        database_url = os.getenv("DATABASE_URL", "sqlite:///./groundtruth.db")
        engine = create_engine(
            database_url,
            connect_args={"check_same_thread": False, "timeout": 60, "isolation_level": "DEFERRED"},
            pool_size=20,
            max_overflow=30,
            pool_timeout=30,
            pool_recycle=3600,
            pool_pre_ping=True,
            echo=False,
        )

        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=60000")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.close()

        return engine

    # PostgreSQL / Lakebase
    config = LakebaseConfig.from_env()
    if config is None:
        raise RuntimeError("Cannot create PostgreSQL engine: Lakebase config not available")
    endpoint_name = os.getenv("ENDPOINT_NAME")
    if not endpoint_name:
        raise RuntimeError(
            "ENDPOINT_NAME is required for DATABASE_ENV=postgres but is not set. "
            "Set it to the endpoint path (projects/<db>/branches/<branch>/endpoints/<endpoint>)."
        )
    credential_manager = get_credential_manager()
    schema_name = get_lakebase_schema_name(config)

    engine = create_engine(
        f"postgresql+pg8000://{config.user}@{config.host}:{config.port}/{config.database}",
        connect_args=pg_connect_args(config),
        pool_size=5,
        max_overflow=5,
        pool_timeout=30,
        pool_recycle=3600,  # match 1h OAuth token lifetime
        pool_pre_ping=False,  # conflicts with do_connect token injection
        echo=False,
    )

    @event.listens_for(engine, "do_connect")
    def _provide_token(dialect, conn_rec, cargs, cparams):
        cparams["password"] = credential_manager.get_password(endpoint_name)

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection, connection_record):
        # Commit the SET: pg8000 is non-autocommit and the pool's reset-on-return
        # ROLLBACK would otherwise revert search_path to the role default.
        try:
            cursor = dbapi_connection.cursor()
            cursor.execute(f'SET search_path TO "{schema_name}", public')
            cursor.close()
            dbapi_connection.commit()
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to SET search_path in on_connect: %s", e)

    logger.info("PostgreSQL engine created (schema=%s)", schema_name)
    return engine
