"""Runtime configuration from environment variables (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "sqlite:///./contacts.db"))

    # AI (optional; used only for profile-text parsing and ambiguous domain choice)
    ai_provider: str = field(default_factory=lambda: os.getenv("AI_PROVIDER", "anthropic"))  # anthropic | openai | none
    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    anthropic_model: str = field(default_factory=lambda: os.getenv("ANTHROPIC_MODEL", "claude-opus-5-5"))
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    openai_model: str = field(default_factory=lambda: os.getenv("OPENAI_MODEL", "gpt-5-mini"))

    # Web search (needed to discover domains and published emails off the company site)
    search_provider: str = field(default_factory=lambda: os.getenv("SEARCH_PROVIDER", "none"))  # brave | searxng | none
    brave_api_key: str = field(default_factory=lambda: os.getenv("BRAVE_API_KEY", ""))
    searxng_url: str = field(default_factory=lambda: os.getenv("SEARXNG_URL", ""))

    # Optional authorized verification provider
    hunter_api_key: str = field(default_factory=lambda: os.getenv("HUNTER_API_KEY", ""))

    # Crawler politeness
    user_agent: str = field(default_factory=lambda: os.getenv(
        "CRAWLER_USER_AGENT", "ContactDiscoveryBot/1.0 (+https://example.invalid/bot; self-hosted research tool)"))
    max_pages_per_domain: int = field(default_factory=lambda: int(os.getenv("MAX_PAGES_PER_DOMAIN", "12")))
    max_external_pages: int = field(default_factory=lambda: int(os.getenv("MAX_EXTERNAL_PAGES", "5")))
    per_host_interval_s: float = field(default_factory=lambda: float(os.getenv("PER_HOST_INTERVAL_S", "1.0")))
    request_timeout_s: float = field(default_factory=lambda: float(os.getenv("REQUEST_TIMEOUT_S", "12")))
    cache_ttl_hours: int = field(default_factory=lambda: int(os.getenv("CACHE_TTL_HOURS", "168")))
    respect_robots: bool = field(default_factory=lambda: _bool("RESPECT_ROBOTS", True))

    # API
    max_concurrent_discoveries: int = field(default_factory=lambda: int(os.getenv("MAX_CONCURRENT_DISCOVERIES", "3")))
    max_batch_size: int = field(default_factory=lambda: int(os.getenv("MAX_BATCH_SIZE", "100")))
    cors_origins: str = field(default_factory=lambda: os.getenv("CORS_ORIGINS", "http://localhost:5173"))


settings = Settings()
