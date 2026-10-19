"""Discovery orchestrator: identity → domain → published emails → patterns → verification."""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlparse

from ..schemas import DiscoverRequest, EmailStatus
from .domain import DomainResult, discover_domain
from .extract import FoundEmail, candidate_links, emails_in_html, emails_in_text
from .linkedin import normalize_linkedin_url
from .patterns import ROLE_LOCALS, PatternStats, candidates, match_pattern, norm_token, split_name, structural_guess
from .verify import hunter_verify, mail_host_label

COMMON_PATHS = ["/about", "/about-us", "/team", "/our-team", "/people", "/leadership", "/company", "/contact",
                "/contact-us", "/press", "/news", "/newsroom"]


@dataclass
class Candidate:
    email: str
    status: EmailStatus
    confidence: float
    pattern: str | None = None
    basis: str = ""
    source_url: str | None = None
    verification: dict = field(default_factory=dict)


@dataclass
class DiscoveryResult:
    linkedin_url: str | None
    full_name: str
    first_name: str
    last_name: str
    company: str
    title: str
    domain: DomainResult
    candidates: list[Candidate]
    evidence: list[dict]
    warnings: list[str]
    explanation: str
    ai_usage: list[dict]
    crawl_stats: dict

    @property
    def best(self) -> Candidate | None:
        return self.candidates[0] if self.candidates else None


class Discovery:
    def __init__(self, *, settings, fetcher, resolver, search, ai, http_client=None):
        self.s = settings
        self.fetcher = fetcher
        self.resolver = resolver
        self.search = search
        self.ai = ai
        self.http = http_client

    async def run(self, req: DiscoverRequest) -> DiscoveryResult:
        warnings: list[str] = []
        evidence: list[dict] = []

        # ---- 1. Identity (user input > pasted text parsed by AI > URL slug) ----
        li = normalize_linkedin_url(req.linkedin_url)
        if req.linkedin_url and not li:
            warnings.append("LinkedIn URL not recognised as a profile URL (expected linkedin.com/in/...).")
        parsed = None
        if req.profile_text:
            if self.ai.enabled:
                try:
                    parsed = await self.ai.parse_profile(req.profile_text)
                except Exception as e:  # noqa: BLE001 — AI is optional; continue without it
                    warnings.append(f"AI parsing failed: {e}")
            else:
                warnings.append("Profile text supplied but no AI provider is configured; it was ignored.")

        full_name = (req.full_name or (parsed.full_name if parsed else "") or "").strip()
        company = (req.company or (parsed.current_company if parsed else "") or "").strip()
        title = (req.title or (parsed.current_title if parsed else "") or "").strip()
        if req.full_name:
            evidence.append({"kind": "identity", "url": None, "snippet": f"Name provided by user: {full_name}"})
        elif parsed and parsed.full_name:
            evidence.append({"kind": "identity", "url": None, "snippet": f"Name parsed by AI from pasted profile text: {full_name}"})
        elif li and li.name_guess:
            full_name = li.name_guess
            warnings.append(f"Name '{full_name}' was inferred from the LinkedIn URL slug and is unverified.")
            evidence.append({"kind": "identity", "url": li.url, "snippet": f"Name inferred from URL slug '{li.slug}'"})
        if company:
            src = "user" if req.company else "AI parse of pasted profile text (unverified)"
            evidence.append({"kind": "identity", "url": None, "snippet": f"Company from {src}: {company}"})
        if parsed:
            warnings += [f"Identity conflict: {c}" for c in parsed.identity_conflicts]

        first, last = split_name(full_name)
        base = dict(linkedin_url=li.url if li else req.linkedin_url, full_name=full_name, first_name=first,
                    last_name=last, company=company, title=title, ai_usage=self.ai.usage, crawl_stats=self.fetcher.stats)

        if not (company or req.company_domain):
            warnings.append("LinkedIn pages are not fetched automatically. Provide the person's company (and name) to continue.")
            return DiscoveryResult(domain=DomainResult(None, None, 0.0), candidates=[], evidence=evidence,
                                   warnings=warnings, explanation="Company unknown; nothing to search.", **base)

        # ---- 2. Domain ----
        dom = await discover_domain(company, search=self.search, resolver=self.resolver, fetcher=self.fetcher,
                                    ai=self.ai, provided=req.company_domain,
                                    ai_guesses=parsed.company_domain_guesses if parsed else None)
        warnings += dom.warnings
        evidence += [{"kind": "domain", **e} for e in dom.evidence]
        if not dom.domain:
            return DiscoveryResult(domain=dom, candidates=[], evidence=evidence, warnings=warnings,
                                   explanation="No official company domain could be confirmed.", **base)

        # ---- 3. Published emails ----
        found = await self._crawl_company(dom)
        found += await self._search_published(full_name, company, dom.domain)

        confirmed: dict[str, Candidate] = {}
        stats = PatternStats()
        for f in found:
            local = f.email.split("@")[0]
            if local in ROLE_LOCALS:
                continue
            c = self._classify_for_person(f, first, last, full_name)
            if c:
                prev = confirmed.get(c.email)
                if not prev or c.confidence > prev.confidence:
                    confirmed[c.email] = c
                evidence.append({"kind": "published_email", "url": f.url, "snippet": f.context[:400], "email": f.email})
                continue
            self._learn_pattern(f, local, stats, full_name)

        for p, share, support in stats.ranked()[:3]:
            urls = stats.sample_urls.get(p, [])[:3]
            evidence.append({"kind": "pattern_sample", "url": urls[0] if urls else None,
                             "snippet": f"Company format {p}: {support} published staff address(es), {share:.0%} of observed samples. "
                                        f"Sources: {', '.join(urls)}"})

        # ---- 4. Predictions (only if nothing published for this person) ----
        cands = sorted(confirmed.values(), key=lambda c: -c.confidence)
        if not cands and first and last:
            cands = self._predict(first, last, dom, stats, parsed.email_patterns_ranked if parsed else None)
            if self.s.hunter_api_key and self.http and cands:
                cands = await self._provider_verify(cands)
        elif not cands:
            warnings.append("Need both first and last name to predict an address.")

        cands.sort(key=lambda c: -c.confidence)
        return DiscoveryResult(domain=dom, candidates=cands, evidence=evidence, warnings=warnings,
                               explanation=self._explain(cands, dom, stats), **base)

    # ---------------- helpers ----------------

    async def _crawl_company(self, dom: DomainResult) -> list[FoundEmail]:
        start = dom.website or f"https://{dom.domain}/"
        root = f"{urlparse(start).scheme}://{urlparse(start).netloc}"
        queue = [start]
        seen: set[str] = set()
        found: list[FoundEmail] = []
        first_page = True
        while queue and len(seen) < self.s.max_pages_per_domain:
            url = queue.pop(0)
            if url in seen:
                continue
            seen.add(url)
            got = await self.fetcher.get_html(url)
            if first_page:
                queue += [u for u in [root + p for p in COMMON_PATHS] if u not in queue]
                first_page = False
            if not got:
                continue
            final, html = got
            found += emails_in_html(html, final, dom.domain)
            for link in candidate_links(html, final):
                if link not in seen and link not in queue:
                    queue.insert(0, link)  # discovered links before guessed common paths
        return found

    async def _search_published(self, full_name: str, company: str, domain: str) -> list[FoundEmail]:
        queries = [f'"@{domain}"', f'"@{domain}" email contact']
        if full_name:
            queries.insert(0, f'"{full_name}" "@{domain}"')
            queries.append(f'"{full_name}" "{company}" email')
        found: list[FoundEmail] = []
        external: list[str] = []
        for q in queries:
            try:
                results = await self.search.search(q, 10)
            except Exception:  # noqa: BLE001 — search is best-effort
                continue
            for r in results:
                found += emails_in_text(f"{r.title} {r.snippet}", r.url, domain)
                host = (urlparse(r.url).hostname or "").lower()
                if not (host == domain or host.endswith("." + domain)) and r.url not in external:
                    external.append(r.url)
        for url in external[: self.s.max_external_pages]:
            got = await self.fetcher.get_html(url)
            if got:
                found += emails_in_html(got[1], got[0], domain)
        return found

    @staticmethod
    def _classify_for_person(f: FoundEmail, first: str, last: str, full_name: str) -> Candidate | None:
        if not (first or last):
            return None
        local = f.email.split("@")[0]
        ctx = norm_token(f.context)
        name_in_ctx = bool(first and last and norm_token(first) in ctx and norm_token(last) in ctx)
        p = match_pattern(local, first, last) if first and last else None
        if p and p not in ("{first}", "{last}"):
            conf = 0.95 if name_in_ctx else 0.88
            return Candidate(f.email, EmailStatus.PUBLICLY_CONFIRMED, conf, p,
                             f"Published at {f.url}; matches the person's name ({p}).", f.url)
        if p and name_in_ctx:  # e.g. jane@ next to "Jane Smith"
            return Candidate(f.email, EmailStatus.PUBLICLY_CONFIRMED, 0.85, p,
                             f"Published at {f.url} next to the person's name.", f.url)
        if name_in_ctx and last and norm_token(last) in local:
            return Candidate(f.email, EmailStatus.PUBLICLY_CONFIRMED, 0.8, None,
                             f"Published at {f.url} next to the person's name.", f.url)
        return None

    @staticmethod
    def _learn_pattern(f: FoundEmail, local: str, stats: PatternStats, person: str) -> None:
        for name in f.names_nearby:
            if norm_token(name) == norm_token(person):
                continue
            nf, nl = split_name(name)
            p = match_pattern(local, nf, nl)
            if p:
                stats.add(p, f.url, exact=True)
                return
        g = structural_guess(local)
        if g:
            stats.add(g, f.url, exact=False)

    @staticmethod
    def _predict(first, last, dom: DomainResult, stats: PatternStats, ai_patterns) -> list[Candidate]:
        out = []
        prior_rank = 0
        for c in candidates(first, last, dom.domain, stats, ai_patterns, limit=6):
            if c["observed"]:
                conf = min(0.75, 0.3 + 0.35 * c["share"] + 0.05 * min(c["support"], 4))
                out.append(Candidate(c["email"], EmailStatus.PATTERN_PREDICTED, round(conf, 2), c["pattern"],
                                     f"Company's observed published format {c['pattern']} "
                                     f"({c['support']} sample(s), {c['share']:.0%} share). Not confirmed for this person."))
            elif dom.mx:
                conf = max(0.05, 0.25 - 0.04 * prior_rank)
                prior_rank += 1
                out.append(Candidate(c["email"], EmailStatus.DOMAIN_VALID_ONLY, round(conf, 2), c["pattern"],
                                     f"Common format {c['pattern']}; domain accepts mail ({mail_host_label(dom.mx)}). "
                                     "Mailbox not confirmed."))
            else:
                out.append(Candidate(c["email"], EmailStatus.UNVERIFIED, 0.05, c["pattern"],
                                     "Common format; domain has no MX records."))
        return out

    async def _provider_verify(self, cands: list[Candidate]) -> list[Candidate]:
        kept = []
        for i, c in enumerate(cands):
            if i < 2:
                v = await hunter_verify(c.email, self.s.hunter_api_key, self.http)
                c.verification = v or {}
                st = (v or {}).get("status")
                if st == "valid" and not v.get("accept_all"):
                    c.status, c.confidence = EmailStatus.PROVIDER_VERIFIED, 0.9
                    c.basis += " Verified by Hunter Email Verifier."
                elif st == "invalid":
                    continue
                elif v and v.get("accept_all"):
                    c.confidence = min(c.confidence, 0.5)
                    c.basis += " Domain is catch-all (per Hunter); mailbox can't be verified."
            kept.append(c)
        return kept

    @staticmethod
    def _explain(cands: list[Candidate], dom: DomainResult, stats: PatternStats) -> str:
        if not cands:
            return f"No address found or predicted for domain {dom.domain}."
        b = cands[0]
        if b.status == EmailStatus.PUBLICLY_CONFIRMED:
            return f"{b.email} is published on a public page tied to this person ({b.source_url})."
        if b.status == EmailStatus.PROVIDER_VERIFIED:
            return f"{b.email} was predicted from the company format and verified by an authorized provider."
        if b.status == EmailStatus.PATTERN_PREDICTED:
            n = sum(stats.exact.values()) + sum(stats.structural.values())
            return (f"No published address for this person. {b.email} follows the company's observed format "
                    f"{b.pattern}, learned from {n} published staff address(es). It is a prediction.")
        return (f"No published addresses found for {dom.domain}. {b.email} uses a common format and the domain "
                "accepts mail, but nothing confirms this mailbox exists.")
