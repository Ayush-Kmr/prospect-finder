// Real-Chromium harness: loads the built extension (dist/) and serves every network
// request from fictional fixtures, so tests are deterministic and contact no real site.
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleWorld, fakeFetch, type World } from '../tests/helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = resolve(HERE, '..', 'dist');
export const FIXTURES = resolve(HERE, '..', 'tests', 'fixtures');
export const PROFILE_URL = 'https://www.linkedin.com/in/jane-smith-1a2b/';
export const CONF_URL = 'https://conf.example/speakers/2026';

/** Chromium that can load unpacked extensions: $CHROMIUM_PATH, Playwright's default, or a cached Playwright build. */
export function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined; // Playwright's own build
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const linuxCache = join(homedir(), '.cache', 'ms-playwright');
  for (const dir of [cache, linuxCache]) {
    if (!existsSync(dir)) continue;
    const builds = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const p = join(dir, b, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chromium found. Run `npx playwright install chromium` or set CHROMIUM_PATH.');
}

/**
 * Copy of dist/ whose manifest also grants host access to the fixture origins.
 * In production these come from activeTab (toolbar click) and the user's permission prompt,
 * neither of which automation can trigger. Everything else is the production build.
 */
function testExtension(extraHosts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'zcef-ext-'));
  cpSync(DIST, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions = [...m.host_permissions, ...extraHosts];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

export function fixtureWorld(): World {
  const w = exampleWorld();
  w.pages[PROFILE_URL] = { body: readFileSync(join(FIXTURES, 'linkedin-classic.html'), 'utf8') };
  w.pages['https://www.linkedin.com/feed/'] = { body: '<html><head><title>Feed | LinkedIn</title></head><body><main><h1>Feed</h1></main></body></html>' };
  w.pages[CONF_URL] = { body: `<html><head><title>AutomateConf 2026 speakers</title></head><body><div class="speaker"><h3>Jane Smith</h3>
    <p>Technical Recruiter, Example Technologies. Contact: jane.smith@exampletech.example</p></div></body></html>` };
  return w;
}

export interface Harness { ctx: BrowserContext; sw: Worker; id: string; world: World; requests: string[] }

export async function launch(opts: { siteAccess: boolean; world?: World; delays?: Record<string, number> }): Promise<Harness> {
  const hosts = ['https://www.linkedin.com/*'];
  if (opts.siteAccess) hosts.push('https://*.exampletech.example/*', 'https://conf.example/*');
  const ext = testExtension(hosts);
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: findChromium(),
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const world = opts.world ?? fixtureWorld();
  const fake = fakeFetch(world);
  const requests: string[] = [];
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (!/^https?:/.test(url)) return route.continue(); // the extension's own files
    requests.push(url);
    const delay = Object.entries(opts.delays ?? {}).find(([k]) => url.startsWith(k))?.[1];
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fake(url);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
    } catch {
      await route.abort('failed');
    }
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  return { ctx, sw, id: new URL(sw.url()).host, world, requests };
}

/** Opens the popup UI in a tab, pointed at `tabId` (the popup normally uses the active tab). */
export async function openPopup(h: Harness, tabId?: number): Promise<Page> {
  const p = await h.ctx.newPage();
  await p.goto(`chrome-extension://${h.id}/src/popup/index.html${tabId ? `?tabId=${tabId}` : ''}`);
  return p;
}

export async function tabIdOf(h: Harness, url: string): Promise<number> {
  return h.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url);
}

export async function session(h: Harness): Promise<Record<string, any>> {
  return h.sw.evaluate(() => chrome.storage.session.get(null));
}
