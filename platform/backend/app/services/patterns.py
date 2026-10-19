"""Corporate email pattern engine.

Patterns use tokens {first} {last} {f} {l} and separators . _ -
Observed published addresses (with the staff name found next to them) are
used to infer which pattern a company uses.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

PATTERNS = [
    "{first}.{last}", "{first}{last}", "{first}", "{f}{last}", "{first}_{last}",
    "{first}.{l}", "{f}.{last}", "{first}{l}", "{last}.{first}", "{last}{first}",
    "{last}{f}", "{last}", "{first}-{last}", "{last}.{f}",
]

# Prior order when nothing is observed (rough frequency in B2B datasets).
DEFAULT_PRIOR = ["{first}.{last}", "{first}", "{f}{last}", "{first}{last}", "{first}_{last}", "{first}.{l}"]

ROLE_LOCALS = {
    "info", "contact", "hello", "hi", "sales", "support", "help", "admin", "office", "team", "press", "media",
    "pr", "news", "marketing", "careers", "jobs", "hr", "recruiting", "talent", "billing", "accounts", "finance",
    "legal", "privacy", "security", "abuse", "noreply", "no-reply", "webmaster", "postmaster", "enquiries",
    "inquiries", "service", "partners", "investors", "ir", "events", "feedback", "general", "mail", "orders",
}


def norm_token(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", s.lower())


def split_name(full_name: str) -> tuple[str, str]:
    cleaned = re.sub(r"\(.*?\)|,.*$", "", full_name or "")  # drop "(she/her)" and ", PhD"
    parts = [p for p in cleaned.split() if norm_token(p)]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[-1]


def render(pattern: str, first: str, last: str) -> str | None:
    f, l = norm_token(first), norm_token(last)
    if ("{first}" in pattern or "{f}" in pattern) and not f:
        return None
    if ("{last}" in pattern or "{l}" in pattern) and not l:
        return None
    return (pattern.replace("{first}", f).replace("{last}", l)
            .replace("{f}", f[:1]).replace("{l}", l[:1])) or None


def match_pattern(local: str, first: str, last: str) -> str | None:
    """Which pattern produces `local` for this name, preferring the most specific."""
    local = local.lower()
    for p in PATTERNS:
        if render(p, first, last) == local:
            return p
    return None


def structural_guess(local: str) -> str | None:
    """Weak pattern hint from the shape of a local part when no name is known."""
    if local in ROLE_LOCALS or any(ch.isdigit() for ch in local):
        return None
    if re.fullmatch(r"[a-z]{2,}\.[a-z]{2,}", local):
        return "{first}.{last}"
    if re.fullmatch(r"[a-z]\.[a-z]{2,}", local):
        return "{f}.{last}"
    if re.fullmatch(r"[a-z]{2,}_[a-z]{2,}", local):
        return "{first}_{last}"
    if re.fullmatch(r"[a-z]{2,}-[a-z]{2,}", local):
        return "{first}-{last}"
    return None


@dataclass
class PatternStats:
    exact: Counter = field(default_factory=Counter)       # pattern -> count of name-confirmed samples
    structural: Counter = field(default_factory=Counter)  # pattern -> count of shape-only samples
    sample_urls: dict = field(default_factory=dict)       # pattern -> [urls]

    def add(self, pattern: str, url: str | None, exact: bool) -> None:
        (self.exact if exact else self.structural)[pattern] += 1
        if url:
            self.sample_urls.setdefault(pattern, [])
            if url not in self.sample_urls[pattern]:
                self.sample_urls[pattern].append(url)

    def ranked(self) -> list[tuple[str, float, int]]:
        """[(pattern, share, support)] ordered by weighted evidence."""
        weight = Counter()
        for p, n in self.exact.items():
            weight[p] += 3 * n
        for p, n in self.structural.items():
            weight[p] += n
        total = sum(weight.values())
        if not total:
            return []
        return [(p, w / total, self.exact[p] + self.structural[p]) for p, w in weight.most_common()]


def candidates(first: str, last: str, domain: str, stats: PatternStats | None = None,
               ai_patterns: list[str] | None = None, limit: int = 8) -> list[dict]:
    """Ranked candidate addresses. Each: {email, pattern, observed(bool), share, support}."""
    seen: set[str] = set()
    out: list[dict] = []

    def push(p: str, observed: bool, share: float = 0.0, support: int = 0):
        local = render(p, first, last)
        if not local:
            return
        email = f"{local}@{domain}"
        if email in seen:
            return
        seen.add(email)
        out.append({"email": email, "pattern": p, "observed": observed, "share": share, "support": support})

    for p, share, support in (stats.ranked() if stats else []):
        push(p, True, share, support)
    for p in ai_patterns or []:
        if p in PATTERNS:
            push(p, False)
    for p in DEFAULT_PRIOR + PATTERNS:
        push(p, False)
    return out[:limit]
