// Lookup orchestration, shared by the extension service worker and the CLI.
//
//   1. Research     one Claude request: parse the profile, then web search + fetch for the
//                   person's published email and real examples of the company's format
//   2. Verify       keep only addresses found in text Claude actually retrieved
//   3. Domain       Claude's domain / Hunter domain-search / provider hints, confirmed by MX
//   4. Providers    Apollo, PDL, Hunter email-finder in parallel (whichever have keys)
//   5. Fallback     pattern candidates (evidence-backed formats first), optionally verified with Hunter
//
// Returns emails/phones with source, status and confidence, plus a cost record.

import { researchProfile } from './llm.js';
import { candidateEmails, cleanDomain, mxRecords, mailHost, normalizeName, patternFromExample } from './email.js';
import { apollo, pdl, hunterDomain, hunterFinder, hunterVerify } from './providers.js';
import { llmCost } from './pricing.js';

const GOOD = new Set(['valid', 'verified', 'deliverable']);
// Shared inboxes: useful, but not the person's own address.
const ROLE_RE = /^(info|hello|contact|hr|careers?|jobs|recruit(ing|ment|er|ers)?|talent|ta|hiring|support|sales|press|media|pr|admin|office|team|people|marketing|enquiries|inquiries|help|privacy|legal)\d*([._-].*)?$/;
const uniqueBy = (items, key) => [...new Map(items.map((x) => [key(x), x])).values()];

// `deep` runs the broader research pass; `prior` carries the quick pass's findings so
// nothing it verified is lost and its searches aren't repeated.
export async function runLookup({ profile, person: preParsed, prior = null }, settings, { fetchImpl = fetch, onProgress = () => {}, deep = false } = {}) {
  const errors = [];
  const providerCalls = [];
  const step = (msg) => onProgress(msg);

  // 1. Research
  let person;
  let usage = null;
  let sources = [];
  let queries = [];
  if (preParsed) {
    person = { email_patterns_ranked: [], company_domain_guesses: [], public_emails: [], pattern_evidence: [], ...preParsed };
  } else {
    step(deep ? 'Searching deeper' : 'Reading the profile');
    const r = await researchProfile(profile, settings, fetchImpl, step, { deep, tried: prior?.queries || [] });
    ({ data: person, usage, sources, queries } = r);
  }
  if (prior) {
    person.public_emails = [...prior.public_emails, ...person.public_emails];
    person.pattern_evidence = [...prior.pattern_evidence, ...person.pattern_evidence];
    sources = [...prior.sources, ...sources];
    queries = [...prior.queries, ...queries];
  }
  person.public_emails = uniqueBy(person.public_emails, (e) => e.email);
  person.pattern_evidence = uniqueBy(person.pattern_evidence, (e) => e.email);
  person.linkedin_url = normalizeLinkedIn(profile?.url || person.linkedin_url);

  // 2. Verify: an address counts as published only if it appears in retrieved text.
  const seenIn = (email) => sources.find((s) => s.text.toLowerCase().includes(email));
  const published = person.public_emails.map((e) => {
    const s = seenIn(e.email);
    return { ...e, seen: !!s, seenUrl: s?.url, owner: ownership(e.email, s?.text, person) };
  });
  const evidence = person.pattern_evidence
    .filter((e) => seenIn(e.email))
    .map((e) => ({ ...e, pattern: patternFromExample(e.email, e.first_name, e.last_name) }))
    .filter((e) => e.pattern);

  const track = async (name, fn) => {
    providerCalls.push(name);
    try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return null; }
  };

  // 3. Domain: Hunter's lookup and every candidate's MX check run at once; first in priority order wins.
  step('Checking the company mail domain');
  const clean = (ds) => ds.filter(Boolean).map(cleanDomain).filter((d) => d.includes('.') && !/linkedin\.com$/.test(d));
  const evidenceDomain = (published.find((e) => e.seen) || evidence[0])?.email.split('@')[1];
  const first = [...new Set(clean([person.domain, evidenceDomain, person.company_email_domain, ...(person.company_domain_guesses || [])]))];
  const [hunterInfo, firstMx] = await Promise.all([
    settings.hunterKey && person.current_company && !person.domain
      ? track('Hunter domain-search', () => hunterDomain(person.current_company, settings, fetchImpl)) : null,
    Promise.all(first.map((d) => mxRecords(d, fetchImpl))),
  ]);
  // Hunter's domain slots in after the evidence and Claude's own answer.
  const domainCandidates = [...new Set(clean([...first.slice(0, 3), hunterInfo?.domain, ...first.slice(3)]))];
  const mxByDomain = new Map(first.map((d, i) => [d, firstMx[i]]));
  for (const d of domainCandidates) if (!mxByDomain.has(d)) mxByDomain.set(d, await mxRecords(d, fetchImpl));
  let mx = [];
  const withMail = domainCandidates.find((d) => mxByDomain.get(d)?.length);
  if (withMail) { person.domain = withMail; mx = mxByDomain.get(withMail); }
  if (!person.domain && domainCandidates[0]) person.domain = domainCandidates[0];

  // 4. Providers
  if (settings.apolloKey || settings.pdlKey || settings.hunterKey) step('Checking data providers');
  const jobs = [];
  if (settings.apolloKey) jobs.push(track('Apollo people/match', () => apollo(person, settings, fetchImpl)));
  if (settings.pdlKey) jobs.push(track('PDL person/enrich', () => pdl(person, settings, fetchImpl)));
  if (settings.hunterKey && person.domain) jobs.push(track('Hunter email-finder', () => hunterFinder(person, settings, fetchImpl)));
  const results = (await Promise.all(jobs)).filter(Boolean);

  const publicEmails = published.map((e) => {
    const work = !!person.domain && e.email.endsWith(`@${person.domain}`);
    const o = OWNERSHIP[e.owner];
    return {
      value: e.email,
      type: e.owner === 'role' ? 'team inbox' : work ? 'work' : 'other',
      status: e.seen ? 'published' : 'unconfirmed',
      confidence: e.seen ? o.confidence : Math.min(0.3, o.confidence),
      url: [e.seenUrl, e.url].find((u) => /^https?:\/\//.test(u || '')),
      note: e.seen ? o.note : 'Claude reported it, but it was not in the pages it retrieved',
      source: 'Public web',
    };
  });
  const emails = mergeBy([
    ...publicEmails,
    ...results.flatMap((r) => r.emails.map((e) => ({ ...e, source: r.source }))),
  ]);
  const phones = mergeBy(results.flatMap((r) => r.phones.map((p) => ({ ...p, source: r.source }))), normPhone);

  // Provider-confirmed domain beats our guess when we had no MX hit.
  if (!mx.length) {
    const hinted = results.map((r) => r.domain).find(Boolean);
    if (hinted) { person.domain = cleanDomain(hinted); mx = await mxRecords(person.domain, fetchImpl); }
  }

  // 4. Pattern fallback
  let guesses = [];
  const haveGoodWork = emails.some((e) => e.type === 'work' && (GOOD.has(e.status) || (e.status === 'published' && e.confidence >= 0.85)));
  const formats = countPatterns(evidence.filter((e) => e.email.endsWith(`@${person.domain}`)));
  if (!haveGoodWork && person.domain && mx.length) {
    step('Ranking email formats');
    guesses = candidateEmails({
      first: person.first_name, last: person.last_name, domain: person.domain,
      knownPattern: hunterInfo?.pattern, llmPatterns: person.email_patterns_ranked,
      evidencePatterns: formats,
    }).slice(0, 6).map((g) => ({ ...g, type: 'work', status: 'guess', source: 'Pattern' }));

    if (settings.hunterKey && settings.verifyGuesses) {
      step('Verifying the top guesses');
      for (const g of guesses.slice(0, 2)) {
        const v = await track(`Hunter verify ${g.value}`, () => hunterVerify(g.value, settings, fetchImpl));
        if (!v) continue;
        g.status = v.status;
        if (v.status === 'valid') g.confidence = Math.max(0.85, v.score);
        else if (v.status === 'invalid') g.confidence = 0;
        else if (v.status === 'accept_all') g.confidence = Math.min(g.confidence, 0.5);
        if (v.status === 'valid') break; // found one; save credits
      }
      guesses = guesses.filter((g) => g.confidence > 0);
    }
    if (hunterInfo?.acceptAll) guesses.forEach((g) => { g.confidence = Math.min(g.confidence, 0.5); g.note = 'domain accepts all addresses'; });
  }

  const allEmails = [...emails, ...guesses.filter((g) => !emails.some((e) => e.value.toLowerCase() === g.value.toLowerCase()))]
    .sort((a, b) => b.confidence - a.confidence);

  if (!settings.apolloKey && !settings.pdlKey && !settings.hunterKey) {
    errors.push('No data-provider keys: emails come from public sources and company patterns only; phone numbers need Apollo / PDL / Hunter.');
  }

  return {
    id: `${Date.now()}`,
    at: new Date().toISOString(),
    person: {
      full_name: person.full_name || `${person.first_name} ${person.last_name}`.trim(),
      first_name: person.first_name,
      last_name: person.last_name,
      title: person.current_title,
      company: person.current_company,
      location: person.location,
      is_recruiter: person.is_recruiter,
      linkedin_url: person.linkedin_url,
      domain: person.domain || null,
      mail_host: mailHost(mx),
    },
    // Only the two strongest addresses are worth showing; the rest are long-shot patterns.
    emails: allEmails.slice(0, 2),
    phones,
    // Nothing verified yet: the panel offers a deeper (slower) search.
    canDeepen: !preParsed && !deep && !haveGoodWork && !formats.some((f) => f.confidence >= 0.8),
    deep,
    // For a follow-up deep pass only; the background keeps it out of saved history.
    research: { public_emails: person.public_emails, pattern_evidence: person.pattern_evidence, sources, queries },
    cost: {
      llm: usage ? { ...usage, usd: llmCost(usage.model, usage, settings.customPricing || {}) } : null,
      sources: [...new Set(sources.map((s) => s.url).filter(Boolean))].slice(0, 10),
      providerCalls,
    },
    errors,
  };
}

// Each published colleague address is a vote for a format. More agreeing votes, higher
// confidence; a split vote (company uses two formats) lowers it.
function countPatterns(examples) {
  const counts = new Map();
  for (const e of examples) counts.set(e.pattern, (counts.get(e.pattern) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([pattern, count]) => ({
    pattern,
    count,
    confidence: +(Math.min(0.92, 0.6 + 0.11 * count) * (count === examples.length ? 1 : 0.8)).toFixed(2),
  }));
}

const OWNERSHIP = {
  exact: { confidence: 0.97, note: 'matches their name' },
  likely: { confidence: 0.88, note: 'their name is in the address and beside it on the page' },
  nearby: { confidence: 0.6, note: 'their name appears next to it, but the address doesn’t follow their name' },
  unclear: { confidence: 0.45, note: 'published, but the page doesn’t clearly tie it to them' },
  role: { confidence: 0.35, note: 'shared team inbox, not their personal address' },
};

// How sure are we this published address is this person's own?
function ownership(email, pageText = '', p) {
  const local = email.split('@')[0];
  if (ROLE_RE.test(local)) return 'role';
  if (patternFromExample(email, p.first_name, p.last_name)) return 'exact';
  const first = normalizeName(p.first_name);
  const last = normalizeName(p.last_name);
  const at = pageText.toLowerCase().indexOf(email);
  const near = at >= 0 && ((s) => (last.length > 1 && s.includes(last)) || (first.length > 2 && s.includes(first)))(normalizeName(pageText.slice(Math.max(0, at - 250), at + email.length + 250)));
  const flat = local.replace(/[^a-z]/g, '');
  const inAddress = (first.length > 2 && flat.includes(first)) || (last.length > 2 && flat.includes(last));
  if (inAddress && near) return 'likely';
  return near ? 'nearby' : 'unclear';
}

function normPhone(p) { return p.value.replace(/[^\d+]/g, ''); }

function mergeBy(items, key = (x) => x.value.toLowerCase()) {
  const map = new Map();
  for (const it of items) {
    const k = key(it);
    const prev = map.get(k);
    if (!prev) { map.set(k, { ...it, sources: [it.source] }); continue; }
    prev.sources.push(it.source);
    // Agreement between independent sources raises confidence.
    if (it.confidence != null) prev.confidence = Math.min(0.99, Math.max(prev.confidence, it.confidence) + 0.05);
    if (GOOD.has(it.status)) prev.status = it.status;
  }
  return [...map.values()].map(({ sources, ...rest }) => ({ ...rest, source: [...new Set(sources)].join(' + ') }));
}

export function normalizeLinkedIn(url) {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : url;
}
