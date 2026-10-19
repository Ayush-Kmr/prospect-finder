import { describe, expect, it } from 'vitest';
import { canonicalDomain, cleanUrl, isDirectoryDomain, isLookalike, nameDomainSimilarity, registrableDomain } from '../src/utils/domain';
import { parseFullName, spellings, surnameForms } from '../src/utils/normalization';
import { fetchWithTimeout, mapLimit, NetError, parseRobots, robotsAllows } from '../src/utils/net';
import { generateCandidates, inferConventions, matchPattern, render } from '../src/services/pattern-engine';
import { extractEmails, sitemapTeamUrls, teamPageLinks } from '../src/services/email-extractor';
import { identityFromSnapshot, splitHeadline } from '../src/services/identity';
import { DnsValidator, validSyntax } from '../src/services/dns-validator';
import { buildSearchLinks } from '../src/services/public-discovery';
import { fakeFetch, noSleep, snap } from './helpers';

describe('normalization', () => {
  it('parses decorated names', () => {
    expect(parseFullName('Jane Smith, SHRM-CP (she/her) 🚀')).toMatchObject({ first: 'Jane', last: 'Smith' });
    expect(parseFullName('Dr. Ludwig van der Berg')).toMatchObject({ first: 'Ludwig', last: 'van der Berg' });
    expect(parseFullName('María José García-López')).toMatchObject({ first: 'María', middle: ['José'], last: 'García-López' });
    expect(parseFullName('Jane "JJ" Smith | Hiring!')).toMatchObject({ first: 'Jane', last: 'Smith' });
    expect(parseFullName('Cher')).toMatchObject({ first: 'Cher', last: '' });
  });
  it('produces transliteration variants and surname forms', () => {
    expect(spellings('Müller')).toEqual(['muller', 'mueller']);
    expect(surnameForms(parseFullName('Ana García-López'))).toEqual(expect.arrayContaining(['garcialopez', 'garcia-lopez', 'lopez', 'garcia']));
    expect(surnameForms(parseFullName('Ludwig van der Berg'))).toEqual(expect.arrayContaining(['vanderberg', 'berg']));
  });
});

describe('domain utils', () => {
  it('canonicalizes and cleans', () => {
    expect(canonicalDomain('https://www.Example.com/careers?utm_source=x')).toBe('example.com');
    expect(canonicalDomain('jane@shop.example.co.uk')).toBe('example.co.uk');
    expect(canonicalDomain('not a domain')).toBeNull();
    expect(canonicalDomain('xn--exmple-cua.com')).toBeNull();
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
    expect(cleanUrl('https://x.example/p?utm_medium=a&id=3#top')).toBe('https://x.example/p?id=3');
  });
  it('filters directories and lookalikes, scores similarity', () => {
    expect(isDirectoryDomain('www.linkedin.com')).toBe(true);
    expect(isLookalike('Example Technologies', 'exampletechnologies-login.com')).toBe(true);
    expect(isLookalike('Example Technologies', 'exampletechnologie.com')).toBe(true);
    expect(isLookalike('Example Technologies', 'exampletechnologies.com')).toBe(false);
    expect(nameDomainSimilarity('Example Technologies Inc.', 'exampletechnologies.com')).toBe(1);
    expect(nameDomainSimilarity('Acme', 'zzz.com')).toBe(0);
  });
});

describe('pattern engine', () => {
  const jane = parseFullName('Jane Smith');
  it('generates the standard formats', () => {
    const locals = generateCandidates(jane, [], 20).map((c) => c.local);
    for (const l of ['jane.smith', 'jane', 'jsmith', 'janesmith', 'jane_smith', 'j.smith', 'janes']) expect(locals).toContain(l);
  });
  it('infers firstname.lastname from observed staff addresses', () => {
    const samples = [
      { local: 'alex.brown', name: parseFullName('Alex Brown'), url: 'u1' },
      { local: 'robert.jones', name: parseFullName('Robert Jones'), url: 'u2' },
      { local: 'sarah.white', name: null, url: 'u3' },
    ];
    const { conventions, conflicting } = inferConventions(samples);
    expect(conventions[0]).toMatchObject({ pattern: '{first}.{last}', exactSupport: 2, structuralSupport: 1 });
    expect(conflicting).toBe(false);
    expect(generateCandidates(jane, conventions)[0].local).toBe('jane.smith');
  });
  it('detects conflicting conventions', () => {
    const { conflicting } = inferConventions([
      { local: 'alex.brown', name: parseFullName('Alex Brown'), url: 'a' },
      { local: 'rjones', name: parseFullName('Robert Jones'), url: 'b' },
    ]);
    expect(conflicting).toBe(true);
  });
  it('handles middle names, hyphens and transliteration', () => {
    expect(render('{f}{m}{last}', parseFullName('John Quincy Adams'))).toBe('jqadams');
    expect(matchPattern('jose.garcia-lopez', parseFullName('José García-López'))).toBe('{first}.{last}');
    expect(matchPattern('stefan.mueller', parseFullName('Stefan Müller'))).toBe('{first}.{last}');
    expect(matchPattern('info', jane)).toBeNull();
  });
});

describe('email extractor', () => {
  const html = `<html><head><script>var x="hidden@acme.example"</script></head><body>
    <div><h3>Ann Lee</h3><a href="mailto:Ann.Lee@acme.example?subject=Hi">Email</a></div>
    <p>Bob Stone &mdash; bob&#64;acme.example</p><p>Carl Diaz: carl [at] acme [dot] example</p>
    <p>support@acme.example · me@gmail.com · logo@2x.png · x@other.example</p></body></html>`;
  it('extracts mailto, entity-encoded and obfuscated addresses for the domain', () => {
    const found = extractEmails(html, 'https://acme.example/team', { domains: ['acme.example'] });
    const byEmail = Object.fromEntries(found.map((f) => [f.email, f]));
    expect(Object.keys(byEmail).sort()).toEqual(['ann.lee@acme.example', 'bob@acme.example', 'carl@acme.example', 'support@acme.example']);
    expect(byEmail['support@acme.example'].isRole).toBe(true);
    expect(byEmail['ann.lee@acme.example'].viaMailto).toBe(true);
    expect(byEmail['ann.lee@acme.example'].namesNearby.map((n) => n.full)).toContain('Ann Lee');
  });
  it('never collects freemail addresses', () => {
    expect(extractEmails('<p>me@gmail.com</p>', 'u').length).toBe(0);
  });
  it('finds team links and sitemap urls on the same site only', () => {
    const links = teamPageLinks('<a href="/our-team">Team</a><a href="https://other.example/team">x</a><a href="/blog">b</a>', 'https://acme.example/', 'acme.example');
    expect(links).toEqual(['https://acme.example/our-team']);
    expect(sitemapTeamUrls('<loc>https://acme.example/leadership</loc><loc>https://acme.example/blog/1</loc>', 'acme.example')).toEqual(['https://acme.example/leadership']);
  });
});

describe('identity', () => {
  it('splits headlines and prefers explicit current company', () => {
    expect(splitHeadline('Technical Recruiter at Example Technologies | Hiring')).toEqual({ title: 'Technical Recruiter', company: 'Example Technologies' });
    const id = identityFromSnapshot(snap({ url: 'https://www.linkedin.com/in/Jane-Smith-1/?x', name: 'Jane Smith (she/her)', headline: 'Recruiter @ Old Co', currentCompanyLabel: 'Example Technologies', experience: [{ lines: ['Technical Recruiter', 'Example Technologies · Full-time', 'Jan 2023 - Present · 1 yr 10 mos'], sub: [], companyHref: '' }] }));
    expect(id).toMatchObject({ company: 'Example Technologies', title: 'Technical Recruiter', linkedinUrl: 'https://www.linkedin.com/in/jane-smith-1' });
    expect(id.name.first).toBe('Jane');
  });
  it('flags missing information', () => {
    const id = identityFromSnapshot(snap({ url: 'https://www.linkedin.com/in/x' }));
    expect(id.notes.join(' ')).toMatch(/enter it manually/);
  });
});

describe('net', () => {
  it('applies robots.txt longest-match rules', () => {
    const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/press\n\nUser-agent: badbot\nDisallow: /');
    expect(robotsAllows(g, 'https://a.example/private/x')).toBe(false);
    expect(robotsAllows(g, 'https://a.example/private/press/1')).toBe(true);
    expect(robotsAllows(g, 'https://a.example/team')).toBe(true);
  });
  it('limits concurrency and isolates errors', async () => {
    let inFlight = 0; let peak = 0;
    const res = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 3) throw new Error('boom');
      return n;
    });
    expect(peak).toBe(2);
    expect(res[2].status).toBe('rejected');
    expect(res[4]).toEqual({ status: 'fulfilled', value: 5 });
  });
  it('times out slow requests', async () => {
    const f = fakeFetch({ dns: {}, pages: { 'https://slow.example/': { delayMs: 500 } } });
    await expect(fetchWithTimeout({ fetch: f }, 'https://slow.example/', {}, 20)).rejects.toMatchObject({ kind: 'timeout' } as Partial<NetError>);
  });
});

describe('dns validator', () => {
  it('parses MX, handles NXDOMAIN, reports outages', async () => {
    const f = fakeFetch({ dns: { 'a.example': { MX: ['mx1.a.example', 'mx2.a.example'] } }, pages: {} });
    const dns = new DnsValidator({ fetch: f });
    expect(await dns.mx('a.example')).toEqual({ ok: true, records: ['mx1.a.example', 'mx2.a.example'] });
    expect(await dns.mx('missing.example')).toEqual({ ok: true, records: [] });
    const down = new DnsValidator({ fetch: fakeFetch({ dns: {}, pages: {}, dnsDown: true }) });
    expect((await down.mx('a.example')).ok).toBe(false);
    expect(validSyntax('jane.smith@a.example')).toBe(true);
    expect(validSyntax('jane..smith@a.example')).toBe(false);
  });
  it('falls back to the second DoH provider', async () => {
    const base = fakeFetch({ dns: { 'a.example': { MX: ['mx.a.example'] } }, pages: {} });
    const f = (async (u: string, i?: RequestInit) => (u.includes('cloudflare') ? new Response('', { status: 502 }) : base(u, i)));
    expect((await new DnsValidator({ fetch: f }).mx('a.example')).records).toEqual(['mx.a.example']);
  });
});

describe('search links', () => {
  it('builds targeted queries for the user to open', () => {
    const links = buildSearchLinks(identityFromSnapshot(snap({ name: 'Jane Smith', headline: 'Recruiter at Example Technologies' })), 'exampletech.example');
    expect(links[0].query).toBe('"Jane Smith" "@exampletech.example"');
    expect(links[0].engines.map((e) => e.name)).toEqual(['Google', 'Bing', 'DuckDuckGo']);
  });
  void noSleep;
});
