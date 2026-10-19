// Turn a profile snapshot (or manual input) into a normalized identity.
import type { ExperienceEntry, ProfileSnapshot } from '../content/profile-reader';
import { normalizeText, parseFullName, type ParsedName } from '../utils/normalization';

export interface Identity {
  name: ParsedName;
  company: string;
  title: string;
  linkedinUrl: string | null;
  companyLinkedInUrl: string | null;
  source: 'profile' | 'manual';
  /** Other plausible current employers the user can switch to. */
  companyOptions: string[];
  /** True once the user edited the fields; re-reading the profile won't overwrite them. */
  edited?: boolean;
  notes: string[];
}

export interface Role { title: string; company: string; current: boolean; dates: string; companyHref: string }

const EMPLOYMENT = /\s*·\s*(full-time|part-time|contract|contractor|self-employed|freelance|internship|apprenticeship|seasonal|temporary|permanent|vollzeit|teilzeit|temps plein|cdi|cdd).*$/i;
const NOT_A_COMPANY = /^(self[- ]employed|freelance(r)?|stealth( mode)?( startup)?|confidential|independent( consultant)?|retired|open to work|career break|various|n\/a)$/i;
const PRESENT_RE = /\b(present|current|now|heute|aujourd[’']hui|presente|atual|actualidad|oggi|heden|obecnie|nu)\b/i;
const MONTHS = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|janv|févr|mars|avr|mai|juin|juil|août|sept|déc|ene|abr|ago|dic|mär|okt|dez)[a-zé.]*';
const DATE_LINE_RE = new RegExp(`((${MONTHS}\\s+)?(19|20)\\d{2}|\\b\\d{1,2}/(19|20)\\d{2})\\s*[-–—]|\\b(19|20)\\d{2}\\s*[-–—]\\s*(${PRESENT_RE.source}|(19|20)\\d{2})|\\d+\\s*(yrs?|mos?|years?|months?)\\b`, 'i');

export const isDateLine = (l: string) => DATE_LINE_RE.test(l);
/** A date range with a year ("Jun 2023 - Present"), as opposed to a bare duration ("3 yrs 4 mos"). */
const isDateRange = (l: string) => isDateLine(l) && /(19|20)\d{2}/.test(l);

export function cleanCompany(raw: string): string {
  return normalizeText(raw).replace(EMPLOYMENT, '').replace(/\s*·.*$/, '').replace(/\s*\((acquired|formerly|now)\b.*\)$/i, '').trim();
}

/** "Technical Recruiter at Example Technologies | Hiring" -> { title, company } */
export function splitHeadline(headline: string): { title: string; company: string } {
  const h = normalizeText(headline).split(/\s+[|•]\s+/)[0];
  const m = h.match(/^(.*?)\s+(?:at|@|bei|chez|en|na|presso)\s+(.+)$/i);
  if (m) return { title: m[1].trim(), company: cleanCompany(m[2]) };
  return { title: h, company: '' };
}

/** Interpret Experience entries (single role or company with nested roles). */
export function parseExperience(entries: ExperienceEntry[]): Role[] {
  const roles: Role[] = [];
  for (const e of entries) {
    // Nested items are roles only if they carry dates (otherwise they're descriptions/skills).
    const subRoles = e.sub.filter((s) => s.some(isDateLine));
    if (subRoles.length && !e.lines.slice(0, 3).some(isDateRange)) {
      // Grouped: first line is the company, nested items are roles.
      const company = cleanCompany(e.lines[0] ?? '');
      for (const s of subRoles) {
        const dates = s.find(isDateLine) ?? '';
        roles.push({ title: normalizeText(s[0] ?? ''), company, current: PRESENT_RE.test(dates), dates, companyHref: e.companyHref });
      }
    } else {
      const lines = e.lines;
      const dates = lines.find(isDateLine) ?? '';
      const second = lines[1] ?? '';
      const company = second && !isDateLine(second) ? cleanCompany(second) : '';
      roles.push({ title: normalizeText(lines[0] ?? ''), company, current: PRESENT_RE.test(dates), dates, companyHref: e.companyHref });
    }
  }
  return roles;
}

export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : null;
}

function nameFromTitle(pageTitle: string): string {
  // "(3) Jane Smith | LinkedIn" / "Jane Smith - Technical Recruiter - Example | LinkedIn"
  const t = pageTitle.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '');
  return t.split(/\s+[-–|]\s+/)[0]?.trim() ?? '';
}

export function identityFromSnapshot(s: ProfileSnapshot): Identity {
  const notes: string[] = [];
  const rawName = s.name || nameFromTitle(s.pageTitle);
  if (!s.name && rawName) notes.push('Name taken from the page title; please confirm.');
  if (!rawName) notes.push('Name not found on the page; enter it manually.');

  const roles = parseExperience(s.experience);
  const current = roles.filter((r) => r.current && r.company && !NOT_A_COMPANY.test(r.company));
  const fromHeadline = splitHeadline(s.headline);
  const label = s.currentCompanyLabel ? cleanCompany(s.currentCompanyLabel) : '';
  const metaCompany = (s.metaDescription.match(/Experience:\s*([^·|]+)/i)?.[1] ?? '').trim();

  // Preference: explicit top-card label > current Experience roles > headline > meta > most recent role.
  const ordered = [label, ...current.map((r) => r.company), fromHeadline.company, metaCompany]
    .map((c) => cleanCompany(c)).filter((c) => c && !NOT_A_COMPANY.test(c));
  let company = ordered[0] ?? '';
  if (!company && roles[0]?.company && !NOT_A_COMPANY.test(roles[0].company)) {
    company = roles[0].company;
    notes.push(`"${company}" is the most recent listed role and may be a previous employer; please confirm.`);
  }
  if (!company) notes.push('Current company not visible on the page; enter it manually.');
  else if (!label && !current.length && fromHeadline.company === company) notes.push('Company taken from the headline; please confirm.');
  if (roles.some((r) => r.company && NOT_A_COMPANY.test(r.company) && r.current)) notes.push('A current role is self-employed/confidential and was skipped.');
  if (new Set(current.map((r) => r.company.toLowerCase())).size > 1) notes.push('Several current positions; pick the right employer if needed.');

  const role = current.find((r) => r.company === company) ?? roles.find((r) => r.company === company);
  const companyOptions = [...new Set([...ordered, ...roles.map((r) => r.company).filter(Boolean)])].filter((c) => c !== company).slice(0, 4);
  const companyHref = role?.companyHref || s.companyLinkedInUrl;

  return {
    name: parseFullName(rawName),
    company,
    title: normalizeText(role?.title || fromHeadline.title),
    linkedinUrl: normalizeLinkedInUrl(s.url),
    companyLinkedInUrl: companyHref || null,
    source: 'profile',
    companyOptions,
    notes,
  };
}

export function identityFromManual(input: { name: string; company: string; title?: string; linkedinUrl?: string }): Identity {
  return {
    name: parseFullName(input.name),
    company: cleanCompany(input.company),
    title: normalizeText(input.title ?? ''),
    linkedinUrl: normalizeLinkedInUrl(input.linkedinUrl),
    companyLinkedInUrl: null,
    source: 'manual',
    companyOptions: [],
    notes: [],
  };
}

/** LinkedIn company slug often equals the domain label: /company/example-technologies -> example-technologies */
export function companySlug(url: string | null): string | null {
  const m = url?.match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m && !/^\d+$/.test(m[1]) ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Stable key so the popup can tell whether a stored lookup belongs to the person on screen. */
export function identityKey(id: Identity): string {
  return [id.linkedinUrl ?? '', id.name.full.toLowerCase(), id.company.toLowerCase()].join('|');
}
