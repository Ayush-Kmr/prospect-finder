// Email pattern generation and DNS (MX) checks. No paid services needed.

export const DEFAULT_PATTERNS = [
  '{first}.{last}', '{f}{last}', '{first}', '{first}{last}', '{first}_{last}',
  '{f}.{last}', '{first}{l}', '{last}.{first}', '{last}{f}', '{last}',
];

const PATTERN_RE = /^(\{(first|last|f|l)\}|[._-])+$/;

export function normalizeName(s = '') {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export function applyPattern(pattern, first, last, domain) {
  const f = normalizeName(first);
  const l = normalizeName(last);
  if (!PATTERN_RE.test(pattern)) return null;
  if (pattern.includes('{first}') || pattern.includes('{f}')) { if (!f) return null; }
  if (pattern.includes('{last}') || pattern.includes('{l}')) { if (!l) return null; }
  const local = pattern
    .replace(/\{first\}/g, f)
    .replace(/\{last\}/g, l)
    .replace(/\{f\}/g, f[0] || '')
    .replace(/\{l\}/g, l[0] || '');
  return local ? `${local}@${domain}` : null;
}

const EXTRA_PATTERNS = ['{first}-{last}', '{f}_{last}', '{first}.{l}', '{f}{l}', '{last}_{first}', '{last}{first}', '{first}{last}{l}'];

// Which pattern produced this real address? e.g. ('jane.doe@acme.com', 'Jane', 'Doe') -> '{first}.{last}'.
export function patternFromExample(email, first, last) {
  const [local, domain] = String(email).toLowerCase().split('@');
  if (!local || !domain) return null;
  return [...DEFAULT_PATTERNS, ...EXTRA_PATTERNS].find((p) => applyPattern(p, first, last, domain) === `${local}@${domain}`) || null;
}

// Ordered, de-duplicated candidates. Patterns seen in real published addresses win,
// then `knownPattern` (Hunter), then Claude's ranking, then generic defaults.
export function candidateEmails({ first, last, domain, knownPattern, evidencePatterns = [], llmPatterns = [] }) {
  const seen = new Set();
  const out = [];
  const push = (pattern, basis, confidence) => {
    const email = applyPattern(pattern, first, last, domain);
    if (email && !seen.has(email)) {
      seen.add(email);
      out.push({ value: email, pattern, basis, confidence });
    }
  };
  for (const e of evidencePatterns) {
    push(e.pattern, `company format seen in ${e.count} published address${e.count > 1 ? 'es' : ''}`, e.confidence ?? (e.count > 1 ? 0.85 : 0.75));
  }
  if (knownPattern) push(knownPattern, 'company pattern (Hunter)', 0.6);
  llmPatterns.slice(0, 5).forEach((p, i) => push(p, 'Claude-ranked pattern', Math.max(0.15, 0.4 - i * 0.06)));
  DEFAULT_PATTERNS.forEach((p) => push(p, 'common pattern', 0.1));
  return out;
}

export function cleanDomain(d = '') {
  return d.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/^.*@/, '');
}

// DNS-over-HTTPS MX lookup. Returns [] when the domain cannot receive mail.
export async function mxRecords(domain, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: 'application/dns-json' } },
    );
    const body = await res.json();
    return (body.Answer || [])
      .filter((a) => a.type === 15)
      .map((a) => a.data.split(' ').pop().replace(/\.$/, '').toLowerCase());
  } catch {
    return [];
  }
}

export function mailHost(mx = []) {
  const s = mx.join(' ');
  if (/google\.com|googlemail\.com/.test(s)) return 'Google Workspace';
  if (/outlook\.com|microsoft\.com/.test(s)) return 'Microsoft 365';
  if (/pphosted|mimecast|barracuda|messagelabs|iphmx/.test(s)) return 'Security gateway';
  return mx.length ? 'Other' : 'None';
}
