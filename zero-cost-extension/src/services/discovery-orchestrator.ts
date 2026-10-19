// Runs the pipeline in stages and reports progress. Pure logic: Chrome APIs are
// injected (permissions, page fetching), so this is fully testable in Node.
import { resolveCompanyDomain, type ResolvedDomain } from './company-resolver';
import { DnsValidator } from './dns-validator';
import { extractPage, type FoundEmail } from './email-extractor';
import { identityKey, type Identity } from './identity';
import { buildSearchLinks, crawlOfficialSite, PageFetcher, type SearchLink, type SourceVisit } from './public-discovery';
import { rank, type RankingResult } from './ranking-engine';
import { canonicalDomain, nameDomainSimilarity } from '../utils/domain';
import type { NetDeps } from '../utils/net';

export type StageKey = 'profile' | 'domain' | 'sources' | 'patterns' | 'dns';
export type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export const STAGE_LABELS: Record<StageKey, string> = {
  profile: 'Profile identified',
  domain: 'Company domain resolved',
  sources: 'Public sources checked',
  patterns: 'Email patterns evaluated',
  dns: 'DNS validation completed',
};

export type LookupError = 'missing-input' | 'no-domain' | 'offline' | 'cancelled' | 'interrupted' | 'internal';

export interface LookupState {
  id: string;
  key: string;                       // identityKey of the person this lookup belongs to
  startedAt: number;
  heartbeatAt: number;
  identity: Identity;
  website: string | null;            // user-provided or user-confirmed
  stages: Record<StageKey, { state: StageState; detail?: string }>;
  domain: ResolvedDomain | null;
  mailDomain: string | null;
  mailDomainInferred: boolean;       // sibling-domain guess, not evidenced
  mx: string[];
  dnsOk: boolean;
  visits: SourceVisit[];
  officialEmails: FoundEmail[];
  externalEmails: FoundEmail[];      // from pages the user sent back
  pageNames: Record<string, string[]>;
  ranking: RankingResult | null;
  searchLinks: SearchLink[];
  needsSitePermission: boolean;
  done: boolean;
  errorKind?: LookupError;
  error?: string;
}

export interface OrchestratorDeps extends NetDeps {
  dns?: DnsValidator;
  /** True if the extension may fetch this URL (host permission granted). */
  hasPermission: (url: string) => Promise<boolean>;
  maxPages?: number;
  intervalMs?: number;
  crawlBudgetMs?: number;
  isOnline?: () => boolean;
}

export function initialState(identity: Identity, website: string | null = null, now = Date.now()): LookupState {
  const stages = Object.fromEntries((Object.keys(STAGE_LABELS) as StageKey[]).map((k) => [k, { state: 'pending' }])) as LookupState['stages'];
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    key: identityKey(identity),
    startedAt: now,
    heartbeatAt: now,
    identity, website, stages, domain: null, mailDomain: null, mailDomainInferred: false, mx: [], dnsOk: true, visits: [],
    officialEmails: [], externalEmails: [], pageNames: {}, ranking: null, searchLinks: [], needsSitePermission: false, done: false,
  };
}

type Emit = (s: LookupState) => void;

function setStage(s: LookupState, k: StageKey, state: StageState, detail?: string) {
  s.stages[k] = { state, detail };
}

function fail(s: LookupState, kind: LookupError, message: string) {
  s.done = true;
  s.errorKind = kind;
  s.error = message;
  for (const k of Object.keys(s.stages) as StageKey[]) {
    if (s.stages[k].state === 'running' || s.stages[k].state === 'pending') s.stages[k] = { state: 'skipped' };
  }
}

/** Mark a lookup as stopped early, keeping whatever was found. */
export function stopLookup(s: LookupState, kind: 'cancelled' | 'interrupted'): LookupState {
  if (s.done) return s;
  fail(s, kind, kind === 'cancelled' ? 'Lookup cancelled.' : 'The lookup was interrupted (the extension was restarted). Press Retry.');
  return s;
}

/** Full lookup. `emit` is called after every stage for progressive UI updates. */
export async function runLookup(state: LookupState, deps: OrchestratorDeps, emit: Emit = () => {}, signal?: AbortSignal): Promise<LookupState> {
  const s = state;
  const dns = deps.dns ?? new DnsValidator(deps);
  const fetcher = new PageFetcher(deps, { intervalMs: deps.intervalMs ?? 800, hasPermission: deps.hasPermission });
  const id = s.identity;

  // 1. Profile
  if (!id.name.first || (!id.company && !s.website)) {
    setStage(s, 'profile', 'failed', !id.name.first ? 'Name missing' : 'Company or website missing');
    fail(s, 'missing-input', 'Enter the person\'s name and company (or company website) to continue.');
    emit(s);
    return s;
  }
  if (deps.isOnline && !deps.isOnline()) {
    setStage(s, 'profile', 'done');
    fail(s, 'offline', 'You are offline. Connect to the internet and press Retry.');
    emit(s);
    return s;
  }
  setStage(s, 'profile', 'done', `${id.name.full}${id.company ? ` · ${id.company}` : ''}`);
  setStage(s, 'domain', 'running');
  emit(s);

  // 2. Domain
  s.domain = await resolveCompanyDomain(
    { company: id.company, website: s.website, companyLinkedInUrl: id.companyLinkedInUrl },
    { ...deps, dns, fetchPage: async (u) => (await deps.hasPermission(u)) ? (await fetcher.get(u, signal)).html : null },
  );
  if (signal?.aborted) return s;
  if (!s.domain.domain) {
    setStage(s, 'domain', 'failed', s.domain.notes.at(-1));
    s.searchLinks = buildSearchLinks(id, null);
    if (s.domain.networkError) fail(s, 'offline', 'DNS validation failed. You may be offline, or DNS-over-HTTPS is blocked on this network.');
    else fail(s, 'no-domain', 'Company website unknown. Pick a suggestion or enter the website to continue.');
    emit(s);
    return s;
  }
  s.mailDomain = s.domain.mailDomain ?? s.domain.domain;
  setStage(s, 'domain', 'done', `${s.domain.domain} (${s.domain.confidence} confidence${s.domain.needsConfirmation ? ', please confirm' : ''})`);
  s.searchLinks = buildSearchLinks(id, s.domain.domain);
  setStage(s, 'sources', 'running');
  emit(s);

  // 3. Official site crawl (only with the user's permission for that site)
  const home = `https://${s.domain.domain}/`;
  if (await deps.hasPermission(home)) {
    s.needsSitePermission = false;
    const crawl = await crawlOfficialSite(s.domain.domain, [], fetcher, {
      maxPages: deps.maxPages ?? 15, signal, personName: id.name, budgetMs: deps.crawlBudgetMs, now: deps.now,
    });
    s.visits = crawl.visits;
    s.officialEmails = crawl.emails;
    s.pageNames = { ...s.pageNames, ...crawl.pageNames };
    const ok = crawl.visits.filter((v) => v.status === 'ok').length;
    const blocked = crawl.visits.filter((v) => v.status === 'blocked' || v.status === 'robots').length;
    const failedFetches = crawl.visits.filter((v) => v.status === 'timeout' || v.status === 'error').length;
    const parts = [`${ok} page(s) read`];
    if (blocked) parts.push(`${blocked} blocked or disallowed`);
    if (failedFetches) parts.push(`${failedFetches} failed`);
    if (crawl.truncated) parts.push('time limit reached');
    parts.push(`${crawl.emails.length} address(es) found`);
    setStage(s, 'sources', ok ? 'done' : 'failed', parts.join(', '));
  } else {
    s.needsSitePermission = true;
    setStage(s, 'sources', 'skipped', `Permission needed to scan ${s.domain.domain}`);
  }
  if (signal?.aborted) return s;
  emit(s);

  // 4–5. Email domain, patterns, DNS, ranking
  await chooseMailDomain(s, dns);
  if (signal?.aborted) return s;
  await finishRanking(s, dns);
  emit(s);
  return s;
}

/**
 * Company domain vs email domain. If the website domain has no MX:
 *  1) prefer a corporate domain the site itself publishes addresses at (evidenced);
 *  2) else try sibling TLDs with the same name that accept mail (inferred, flagged).
 */
export async function chooseMailDomain(s: LookupState, dns: DnsValidator) {
  if (!s.domain?.domain || s.domain.mailDomain) return;
  const counts = new Map<string, number>();
  for (const e of s.officialEmails) {
    if (e.domain !== s.domain.domain && !e.isRole && nameDomainSimilarity(s.identity.company, e.domain) >= 0.7) {
      counts.set(e.domain, (counts.get(e.domain) ?? 0) + 1);
    }
  }
  const alias = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (alias) {
    s.mailDomain = alias;
    s.domain.notes.push(`The company's site publishes staff addresses at ${alias}; using it as the email domain.`);
    return;
  }
  const label = s.domain.domain.split('.')[0];
  for (const tld of ['com', 'co', 'io', 'net']) {
    const sib = `${label}.${tld}`;
    if (sib === s.domain.domain) continue;
    const mx = await dns.mx(sib);
    if (mx.ok && mx.records.length) {
      s.mailDomain = sib;
      s.mailDomainInferred = true;
      s.domain.notes.push(`${s.domain.domain} has no mail server; ${sib} does. Using ${sib} as an unconfirmed email domain.`);
      return;
    }
  }
}

export async function finishRanking(s: LookupState, dns: DnsValidator) {
  if (!s.domain?.domain || !s.mailDomain) return;
  setStage(s, 'patterns', 'running');
  setStage(s, 'dns', 'running');
  const mx = await dns.mx(s.mailDomain);
  s.dnsOk = mx.ok;
  s.mx = mx.records;
  setStage(s, 'dns', mx.ok ? 'done' : 'failed', mx.ok ? (mx.records.length ? `${s.mailDomain} accepts mail (${mx.records[0]})` : `${s.mailDomain} has no MX records`) : `DNS validation failed: ${mx.error}`);
  // An inferred sibling mail domain is treated as weakly linked to the company.
  const domainForRanking = s.mailDomainInferred ? { ...s.domain, confidence: 'low' as const } : s.domain;
  s.ranking = rank({
    name: s.identity.name, domain: domainForRanking, mailDomain: s.mailDomain, mx: s.mx, dnsOk: s.dnsOk,
    emails: [...s.officialEmails, ...s.externalEmails], pageNames: s.pageNames,
  });
  const conv = s.ranking.conventions[0];
  setStage(s, 'patterns', 'done', conv ? `Company format: ${conv.pattern} (${conv.exactSupport + conv.structuralSupport} published sample(s))` : 'No company format observed; using common formats');
  const predicted = s.ranking.candidates.filter((c) => c.status !== 'PUBLICLY_CONFIRMED').slice(0, 3).map((c) => c.email);
  s.searchLinks = buildSearchLinks(s.identity, s.domain.domain, s.ranking.outcome === 'confirmed' ? [] : predicted);
  s.done = true;
}

/** User-assisted: extract from a page the user opened or pasted, then re-rank. */
export async function analyzeUserPage(s: LookupState, html: string, url: string, deps: { dns?: DnsValidator } & NetDeps): Promise<{ state: LookupState; found: number }> {
  let host = '';
  try { host = new URL(url).hostname; } catch { return { state: s, found: 0 }; }
  if (/(^|\.)linkedin\.com$/i.test(host)) return { state: s, found: 0 };
  const page = extractPage(html, url);
  const before = new Set(s.externalEmails.map((e) => `${e.email}|${e.url}`));
  for (const f of page.emails) if (!before.has(`${f.email}|${f.url}`)) s.externalEmails.push(f);
  if (page.names.length) s.pageNames = { ...s.pageNames, [url]: page.names };
  await finishRanking(s, deps.dns ?? new DnsValidator(deps));
  const relevant = s.mailDomain ? page.emails.filter((f) => f.domain === s.mailDomain || f.domain.endsWith(`.${s.mailDomain}`)).length : 0;
  return { state: s, found: relevant };
}

export function websiteFromInput(raw: string): string | null {
  return canonicalDomain(raw);
}

/** A running lookup with no heartbeat for this long is treated as interrupted. */
export const STALE_AFTER_MS = 45_000;
export function isStale(s: LookupState, now = Date.now()): boolean {
  return !s.done && now - s.heartbeatAt > STALE_AFTER_MS;
}
