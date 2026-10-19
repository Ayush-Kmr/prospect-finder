// Domain helpers: canonicalization, registrable domain, directory/lookalike filtering.
import { token } from './normalization';

const TWO_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'co.jp', 'com.br', 'co.nz',
  'com.sg', 'com.mx', 'co.za', 'com.cn', 'com.hk', 'co.kr', 'com.tr', 'com.ar', 'co.il', 'com.my', 'com.ph',
]);

/** Sites that describe companies but are never a company's own domain. */
export const DIRECTORY_DOMAINS = new Set([
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'tiktok.com',
  'wikipedia.org', 'wikidata.org', 'wikimedia.org', 'crunchbase.com', 'glassdoor.com', 'indeed.com',
  'bloomberg.com', 'zoominfo.com', 'apollo.io', 'rocketreach.co', 'signalhire.com', 'lusha.com', 'pitchbook.com',
  'dnb.com', 'owler.com', 'craft.co', 'github.com', 'medium.com', 'reddit.com', 'quora.com', 'yelp.com',
  'trustpilot.com', 'g2.com', 'capterra.com', 'builtin.com', 'wellfound.com', 'angel.co', 'ycombinator.com',
  'theorg.com', 'comparably.com', 'contactout.com', 'hunter.io', 'clearbit.com', 'duckduckgo.com', 'google.com',
  'bing.com', 'yahoo.com', 'apple.com', 'amazon.com', 'blogspot.com', 'wordpress.com', 'wix.com', 'squarespace.com',
]);

export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'zoho.com', 'yandex.com', 'mail.com', 'qq.com',
  '163.com', 'web.de', 'msn.com',
]);

const TRACKING_PARAMS = /^(utm_|gclid$|fbclid$|mc_|msclkid$|ref$|ref_src$|trk$|_hs)/i;
const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'sa',
  'plc', 'pvt', 'private', 'group', 'holdings', 'the', 'and', 'bv', 'srl', 'oy', 'ab', 'as', 'kk', 'pte', 'lp', 'llp',
]);

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length >= 3 && TWO_LEVEL.has(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

/** Accepts "Example.com", "https://www.example.com/careers?utm_x=1", "jane@example.com". */
export function canonicalDomain(input: string): string | null {
  let s = (input ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop()!;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.') || u.hostname.startsWith('xn--') || u.hostname.includes('.xn--')) return null;
    if (!/^[a-z0-9.-]+$/.test(u.hostname)) return null;
    return registrableDomain(u.hostname);
  } catch {
    return null;
  }
}

/** Drop fragments and tracking parameters. */
export function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

export function isDirectoryDomain(domain: string): boolean {
  return DIRECTORY_DOMAINS.has(registrableDomain(domain));
}

export function sameSite(url: string, domain: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function companyTokens(company: string): string[] {
  return (company ?? '')
    .split(/[\s,.&/+()-]+/)
    .map((t) => token(t))
    .filter((t) => t && !COMPANY_SUFFIXES.has(t));
}

/**
 * 0..1 similarity between a company name and a domain's first label.
 * 1 = exact ("Example Technologies" vs exampletechnologies.com or example.com when tokens[0] is distinctive).
 */
export function nameDomainSimilarity(company: string, domain: string): number {
  const toks = companyTokens(company);
  if (!toks.length) return 0;
  const label = token(domain.split('.')[0]);
  const joined = toks.join('');
  if (label === joined) return 1;
  if (label === toks[0] && toks[0].length >= 4) return 0.85;
  if (joined.startsWith(label) && label.length >= 4) return 0.75;
  if (label.startsWith(joined)) return 0.7; // e.g. examplehq.com
  if (toks.length >= 2 && label === toks.map((t) => t[0]).join('')) return 0.5; // acronym
  if (label.includes(toks[0]) && toks[0].length >= 4) return 0.45;
  return 0;
}

/**
 * Lookalike guard: the label contains the company name plus a suspicious decoration,
 * or differs from the expected label by a single character (typosquat).
 */
export function isLookalike(company: string, domain: string): boolean {
  const toks = companyTokens(company);
  if (!toks.length) return false;
  const label = token(domain.split('.')[0]);
  const joined = toks.join('');
  if (label !== joined && /(login|secure|verify|support|account|mail|official|online)$/.test(label) && label.includes(joined)) return true;
  return label.length >= 5 && label !== joined && levenshtein(label, joined) === 1;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function heuristicDomains(company: string): string[] {
  const toks = companyTokens(company);
  if (!toks.length) return [];
  const joined = toks.join('');
  const out = [`${joined}.com`, `${joined}.io`, `${joined}.co`, `${joined}.ai`];
  if (toks.length > 1) out.push(`${toks.join('-')}.com`, `${toks[0]}.com`, `${toks[0]}${toks[1]}.com`);
  return [...new Set(out)];
}
