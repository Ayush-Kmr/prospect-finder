"""Polite HTTP fetcher: robots.txt, per-host rate limiting, size limits, caching.

Never used for linkedin.com (blocked explicitly) and never sends credentials.
"""

from __future__ import annotations

import asyncio
import time
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx

from .cache import cache_key

BLOCKED_HOSTS = ("linkedin.com", "licdn.com")
MAX_BYTES = 2_000_000


class PoliteFetcher:
    def __init__(self, client: httpx.AsyncClient, cache, *, user_agent: str, per_host_interval_s: float = 1.0,
                 ttl_hours: float = 168, respect_robots: bool = True, shared: dict | None = None):
        self.client = client
        self.cache = cache
        self.ua = user_agent
        self.interval = per_host_interval_s
        self.ttl = ttl_hours
        self.respect_robots = respect_robots
        # robots / throttle state can be shared across fetchers so per-host rate
        # limits hold across concurrent discoveries.
        shared = shared if shared is not None else {}
        self._robots: dict[str, RobotFileParser | None] = shared.setdefault("robots", {})
        self._last: dict[str, float] = shared.setdefault("last", {})
        self._locks: dict[str, asyncio.Lock] = shared.setdefault("locks", {})
        self.stats = {"fetched": 0, "cached": 0, "robots_blocked": 0, "errors": 0}

    @staticmethod
    def blocked(url: str) -> bool:
        host = (urlparse(url).hostname or "").lower()
        return any(host == b or host.endswith("." + b) for b in BLOCKED_HOSTS)

    async def _throttle(self, host: str) -> None:
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            wait = self._last.get(host, 0) + self.interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last[host] = time.monotonic()

    async def _allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        p = urlparse(url)
        origin = f"{p.scheme}://{p.netloc}"
        if origin not in self._robots:
            rp = RobotFileParser()
            try:
                await self._throttle(p.netloc)
                r = await self.client.get(origin + "/robots.txt", headers={"user-agent": self.ua})
                if r.status_code in (401, 403):
                    rp.disallow_all = True
                elif r.status_code >= 400:
                    rp.allow_all = True
                else:
                    rp.parse(r.text.splitlines())
            except httpx.HTTPError:
                rp.allow_all = True
            self._robots[origin] = rp
        rp = self._robots[origin]
        return rp.can_fetch(self.ua, url)

    async def get_html(self, url: str) -> tuple[str, str] | None:
        """Returns (final_url, html) or None. Cached."""
        if self.blocked(url):
            return None
        key = cache_key("page", url)
        hit = self.cache.get(key)
        if hit is not None:
            self.stats["cached"] += 1
            return (hit["url"], hit["html"]) if hit else None
        if not await self._allowed(url):
            self.stats["robots_blocked"] += 1
            return None
        await self._throttle(urlparse(url).netloc)
        try:
            async with self.client.stream("GET", url, headers={"user-agent": self.ua, "accept": "text/html"},
                                          follow_redirects=True) as r:
                ctype = r.headers.get("content-type", "")
                if r.status_code != 200 or "html" not in ctype:
                    self.cache.set(key, {}, self.ttl)
                    return None
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_BYTES:
                        break
                final = str(r.url)
                if self.blocked(final):
                    return None
                html = buf.decode(r.encoding or "utf-8", errors="replace")
        except httpx.HTTPError:
            self.stats["errors"] += 1
            return None
        self.stats["fetched"] += 1
        self.cache.set(key, {"url": final, "html": html}, self.ttl)
        return final, html
