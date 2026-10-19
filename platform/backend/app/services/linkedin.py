"""LinkedIn URL normalization and identity hints.

This module never fetches linkedin.com. LinkedIn's User Agreement prohibits
automated access, so identity comes from what the user provides (name, company,
pasted profile text). The URL slug can suggest a name, which is labelled inferred.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote, urlparse

_SLUG_SUFFIX = re.compile(r"-(?=[a-z0-9]*\d)[a-z0-9]{4,}$")  # trailing id like -1a2b3c4d


@dataclass
class LinkedInRef:
    url: str
    slug: str
    name_guess: str  # "" if the slug doesn't look like a name


def normalize_linkedin_url(raw: str | None) -> LinkedInRef | None:
    if not raw:
        return None
    s = raw.strip()
    if not s.startswith("http"):
        s = "https://" + s
    p = urlparse(s)
    host = (p.hostname or "").lower()
    if not (host == "linkedin.com" or host.endswith(".linkedin.com")):
        return None
    m = re.match(r"^/(?:in|pub)/([^/?#]+)", p.path, re.I)
    if not m:
        return None
    slug = unquote(m.group(1)).strip().lower()
    return LinkedInRef(url=f"https://www.linkedin.com/in/{slug}", slug=slug, name_guess=name_from_slug(slug))


def name_from_slug(slug: str) -> str:
    base = _SLUG_SUFFIX.sub("", slug)
    parts = [p for p in re.split(r"[-_]+", base) if p and not p.isdigit()]
    if not 2 <= len(parts) <= 4 or any(len(p) == 1 and i == len(parts) - 1 for i, p in enumerate(parts)):
        return ""
    if not all(re.fullmatch(r"[a-zà-ÿ'.]+", p) for p in parts):
        return ""
    return " ".join(p.capitalize() for p in parts)
