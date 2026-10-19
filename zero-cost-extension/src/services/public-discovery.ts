// Public-source discovery.
//  Automatic: polite crawl of the company's own site (homepage, sitemap, team/about/
//  press/contact pages) when the user has granted access to that site.
//  User-assisted: targeted web-search links the user opens; the user then sends a
//  result page back ("Analyze this page"). Search engines are never scraped.
import { extractPage, personLinks, sitemapTeamUrls, teamPageLinks, type FoundEmail } from './email-extractor';
import type { Identity } from './identity';
import type { ParsedName } from '../utils/normalization';
import { cleanUrl } from '../utils/domain';
import { fetchWithTimeout, HostRateLimiter, mapLimit, NetError, parseRobots, robotsAllows, type NetDeps } from '../utils/net';

export type SourceStatus = 'ok' | 'blocked' | 'robots' | 'not-found' | 'timeout' | 'error' | 'not-html' | 'no-permission';

export interface SourceVisit { url: string; status: SourceStatus; detail?: string; emails: number }

export interface CrawlResult { visits: SourceVisit[]; emails: FoundEmail[]; pageNames: Record<string, string[]>; truncated: boolean }

export interface PageFetcherOptions {
  intervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgentToken?: string;
  hasPermission?: (url: string) => Promise<boolean>;
}

const CHALLENGE_RE = /(captcha|cf-challenge|challenge-platform|attention required|access denied|are you a robot|px-captcha|ddos protection)/i;
export const COMMON_PATHS = [
  '/team', '/our-team', '/about/team', '/company/team', '/people', '/our-people', '/leadership', '/about/leadership',
  '/management', '/staff', '/directory', '/about', '/about-us', '/company', '/contact', '/contact-us', '/press',
  '/newsroom', '/media', '/news', '/impressum', '/imprint',
];

/** Fetches public HTML politely: robots.txt, per-host spacing, timeouts, size cap, challenge detection. */
export class PageFetcher {
  private robots = new Map<string, Promise<ReturnType<typeof parseRobots> | null>>();
  private limiter: HostRateLimiter;
  constructor(private deps: NetDeps, private opts: PageFetcherOptions = {}) {
    this.limiter = new HostRateLimiter(opts.intervalMs ?? 800, deps);
  }

  private robotsFor(origin: string, signal?: AbortSignal) {
    if (!this.robots.has(origin)) {
      this.robots.set(origin, (async () => {
        try {
          await this.limiter.wait(origin);
          const r = await fetchWithTimeout(this.deps, `${origin}/robots.txt`, {}, this.opts.timeoutMs ?? 8000, signal);
          if (r.status === 401 || r.status === 403) return parseRobots('User-agent: *\nDisallow: /');
          if (!r.ok) return null;
          return parseRobots(await r.text());
        } catch {
          return null; // unreachable robots.txt: treat as no restrictions (RFC 9309 §2.3.1.3)
        }
      })());
    }
    return this.robots.get(origin)!;
  }

  async get(rawUrl: string, signal?: AbortSignal): Promise<{ visit: SourceVisit; html: string | null; finalUrl: string }> {
    const url = cleanUrl(rawUrl);
    const visit: SourceVisit = { url: url ?? rawUrl, status: 'error', emails: 0 };
    if (!url) return { visit: { ...visit, detail: 'Invalid URL' }, html: null, finalUrl: rawUrl };
    if (/(^|\.)linkedin\.com$|(^|\.)licdn\.com$/i.test(new URL(url).hostname)) {
      return { visit: { ...visit, status: 'blocked', detail: 'LinkedIn pages are never fetched automatically' }, html: null, finalUrl: url };
    }
    if (this.opts.hasPermission && !(await this.opts.hasPermission(url))) {
      return { visit: { ...visit, status: 'no-permission', detail: 'Site access not granted' }, html: null, finalUrl: url };
    }
    const origin = new URL(url).origin;
    const groups = await this.robotsFor(origin, signal);
    if (groups && !robotsAllows(groups, url, this.opts.userAgentToken)) {
      return { visit: { ...visit, status: 'robots', detail: 'Disallowed by robots.txt' }, html: null, finalUrl: url };
    }
    try {
      await this.limiter.wait(url);
      const r = await fetchWithTimeout(this.deps, url, { headers: { accept: 'text/html,application/xhtml+xml' } }, this.opts.timeoutMs ?? 10000, signal);
      if (r.status === 403 || r.status === 429 || r.status === 503) {
        return { visit: { ...visit, status: 'blocked', detail: `HTTP ${r.status}: the site refused automated access` }, html: null, finalUrl: url };
      }
      if (r.status === 404 || r.status === 410) return { visit: { ...visit, status: 'not-found', detail: `HTTP ${r.status}` }, html: null, finalUrl: url };
      if (!r.ok) return { visit: { ...visit, status: 'error', detail: `HTTP ${r.status}` }, html: null, finalUrl: url };
      const ctype = r.headers.get('content-type') ?? '';
      if (!/html|xml/.test(ctype)) return { visit: { ...visit, status: 'not-html', detail: ctype || 'unknown type' }, html: null, finalUrl: url };
      const text = (await r.text()).slice(0, this.opts.maxBytes ?? 1_500_000);
      if (CHALLENGE_RE.test(text.slice(0, 5000)) && text.length < 30000) {
        return { visit: { ...visit, status: 'blocked', detail: 'Bot challenge page; not bypassed' }, html: null, finalUrl: url };
      }
      return { visit: { ...visit, status: 'ok' }, html: text, finalUrl: r.url || url };
    } catch (e) {
      const kind = e instanceof NetError ? e.kind : 'other';
      if (kind === 'aborted') throw e;
      return { visit: { ...visit, status: kind === 'timeout' ? 'timeout' : 'error', detail: (e as Error).message }, html: null, finalUrl: url };
    }
  }
}

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onVisit?: (v: SourceVisit) => void;
  /** Follow up to 3 same-site links that mention this person (their bio page). */
  personName?: ParsedName;
  /** Stop starting new page fetches after this many ms. */
  budgetMs?: number;
  now?: () => number;
}

/** Crawl the official site for published addresses at `mailDomains` (empty = any non-freemail domain). */
export async function crawlOfficialSite(siteDomain: string, mailDomains: string[], fetcher: PageFetcher, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 15;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 45_000);
  const visits: SourceVisit[] = [];
  const emails: FoundEmail[] = [];
  const pageNames: Record<string, string[]> = {};
  const bioLinks: string[] = [];
  const seen = new Set<string>();
  const record = (v: SourceVisit) => { visits.push(v); opts.onVisit?.(v); };
  const scan = (html: string, url: string, v: SourceVisit) => {
    const page = extractPage(html, url, { domains: mailDomains.length ? mailDomains : undefined });
    v.emails = page.emails.length;
    emails.push(...page.emails);
    if (page.names.length) pageNames[url] = page.names;
    if (opts.personName) for (const l of personLinks(html, url, siteDomain, opts.personName)) if (!bioLinks.includes(l)) bioLinks.push(l);
  };
  const fetchAll = (urls: string[]) => mapLimit(urls, opts.concurrency ?? 3, async (u) => {
    if (opts.signal?.aborted || now() > deadline || seen.has(u)) return;
    seen.add(u);
    const r = await fetcher.get(u, opts.signal);
    if (r.visit.status === 'not-found') return; // guessed path; don't clutter the source list
    record(r.visit);
    if (r.html) scan(r.html, r.finalUrl, r.visit);
  });

  // 1. Homepage (try apex, then www)
  let home: { html: string; url: string } | null = null;
  for (const u of [`https://${siteDomain}/`, `https://www.${siteDomain}/`]) {
    const r = await fetcher.get(u, opts.signal);
    seen.add(r.visit.url);
    record(r.visit);
    if (r.html) { home = { html: r.html, url: r.finalUrl }; seen.add(r.finalUrl); scan(r.html, r.finalUrl, r.visit); break; }
    if (r.visit.status === 'no-permission' || r.visit.status === 'robots') break;
  }
  if (!home) return { visits, emails, pageNames, truncated: false };

  // 2. Candidate pages: links from homepage, sitemap, then common paths.
  const origin = new URL(home.url).origin;
  const queue: string[] = teamPageLinks(home.html, home.url, siteDomain);
  const sm = await fetcher.get(`${origin}/sitemap.xml`, opts.signal);
  if (sm.html) queue.push(...sitemapTeamUrls(sm.html, siteDomain));
  queue.push(...COMMON_PATHS.map((p) => origin + p));
  const pages = [...new Set(queue.map((u) => cleanUrl(u)).filter((u): u is string => !!u && !seen.has(u)))].slice(0, maxPages - 1);
  await fetchAll(pages);

  // 3. The person's own bio page(s), if a fetched page links to one.
  await fetchAll(bioLinks.map((u) => cleanUrl(u)).filter((u): u is string => !!u && !seen.has(u)).slice(0, 3));
  return { visits, emails, pageNames, truncated: now() > deadline };
}

export interface SearchLink { label: string; query: string; engines: { name: string; url: string }[] }

export const SEARCH_ENGINES = [
  { name: 'Google', url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { name: 'Bing', url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { name: 'DuckDuckGo', url: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
];
export const SEARCH_ENGINE_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/i;

/**
 * Targeted public web searches the user can open (user-assisted mode), most productive first.
 * `predicted` = top predicted addresses; searching for the exact address finds pages that publish it.
 */
export function buildSearchLinks(id: Identity, domain: string | null, predicted: string[] = []): SearchLink[] {
  const name = id.name.full;
  const company = id.company;
  const qs: { label: string; q: string }[] = [];
  if (predicted.length) qs.push({ label: 'Exact predicted addresses', q: predicted.slice(0, 3).map((e) => `"${e}"`).join(' OR ') });
  if (name && domain) qs.push({ label: 'Name + email domain', q: `"${name}" "@${domain}"` });
  if (name && domain) qs.push({ label: 'Name on company site', q: `site:${domain} "${name}"` });
  if (name && company) qs.push({ label: 'Name + company + email', q: `"${name}" "${company}" (email OR contact OR "e-mail")` });
  if (name && id.title && company) qs.push({ label: 'Name + role + company', q: `"${name}" "${id.title}" "${company}"` });
  if (name && company) qs.push({ label: 'Speaker / press / bio pages', q: `"${name}" "${company}" (speaker OR panelist OR press OR interview OR bio)` });
  if (name && domain) qs.push({ label: 'Public documents (PDF)', q: `"${name}" "${domain}" filetype:pdf` });
  if (domain) qs.push({ label: 'Company email format (other staff)', q: `"@${domain}" -info -support -sales -careers -press -hello` });
  if (domain) qs.push({ label: 'Company team / leadership pages', q: `site:${domain} (team OR leadership OR people OR staff OR about)` });
  return qs.map(({ label, q }) => ({ label, query: q, engines: SEARCH_ENGINES.map((e) => ({ name: e.name, url: e.url(q) })) }));
}
