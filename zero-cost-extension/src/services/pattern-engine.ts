// Deterministic corporate email pattern engine (no AI).
// Tokens: {first} {last} {f} {l} {m} (middle initial). Separators: . _ -
import { spellings, surnameForms, token, type ParsedName } from '../utils/normalization';

export const PATTERNS = [
  '{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{first}_{last}', '{f}.{last}', '{first}{l}',
  '{first}.{l}', '{last}.{first}', '{last}{first}', '{last}{f}', '{last}', '{first}-{last}', '{f}{m}{last}',
  '{first}.{m}.{last}', '{last}_{first}', '{f}_{last}', '{last}.{f}',
] as const;
export type Pattern = (typeof PATTERNS)[number];

/** Human-readable label: "{first}.{last}" -> "firstname.lastname" */
export function describePattern(p: string): string {
  return p.replace('{first}', 'firstname').replace('{last}', 'lastname').replace('{f}', 'f').replace('{l}', 'l').replace('{m}', 'm');
}

// Prior order when no company convention is observed (approximate prevalence in B2B email).
export const PRIOR: Pattern[] = ['{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{f}.{last}', '{first}_{last}', '{first}{l}'];

interface NameForms { firsts: string[]; lasts: string[]; middleInitial: string }

function forms(name: ParsedName): NameForms {
  return {
    firsts: spellings(name.first),
    lasts: surnameForms(name),
    middleInitial: name.middle.length ? token(name.middle[0]).slice(0, 1) : '',
  };
}

function renderWith(p: string, first: string, last: string, m: string): string | null {
  if ((p.includes('{first}') || p.includes('{f}')) && !first) return null;
  if ((p.includes('{last}') || p.includes('{l}')) && !last) return null;
  if (p.includes('{m}') && !m) return null;
  const local = p.replace('{first}', first).replace('{last}', last).replace('{f}', first[0] ?? '')
    .replace('{l}', last[0] ?? '').replace('{m}', m);
  return local.replace(/[^a-z0-9._-]/g, '') || null;
}

/** Primary rendering of a pattern for a name. */
export function render(p: string, name: ParsedName): string | null {
  const f = forms(name);
  return renderWith(p, f.firsts[0] ?? '', f.lasts[0] ?? '', f.middleInitial);
}

/** Every rendering across spelling/surname variants (primary first). */
export function renderVariants(p: string, name: ParsedName): string[] {
  const f = forms(name);
  const out: string[] = [];
  for (const first of f.firsts.length ? f.firsts : ['']) {
    for (const last of f.lasts.length ? f.lasts : ['']) {
      const r = renderWith(p, first, last, f.middleInitial);
      if (r && !out.includes(r)) out.push(r);
    }
  }
  return out;
}

/** Which pattern produced `local` for this name (null if none). */
export function matchPattern(local: string, name: ParsedName): Pattern | null {
  const l = local.toLowerCase();
  for (const p of PATTERNS) if (renderVariants(p, name).includes(l)) return p;
  return null;
}

/** Weak hint from the shape of a local part when no name is attached. */
export function structuralGuess(local: string): Pattern | null {
  if (/\d/.test(local)) return null;
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) return '{first}.{last}';
  if (/^[a-z]\.[a-z]{2,}$/.test(local)) return '{f}.{last}';
  if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) return '{first}_{last}';
  if (/^[a-z]{2,}-[a-z]{2,}$/.test(local)) return '{first}-{last}';
  return null;
}

export interface Sample { local: string; name: ParsedName | null; url: string }
export interface Convention {
  pattern: Pattern;
  exactSupport: number;      // published addresses whose owner's name is known and matches
  structuralSupport: number; // addresses whose shape suggests the pattern
  share: number;             // weighted share of all evidence (0..1)
  examples: { local: string; url: string }[];
}

export function inferConventions(samples: Sample[]): { conventions: Convention[]; conflicting: boolean } {
  const map = new Map<Pattern, Convention>();
  const seen = new Set<string>();
  for (const s of samples) {
    if (seen.has(s.local)) continue;
    seen.add(s.local);
    let p: Pattern | null = null;
    let exact = false;
    if (s.name) { p = matchPattern(s.local, s.name); exact = !!p; }
    if (!p) p = structuralGuess(s.local);
    if (!p) continue;
    const c = map.get(p) ?? { pattern: p, exactSupport: 0, structuralSupport: 0, share: 0, examples: [] };
    if (exact) c.exactSupport++; else c.structuralSupport++;
    if (c.examples.length < 5) c.examples.push({ local: s.local, url: s.url });
    map.set(p, c);
  }
  const weight = (c: Convention) => 3 * c.exactSupport + c.structuralSupport;
  const total = [...map.values()].reduce((a, c) => a + weight(c), 0);
  const conventions = [...map.values()]
    .map((c) => ({ ...c, share: total ? weight(c) / total : 0 }))
    .sort((a, b) => b.share - a.share);
  const conflicting = conventions.length > 1 && conventions[1].exactSupport > 0 && conventions[0].share - conventions[1].share < 0.25;
  return { conventions, conflicting };
}

export interface GeneratedCandidate { local: string; pattern: Pattern; variant: boolean }

/** Candidates for the person: observed conventions first, then the prior, then the rest. */
export function generateCandidates(name: ParsedName, conventions: Convention[], limit = 10): GeneratedCandidate[] {
  const order: Pattern[] = [...conventions.map((c) => c.pattern)];
  for (const p of [...PRIOR, ...PATTERNS]) if (!order.includes(p)) order.push(p);
  const out: GeneratedCandidate[] = [];
  const seen = new Set<string>();
  for (const p of order) {
    renderVariants(p, name).forEach((local, i) => {
      if (!seen.has(local)) { seen.add(local); out.push({ local, pattern: p, variant: i > 0 }); }
    });
  }
  // Primary renderings before spelling variants, preserving pattern order.
  return [...out.filter((c) => !c.variant), ...out.filter((c) => c.variant)].slice(0, limit);
}
