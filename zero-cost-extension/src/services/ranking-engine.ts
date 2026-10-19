// Deterministic, explainable ranking. Scores measure how well a candidate is
// supported by evidence found in this lookup; they are NOT the probability
// that a mailbox exists.
import type { ResolvedDomain } from './company-resolver';
import type { FoundEmail } from './email-extractor';
import {
  describePattern, generateCandidates, inferConventions, matchPattern, PRIOR, type Convention, type Pattern,
} from './pattern-engine';
import { sameSite } from '../utils/domain';
import { parseFullName, surnameForms, token, type ParsedName } from '../utils/normalization';

export type Status = 'PUBLICLY_CONFIRMED' | 'PATTERN_SUPPORTED' | 'PREDICTED' | 'DOMAIN_VALID_ONLY' | 'UNVERIFIED' | 'NOT_FOUND';

export const STATUS_TEXT: Record<Status, string> = {
  PUBLICLY_CONFIRMED: 'Publicly confirmed — published on a public page',
  PATTERN_SUPPORTED: 'Pattern-supported — mailbox not verified',
  PREDICTED: 'Predicted — mailbox not verified',
  DOMAIN_VALID_ONLY: 'Domain valid only — mailbox not verified',
  UNVERIFIED: 'Unverified — domain could not be checked',
  NOT_FOUND: 'Not found',
};

/** Explicit weights (points). Shown in the evidence panel. */
export const WEIGHTS = {
  exactPublished: 45,        // the exact address appears on a public page
  nameAdjacent: 20,          // ... next to the person's full name
  officialSource: 10,        // ... on the company's own site
  extraSource: 5,            // each additional independent page (max 2)
  conventionMax: 35,         // matches the company's observed format (scaled by support and share)
  conventionConsistent: 5,   // a published address that also fits the observed format
  priorTop: 12,              // common-format prior for the most common format, decreasing
  domainHigh: 10,
  domainMedium: 5,
  mx: 5,
  noMx: -25,
  conflictingConvention: -10,
  conflictingPublished: -10,
  conflictingDomain: -10,
  spellingVariant: -5,
  incompleteName: -15,
} as const;

export interface Signal { label: string; points: number }
export interface EvidenceLink { url: string; snippet: string }

export interface RankedCandidate {
  email: string;
  status: Status;
  score: number;
  strength: 'Strong' | 'Moderate' | 'Weak' | 'Very weak';
  signals: Signal[];
  explanation: string;
  evidence: EvidenceLink[];
  pattern: Pattern | null;
}

export interface RankingInput {
  name: ParsedName;
  domain: ResolvedDomain;
  mailDomain: string | null;
  mx: string[];
  dnsOk: boolean;
  emails: FoundEmail[];
  /** Names seen anywhere on each page (url -> names), to attribute staff addresses on grid layouts. */
  pageNames?: Record<string, string[]>;
}

export type Outcome = 'confirmed' | 'pattern' | 'prediction' | 'unverified' | 'none';

export interface RankingResult {
  outcome: Outcome;
  /** One-line, honest summary for the UI. */
  summary: string;
  candidates: RankedCandidate[];
  conventions: Convention[];
  conflictingConvention: boolean;
  genericOnly: string[]; // role addresses seen (never used as the person's email)
  notes: string[];
}

function strength(score: number): RankedCandidate['strength'] {
  return score >= 80 ? 'Strong' : score >= 55 ? 'Moderate' : score >= 30 ? 'Weak' : 'Very weak';
}

function finalize(c: Omit<RankedCandidate, 'score' | 'strength'>): RankedCandidate {
  const score = Math.max(0, Math.min(100, c.signals.reduce((a, s) => a + s.points, 0)));
  return { ...c, score, strength: strength(score) };
}

/** Is this published address attributable to the person? */
function attributable(f: FoundEmail, name: ParsedName): { ok: boolean; adjacent: boolean; pattern: Pattern | null } {
  const adjacent = f.namesNearby.some((n) => token(n.first) === token(name.first) && token(n.last) === token(name.last));
  const pattern = name.first && name.last ? matchPattern(f.local, name) : null;
  // A bare "{first}" or "{last}" address is only attributable when printed next to the full name.
  if (pattern && pattern !== '{first}' && pattern !== '{last}') return { ok: true, adjacent, pattern };
  if (pattern && adjacent) return { ok: true, adjacent, pattern };
  if (adjacent && surnameForms(name).some((s) => s.length >= 3 && f.local.includes(s))) return { ok: true, adjacent, pattern: null };
  return { ok: false, adjacent, pattern: null };
}

function isPerson(n: ParsedName, person: ParsedName) {
  return token(n.first) === token(person.first) && token(n.last) === token(person.last);
}

/** Whose address is this? Nearby names first, then any name on the same page. */
function ownerName(f: FoundEmail, person: ParsedName, pageNames: string[]): ParsedName | null {
  for (const n of f.namesNearby) if (!isPerson(n, person) && matchPattern(f.local, n)) return n;
  for (const raw of pageNames) {
    const n = parseFullName(raw);
    if (n.first && n.last && !isPerson(n, person) && matchPattern(f.local, n)) return n;
  }
  return null;
}

export function rank(input: RankingInput): RankingResult {
  const { name, domain, mailDomain, mx, dnsOk } = input;
  const notes: string[] = [];
  const relevantDomain = mailDomain ?? domain.domain;
  if (!relevantDomain) return { outcome: 'none', summary: 'No company email domain could be established.', candidates: [], conventions: [], conflictingConvention: false, genericOnly: [], notes: ['No company email domain.'] };

  const atDomain = input.emails.filter((e) => e.domain === relevantDomain || e.domain.endsWith(`.${relevantDomain}`));
  const genericOnly = [...new Set(atDomain.filter((e) => e.isRole).map((e) => e.email))];
  const personal = atDomain.filter((e) => !e.isRole);

  // 1. Published addresses for this person
  const confirmed = new Map<string, { finds: FoundEmail[]; adjacent: boolean; pattern: Pattern | null }>();
  const samples: { local: string; name: ParsedName | null; url: string }[] = [];
  for (const f of personal) {
    const a = attributable(f, name);
    if (a.ok) {
      const c = confirmed.get(f.email) ?? { finds: [], adjacent: false, pattern: a.pattern };
      c.finds.push(f);
      c.adjacent ||= a.adjacent;
      confirmed.set(f.email, c);
    } else {
      samples.push({ local: f.local, name: ownerName(f, name, input.pageNames?.[f.url] ?? []), url: f.url });
    }
  }

  // 2. Company convention from other published staff addresses
  const { conventions, conflicting } = inferConventions(samples);
  const conventionOf = (p: Pattern | null) => conventions.find((c) => c.pattern === p);
  const conventionPoints = (c: Convention) =>
    Math.round(WEIGHTS.conventionMax * Math.min(1, (c.exactSupport + 0.5 * c.structuralSupport) / 3) * c.share);

  const domainSignals = (): Signal[] => {
    const s: Signal[] = [];
    if (domain.confidence === 'high') s.push({ label: `Company domain ${domain.domain} confirmed by independent sources`, points: WEIGHTS.domainHigh });
    else if (domain.confidence === 'medium') s.push({ label: `Company domain ${domain.domain} is likely but not fully confirmed`, points: WEIGHTS.domainMedium });
    else s.push({ label: `Company domain ${domain.domain} is uncertain`, points: 0 });
    if (domain.conflicting) s.push({ label: 'Several plausible company domains', points: WEIGHTS.conflictingDomain });
    if (!dnsOk) s.push({ label: 'DNS check unavailable (offline or DNS error)', points: 0 });
    else if (mx.length) s.push({ label: `${relevantDomain} accepts email (MX records found)`, points: WEIGHTS.mx });
    else s.push({ label: `${relevantDomain} has no MX records`, points: WEIGHTS.noMx });
    return s;
  };

  const out: RankedCandidate[] = [];
  for (const [email, c] of confirmed) {
    const pages = [...new Set(c.finds.map((f) => f.url))];
    const official = pages.some((u) => domain.domain && sameSite(u, domain.domain));
    const signals: Signal[] = [{ label: `Exact address published on ${pages.length} public page(s)`, points: WEIGHTS.exactPublished }];
    if (c.adjacent) signals.push({ label: "Published next to the person's full name", points: WEIGHTS.nameAdjacent });
    else signals.push({ label: `Address matches the person's name (${describePattern(c.pattern ?? '')})`, points: 10 });
    if (official) signals.push({ label: "Found on the company's own website", points: WEIGHTS.officialSource });
    if (pages.length > 1) signals.push({ label: `${pages.length - 1} additional independent source(s)`, points: Math.min(2, pages.length - 1) * WEIGHTS.extraSource });
    const conv = conventionOf(c.pattern);
    if (conv && conv.exactSupport + conv.structuralSupport > 0) signals.push({ label: 'Also consistent with the company\'s observed email format', points: WEIGHTS.conventionConsistent });
    if (confirmed.size > 1) signals.push({ label: `${confirmed.size - 1} other published address(es) also match this person`, points: WEIGHTS.conflictingPublished });
    signals.push(...domainSignals().filter((s) => s.points >= 0 || s.label.includes('MX')));
    out.push(finalize({
      email, status: 'PUBLICLY_CONFIRMED', signals, pattern: c.pattern,
      evidence: c.finds.map((f) => ({ url: f.url, snippet: f.context.slice(0, 240) })),
      explanation: `Published on ${pages.length === 1 ? 'a public page' : `${pages.length} public pages`}${c.adjacent ? " next to the person's name" : ''}. Mailbox delivery not tested.`,
    }));
  }

  // 3. Predictions (always offered as alternatives; never labelled confirmed)
  if (!name.first) {
    notes.push('A first name is needed to generate candidates.');
  } else {
    if (!name.last) notes.push('Only a single name is known; predictions are limited.');
    const confirmedSet = new Set(out.map((c) => c.email));
    generateCandidates(name, conventions, 8).forEach((g) => {
      const email = `${g.local}@${relevantDomain}`;
      if (confirmedSet.has(email)) return;
      const conv = conventionOf(g.pattern);
      const supported = !!conv && (conv.exactSupport >= 1 || conv.structuralSupport >= 2);
      const signals: Signal[] = [];
      if (conv) {
        const n = conv.exactSupport + conv.structuralSupport;
        signals.push({ label: `Matches the company format ${describePattern(g.pattern)} seen in ${n} published address(es)`, points: conventionPoints(conv) });
      } else {
        const idx = PRIOR.indexOf(g.pattern);
        signals.push({ label: `Common corporate format ${describePattern(g.pattern)}`, points: idx >= 0 ? Math.max(2, WEIGHTS.priorTop - 2 * idx) : 1 });
      }
      if (conflicting && conv) signals.push({ label: 'The company uses more than one format', points: WEIGHTS.conflictingConvention });
      if (g.variant) signals.push({ label: 'Alternative spelling of the name', points: WEIGHTS.spellingVariant });
      if (!name.last && /\{last\}|\{l\}/.test(g.pattern)) return;
      if (!name.last) signals.push({ label: 'Surname unknown', points: WEIGHTS.incompleteName });
      signals.push(...domainSignals());

      let status: Status;
      if (!dnsOk || !mx.length) status = 'UNVERIFIED';
      else if (supported) status = 'PATTERN_SUPPORTED';
      else if (domain.confidence === 'high' || domain.confidence === 'medium') status = 'PREDICTED';
      else status = 'DOMAIN_VALID_ONLY';

      const evidence = conv ? conv.examples.map((e) => ({ url: e.url, snippet: `Published staff address following ${describePattern(conv.pattern)}` })) : [];
      const n = conv ? conv.exactSupport + conv.structuralSupport : 0;
      const explanation = supported
        ? `Matches the corporate naming format observed in ${n} published company contact${n === 1 ? '' : 's'}. Individual mailbox not verified.`
        : status === 'UNVERIFIED'
          ? `Common format, but ${dnsOk ? `${relevantDomain} has no mail server` : 'DNS could not be checked'}. Not verified.`
          : `No company format was observed; this uses a common corporate format. Individual mailbox not verified.`;
      out.push(finalize({ email, status, signals, evidence, explanation, pattern: g.pattern }));
    });
  }

  const order: Record<Status, number> = { PUBLICLY_CONFIRMED: 0, PATTERN_SUPPORTED: 1, PREDICTED: 2, DOMAIN_VALID_ONLY: 3, UNVERIFIED: 4, NOT_FOUND: 5 };
  out.sort((a, b) => order[a.status] - order[b.status] || b.score - a.score);
  if (genericOnly.length && !confirmed.size) notes.push(`Only generic addresses were published (${genericOnly.slice(0, 3).join(', ')}); they are not used as the person's email.`);

  const best = out[0];
  let outcome: Outcome = 'none';
  let summary = 'No email could be found or predicted.';
  if (best?.status === 'PUBLICLY_CONFIRMED') {
    outcome = 'confirmed';
    summary = confirmed.size > 1
      ? 'Several published addresses match this person; check the sources.'
      : 'Publicly published address found for this person.';
  } else if (best?.status === 'PATTERN_SUPPORTED') {
    outcome = 'pattern';
    summary = 'No publicly confirmed email found. Best prediction follows the company\'s observed email format (not verified).';
  } else if (best && (best.status === 'PREDICTED' || best.status === 'DOMAIN_VALID_ONLY')) {
    outcome = 'prediction';
    summary = 'No publicly confirmed email and no company email format found. Best guess uses a common format (not verified).';
  } else if (best) {
    outcome = 'unverified';
    summary = dnsOk ? `${relevantDomain} has no mail server; these guesses are unlikely to work.` : 'DNS validation failed (offline?); guesses could not be checked.';
  }
  return { outcome, summary, candidates: out, conventions, conflictingConvention: conflicting, genericOnly, notes };
}
