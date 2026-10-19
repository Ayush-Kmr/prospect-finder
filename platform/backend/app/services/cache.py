"""Persistent key/value cache (DB-backed) with an in-memory variant for tests."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete


def cache_key(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


class MemoryCache:
    def __init__(self):
        self._d: dict[str, Any] = {}

    def get(self, key: str):
        return self._d.get(key)

    def set(self, key: str, value: Any, ttl_hours: float = 24) -> None:
        self._d[key] = value


class DBCache:
    def __init__(self, session_factory):
        self._sf = session_factory

    def get(self, key: str):
        from ..models import CacheEntry
        with self._sf() as s:
            row = s.get(CacheEntry, key)
            if not row:
                return None
            exp = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
            if exp < datetime.now(timezone.utc):
                s.delete(row)
                s.commit()
                return None
            return json.loads(row.value)

    def set(self, key: str, value: Any, ttl_hours: float = 24) -> None:
        from ..models import CacheEntry
        with self._sf() as s:
            s.merge(CacheEntry(key=key, value=json.dumps(value),
                               expires_at=datetime.now(timezone.utc) + timedelta(hours=ttl_hours)))
            s.commit()

    def purge_expired(self) -> None:
        from ..models import CacheEntry
        with self._sf() as s:
            s.execute(delete(CacheEntry).where(CacheEntry.expires_at < datetime.now(timezone.utc)))
            s.commit()
