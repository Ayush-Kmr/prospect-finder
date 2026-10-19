// Fictional network for tests. All companies/people are invented; domains use .example (RFC 2606).
import type { FetchLike } from '../src/utils/net';

export interface Route { status?: number; type?: string; body?: string; delayMs?: number; throws?: string }

export interface World {
  dns: Record<string, { A?: string[]; MX?: string[] }>;
  pages: Record<string, Route>;
  wikidata?: Record<string, { id: string; label: string; description: string; website?: string }[]>;
  ddg?: Record<string, { Results?: { FirstURL: string; Text: string }[] }>;
  dnsDown?: boolean;
}

export function fakeFetch(world: World): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fn = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);

    if (u.hostname === 'cloudflare-dns.com' || u.hostname === 'dns.google') {
      if (world.dnsDown) throw new TypeError('Failed to fetch');
      const name = u.searchParams.get('name')!;
      const type = u.searchParams.get('type')!;
      const rec = world.dns[name];
      if (!rec) return json({ Status: 3 });
      const code = type === 'MX' ? 15 : 1;
      const data = (type === 'MX' ? rec.MX : rec.A) ?? [];
      return json({ Status: 0, Answer: data.map((d, i) => ({ type: code, data: type === 'MX' ? `${10 * (i + 1)} ${d}.` : d })) });
    }

    if (u.hostname === 'www.wikidata.org') {
      const action = u.searchParams.get('action');
      const all = Object.values(world.wikidata ?? {}).flat();
      if (action === 'wbsearchentities') {
        return json({ search: (world.wikidata ?? {})[u.searchParams.get('search')!] ?? [] });
      }
      const ids = (u.searchParams.get('ids') ?? '').split('|');
      const entities = Object.fromEntries(ids.map((id) => {
        const e = all.find((x) => x.id === id);
        return [id, { claims: e?.website ? { P856: [{ mainsnak: { datavalue: { value: e.website } } }] } : {} }];
      }));
      return json({ entities });
    }

    if (u.hostname === 'api.duckduckgo.com') return json((world.ddg ?? {})[u.searchParams.get('q')!] ?? {});

    const route = world.pages[url];
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (route.throws) throw new TypeError(route.throws);
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
      });
    }
    return new Response(route.body ?? '', { status: route.status ?? 200, headers: { 'content-type': route.type ?? 'text/html; charset=utf-8' } });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => {};

// ------------------------------------------------------------------
// "Example Technologies" — a fictional company publishing staff emails.
export const EX = 'exampletech.example';
export function exampleWorld(overrides: Partial<World> = {}): World {
  return {
    dns: {
      [EX]: { A: ['192.0.2.10'], MX: ['aspmx.l.google.com'] },
      [`www.${EX}`]: { A: ['192.0.2.10'] },
      'exampletechnologies.example': { A: ['192.0.2.99'], MX: [] },
    },
    wikidata: {
      'Example Technologies': [{ id: 'Q1', label: 'Example Technologies', description: 'software company', website: `https://www.${EX}/?utm_source=wd` }],
    },
    ddg: { 'Example Technologies': { Results: [{ FirstURL: `https://${EX}/`, Text: 'Official site' }] } },
    pages: {
      [`https://${EX}/robots.txt`]: { type: 'text/plain', body: 'User-agent: *\nDisallow: /internal/\n' },
      [`https://${EX}/`]: { body: `<html><head><title>Example Technologies — Cloud tools</title></head><body>
        <nav><a href="/team">Our Team</a> <a href="/press">Newsroom</a> <a href="/internal/directory">Staff directory</a></nav>
        <footer>Questions? <a href="mailto:info@${EX}">info@${EX}</a></footer></body></html>` },
      [`https://${EX}/team`]: { body: `<html><body><h1>Team</h1>
        <div class="person"><h3>Alex Brown</h3><p>CEO</p><a href="mailto:alex.brown@${EX}">Email</a></div>
        <div class="person"><h3>Robert Jones</h3><p>CTO &mdash; robert.jones&#64;${EX}</p></div>
        <div class="person"><h3>Sarah White</h3><p>VP People. Contact Sarah White: sarah [dot] white [at] ${EX.replace('.', ' [dot] ')}</p></div>
        </body></html>` },
      [`https://${EX}/press`]: { body: `<html><body><p>Media: press@${EX}</p>
        <p>Speaker bio: Dana Kowalski, Head of Talent, can be reached at dana.kowalski@${EX}.</p></body></html>` },
      [`https://${EX}/internal/directory`]: { body: `<p>Jane Smith jane.smith@${EX}</p>` },
      [`https://${EX}/sitemap.xml`]: { type: 'application/xml', body: `<urlset><url><loc>https://${EX}/about-us</loc></url></urlset>` },
      [`https://${EX}/about-us`]: { body: '<p>We build things. Personal: someone@gmail.com</p>' },
      ...overrides.pages,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'pages')),
  };
}

import type { ProfileSnapshot } from '../src/content/profile-reader';
export function snap(p: Partial<ProfileSnapshot>): ProfileSnapshot {
  return {
    url: 'https://www.linkedin.com/in/jane-smith', isProfile: true, ready: true, name: '', headline: '', pageTitle: '',
    metaDescription: '', currentCompanyLabel: '', companyLinkedInUrl: '', topCardLines: [], experience: [], ...p,
  };
}
