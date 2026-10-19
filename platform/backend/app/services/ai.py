"""Interchangeable AI providers (Anthropic Claude / OpenAI) for two narrow jobs:

1. parse_profile: turn profile text the user pasted into structured identity fields.
2. choose_domain: pick the official domain from a list of candidates gathered from search.

Hallucination guards: JSON-schema-constrained output validated with Pydantic;
the model never returns email addresses; choose_domain may only return one of
the given candidates (or null). Responses are cached.
"""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ValidationError

from .cache import cache_key
from .patterns import PATTERNS


class ProfileFields(BaseModel):
    full_name: str
    current_company: str
    current_title: str
    company_domain_guesses: list[str]
    email_patterns_ranked: list[str]
    identity_conflicts: list[str]


class DomainChoice(BaseModel):
    domain: str | None
    reason: str


def _schema(model: type[BaseModel]) -> dict:
    s = model.model_json_schema()
    s["additionalProperties"] = False
    s["required"] = list(s["properties"].keys())
    return s


PROFILE_SYSTEM = f"""You extract structured identity data from professional-profile text that a user pasted.
- full_name: the person's name without credentials, emojis, pronouns.
- current_company: employer of the CURRENT primary role (no end date). Empty string if unclear.
- current_title: that role's title.
- company_domain_guesses: up to 3 likely corporate email domains for current_company (e.g. "acme.com"), most likely first. These are guesses and will be checked.
- email_patterns_ranked: up to 4 patterns from this list only: {", ".join(PATTERNS)}.
- identity_conflicts: short notes if the text is inconsistent (e.g. two current employers, name mismatch).
Never output email addresses or phone numbers."""

DOMAIN_SYSTEM = """You pick the official website domain of a company from candidate domains found by web search.
Return exactly one candidate from the list, or null if none is clearly the company's own site.
Prefer the company's primary corporate domain over subsidiaries, job boards, directories and social networks."""


class AIProvider(Protocol):
    name: str
    async def json_call(self, system: str, user: str, schema: dict) -> tuple[str, dict]: ...


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, model: str):
        from anthropic import AsyncAnthropic
        self.client = AsyncAnthropic(api_key=api_key)
        self.model = model

    async def json_call(self, system: str, user: str, schema: dict) -> tuple[str, dict]:
        resp = await self.client.beta.messages.create(
            model=self.model,
            max_tokens=4000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("AI provider declined the request.")
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("AI response truncated.")
        text = "".join(b.text for b in resp.content if b.type == "text")
        usage = {"model": resp.model, "input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
        return text, usage


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, model: str):
        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model

    async def json_call(self, system: str, user: str, schema: dict) -> tuple[str, dict]:
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_schema", "json_schema": {"name": "out", "strict": True, "schema": schema}},
        )
        msg = resp.choices[0].message
        if getattr(msg, "refusal", None):
            raise RuntimeError(f"AI provider declined: {msg.refusal}")
        usage = {"model": resp.model, "input_tokens": resp.usage.prompt_tokens, "output_tokens": resp.usage.completion_tokens}
        return msg.content or "{}", usage


class AIService:
    def __init__(self, provider: AIProvider | None, cache):
        self.provider = provider
        self.cache = cache
        self.usage: list[dict] = []

    @property
    def enabled(self) -> bool:
        return self.provider is not None

    async def _call(self, kind: str, system: str, user: str, model: type[BaseModel]):
        key = cache_key("ai", kind, self.provider.name, user)
        if (hit := self.cache.get(key)) is not None:
            return model.model_validate(hit)
        text, usage = await self.provider.json_call(system, user, _schema(model))
        self.usage.append({"call": kind, **usage})
        try:
            out = model.model_validate_json(text)
        except ValidationError as e:
            raise RuntimeError(f"AI output failed schema validation: {e.errors()[:2]}") from e
        self.cache.set(key, out.model_dump(), 24 * 30)
        return out

    async def parse_profile(self, text: str) -> ProfileFields | None:
        if not self.enabled or not text.strip():
            return None
        out = await self._call("profile", PROFILE_SYSTEM, text[:30000], ProfileFields)
        out.email_patterns_ranked = [p for p in out.email_patterns_ranked if p in PATTERNS]
        return out

    async def choose_domain(self, company: str, candidates: list[dict]) -> DomainChoice | None:
        if not self.enabled or not candidates:
            return None
        lines = "\n".join(f"- {c['domain']} (title: {c.get('title', '')[:100]})" for c in candidates)
        out = await self._call("domain", DOMAIN_SYSTEM, f"Company: {company}\nCandidates:\n{lines}", DomainChoice)
        allowed = {c["domain"] for c in candidates}
        if out.domain not in allowed:  # guard: model may only pick from the list
            out.domain = None
        return out


def make_ai(settings, cache) -> AIService:
    provider = None
    if settings.ai_provider == "anthropic" and settings.anthropic_api_key:
        provider = AnthropicProvider(settings.anthropic_api_key, settings.anthropic_model)
    elif settings.ai_provider == "openai" and settings.openai_api_key:
        provider = OpenAIProvider(settings.openai_api_key, settings.openai_model)
    return AIService(provider, cache)
