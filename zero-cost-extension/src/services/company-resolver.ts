// Company domain resolution from free, permitted sources:
//   user-provided website · Wikidata "official website" (P856) · DuckDuckGo Instant Answer
//   "Official site" · LinkedIn company slug · name heuristics
// Every candidate must resolve in DNS. A single unverified source is never enough
// for "high" confidence; low/conflicting results ask the user to confirm.
import { companySlug } from './identity';
import type { DnsValidator } from './dns-validator';
import { pageTitle } from './email-extractor';
import {
  canonicalDomain, companyTokens, heuristicDomains, isDirectoryDomain, isLookalike, nameDomainSimilarity,
} from '../utils/domain';
import { normalizeText, token } from '../utils/normalization';
import { fetchWithTimeout, type NetDeps } from '../utils/net';

export type SourceKind = 'user' | 'wikidata' | 'duckduckgo' | 'linkedin-slug' | 'heuristic';

export interface DomainCandidate {
  domain: string;
  score: number;
  sources: SourceKind[];
  signals: string[];   // human-readable reasons
  resolves: boolean;
  mx: string[];
  homepageTitle?: string;
}

export interface ResolvedDomain {
  domain: string | null;
  mailDomain: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  needsConfirmation: boolean;
  conflicting: boolean;
  candidates: DomainCandidate[];
  notes: string[];
  /** Every DNS check failed: likely offline or DNS-over-HTTPS blocked. */
  networkError?: boolean;
}

export interface ResolverDeps extends NetDeps {
  dns: DnsValidator;
  /** Fetch a public page's HTML if the user granted access; null otherwise. */
  fetchPage?: (url: string) => Promise<string | null>;
}

const SOURCE_POINTS: Record<SourceKind, number> = { user: 60, wikidata: 40, duckduckgo: 35, 'linkedin-slug': 15, heuristic: 5 };
const COMPANYISH = /(company|corporation|business|firm|startup|manufacturer|organi[sz]ation|brand|enterprise|provider|developer|bank|retailer|agency|group|subsidiary)/i;

async function getJson<T>(deps: NetDeps, url: string): Promise<T | null> {
  try {
    const r = await fetchWithTimeout(deps, url, { headers: { accept: 'application/json', 'Api-User-Agent': 'ZeroCostEmailFinder/1.0 (personal extension)' } }, 8000);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Wikidata: search entities by name, read "official website" (P856). */
export async function wikidataWebsites(deps: NetDeps, company: string): Promise<{ domain: string; label: string; exact: boolean }[]> {
  type Search = { search?: { id: string; label?: string; description?: string }[] };
  const s = await getJson<Search>(deps, `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&type=item&limit=5&search=${encodeURIComponent(company)}`);
  const hits = (s?.search ?? []).filter((h) => !h.description || COMPANYISH.test(h.description) || token(h.label ?? '') === token(company));
  if (!hits.length) return [];
  type Ents = { entities?: Record<string, { claims?: { P856?: { mainsnak?: { datavalue?: { value?: string } } }[] } }> };
  const e = await getJson<Ents>(deps, `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&props=claims&ids=${hits.map((h) => h.id).join('|')}`);
  const out: { domain: string; label: string; exact: boolean }[] = [];
  for (const h of hits) {
    for (const c of e?.entities?.[h.id]?.claims?.P856 ?? []) {
      const d = canonicalDomain(c.mainsnak?.datavalue?.value ?? '');
      if (d) out.push({ domain: d, label: h.label ?? '', exact: token(h.label ?? '') === token(company) });
    }
  }
  return out;
}

/** DuckDuckGo Instant Answer API (free, no key): "Official site" result / infobox website. */
export async function duckduckgoWebsites(deps: NetDeps, company: string): Promise<string[]> {
  type IA = { Results?: { FirstURL?: string; Text?: string }[]; Infobox?: { content?: { label?: string; value?: unknown }[] } };
  const r = await getJson<IA>(deps, `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(company)}`);
  const out: string[] = [];
  for (const res of r?.Results ?? []) {
    if (/official site/i.test(res.Text ?? '') && res.FirstURL) { const d = canonicalDomain(res.FirstURL); if (d) out.push(d); }
  }
  for (const c of r?.Infobox?.content ?? []) {
    if (/website/i.test(c.label ?? '') && typeof c.value === 'string') { const d = canonicalDomain(c.value); if (d) out.push(d); }
  }
  return [...new Set(out)];
}

const LEGAL_SUFFIX = /[,\s]+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|ag|s\.?a|s\.?a\.?s|plc|pvt\.?\s*ltd|private limited|pte\.?\s*ltd|b\.?v|n\.?v|s\.?r\.?l|oy|ab|a\/s|as|kk|lp|llp|sarl|spa)\.?$/i;

/** "Example Technologies, Inc." -> "Example Technologies" (repeatedly, for "Foo Holdings Pvt. Ltd."). */
export function stripLegalSuffix(name: string): string {
  let s = normalizeText(name);
  for (let i = 0; i < 3 && LEGAL_SUFFIX.test(s); i++) s = s.replace(LEGAL_SUFFIX, '').trim();
  return s;
}

export async function resolveCompanyDomain(
  input: { company: string; website?: string | null; companyLinkedInUrl?: string | null },
  deps: ResolverDeps,
): Promise<ResolvedDomain> {
  const notes: string[] = [];
  const company = normalizeText(input.company);
  const cands = new Map<string, DomainCandidate>();
  const add = (domain: string | null, src: SourceKind, signal: string) => {
    if (!domain) return;
    if (isDirectoryDomain(domain)) return;
    if (src !== 'user' && isLookalike(company, domain)) { notes.push(`Ignored lookalike domain ${domain}.`); return; }
    const c = cands.get(domain) ?? { domain, score: 0, sources: [], signals: [], resolves: false, mx: [] };
    if (!c.sources.includes(src)) { c.sources.push(src); c.score += SOURCE_POINTS[src]; c.signals.push(signal); }
    cands.set(domain, c);
  };

  if (input.website) {
    const d = canonicalDomain(input.website);
    if (d) add(d, 'user', 'Provided by you');
    else notes.push(`"${input.website}" is not a valid website/domain.`);
  }

  if (company) {
    // Query with and without the legal suffix ("Example Technologies Inc." -> "Example Technologies").
    const names = [...new Set([company, stripLegalSuffix(company)].filter(Boolean))];
    const results = await Promise.allSettled(names.flatMap((n) => [wikidataWebsites(deps, n), duckduckgoWebsites(deps, n)]));
    let wdOk = false; let ddgOk = false;
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      if (i % 2 === 0) { wdOk = true; for (const w of r.value as Awaited<ReturnType<typeof wikidataWebsites>>) add(w.domain, 'wikidata', `Wikidata official website${w.exact ? '' : ` (entity "${w.label}")`}`); }
      else { ddgOk = true; for (const d of r.value as string[]) add(d, 'duckduckgo', 'DuckDuckGo "Official site"'); }
    });
    if (!wdOk) notes.push('Wikidata unavailable.');
    if (!ddgOk) notes.push('DuckDuckGo unavailable.');

    const slug = companySlug(input.companyLinkedInUrl ?? null);
    if (slug) {
      const label = token(slug.replace(/-(inc|llc|ltd|gmbh|corp)$/, ''));
      for (const c of [...cands.values()]) if (token(c.domain.split('.')[0]) === label) add(c.domain, 'linkedin-slug', 'Matches LinkedIn company page name');
      add(`${label}.com`, 'linkedin-slug', 'Derived from LinkedIn company page name');
    }
    for (const h of heuristicDomains(company)) add(h, 'heuristic', 'Name-based guess');
  }

  if (!cands.size) {
    return { domain: null, mailDomain: null, confidence: 'none', needsConfirmation: true, conflicting: false, candidates: [], notes: [...notes, 'No company name or website to work from.'] };
  }

  // Validate the most promising candidates (bounded).
  const toCheck = [...cands.values()]
    .sort((a, b) => (b.score + 25 * nameDomainSimilarity(company, b.domain)) - (a.score + 25 * nameDomainSimilarity(company, a.domain)))
    .slice(0, 6);
  await Promise.allSettled(toCheck.map(async (c) => {
    const [res, mx] = await Promise.all([deps.dns.resolves(c.domain), deps.dns.mx(c.domain)]);
    if (!res.ok && !mx.ok) { c.signals.push(`DNS lookup failed (${res.error ?? 'unknown'})`); return; }
    c.resolves = res.records.length > 0;
    c.mx = mx.records;
    const sim = nameDomainSimilarity(company, c.domain);
    c.score += Math.round(25 * sim);
    if (sim >= 0.7) c.signals.push('Domain name matches company name');
    if (c.mx.length) { c.score += 10; c.signals.push('Domain receives email (MX found)'); }
    if (c.resolves && deps.fetchPage) {
      const html = (await deps.fetchPage(`https://${c.domain}/`)) ?? (await deps.fetchPage(`https://www.${c.domain}/`));
      if (html) {
        c.homepageTitle = pageTitle(html);
        const t = token(c.homepageTitle);
        const toks = companyTokens(company);
        if (toks.length && toks.every((x) => t.includes(x))) { c.score += 15; c.signals.push('Homepage title names the company'); }
      }
    }
  }));

  const valid = toCheck.filter((c) => c.resolves).sort((a, b) => b.score - a.score);
  const networkError = toCheck.length > 0 && toCheck.every((c) => c.signals.some((x) => x.startsWith('DNS lookup failed')));
  if (networkError) {
    return { domain: null, mailDomain: null, confidence: 'none', needsConfirmation: true, conflicting: false, candidates: toCheck, networkError: true,
      notes: [...notes, 'DNS validation failed for every candidate. You may be offline, or DNS-over-HTTPS is blocked on this network.'] };
  }
  for (const c of toCheck.filter((x) => !x.resolves && x.sources.some((s) => s !== 'heuristic'))) {
    notes.push(`${c.domain} does not resolve in DNS.`);
  }
  if (!valid.length) {
    return { domain: null, mailDomain: null, confidence: 'none', needsConfirmation: true, conflicting: false, candidates: toCheck, notes: [...notes, 'No candidate domain resolves. Enter the company website.'] };
  }

  const best = valid[0];
  const independent = best.sources.filter((s) => s !== 'heuristic').length;
  // A name-only guess (e.g. "Example Widgets" -> example.com) is too weak to act on unless the
  // domain is exactly the full company name; offer it for confirmation instead.
  if (independent === 0 && nameDomainSimilarity(company, best.domain) < 1) {
    return {
      domain: null, mailDomain: null, confidence: 'none', needsConfirmation: true, conflicting: false, candidates: valid,
      notes: [...notes, `No public source confirms a website for "${company}". Pick a suggestion or enter the website.`],
    };
  }
  const titleMatch = best.signals.includes('Homepage title names the company');
  const conflicting = valid.length > 1 && valid[1].score >= 45 && best.score - valid[1].score < 10 && !best.sources.includes('user');
  let confidence: ResolvedDomain['confidence'] =
    best.score >= 70 && (independent >= 2 || best.sources.includes('user') || titleMatch) ? 'high'
      : best.score >= 45 ? 'medium' : 'low';
  if (conflicting && confidence === 'high') confidence = 'medium';
  if (conflicting) notes.push(`Several plausible domains: ${valid.slice(0, 3).map((c) => c.domain).join(', ')}. Please confirm.`);
  if (!best.mx.length) notes.push(`${best.domain} has no MX records; the company may use a different email domain.`);

  return {
    domain: best.domain,
    mailDomain: best.mx.length ? best.domain : null,
    confidence,
    needsConfirmation: confidence !== 'high' || conflicting,
    conflicting,
    candidates: valid,
    notes,
  };
}
