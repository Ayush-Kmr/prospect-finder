// Real Chromium + the built extension. Network is served from fictional fixtures.
// The LinkedIn page here is a hand-written fixture: passing these tests does NOT prove
// compatibility with LinkedIn's live site.
import { expect, test } from '@playwright/test';
import { CONF_URL, launch, openPopup, PROFILE_URL, session, tabIdOf, type Harness } from './harness';

const EX = 'exampletech.example';
let h: Harness;
test.afterEach(async () => { await h?.ctx.close(); });

async function openProfile(harness: Harness) {
  const page = await harness.ctx.newPage();
  await page.goto(PROFILE_URL);
  return tabIdOf(harness, PROFILE_URL);
}

test('service worker starts and popup renders the manual form', async () => {
  h = await launch({ siteAccess: false });
  expect(h.sw.url()).toMatch(/service-worker\.js$/);
  const popup = await openPopup(h);
  await expect(popup.getByLabel('Full name')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' })).toBeDisabled();
});

test('reads the LinkedIn-like profile via content script and finds a prediction without site access', async () => {
  h = await launch({ siteAccess: false });
  const tabId = await openProfile(h);
  const popup = await openPopup(h, tabId);
  const person = popup.getByTestId('person');
  await expect(person).toContainText('Jane Smith');
  await expect(person).toContainText('Example Technologies');
  await expect(person).toContainText('Technical Recruiter');

  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('result')).toBeVisible({ timeout: 20_000 });
  await expect(popup.getByTestId('best-email')).toHaveText(`jane.smith@${EX}`);
  await expect(popup.getByTestId('best-status')).toHaveText('Predicted — mailbox not verified');
  await expect(popup.getByTestId('permission')).toContainText('Permission needed');
  await expect(popup.locator('[data-stage="sources"]')).toHaveAttribute('data-state', 'skipped');
  // No request reached the company site without permission.
  expect(h.requests.some((u) => u.startsWith(`https://${EX}/`))).toBe(false);
  const s = await session(h);
  expect(s.lookup.done).toBe(true);
  expect(s.lookup.identity.name.full).toBe('Jane Smith');
});

test('with site access: crawls the company site, PATTERN_SUPPORTED with evidence links; alternatives and copy work', async () => {
  h = await launch({ siteAccess: true });
  const tabId = await openProfile(h);
  const popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('best-status')).toHaveText('Pattern-supported — mailbox not verified', { timeout: 30_000 });
  await expect(popup.getByTestId('best-email')).toHaveText(`jane.smith@${EX}`);
  await expect(popup.locator('[data-stage="sources"]')).toHaveAttribute('data-state', 'done');
  // robots.txt disallows /internal/ — never requested.
  expect(h.requests.some((u) => u.includes('/internal/'))).toBe(false);

  await popup.getByRole('button', { name: 'VIEW EVIDENCE' }).click();
  const ev = popup.getByTestId('evidence');
  await expect(ev).toContainText('Pages showing the company format');
  await expect(ev.locator(`a[href="https://${EX}/team"]`).first()).toBeVisible();

  await popup.getByRole('button', { name: /SHOW ALTERNATIVES/ }).click();
  await expect(popup.getByTestId('alternatives').locator('li')).not.toHaveCount(0);

  // "Copied ✓" only appears after navigator.clipboard.writeText() resolves. (Chromium won't grant
  // clipboard-read to extension origins under automation, so the clipboard itself isn't read back.)
  await popup.getByRole('button', { name: 'COPY EMAIL' }).click();
  await expect(popup.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
});

test('closing and reopening the popup keeps the result and the user’s edits; Clear wipes session', async () => {
  h = await launch({ siteAccess: false });
  const tabId = await openProfile(h);
  let popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'Edit' }).click();
  await popup.getByLabel('Company', { exact: true }).fill('Example Technologies Inc.');
  await popup.getByRole('button', { name: 'Save' }).click();
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('result')).toBeVisible({ timeout: 20_000 });
  await popup.close();

  popup = await openPopup(h, tabId);
  await expect(popup.getByTestId('person')).toContainText('Example Technologies'); // cleaned "Inc." edit kept
  expect((await session(h)).identity.edited).toBe(true);
  await expect(popup.getByTestId('best-email')).toHaveText(`jane.smith@${EX}`);

  await popup.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(async () => Object.keys(await session(h)).length).toBe(0);
});

test('Cancel stops a slow lookup and the popup leaves the searching state', async () => {
  h = await launch({ siteAccess: true, delays: { [`https://${EX}/`]: 8000 } });
  const tabId = await openProfile(h);
  const popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByRole('button', { name: 'SEARCHING…' })).toBeVisible();
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup.getByText('Lookup cancelled.').first()).toBeVisible();
  await expect(popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' })).toBeEnabled();
  expect((await session(h)).lookup.errorKind).toBe('cancelled');
});

test('Retry starts a fresh lookup', async () => {
  h = await launch({ siteAccess: false });
  const tabId = await openProfile(h);
  const popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('result')).toBeVisible({ timeout: 20_000 });
  const first = (await session(h)).lookup.id;
  await popup.getByRole('button', { name: 'RETRY' }).click();
  await expect.poll(async () => (await session(h)).lookup.id).not.toBe(first);
  await expect(popup.getByTestId('result')).toBeVisible({ timeout: 20_000 });
});

test('user-assisted: "Analyze current tab" on a public page upgrades to PUBLICLY_CONFIRMED with a source link', async () => {
  h = await launch({ siteAccess: true });
  const tabId = await openProfile(h);
  let popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('best-status')).toHaveText(/Pattern-supported/, { timeout: 30_000 });
  await popup.close();

  const conf = await h.ctx.newPage();
  await conf.goto(CONF_URL);
  popup = await openPopup(h, await tabIdOf(h, CONF_URL));
  await popup.getByRole('button', { name: 'Analyze current tab' }).click();
  await expect(popup.getByTestId('assist-msg')).toContainText('1 relevant address');
  await expect(popup.getByTestId('best-status')).toHaveText('Publicly confirmed — published on a public page');
  await popup.getByRole('button', { name: 'VIEW EVIDENCE' }).click();
  await expect(popup.getByTestId('evidence').locator(`a[href="${CONF_URL}"]`)).toBeVisible();
});

test('non-profile LinkedIn page: "Profile not detected" with manual entry', async () => {
  h = await launch({ siteAccess: false });
  const page = await h.ctx.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const popup = await openPopup(h, await tabIdOf(h, 'https://www.linkedin.com/feed/'));
  await expect(popup.getByText(/Profile not detected/)).toBeVisible();
  await expect(popup.getByLabel('Full name')).toBeVisible();
});

test('a lookup interrupted by a worker restart is shown as interrupted, not as searching forever', async () => {
  h = await launch({ siteAccess: false });
  const tabId = await openProfile(h);
  let popup = await openPopup(h, tabId);
  await expect(popup.getByTestId('person')).toContainText('Jane Smith');
  // Simulate a lookup whose worker died 2 minutes ago.
  await h.sw.evaluate(async () => {
    const { identity } = await chrome.storage.session.get('identity');
    const { initialStateForTest } = { initialStateForTest: null };
    void initialStateForTest;
    const key = [identity.linkedinUrl ?? '', identity.name.full.toLowerCase(), identity.company.toLowerCase()].join('|');
    const old = Date.now() - 120_000;
    await chrome.storage.session.set({ lookup: {
      id: 'dead', key, startedAt: old, heartbeatAt: old, identity, website: null,
      stages: { profile: { state: 'done' }, domain: { state: 'running' }, sources: { state: 'pending' }, patterns: { state: 'pending' }, dns: { state: 'pending' } },
      domain: null, mailDomain: null, mailDomainInferred: false, mx: [], dnsOk: true, visits: [], officialEmails: [], externalEmails: [],
      pageNames: {}, ranking: null, searchLinks: [], needsSitePermission: false, done: false,
    } });
  });
  await popup.close();
  popup = await openPopup(h, tabId);
  await expect(popup.getByText(/stopped responding/)).toBeVisible();
  await expect(popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' })).toBeEnabled();
});

test('messages from web pages cannot drive the extension', async () => {
  h = await launch({ siteAccess: false });
  const page = await h.ctx.newPage();
  await page.goto(PROFILE_URL);
  // No externally_connectable: a page has no channel to the extension at all.
  const hasRuntime = await page.evaluate(() => typeof (globalThis as any).chrome?.runtime?.sendMessage === 'function');
  expect(hasRuntime).toBe(false);
});

test('"Analyze all open result tabs" reads public pages in the window and skips LinkedIn', async () => {
  h = await launch({ siteAccess: true });
  const tabId = await openProfile(h);
  const conf = await h.ctx.newPage();
  await conf.goto(CONF_URL);
  const popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('best-status')).toHaveText(/Pattern-supported/, { timeout: 30_000 });
  await popup.getByRole('button', { name: 'Analyze all open result tabs in this window' }).click();
  await expect(popup.getByTestId('assist-msg')).toContainText('1 relevant address');
  await expect(popup.getByTestId('best-status')).toHaveText('Publicly confirmed — published on a public page');
});

test('no errors recorded by Chrome after a full session and repeated menu registration (reload path)', async () => {
  h = await launch({ siteAccess: true });
  const tabId = await openProfile(h);
  const popup = await openPopup(h, tabId);
  await popup.getByRole('button', { name: 'FIND PROFESSIONAL EMAIL' }).click();
  await expect(popup.getByTestId('result')).toBeVisible({ timeout: 30_000 });
  // The worker's registration (removeAll -> create), run twice as a reload/update would.
  const errs = await h.sw.evaluate(async () => {
    const out: string[] = [];
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((done) => chrome.contextMenus.removeAll(() =>
        chrome.contextMenus.create({ id: 'analyze-page', title: 'Email Finder: analyze this page', contexts: ['page'] }, () => {
          if (chrome.runtime.lastError) out.push(chrome.runtime.lastError.message ?? 'error');
          done();
        })));
    }
    return out;
  });
  expect(errs).toEqual([]);
  // What chrome://extensions shows under the "Errors" button.
  const ext = await h.ctx.newPage();
  await ext.goto('chrome://extensions/');
  const info = await ext.evaluate(() => new Promise<any[]>((res) => (chrome as any).developerPrivate.getExtensionsInfo({ includeDisabled: true }, res)));
  const me = info.find((x) => x.id === h.id);
  expect(me.state).toBe('ENABLED');
  expect(me.runtimeErrors.map((e: any) => e.message)).toEqual([]);
  expect(me.manifestErrors.map((e: any) => e.message)).toEqual([]);
});
