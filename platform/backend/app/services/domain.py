"""Company domain discovery and validation.

Candidates come from several independent signals (web-search results, name-based
heuristics, AI guesses from pasted profile text). Each candidate is checked for
MX records and a homepage whose title/host matches the company name. A single
unverified search result is never accepted alone.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .patterns import norm_token

DIRECTORY_HOSTS = {
    "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com", "wikipedia.org",
    "crunchbase.com", "glassdoor.com", "indeed.com", "bloomberg.com", "zoominfo.com", "apollo.io", "rocketreach.co",
    "signalhire.com", "lusha.com", "pitchbook.com", "dnb.com", "owler.com", "craft.co", "github.com", "medium.com",
    "reddit.com", "quora.com", "yelp.com", "trustpilot.com", "g2.com", "capterra.com", "builtin.com", "wellfound.com",
    "angel.co", "ycombinator.com", "tiktok.com", "amazon.com", "apple.com", "google.com", "bing.com", "yahoo.com",
    "theorg.com", "comparably.com", "levels.fyi", "rocketreach.com", "contactout.com", "hunter.io", "clearbit.com",
}
TWO_LEVEL_SUFFIXES = {"co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.in", "co.jp", "com.br", "co.nz", "com.sg",
                      "com.mx", "co.za", "com.cn", "com.hk", "co.kr", "com.tr", "com.ar"}
COMPANY_SUFFIXES = {"inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh",
                    "ag", "sa", "plc", "pvt", "private", "group", "holdings", "technologies", "technology", "labs",
                    "the", "and", "bv", "srl", "oy", "ab", "as", "kk"}


@dataclass
class DomainResult:
    domain: str | None
    website: str | None
    confidence: float
    mx: list[str] = field(default_factory=list)
    evidence: list[dict] = field(default_factory=list)  # {url, snippet}
    warnings: list[str] = field(default_factory=list)


def registrable(host: str) -> str:
    host = host.lower().strip(".").removeprefix("www.")
    parts = host.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in TWO_LEVEL_SUFFIXES:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def clean_domain(d: str) -> str:
    d = d.strip().lower()
    d = re.sub(r"^https?://", "", d).split("/")[0].split("@")[-1]
    return registrable(d)


def company_tokens(company: str) -> list[str]:
    toks = [norm_token(t) for t in re.split(r"[\s,.&/+-]+", company or "")]
    return [t for t in toks if t and t not in COMPANY_SUFFIXES]


def name_match(company: str, domain: str, title: str = "") -> float:
    """0..1 similarity between company name and a domain/homepage title."""
    toks = company_tokens(company)
    if not toks:
        return 0.0
    label = norm_token(domain.split(".")[0])
    joined = "".join(toks)
    score = 0.0
    if label == joined:
        score = 1.0
    elif label.startswith(joined) or (joined.startswith(label) and len(label) >= 4):
        score = 0.8
    elif toks[0] in label and len(toks[0]) >= 3:
        score = 0.6
    elif len(toks) >= 2 and label == "".join(t[0] for t in toks):
        score = 0.5  # acronym
    t = norm_token(title)
    if t and all(tok in t for tok in toks):
        score = max(score, 0.7) + 0.2
    return min(score, 1.0)


def heuristic_domains(company: str) -> list[str]:
    toks = company_tokens(company)
    if not toks:
        return []
    joined = "".join(toks)
    out = [f"{joined}.com", f"{joined}.io", f"{joined}.ai", f"{joined}.co"]
    if len(toks) > 1:
        out += [f"{'-'.join(toks)}.com", f"{toks[0]}.com"]
    return out


async def _homepage(fetcher, domain: str) -> tuple[str | None, str]:
    for url in (f"https://{domain}/", f"https://www.{domain}/"):
        got = await fetcher.get_html(url)
        if got:
            final, html = got
            soup = BeautifulSoup(html, "html.parser")
            title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
            og = soup.find("meta", attrs={"property": "og:site_name"})
            if og and og.get("content"):
                title = f"{title} | {og['content']}"
            return final, title
    return None, ""


async def discover_domain(company: str, *, search, resolver, fetcher, ai=None, provided: str | None = None,
                          ai_guesses: list[str] | None = None) -> DomainResult:
    if provided:
        d = clean_domain(provided)
        mx = await resolver.mx(d)
        website, title = await _homepage(fetcher, d)
        res = DomainResult(d, website, 0.9, mx, [{"url": website, "snippet": f"User-provided domain. Homepage title: {title!r}"}])
        if company and website and name_match(company, d, title) < 0.5:
            res.confidence = 0.6
            res.warnings.append(f"Domain mismatch: homepage title {title!r} does not mention {company!r}.")
        if not mx:
            res.confidence = min(res.confidence, 0.4)
            res.warnings.append(f"{d} has no MX records, so it cannot receive email.")
        return res

    if not company:
        return DomainResult(None, None, 0.0, warnings=["No company known; cannot discover domain."])

    cands: dict[str, dict] = {}

    def add(domain: str, score: float, source: str, url: str | None = None, title: str = ""):
        domain = clean_domain(domain)
        if not domain or "." not in domain or domain in DIRECTORY_HOSTS:
            return
        c = cands.setdefault(domain, {"domain": domain, "score": 0.0, "sources": set(), "urls": [], "title": ""})
        c["score"] += score
        c["sources"].add(source)
        if url:
            c["urls"].append(url)
        c["title"] = c["title"] or title

    for q in (f'"{company}" official website', f"{company} company"):
        for i, r in enumerate(await search.search(q, 10)):
            host = urlparse(r.url).hostname or ""
            add(host, 1.0 / (i + 1), "search", r.url, r.title)
    for g in ai_guesses or []:
        add(g, 0.3, "ai_guess")
    for h in heuristic_domains(company):
        add(h, 0.1, "name_heuristic")

    ranked = sorted(cands.values(), key=lambda c: -(c["score"] + name_match(company, c["domain"], c["title"])))[:6]
    checked = []
    for c in ranked:
        c["mx"] = await resolver.mx(c["domain"])
        if not c["mx"]:
            continue
        c["website"], home_title = await _homepage(fetcher, c["domain"])
        c["title"] = home_title or c["title"]
        c["match"] = name_match(company, c["domain"], c["title"])
        independent = len(c["sources"] - {"name_heuristic"}) + (1 if c["website"] and c["match"] >= 0.5 else 0)
        c["final"] = c["score"] + 1.5 * c["match"] + 0.4 * independent
        if c["match"] >= 0.5 or independent >= 2:
            checked.append(c)
    if not checked:
        return DomainResult(None, None, 0.0, warnings=[f"Could not confirm an official domain for {company!r}."])

    checked.sort(key=lambda c: -c["final"])
    best = checked[0]
    notes = []
    if ai and ai.enabled and len(checked) > 1 and checked[1]["final"] > 0.8 * best["final"]:
        choice = await ai.choose_domain(company, [{"domain": c["domain"], "title": c["title"]} for c in checked[:5]])
        if choice and choice.domain:
            best = next(c for c in checked if c["domain"] == choice.domain)
            notes.append(f"AI tie-break: {choice.reason}")

    conf = min(0.95, 0.35 + 0.35 * best["match"] + 0.1 * len(best["sources"] - {"name_heuristic"}) + (0.1 if best["website"] else 0))
    ev = [{"url": best.get("website") or (best["urls"][0] if best["urls"] else None),
           "snippet": f"Domain {best['domain']} — homepage title {best['title']!r}; signals: {', '.join(sorted(best['sources']))}; "
                      f"MX: {', '.join(best['mx'][:2])}. {' '.join(notes)}".strip()}]
    res = DomainResult(best["domain"], best.get("website"), round(conf, 2), best["mx"], ev)
    if best["match"] < 0.5:
        res.warnings.append(f"Domain {best['domain']} chosen on search signals only; its name/title does not clearly match {company!r}.")
    return res
