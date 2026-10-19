"""End-to-end demo against the fictional Northwind Robotics world (no network, no keys).

    .venv/bin/python scripts/demo.py
"""

import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import demo  # noqa: E402
from app.config import Settings  # noqa: E402
from app.schemas import DiscoverRequest  # noqa: E402
from app.services.ai import AIService  # noqa: E402
from app.services.cache import MemoryCache  # noqa: E402
from app.services.discovery import Discovery  # noqa: E402
from app.services.fetcher import PoliteFetcher  # noqa: E402

PEOPLE = [
    DiscoverRequest(full_name="Maria Gonzalez", company="Northwind Robotics"),
    DiscoverRequest(full_name="Alex Chen", company="Northwind Robotics"),
    DiscoverRequest(linkedin_url="https://www.linkedin.com/in/jane-smith-1a2b3c4d", company="Northwind Robotics"),
    DiscoverRequest(full_name="Pat Doe", company="Nonexistent Widgets Ltd"),
]


async def main():
    s = Settings()
    s.per_host_interval_s = 0
    cache = MemoryCache()
    async with httpx.AsyncClient(transport=demo.mock_transport()) as client:
        for req in PEOPLE:
            fetcher = PoliteFetcher(client, cache, user_agent=s.user_agent, per_host_interval_s=0)
            d = Discovery(settings=s, fetcher=fetcher, resolver=demo.DemoResolver(), search=demo.DemoSearch(),
                          ai=AIService(None, cache))
            r = await d.run(req)
            best = r.best
            print(f"\n{r.full_name or '?'} @ {r.company}  (domain: {r.domain.domain})")
            print(f"  {best.email if best else '—':45} {best.status.value if best else 'NOT_FOUND':20} "
                  f"{round(best.confidence * 100) if best else 0}%")
            print(f"  {r.explanation}")
            for w in r.warnings:
                print(f"  ! {w}")
            if best and best.source_url:
                print(f"  source: {best.source_url}")


if __name__ == "__main__":
    asyncio.run(main())
