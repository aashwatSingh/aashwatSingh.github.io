"""
@author: Jon Sorey (data layer), shared core
@description: Opens the database connection. It connects to PostgreSQL / Supabase when DATABASE_URL is
    set and falls back to a local SQLite file when it is not (or when Postgres is unreachable), then
    hands each API request its own short-lived database session. It also defines the column types that
    keep ids, money and UTC timestamps identical on both databases.
@traces: SE-NFR-01, SE-NFR-08, SE-NFR-09
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import CHAR, DateTime, create_engine, event, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.types import TypeDecorator

from app.core.config import get_settings

logger = logging.getLogger("projectforge.database")


def utcnow() -> datetime:
    """Current time as a naive UTC datetime (the single time representation used internally)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def to_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def new_id() -> str:
    return str(uuid.uuid4())


class GUID(TypeDecorator):
    """UUID stored natively on PostgreSQL and as a 36-char string on SQLite; always a str in Python."""

    impl = CHAR(36)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=False))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return str(uuid.UUID(str(value)))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return str(value)


class UTCDateTime(TypeDecorator):
    """timestamptz on PostgreSQL; values are always naive UTC in Python on both databases."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        value = to_naive_utc(value)
        if dialect.name == "postgresql":
            return value.replace(tzinfo=timezone.utc)
        return value

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return to_naive_utc(value)


class Base(DeclarativeBase):
    pass


def _make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        kwargs: dict = {"connect_args": {"check_same_thread": False}}
        if ":memory:" in url or url in {"sqlite://", "sqlite:///"}:
            kwargs["poolclass"] = StaticPool
        eng = create_engine(url, **kwargs)

        @event.listens_for(eng, "connect")
        def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - driver hook
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.close()

        return eng
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
        connect_args={"connect_timeout": 5, "options": "-c timezone=utc"},
    )


def _build_engine() -> tuple[Engine, str]:
    settings = get_settings()
    url = settings.database_url
    if url.startswith("sqlite"):
        return _make_engine(url), url
    try:
        eng = _make_engine(url)
        with eng.connect() as conn:
            conn.execute(text("select 1"))
        logger.info("Connected to PostgreSQL / Supabase.")
        return eng, url
    except Exception as exc:  # pragma: no cover - depends on external database
        if not settings.db_fallback_to_sqlite:
            raise
        logger.warning("PostgreSQL unavailable (%s); falling back to local SQLite demo database.", exc)
        return _make_engine(settings.sqlite_url), settings.sqlite_url


engine, ACTIVE_DATABASE_URL = _build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request, rolled back on error, always closed."""
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def create_all() -> None:
    from app.models import entities  # noqa: F401  (register mappers)

    Base.metadata.create_all(bind=engine)


def database_kind() -> str:
    return "postgresql" if ACTIVE_DATABASE_URL.startswith("postgresql") else "sqlite"
