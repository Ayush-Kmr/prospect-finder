"""Find email addresses published on HTML pages, with surrounding context."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote, urljoin, urlparse

from bs4 import BeautifulSoup

EMAIL_RE = re.compile(r"(?<![\w.+-])([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?![\w-])", re.I)
# Common human-readable obfuscations: "jane [at] example [dot] com", "jane(at)example.com"
OBFUSCATED_RE = re.compile(
    r"\b([a-z0-9._%+-]{1,64})\s*[\[\(\{]\s*at\s*[\]\)\}]\s*([a-z0-9-]+(?:\s*(?:[\[\(\{]\s*dot\s*[\]\)\}]|\.)\s*[a-z0-9-]+)+)",
    re.I)
NAME_RE = re.compile(r"\b([A-Z][a-zà-ÿ'’-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-zà-ÿ'’-]+)\b")

TEAM_HINTS = ("team", "about", "people", "leadership", "management", "staff", "contact", "press", "news",
              "media", "company", "who-we-are", "our-team", "board", "directory", "speakers", "authors")


@dataclass
class FoundEmail:
    email: str
    url: str
    context: str  # ~300 chars of visible text around the address
    names_nearby: list[str]


def _visible_text(soup: BeautifulSoup) -> str:
    for t in soup(["script", "style", "noscript", "template", "svg"]):
        t.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ")).strip()


def _deobfuscate(text: str) -> str:
    def fix(m: re.Match) -> str:
        domain = re.sub(r"\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*|\s*\.\s*", ".", m.group(2))
        return f" {m.group(1)}@{domain} "
    return OBFUSCATED_RE.sub(fix, text)


def emails_in_html(html: str, url: str, domain: str | None = None) -> list[FoundEmail]:
    """All addresses on the page (optionally only @domain or its subdomains)."""
    soup = BeautifulSoup(html, "html.parser")
    mailtos = []
    for a in soup.select('a[href^="mailto:"]'):
        addr = unquote(a["href"][7:].split("?")[0]).strip()
        # The link label is often just "Email"; the enclosing block carries the name.
        block = a.find_parent(["li", "div", "article", "section", "td", "p"]) or a
        mailtos.append((addr, block.get_text(" ", strip=True)[:300]))
    text = _deobfuscate(_visible_text(soup))
    return _collect(text, url, domain, mailtos)


def emails_in_text(text: str, url: str, domain: str | None = None) -> list[FoundEmail]:
    return _collect(_deobfuscate(text), url, domain, [])


def _collect(text: str, url: str, domain: str | None, mailtos: list[tuple[str, str]]) -> list[FoundEmail]:
    found: dict[str, FoundEmail] = {}

    def keep(addr: str) -> bool:
        if not EMAIL_RE.fullmatch(addr):
            return False
        if re.search(r"\.(png|jpe?g|gif|svg|webp|css|js)$", addr, re.I):  # e.g. logo@2x.png
            return False
        if not domain:
            return True
        host = addr.rsplit("@", 1)[1].lower()
        return host == domain or host.endswith("." + domain)

    for m in EMAIL_RE.finditer(text):
        addr = m.group(1).lower().rstrip(".")
        if not keep(addr) or addr in found:
            continue
        ctx = text[max(0, m.start() - 160): m.end() + 160]
        found[addr] = FoundEmail(addr, url, ctx, NAME_RE.findall(ctx))
    for addr, label in mailtos:
        addr = addr.lower()
        if keep(addr) and addr not in found:
            found[addr] = FoundEmail(addr, url, label, NAME_RE.findall(label))
    return list(found.values())


def candidate_links(html: str, base_url: str, limit: int = 20) -> list[str]:
    """Same-site links that look like team / about / press pages."""
    soup = BeautifulSoup(html, "html.parser")
    base_host = urlparse(base_url).hostname or ""
    root = base_host.removeprefix("www.")
    scored: dict[str, int] = {}
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0]
        p = urlparse(href)
        host = (p.hostname or "").removeprefix("www.")
        if p.scheme not in ("http", "https") or not (host == root or host.endswith("." + root)):
            continue
        if re.search(r"\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?|mp4)$", p.path, re.I):
            continue
        hay = (p.path + " " + a.get_text(" ", strip=True)).lower()
        score = sum(h in hay for h in TEAM_HINTS)
        if score:
            scored[href] = max(scored.get(href, 0), score)
    return [u for u, _ in sorted(scored.items(), key=lambda kv: -kv[1])][:limit]
