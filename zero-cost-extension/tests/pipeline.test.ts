import { describe, expect, it } from 'vitest';
import { resolveCompanyDomain } from '../src/services/company-resolver';
import { DnsValidator } from '../src/services/dns-validator';
import { analyzeUserPage, initialState, runLookup, type LookupState } from '../src/services/discovery-orchestrator';
import { identityFromManual } from '../src/services/identity';
import { EX, exampleWorld, fakeFetch, noSleep, type World } from './helpers';

const allow = async () => true;

async function lookup(world: World, name: string, opts: { company?: string; website?: string; permission?: (u: string) => Promise<boolean> } = {}) {
  const f = fakeFetch(world);
  const deps = { fetch: f, sleep: noSleep, hasPermission: opts.permission ?? allow, intervalMs: 0 };
  const emitted: LookupState[] = [];
  const state = await runLookup(initialState(identityFromManual({ name, company: opts.company ?? 'Example Technologies' }), opts.website ?? null), deps, (s) => emitted.push(structuredClone(s)));
  return { state, calls: f.calls, emitted, best: state.ranking?.candidates[0], deps };
}

describe('company domain resolution', () => {
  it('reaches high confidence when independent sources agree', async () => {
    const f = fakeFetch(exampleWorld());
    const r = await resolveCompanyDomain({ company: 'Example Technologies' }, { fetch: f, dns: new DnsValidator({ fetch: f }) });
    expect(r).toMatchObject({ domain: EX, mailDomain: EX, confidence: 'high', needsConfirmation: false });
    expect(r.candidates[0].sources).toEqual(expect.arrayContaining(['wikidata', 'duckduckgo']));
  });

  it('asks for confirmation when domains conflict', async () => {
    const world = exampleWorld({
      wikidata: { 'Example Technologies': [{ id: 'Q1', label: 'Example Technologies', description: 'software company', website: 'https://exampletech.example' }] },
      ddg: { 'Example Technologies': { Results: [{ FirstURL: 'https://example-tech-global.example', Text: 'Official site' }] } },
    });
    world.dns['example-tech-global.example'] = { A: ['192.0.2.50'], MX: ['mx.example-tech-global.example'] };
    const f = fakeFetch(world);
    const r = await resolveCompanyDomain({ company: 'Example Technologies' }, { fetch: f, dns: new DnsValidator({ fetch: f }) });
    expect(r.needsConfirmation).toBe(true);
    expect(r.candidates.map((c) => c.domain)).toEqual(expect.arrayContaining([EX, 'example-tech-global.example']));
  });

  it('rejects an invalid domain and never uses directories', async () => {
    const world = exampleWorld({ wikidata: {}, ddg: { 'Nowhere Widgets': { Results: [{ FirstURL: 'https://www.linkedin.com/company/nowhere', Text: 'Official site' }] } } });
    const f = fakeFetch(world);
    const r = await resolveCompanyDomain({ company: 'Nowhere Widgets', website: 'nowhere-widgets.example' }, { fetch: f, dns: new DnsValidator({ fetch: f }) });
    expect(r.domain).toBeNull();
    expect(r.notes.join(' ')).toMatch(/does not resolve/);
  });
});

describe('end-to-end lookup', () => {
  it('confirms an address published on the company site, next to the name', async () => {
    const { best, state } = await lookup(exampleWorld(), 'Dana Kowalski');
    expect(best).toMatchObject({ email: `dana.kowalski@${EX}`, status: 'PUBLICLY_CONFIRMED' });
    expect(best!.evidence[0].url).toBe(`https://${EX}/press`);
    expect(best!.signals.map((s) => s.label).join(' ')).toMatch(/next to the person's full name/);
    expect(state.stages.sources.state).toBe('done');
  });

  it('predicts from the observed company format and labels it PATTERN_SUPPORTED, not confirmed', async () => {
    const { best, state, calls } = await lookup(exampleWorld(), 'Jane Smith');
    expect(best).toMatchObject({ email: `jane.smith@${EX}`, status: 'PATTERN_SUPPORTED' });
    expect(best!.explanation).toBe('Matches the corporate naming format observed in 4 published company contacts. Individual mailbox not verified.');
    expect(state.ranking!.candidates.every((c) => c.status !== 'PUBLICLY_CONFIRMED')).toBe(true);
    // robots.txt disallows /internal/: the page listing Jane is never fetched
    expect(calls.some((u) => u.includes('/internal/'))).toBe(false);
    expect(state.visits.find((v) => v.url.includes('/internal/'))?.status).toBe('robots');
  });

  it('streams progress through every stage', async () => {
    const { emitted } = await lookup(exampleWorld(), 'Jane Smith');
    const last = emitted.at(-1)!;
    expect(Object.values(last.stages).every((s) => s.state === 'done')).toBe(true);
    expect(emitted[0].stages.domain.state).toBe('running');
  });

  it('never uses generic addresses as the person\'s email', async () => {
    const world = exampleWorld({ pages: {
      [`https://${EX}/team`]: { body: `<p>Contact: info@${EX}, careers@${EX}, support@${EX}</p>` },
      [`https://${EX}/press`]: { body: `<p>press@${EX}</p>` },
    } });
    const { best, state } = await lookup(world, 'Jane Smith');
    expect(best!.email).toBe(`jane.smith@${EX}`);
    expect(best!.status).toBe('PREDICTED');
    expect(state.ranking!.genericOnly).toEqual(expect.arrayContaining([`info@${EX}`, `careers@${EX}`]));
    expect(state.ranking!.notes.join(' ')).toMatch(/Only generic addresses/);
  });

  it('reports sites that block automated access and does not bypass them', async () => {
    const world = exampleWorld({ pages: {
      [`https://${EX}/team`]: { status: 403, body: 'Forbidden' },
      [`https://${EX}/press`]: { body: '<html><title>Attention Required! | Cloudflare</title><div id="cf-challenge">captcha</div></html>' },
    } });
    const { state, best } = await lookup(world, 'Jane Smith');
    const blocked = state.visits.filter((v) => v.status === 'blocked').map((v) => v.url);
    expect(blocked).toEqual(expect.arrayContaining([`https://${EX}/team`, `https://${EX}/press`]));
    expect(best!.status).not.toBe('PUBLICLY_CONFIRMED');
  });

  it('records timeouts and keeps going', async () => {
    const world = exampleWorld({ pages: { [`https://${EX}/team`]: { delayMs: 60_000 } } });
    const f = fakeFetch(world);
    const { PageFetcher } = await import('../src/services/public-discovery');
    const fetcher = new PageFetcher({ fetch: f, sleep: noSleep }, { timeoutMs: 30, intervalMs: 0 });
    const r = await fetcher.get(`https://${EX}/team`);
    expect(r.visit.status).toBe('timeout');
  });

  it('skips the crawl without site permission but still returns predictions', async () => {
    const permission = async (u: string) => !u.includes(EX);
    const { state, calls, best } = await lookup(exampleWorld(), 'Jane Smith', { permission });
    expect(state.needsSitePermission).toBe(true);
    expect(state.stages.sources.state).toBe('skipped');
    expect(calls.some((u) => u.startsWith(`https://${EX}/`))).toBe(false);
    expect(best).toMatchObject({ email: `jane.smith@${EX}`, status: 'PREDICTED' });
  });

  it('stops with a clear message when profile information is missing', async () => {
    const { state } = await lookup(exampleWorld(), '', { company: '' });
    expect(state.stages.profile.state).toBe('failed');
    expect(state.error).toMatch(/Enter the person's name and company/);
    expect(state.ranking).toBeNull();
  });

  it('offline: DNS unavailable is reported as such, with no results claimed', async () => {
    const world = exampleWorld({ dnsDown: true });
    const { state } = await lookup(world, 'Jane Smith', { website: EX });
    expect(state.domain?.domain ?? null).toBeNull();
    expect(state.errorKind).toBe('offline');
    expect(state.error).toMatch(/DNS validation failed/);
    expect(state.ranking).toBeNull();
  });

  it('catch-all domains: predictions are never upgraded without published evidence', async () => {
    // A catch-all server would accept any address; without SMTP probing we can't tell, and we don't claim to.
    const world = exampleWorld({ pages: { [`https://${EX}/team`]: { body: '<p>No staff listed.</p>' }, [`https://${EX}/press`]: { body: '' } } });
    const { state } = await lookup(world, 'Jane Smith');
    for (const c of state.ranking!.candidates) {
      expect(['PREDICTED', 'DOMAIN_VALID_ONLY']).toContain(c.status);
      expect(c.explanation).toMatch(/not verified/);
    }
  });

  it('user-assisted: a page the user sends back can confirm the address', async () => {
    const { state, deps } = await lookup(exampleWorld(), 'Jane Smith');
    const html = `<html><body><h2>AutomateConf speakers</h2><div><h3>Jane Smith</h3><p>Technical Recruiter, Example Technologies — jane.smith@${EX}</p></div></body></html>`;
    const { state: after, found } = await analyzeUserPage(state, html, 'https://conf.example/speakers', { fetch: deps.fetch });
    expect(found).toBe(1);
    expect(after.ranking!.candidates[0]).toMatchObject({ email: `jane.smith@${EX}`, status: 'PUBLICLY_CONFIRMED' });
    expect(after.ranking!.candidates[0].evidence[0].url).toBe('https://conf.example/speakers');
  });

  it('never fetches LinkedIn', async () => {
    const { calls } = await lookup(exampleWorld(), 'Jane Smith');
    expect(calls.some((u) => u.includes('linkedin.com'))).toBe(false);
  });
});

describe('weak domain evidence', () => {
  it('does not act on a name-only guess; asks the user instead', async () => {
    const world = exampleWorld({ wikidata: {}, ddg: {} });
    world.dns['example.com'] = { A: ['192.0.2.1'], MX: ['mx.example.com'] };
    const f = fakeFetch(world);
    const r = await resolveCompanyDomain({ company: 'Example Nonexistent Widgets Ltd' }, { fetch: f, dns: new DnsValidator({ fetch: f }) });
    expect(r.domain).toBeNull();
    expect(r.needsConfirmation).toBe(true);
    expect(r.candidates.map((c) => c.domain)).toContain('example.com');
  });
});
