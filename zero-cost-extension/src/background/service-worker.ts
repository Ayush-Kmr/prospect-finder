// MV3 service worker. Owns the lookup so it survives the popup closing.
// State lives in chrome.storage.session: held in memory by Chrome, never written
// to disk, cleared when the browser session ends (and by "Clear").
import { readLinkedInProfile, type ProfileSnapshot } from '../content/profile-reader';
import { DnsValidator } from '../services/dns-validator';
import { analyzeUserPage, initialState, runLookup, stopLookup, type LookupState } from '../services/discovery-orchestrator';
import { identityFromManual, identityFromSnapshot, identityKey, type Identity } from '../services/identity';
import { PageFetcher, SEARCH_ENGINE_HOSTS } from '../services/public-discovery';
import type { Msg, PendingAction, Reply } from '../shared/messages';

const deps = { fetch: (u: string, i?: RequestInit) => fetch(u, i) };
const MENU_ID = 'analyze-page';
let controller: AbortController | null = null;
let activeId: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

async function hasPermission(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    return await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    return false;
  }
}

interface Session { identity?: Identity; lookup?: LookupState; profileTabUrl?: string; pending?: PendingAction }
const getSession = () => chrome.storage.session.get(['identity', 'lookup', 'profileTabUrl', 'pending']) as Promise<Session>;
const save = (patch: Partial<Session>) => chrome.storage.session.set(patch);

// A worker restart means any in-flight lookup is gone: say so instead of spinning forever.
// Guarded so it can't overwrite a lookup that started while this check was pending.
void getSession().then(({ lookup }) => {
  if (lookup && !lookup.done && activeId === null) return save({ lookup: stopLookup(lookup, 'interrupted') });
}).catch(() => {});

async function readProfile(tabId: number): Promise<Reply> {
  let snap: ProfileSnapshot | undefined;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readLinkedInProfile, args: [4000] });
    snap = res?.result as ProfileSnapshot | undefined;
  } catch {
    return { ok: false, code: 'unreadable', error: 'Could not read this tab. Reload the LinkedIn page, then open the extension again.' };
  }
  if (!snap?.isProfile) return { ok: false, code: 'not-profile', error: 'Profile not detected on this tab. Enter the details manually.' };
  const fresh = identityFromSnapshot(snap);
  const prev = await getSession();
  if (prev.profileTabUrl === fresh.linkedinUrl && prev.identity?.edited) {
    return { ok: true, identity: prev.identity }; // keep the user's corrections on reopen
  }
  if (prev.profileTabUrl !== fresh.linkedinUrl) {
    controller?.abort();
    activeId = null;
    await chrome.storage.session.remove(['lookup', 'pending']); // new person: discard the previous lookup
  }
  await save({ identity: fresh, profileTabUrl: fresh.linkedinUrl ?? undefined });
  return { ok: true, identity: fresh };
}

function startHeartbeat() {
  stopHeartbeat();
  // Extension API calls keep the worker alive; this also lets the popup detect a dead lookup.
  heartbeat = setInterval(async () => {
    try {
      const { lookup } = await getSession();
      if (lookup && lookup.id === activeId && !lookup.done) await save({ lookup: { ...lookup, heartbeatAt: Date.now() } });
    } catch {
      // Storage unavailable (worker shutting down); the next tick or the popup recovers.
    }
  }, 15_000);
}
function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = null; }

async function find(input: Identity, website: string | null): Promise<Reply> {
  // Keep the "edited" flag so reopening the popup doesn't replace the user's corrections.
  const prev = (await getSession()).identity;
  const identity: Identity = { ...input, edited: input.edited || (!!prev?.edited && identityKey(prev) === identityKey(input)) };
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;
  const state = initialState(identity, website);
  activeId = state.id;
  await save({ identity, lookup: state, pending: undefined });
  startHeartbeat();
  const emit = (s: LookupState) => {
    if (ctl.signal.aborted || activeId !== s.id) return; // never let a superseded run overwrite newer state
    void save({ lookup: { ...s, heartbeatAt: Date.now() } });
  };
  runLookup(state, { ...deps, hasPermission, isOnline: () => navigator.onLine }, emit, ctl.signal)
    .catch((e) => {
      if (ctl.signal.aborted || activeId !== state.id) return;
      state.done = true; state.errorKind = 'internal'; state.error = `Unexpected error: ${String(e?.message ?? e)}`;
      void save({ lookup: state });
    })
    .finally(() => { if (activeId === state.id) stopHeartbeat(); });
  return { ok: true };
}

async function analyzeHtml(html: string, url: string): Promise<Reply> {
  const { lookup } = await getSession();
  if (!lookup?.domain?.domain) return { ok: false, code: 'no-lookup', error: 'Run a lookup first (open a LinkedIn profile and press Find).' };
  if (!lookup.done) return { ok: false, code: 'no-lookup', error: 'Wait for the current lookup to finish.' };
  const { state, found } = await analyzeUserPage(lookup, html, url, { ...deps, dns: new DnsValidator(deps) });
  await save({ lookup: state });
  return { ok: true, found };
}

async function readTab(tabId: number): Promise<{ html: string; url: string } | null> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    // The rendered DOM (after the page's own scripts ran), exactly what the user sees.
    func: () => ({ html: document.documentElement.outerHTML.slice(0, 1_500_000), url: location.href }),
  });
  return (res?.result as { html: string; url: string } | undefined) ?? null;
}

const analyzable = (url?: string) => {
  if (!url || !/^https?:\/\//.test(url)) return false;
  const host = new URL(url).hostname;
  return !/(^|\.)linkedin\.com$/i.test(host) && !SEARCH_ENGINE_HOSTS.test(host);
};

async function analyzeUrl(url: string): Promise<Reply> {
  const r = await new PageFetcher(deps, { hasPermission }).get(url);
  if (!r.html) {
    const code = r.visit.status === 'no-permission' ? 'no-permission' : 'unreadable';
    return { ok: false, code, error: `Could not read the page: ${r.visit.detail ?? r.visit.status}. Open it and use "Analyze current tab" instead.` };
  }
  return analyzeHtml(r.html, r.finalUrl);
}

async function handle(msg: Msg): Promise<Reply> {
  switch (msg.type) {
    case 'readProfile':
      return readProfile(msg.tabId);
    case 'saveIdentity':
      await save({ identity: { ...msg.identity, edited: true } });
      return { ok: true };
    case 'find':
      return find(msg.manual ? identityFromManual(msg.manual) : msg.identity!, msg.website ?? null);
    case 'analyzeTab': {
      const page = await readTab(msg.tabId).catch(() => null);
      if (!page) return { ok: false, code: 'unreadable', error: 'Could not read this tab.' };
      if (!analyzable(page.url)) return { ok: false, code: 'unreadable', error: 'Open a public result page (not LinkedIn or a search results page) and try again.' };
      return analyzeHtml(page.html, page.url);
    }
    case 'analyzeTabs': {
      // Result pages the user opened in a window. Needs site access for each (activeTab covers only one tab).
      const tabs = (await chrome.tabs.query({ windowId: msg.windowId })).filter((t) => analyzable(t.url));
      let analyzed = 0; let skipped = 0; let found = 0;
      for (const t of tabs.slice(0, 20)) {
        if (!(await hasPermission(t.url!))) { skipped++; continue; }
        const page = await readTab(t.id!).catch(() => null);
        if (!page) { skipped++; continue; }
        const r = await analyzeHtml(page.html, page.url);
        if (r.ok) { analyzed++; found += r.found ?? 0; } else skipped++;
      }
      return { ok: true, analyzed, skipped, found };
    }
    case 'analyzeUrl':
      return analyzeUrl(msg.url);
    case 'setPending':
      await save({ pending: msg.pending ?? undefined });
      return { ok: true };
    case 'cancel': {
      controller?.abort();
      stopHeartbeat();
      const { lookup } = await getSession();
      if (lookup && !lookup.done) await save({ lookup: stopLookup(lookup, 'cancelled') });
      activeId = null;
      return { ok: true };
    }
    case 'clear':
      controller?.abort();
      stopHeartbeat();
      activeId = null;
      await chrome.storage.session.clear();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // async response
});

// Resume work after a permission grant (the permission prompt can close the popup).
// No caller awaits this listener, so a failure here would surface as an uncaught rejection on chrome://extensions.
chrome.permissions.onAdded.addListener(async (granted) => {
  try {
    const { pending } = await getSession();
    if (!pending) return;
    const origins = granted.origins ?? [];
    const covers = pending.origins.some((o) => origins.includes(o) || origins.includes('https://*/*'));
    if (!covers) return;
    await save({ pending: undefined });
    if (pending.kind === 'scan') await find(pending.identity, pending.website);
    else await analyzeUrl(pending.url);
  } catch (e) {
    console.warn('Email Finder: resuming after permission grant failed', e);
  }
});

// Right-click "Analyze this page": the click grants activeTab for that tab.
// Menus persist across reloads/updates, so re-registering must replace, not duplicate
// (a plain create() throws "Cannot create item with duplicate id" on every reload).
function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Email Finder: analyze this page', contexts: ['page'] }, () => {
      if (chrome.runtime.lastError) console.warn('Email Finder: context menu', chrome.runtime.lastError.message);
    });
  });
}
chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id == null) return;
  const tabId = tab.id;
  try {
    const page = await readTab(tabId).catch(() => null);
    const r = page && analyzable(page.url) ? await analyzeHtml(page.html, page.url) : { ok: false as const, error: 'unreadable' };
    await chrome.action.setBadgeBackgroundColor({ color: r.ok && (r.found ?? 0) > 0 ? '#059669' : '#64748b', tabId });
    await chrome.action.setBadgeText({ text: r.ok ? String(r.found ?? 0) : '!', tabId });
  } catch {
    // Tab closed or navigated away meanwhile; nothing to show.
  }
});
