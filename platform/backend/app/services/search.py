"""Web search through authorized APIs: Brave Search API or a self-hosted SearXNG.

Scraping search-engine result pages violates their terms, so it isn't offered.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from .cache import cache_key


@dataclass
class SearchResult:
    url: str
    title: str
    snippet: str


class NoSearch:
    name = "none"

    async def search(self, query: str, count: int = 10) -> list[SearchResult]:
        return []


class BraveSearch:
    name = "brave"

    def __init__(self, api_key: str, client: httpx.AsyncClient, cache, ttl_hours: float = 168):
        self.key, self.client, self.cache, self.ttl = api_key, client, cache, ttl_hours

    async def search(self, query: str, count: int = 10) -> list[SearchResult]:
        ck = cache_key("brave", query, count)
        if (hit := self.cache.get(ck)) is not None:
            return [SearchResult(**r) for r in hit]
        r = await self.client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": count},
            headers={"x-subscription-token": self.key, "accept": "application/json"},
        )
        r.raise_for_status()
        results = [SearchResult(x.get("url", ""), x.get("title", ""), x.get("description", ""))
                   for x in (r.json().get("web") or {}).get("results", [])]
        self.cache.set(ck, [vars(x) for x in results], self.ttl)
        return results


class SearxngSearch:
    """Requires `formats: [html, json]` in the instance's settings.yml."""
    name = "searxng"

    def __init__(self, base_url: str, client: httpx.AsyncClient, cache, ttl_hours: float = 168):
        self.base, self.client, self.cache, self.ttl = base_url.rstrip("/"), client, cache, ttl_hours

    async def search(self, query: str, count: int = 10) -> list[SearchResult]:
        ck = cache_key("searx", query, count)
        if (hit := self.cache.get(ck)) is not None:
            return [SearchResult(**r) for r in hit]
        r = await self.client.get(f"{self.base}/search", params={"q": query, "format": "json"})
        r.raise_for_status()
        results = [SearchResult(x.get("url", ""), x.get("title", ""), x.get("content", ""))
                   for x in r.json().get("results", [])][:count]
        self.cache.set(ck, [vars(x) for x in results], self.ttl)
        return results


def make_search(settings, client: httpx.AsyncClient, cache):
    if settings.search_provider == "brave" and settings.brave_api_key:
        return BraveSearch(settings.brave_api_key, client, cache, settings.cache_ttl_hours)
    if settings.search_provider == "searxng" and settings.searxng_url:
        return SearxngSearch(settings.searxng_url, client, cache, settings.cache_ttl_hours)
    return NoSearch()
