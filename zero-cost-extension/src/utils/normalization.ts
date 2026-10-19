// Name and text normalization. Pure functions, no I/O.

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'rev']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'md', 'cpa', 'pe', 'esq']);
// Lowercase particles that belong to the surname: "Ludwig van Beethoven" -> last "van Beethoven".
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'dos', 'das', 'ter', 'ten', 'bin', 'al', 'st']);

// Common transliterations; each maps to a primary and (optionally) a secondary spelling.
const TRANSLIT: Record<string, [string, string?]> = {
  ä: ['a', 'ae'], ö: ['o', 'oe'], ü: ['u', 'ue'], ß: ['ss'], æ: ['ae'], ø: ['o', 'oe'], å: ['a', 'aa'],
  œ: ['oe'], ł: ['l'], đ: ['d'], ð: ['d'], þ: ['th'], ı: ['i'],
};

export interface ParsedName {
  full: string;
  first: string;
  middle: string[];
  last: string;        // full surname as written ("van der Berg", "García-López")
  lastParts: string[]; // ["van", "der", "berg"] / ["garcia", "lopez"]
}

export function normalizeText(s: string): string {
  return (s ?? '').normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/** Strip accents and transliterate; `variant` 1 uses secondary spellings (ü -> ue). */
export function asciiFold(s: string, variant: 0 | 1 = 0): string {
  let out = '';
  for (const ch of (s ?? '').toLowerCase()) {
    const t = TRANSLIT[ch];
    out += t ? (variant === 1 && t[1] ? t[1] : t[0]) : ch;
  }
  return out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Lowercase a–z only. */
export function token(s: string, variant: 0 | 1 = 0): string {
  return asciiFold(s, variant).replace(/[^a-z]/g, '');
}

export function stripDecorations(raw: string): string {
  return normalizeText(raw)
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]|"[^"]*"|“[^”]*”/g, ' ') // (she/her), [nickname], "Bobby"
    .replace(/\s*[|•·–—].*$/, '')                          // "Jane Smith | Recruiter"
    .replace(/,.*$/, '')                                   // "Jane Smith, SHRM-CP"
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFullName(raw: string): ParsedName {
  const cleaned = stripDecorations(raw);
  let words = cleaned.split(' ').filter((w) => token(w));
  while (words.length && HONORIFICS.has(token(words[0]))) words = words.slice(1);
  while (words.length > 1 && SUFFIXES.has(token(words[words.length - 1]))) words = words.slice(0, -1);
  if (!words.length) return { full: '', first: '', middle: [], last: '', lastParts: [] };
  if (words.length === 1) return { full: words[0], first: words[0], middle: [], last: '', lastParts: [] };

  const first = words[0];
  // Surname starts at the first particle after the given name, else it's the final word.
  let lastStart = words.length - 1;
  for (let i = 1; i < words.length - 1; i++) {
    if (PARTICLES.has(words[i].toLowerCase())) { lastStart = i; break; }
  }
  const middle = words.slice(1, lastStart);
  const last = words.slice(lastStart).join(' ');
  const lastParts = last.split(/[\s-]+/).map((p) => token(p)).filter(Boolean);
  return { full: words.join(' '), first, middle, last, lastParts };
}

/** Distinct ASCII spellings of a name part (primary first). "Jean-Luc" -> jeanluc, jean-luc, jean. */
export function spellings(s: string): string[] {
  const out: string[] = [];
  for (const v of [0, 1] as const) {
    out.push(token(s, v));
    if (/-/.test(s)) {
      const parts = s.split('-').map((x) => token(x, v)).filter(Boolean);
      out.push(parts.join('-'), parts[0]);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Surname forms used in email local parts, primary first:
 * "García-López" -> garcialopez, garcia-lopez, lopez, garcia; "van der Berg" -> vanderberg, berg.
 * With a middle name, the middle+last compound and the middle name alone are added last
 * (Spanish/Portuguese double surnames: "José Luis García Márquez" -> garciamarquez, garcia).
 */
export function surnameForms(p: ParsedName): string[] {
  if (!p.lastParts.length) return [];
  const forms: string[] = [];
  for (const v of [0, 1] as const) {
    const parts = p.last.split(/[\s-]+/).map((x) => token(x, v)).filter(Boolean);
    forms.push(parts.join(''));
    if (parts.length > 1) {
      if (/-/.test(p.last)) forms.push(parts.join('-'));
      const nonParticle = parts.filter((x) => !PARTICLES.has(x));
      forms.push(nonParticle[nonParticle.length - 1], nonParticle[0]);
    }
  }
  if (p.middle.length) {
    const m = token(p.middle[p.middle.length - 1]);
    if (m.length > 1) forms.push(m + token(p.last), m);
  }
  return [...new Set(forms.filter(Boolean))];
}

export function namesMatch(a: string, b: string): boolean {
  const pa = parseFullName(a);
  const pb = parseFullName(b);
  return !!pa.first && !!pb.first && token(pa.first) === token(pb.first) && token(pa.last) === token(pb.last);
}
