import { describe, expect, it } from 'vitest';
import type { ResolvedDomain } from '../src/services/company-resolver';
import { initialState, isStale, runLookup, stopLookup, STALE_AFTER_MS } from '../src/services/discovery-orchestrator';
import { extractPage } from '../src/services/email-extractor';
import { identityFromManual } from '../src/services/identity';
import { generateCandidates, matchPattern } from '../src/services/pattern-engine';
import { rank } from '../src/services/ranking-engine';
import { parseFullName } from '../src/utils/normalization';
import { EX, exampleWorld, fakeFetch, noSleep, type World } from './helpers';

const allow = async () => true;
const DOMAIN: ResolvedDomain = { domain: 'acme.example', mailDomain: 'acme.example', confidence: 'high', needsConfirmation: false, conflicting: false, candidates: [], notes: [] };

async function lookup(world: World, name: string, extra: Partial<Parameters<typeof runLookup>[1]> = {}, signal?: AbortSignal) {
  const f = fakeFetch(world);
  const state = await runLookup(initialState(identityFromManual({ name, company: 'Example Technologies' })), { fetch: f, sleep: noSleep, hasPermission: allow, intervalMs: 0, ...extra }, () => {}, signal);
  return { state, calls: f.calls, best: state.ranking?.candidates[0] };
}

describe('international names', () => {
  it.each([
    ['Jean-Luc Picard', 'jeanluc.picard', '{first}.{last}'],
    ['Jean-Luc Picard', 'jean.picard', '{first}.{last}'],
    ['José Luis García Márquez', 'jose.garcia', '{first}.{last}'],
    ['Stefan Müller', 'smueller', '{f}{last}'],
    ["Siobhan O'Brien", 'siobhan.obrien', '{first}.{last}'],
    ['Ludwig van der Berg', 'ludwig.vanderberg', '{first}.{last}'],
    ['Wei Zhang', 'zhang.wei', '{last}.{first}'],
    ['Ana García-López', 'agarcialopez', '{f}{last}'],
  ])('%s matches %s', (name, local, pattern) => {
    expect(matchPattern(local, parseFullName(name))).toBe(pattern);
  });

  it('primary spellings come before variants in candidates', () => {
    const c = generateCandidates(parseFullName('Stefan Müller'), [], 20).map((x) => x.local);
    expect(c.indexOf('stefan.muller')).toBeLessThan(c.indexOf('stefan.mueller'));
  });
});

describe('extraction', () => {
  it('reads schema.org JSON-LD and microdata with the owner name', () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Person","name":"Maria Gonzalez","jobTitle":"CTO","email":"mailto:maria.gonzalez@acme.example"}]}</script>
      <script type="application/ld+json">{not valid json</script></head><body>
      <div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Tom Becker</span>
      <a itemprop="email" href="mailto:tom.becker@acme.example">Email</a></div></body></html>`;
    const { emails } = extractPage(html, 'https://acme.example/team', { domains: ['acme.example'] });
    const maria = emails.find((e) => e.email === 'maria.gonzalez@acme.example')!;
    expect(maria.structured).toBe(true);
    expect(maria.namesNearby.map((n) => n.full)).toContain('Maria Gonzalez');
    expect(emails.find((e) => e.email === 'tom.becker@acme.example')!.namesNearby.map((n) => n.full)).toContain('Tom Becker');
  });

  it('dedupes an address shown several ways on one page and merges name evidence', () => {
    const html = `<div><h3>Ann Lee</h3><a href="mailto:ann.lee@acme.example">ann.lee@acme.example</a></div><p>Write to ANN.LEE@ACME.EXAMPLE</p>`;
    const { emails } = extractPage(html, 'u', { domains: ['acme.example'] });
    expect(emails).toHaveLength(1);
    expect(emails[0].viaMailto).toBe(true);
    expect(emails[0].namesNearby.map((n) => n.full)).toContain('Ann Lee');
  });

  it('decodes common obfuscations and entities', () => {
    const html = `<p>a.one (at) acme (dot) example</p><p>b.two{at}acme{dot}example</p><p>c.three＠acme.example</p>
      <p>&#100;.four&#x40;acme&#46;example</p>`;
    const got = extractPage(html, 'u', { domains: ['acme.example'] }).emails.map((e) => e.email).sort();
    expect(got).toEqual(['a.one@acme.example', 'b.two@acme.example', 'c.three@acme.example', 'd.four@acme.example']);
  });

  it('does not decode Cloudflare email protection in automatic crawls (anti-harvesting measure)', () => {
    const html = '<a href="/cdn-cgi/l/email-protection#1b7a7577"><span class="__cf_email__" data-cfemail="1b7a7577">[email&#160;protected]</span></a>';
    expect(extractPage(html, 'u').emails).toHaveLength(0);
  });

  it('collects page-wide names for grid layouts', () => {
    const html = '<div class="grid"><div><h3>Alex Brown</h3><h3>Robert Jones</h3></div><div><p>abrown@acme.example</p><p>rjones@acme.example</p></div></div>';
    expect(extractPage(html, 'u').names).toEqual(expect.arrayContaining(['Alex Brown', 'Robert Jones']));
  });
});

describe('ranking rules', () => {
  const jane = parseFullName('Jane Smith');
  const page = (html: string, url = 'https://acme.example/team') => extractPage(html, url, { domains: ['acme.example'] });

  it('attributes staff addresses to names elsewhere on the page (grid layout)', () => {
    const p = page('<section><div><h3>Alex Brown</h3></div><div><h3>Robert Jones</h3></div><div><h3>Sarah White</h3></div></section><section><p>abrown@acme.example</p><p>rjones@acme.example</p><p>swhite@acme.example</p></section>');
    const r = rank({ name: jane, domain: DOMAIN, mailDomain: 'acme.example', mx: ['mx'], dnsOk: true, emails: p.emails, pageNames: { 'https://acme.example/team': p.names } });
    expect(r.conventions[0]).toMatchObject({ pattern: '{f}{last}', exactSupport: 3 });
    expect(r.candidates[0]).toMatchObject({ email: 'jsmith@acme.example', status: 'PATTERN_SUPPORTED' });
    expect(r.outcome).toBe('pattern');
  });

  it('published address beats any guess, always has a clickable source, and conflicts reduce its score', () => {
    const single = page('<p>Jane Smith — jane.smith@acme.example</p>');
    const r1 = rank({ name: jane, domain: DOMAIN, mailDomain: 'acme.example', mx: ['mx'], dnsOk: true, emails: single.emails });
    expect(r1.candidates[0]).toMatchObject({ email: 'jane.smith@acme.example', status: 'PUBLICLY_CONFIRMED' });
    expect(r1.candidates[0].evidence[0].url).toMatch(/^https:\/\//);
    expect(r1.candidates.slice(1).every((c) => c.status !== 'PUBLICLY_CONFIRMED')).toBe(true);

    const both = [...single.emails, ...page('<p>Jane Smith: jsmith@acme.example</p>', 'https://press.example/a').emails];
    const r2 = rank({ name: jane, domain: DOMAIN, mailDomain: 'acme.example', mx: ['mx'], dnsOk: true, emails: both });
    const conf = r2.candidates.filter((c) => c.status === 'PUBLICLY_CONFIRMED');
    expect(conf).toHaveLength(2);
    expect(conf[0].score).toBeLessThan(r1.candidates[0].score);
    expect(r2.summary).toMatch(/Several published addresses/);
  });

  it('DNS/MX alone never confirms; generic addresses are never personal', () => {
    const p = page('<p>info@acme.example hr@acme.example jobs@acme.example</p>');
    const r = rank({ name: jane, domain: DOMAIN, mailDomain: 'acme.example', mx: ['aspmx.l.google.com'], dnsOk: true, emails: p.emails });
    expect(r.candidates.every((c) => c.status !== 'PUBLICLY_CONFIRMED' && !c.email.startsWith('info@'))).toBe(true);
    expect(r.candidates[0].status).toBe('PREDICTED');
    expect(r.candidates[0].explanation).toMatch(/not verified/);
    expect(r.candidates[0].evidence).toHaveLength(0); // missing public evidence is disclosed as such
    expect(r.outcome).toBe('prediction');
  });

  it('a published address for a different person is never attributed to the target', () => {
    const p = page('<p>Jane Smithson — jane.smithson@acme.example</p>');
    const r = rank({ name: jane, domain: DOMAIN, mailDomain: 'acme.example', mx: ['mx'], dnsOk: true, emails: p.emails });
    expect(r.candidates.some((c) => c.status === 'PUBLICLY_CONFIRMED')).toBe(false);
  });
});

describe('discovery behaviour', () => {
  it("follows a team page link to the person's own bio page", async () => {
    const world = exampleWorld({ pages: {
      [`https://${EX}/team`]: { body: '<a href="/team/jane-smith">Jane Smith</a> <a href="/team/alex-brown">Alex Brown</a>' },
      [`https://${EX}/team/jane-smith`]: { body: `<h1>Jane Smith</h1><p>Technical Recruiter</p><a href="mailto:jane.smith@${EX}">Email Jane</a>` },
    } });
    const { best, calls } = await lookup(world, 'Jane Smith');
    expect(calls).toContain(`https://${EX}/team/jane-smith`);
    expect(best).toMatchObject({ email: `jane.smith@${EX}`, status: 'PUBLICLY_CONFIRMED' });
    expect(best!.evidence[0].url).toBe(`https://${EX}/team/jane-smith`);
  });

  it('uses a sibling domain with MX as an unconfirmed email domain, and says so', async () => {
    const world = exampleWorld({
      wikidata: { 'Example Technologies': [{ id: 'Q1', label: 'Example Technologies', description: 'software company', website: 'https://exampletech.io' }] },
      ddg: { 'Example Technologies': { Results: [{ FirstURL: 'https://exampletech.io', Text: 'Official site' }] } },
    });
    world.dns['exampletech.io'] = { A: ['192.0.2.7'], MX: [] };
    world.dns['exampletech.com'] = { A: ['192.0.2.8'], MX: ['mx.exampletech.com'] };
    const { state, best } = await lookup(world, 'Jane Smith', { hasPermission: async () => false });
    expect(state.mailDomain).toBe('exampletech.com');
    expect(state.mailDomainInferred).toBe(true);
    expect(best!.status).toBe('DOMAIN_VALID_ONLY');
  });

  it('records public-source errors without failing the lookup', async () => {
    const world = exampleWorld({ pages: {
      [`https://${EX}/team`]: { status: 500, body: 'oops' },
      [`https://${EX}/press`]: { throws: 'ECONNRESET' },
    } });
    const { state, best } = await lookup(world, 'Jane Smith');
    const byUrl = Object.fromEntries(state.visits.map((v) => [v.url, v.status]));
    expect(byUrl[`https://${EX}/team`]).toBe('error');
    expect(byUrl[`https://${EX}/press`]).toBe('error');
    expect(state.stages.sources.detail).toMatch(/failed/);
    expect(best).toBeDefined();
  });

  it('cancellation stops further fetches; stopLookup marks it cancelled', async () => {
    const ctl = new AbortController();
    const world = exampleWorld();
    const f = fakeFetch(world);
    const fetchAndCancel = (async (u: string, i?: RequestInit) => {
      if (u === `https://${EX}/`) ctl.abort(); // cancel as soon as the crawl starts
      return f(u, i);
    }) as typeof f;
    const state = initialState(identityFromManual({ name: 'Jane Smith', company: 'Example Technologies' }));
    await runLookup(state, { fetch: fetchAndCancel, sleep: noSleep, hasPermission: allow, intervalMs: 0 }, () => {}, ctl.signal).catch(() => {});
    expect(f.calls.filter((u) => u.startsWith(`https://${EX}/`) && !u.endsWith('robots.txt')).length).toBeLessThanOrEqual(2);
    expect(state.done).toBe(false);
    stopLookup(state, 'cancelled');
    expect(state).toMatchObject({ done: true, errorKind: 'cancelled' });
  });

  it('respects the crawl time budget', async () => {
    let t = 0;
    const { state } = await lookup(exampleWorld(), 'Jane Smith', { crawlBudgetMs: 5, now: () => (t += 10) });
    expect(state.stages.sources.detail).toMatch(/time limit reached/);
  });

  it('permission rejected: no request is made to the company site, not even its homepage title', async () => {
    const { calls, state } = await lookup(exampleWorld(), 'Jane Smith', { hasPermission: async () => false });
    expect(calls.some((u) => u.includes(`//${EX}/`) || u.includes(`//www.${EX}/`))).toBe(false);
    expect(state.needsSitePermission).toBe(true);
  });

  it('builds exact-address searches from the top predictions', async () => {
    const { state } = await lookup(exampleWorld(), 'Jane Smith');
    expect(state.searchLinks[0].label).toBe('Exact predicted addresses');
    expect(state.searchLinks[0].query).toContain(`"jane.smith@${EX}"`);
  });
});

describe('stale session results', () => {
  it('a running lookup without heartbeat becomes stale; finished ones never do', () => {
    const s = initialState(identityFromManual({ name: 'Jane Smith', company: 'X' }), null, 1000);
    expect(isStale(s, 1000 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(s, 1000 + STALE_AFTER_MS + 1)).toBe(true);
    s.done = true;
    expect(isStale(s, 1e12)).toBe(false);
  });

  it('lookups carry the identity key so a different person never sees them', () => {
    const a = initialState(identityFromManual({ name: 'Jane Smith', company: 'Acme', linkedinUrl: 'https://www.linkedin.com/in/jane' }));
    const b = initialState(identityFromManual({ name: 'Jane Smith', company: 'Globex', linkedinUrl: 'https://www.linkedin.com/in/jane2' }));
    expect(a.key).not.toBe(b.key);
  });
});

describe('company name normalization', () => {
  it('strips legal suffixes and still resolves the domain', async () => {
    const { stripLegalSuffix, resolveCompanyDomain } = await import('../src/services/company-resolver');
    const { DnsValidator } = await import('../src/services/dns-validator');
    expect(stripLegalSuffix('Example Technologies, Inc.')).toBe('Example Technologies');
    expect(stripLegalSuffix('Foo Software Pvt. Ltd.')).toBe('Foo Software');
    expect(stripLegalSuffix('Müller GmbH')).toBe('Müller');
    expect(stripLegalSuffix('Acme')).toBe('Acme');
    const f = fakeFetch(exampleWorld());
    const r = await resolveCompanyDomain({ company: 'Example Technologies Inc.' }, { fetch: f, dns: new DnsValidator({ fetch: f }) });
    expect(r).toMatchObject({ domain: EX, confidence: 'high' });
  });
});
