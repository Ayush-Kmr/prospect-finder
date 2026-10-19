from __future__ import annotations

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str):
    kwargs = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
    return create_engine(url, **kwargs)


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


# Versioned, forward-only migrations. Each entry runs once and is recorded in
# schema_version. Migration 1 creates the ORM schema; add new entries as raw SQL
# (or callables) for later changes.
def _m1(conn):
    from . import models  # noqa: F401  (register tables)
    Base.metadata.create_all(conn)


MIGRATIONS = [(1, "initial schema", _m1)]


def migrate(eng=None) -> int:
    eng = eng or engine
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT)"))
        done = {r[0] for r in conn.execute(text("SELECT version FROM schema_version"))}
        for version, desc, fn in MIGRATIONS:
            if version in done:
                continue
            fn(conn) if callable(fn) else conn.execute(text(fn))
            conn.execute(text("INSERT INTO schema_version (version, description) VALUES (:v, :d)"), {"v": version, "d": desc})
        return max([v for v, _, _ in MIGRATIONS] + [0])
