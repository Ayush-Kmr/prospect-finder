// Local email extraction from HTML: regex, mailto links, entity decoding,
// common "[at]/[dot]" obfuscation, role filtering, and name association.
// Uses node-html-parser (works in MV3 service workers, which have no DOMParser).
import { parse, type HTMLElement } from 'node-html-parser';
import { FREEMAIL_DOMAINS } from '../utils/domain';
import { normalizeText, parseFullName, token, type ParsedName } from '../utils/normalization';

export const ROLE_LOCALS = new Set([
  'info', 'contact', 'hello', 'hi', 'sales', 'support', 'help', 'admin', 'office', 'team', 'press', 'media', 'pr',
  'news', 'marketing', 'careers', 'jobs', 'hr', 'recruiting', 'talent', 'billing', 'accounts', 'finance', 'legal',
  'privacy', 'security', 'abuse', 'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster', 'enquiries',
  'inquiries', 'service', 'partners', 'investors', 'ir', 'events', 'feedback', 'general', 'mail', 'orders', 'hiring',
  'compliance', 'dpo', 'gdpr', 'sponsorship', 'community', 'devrel', 'ops', 'it', 'reception',
]);

const EMAIL_RE = /(?<![\w.+-])([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24})(?![\w-])/gi;
const OBFUSCATED_AT_RE = /\b([a-z0-9._%+-]{1,64})\s*[[({]\s*at\s*[\])}]\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const OBFUSCATED_DOT_RE = /\s*[[({]\s*dot\s*[\])}]\s*/gi;
const NAME_RE = /\b([A-Z][a-zà-ÿ'’-]+(?:\s+[A-Z]\.?)?(?:\s+(?:van|von|de|der|da|del|di|le|la)\b)?\s+[A-Z][a-zà-ÿ'’-]+)\b/g;
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i;

export interface FoundEmail {
  email: string;
  local: string;
  domain: string;
  url: string;
  context: string;
  namesNearby: ParsedName[];
  isRole: boolean;
  viaMailto: boolean;
  /** From schema.org JSON-LD / microdata, where the owner's name is stated explicitly. */
  structured?: boolean;
}

export interface ExtractOptions {
  /** Keep only addresses at these domains (or their subdomains). */
  domains?: string[];
  includeFreemail?: boolean;
}

export interface PageExtraction {
  emails: FoundEmail[];
  /** Person-like names anywhere on the page (helps attribute addresses on grid-style team pages). */
  names: string[];
}

function visibleText(root: HTMLElement): string {
  root.querySelectorAll('script,style,noscript,template,svg,head').forEach((n) => n.remove());
  // structuredText decodes entities and separates block elements (plain .text runs
  // "a@b.com</p><p>Next" together into "a@b.comNext").
  return normalizeText(root.structuredText ?? '');
}

function deobfuscate(text: string): string {
  // "sarah [dot] white [at] example [dot] com" -> "sarah.white@example.com"
  return text.replace(OBFUSCATED_DOT_RE, '.').replace(OBFUSCATED_AT_RE, (_m, local: string, dom: string) => ` ${local}@${dom} `);
}

function namesIn(text: string): ParsedName[] {
  const out: ParsedName[] = [];
  for (const m of text.matchAll(NAME_RE)) {
    const p = parseFullName(m[1]);
    if (p.first && p.last) out.push(p);
  }
  return out;
}

/** schema.org Person/Organization nodes with an email, from JSON-LD and microdata. */
function structuredEmails(root: HTMLElement): { email: string; context: string }[] {
  const out: { email: string; context: string }[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    const o = node as Record<string, unknown>;
    const emails = ([] as unknown[]).concat(o.email ?? []).filter((e): e is string => typeof e === 'string');
    if (emails.length) {
      const name = typeof o.name === 'string' ? o.name : [o.givenName, o.familyName].filter((x) => typeof x === 'string').join(' ');
      const job = typeof o.jobTitle === 'string' ? o.jobTitle : '';
      for (const e of emails) out.push({ email: e.replace(/^mailto:/i, ''), context: normalizeText(`${name} ${job}`) });
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  for (const sc of root.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(sc.text)); } catch { /* invalid JSON-LD is common; ignore */ }
  }
  for (const el of root.querySelectorAll('[itemprop="email"]')) {
    const raw = el.getAttribute('content') ?? el.getAttribute('href') ?? el.text;
    let scope: HTMLElement | null = el.parentNode as HTMLElement | null;
    while (scope && scope.parentNode && scope.getAttribute?.('itemscope') === undefined) scope = scope.parentNode as HTMLElement;
    const name = scope?.querySelector?.('[itemprop="name"]')?.text ?? '';
    out.push({ email: (raw ?? '').replace(/^mailto:/i, '').trim(), context: normalizeText(name) });
  }
  return out;
}

export function extractPage(html: string, url: string, opts: ExtractOptions = {}): PageExtraction {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  const structured = structuredEmails(root);

  const mailtos: { email: string; context: string }[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (!/^mailto:/i.test(href)) continue;
    let addr = href.slice(7).split('?')[0];
    try { addr = decodeURIComponent(addr); } catch { /* keep raw */ }
    // Link text is often just "Email"; the enclosing block carries the person's name.
    let block: HTMLElement | null = a.parentNode as HTMLElement | null;
    for (let up = 0; up < 3 && block?.parentNode && (block.structuredText ?? '').trim().length < 12; up++) block = block.parentNode as HTMLElement;
    mailtos.push({ email: addr, context: normalizeText(block?.structuredText ?? a.text ?? '').slice(0, 300) });
  }

  const text = deobfuscate(visibleText(root));
  const found = new Map<string, FoundEmail>();

  const consider = (raw: string, context: string, kind: 'text' | 'mailto' | 'structured') => {
    const email = normalizeText(raw).toLowerCase().replace(/^[.]+|[.]+$/g, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || ASSET_RE.test(email)) return;
    const [local, domain] = email.split('@');
    if (opts.domains?.length && !opts.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return;
    if (!opts.includeFreemail && FREEMAIL_DOMAINS.has(domain)) return; // never collect personal mailboxes
    const names = namesIn(context);
    const prev = found.get(email);
    if (prev) {
      // Same address seen again on the page: merge name evidence instead of duplicating.
      for (const n of names) if (!prev.namesNearby.some((p) => p.full === n.full)) prev.namesNearby.push(n);
      prev.viaMailto ||= kind === 'mailto';
      prev.structured ||= kind === 'structured';
      return;
    }
    found.set(email, {
      email, local, domain, url, context, namesNearby: names,
      isRole: ROLE_LOCALS.has(local.replace(/[0-9]+$/, '')), viaMailto: kind === 'mailto', structured: kind === 'structured',
    });
  };

  // Most explicit attribution first: structured data, then mailto blocks, then free text.
  for (const m of structured) consider(m.email, m.context, 'structured');
  for (const m of mailtos) consider(m.email, m.context, 'mailto');
  for (const m of text.matchAll(EMAIL_RE)) {
    const i = m.index ?? 0;
    consider(m[1], text.slice(Math.max(0, i - 160), i + m[1].length + 160), 'text');
  }
  const names = [...new Set([...text.matchAll(NAME_RE)].map((m) => m[1]))].slice(0, 300);
  return { emails: [...found.values()], names };
}

export function extractEmails(html: string, url: string, opts: ExtractOptions = {}): FoundEmail[] {
  return extractPage(html, url, opts).emails;
}

/** Same-site links whose text or URL contains the person's surname (e.g. /team/jane-smith). */
export function personLinks(html: string, baseUrl: string, domain: string, name: ParsedName, limit = 3): string[] {
  const last = token(name.last.split(/[\s-]+/).pop() ?? '');
  const first = token(name.first);
  if (last.length < 2) return [];
  const root = parse(html);
  const out: string[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    let u: URL;
    try { u = new URL(a.getAttribute('href') ?? '', baseUrl); } catch { continue; }
    const host = u.hostname.toLowerCase();
    if (!/^https?:$/.test(u.protocol) || !(host === domain || host.endsWith(`.${domain}`))) continue;
    const hay = token(`${u.pathname} ${a.text}`);
    if (hay.includes(last) && (!first || hay.includes(first))) {
      u.hash = '';
      if (!out.includes(u.toString())) out.push(u.toString());
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Same-site links that look like team/about/press/contact pages, best first. */
const LINK_HINTS = ['team', 'about', 'people', 'leadership', 'management', 'staff', 'contact', 'press', 'news',
  'media', 'company', 'who-we-are', 'our-team', 'board', 'directory', 'speakers', 'authors', 'founders', 'executives'];

export function teamPageLinks(html: string, baseUrl: string, domain: string, limit = 15): string[] {
  const root = parse(html);
  const scored = new Map<string, number>();
  for (const a of root.querySelectorAll('a[href]')) {
    let u: URL;
    try { u = new URL(a.getAttribute('href') ?? '', baseUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.toLowerCase();
    if (!(host === domain || host.endsWith(`.${domain}`))) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?|mp4|svg)$/i.test(u.pathname)) continue;
    u.hash = '';
    const hay = `${u.pathname} ${a.text ?? ''}`.toLowerCase();
    const score = LINK_HINTS.reduce((n, h) => n + (hay.includes(h) ? 1 : 0), 0);
    if (score) scored.set(u.toString(), Math.max(scored.get(u.toString()) ?? 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, limit);
}

/** <title> and og:site_name, for checking that a homepage belongs to the company. */
export function pageTitle(html: string): string {
  const root = parse(html);
  const title = normalizeText(root.querySelector('title')?.text ?? '');
  const site = root.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? '';
  return [title, normalizeText(site)].filter(Boolean).join(' | ');
}

/** URLs from a sitemap.xml that look like team/about pages. */
export function sitemapTeamUrls(xml: string, domain: string, limit = 10): string[] {
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  return urls
    .filter((u) => { try { const h = new URL(u).hostname; return h === domain || h.endsWith(`.${domain}`); } catch { return false; } })
    .filter((u) => LINK_HINTS.some((h) => new URL(u).pathname.toLowerCase().includes(h)))
    .slice(0, limit);
}
