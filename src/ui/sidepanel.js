import { getSettings } from '../settings.js';

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

const STATUS = {
  published: 'Published', valid: 'Verified', verified: 'Verified', deliverable: 'Verified',
  unconfirmed: 'Unconfirmed', guess: 'Guess', accept_all: 'Accept-all', risky: 'Risky', unknown: 'Unknown',
};
const STATUS_HELP = {
  published: 'Found word-for-word on a public page. Open the source to see it.',
  valid: 'A mail provider confirmed this address accepts mail.',
  verified: 'A data provider has this address on record as verified.',
  deliverable: 'A data provider confirmed this address accepts mail.',
  unconfirmed: 'Claude mentioned it, but it was not in the pages it retrieved. Double-check before using.',
  guess: 'Built from the company’s email format. Not confirmed to exist.',
  accept_all: 'The company accepts mail for any address, so this can’t be confirmed.',
};
const tone = (c = 0) => (c >= 0.8 ? 'good' : c >= 0.45 ? 'warn' : 'bad');
const pct = (c = 0) => `${Math.round(c * 100)}%`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

async function copy(text, label = 'Copied') {
  await navigator.clipboard.writeText(text);
  toast(`✓ ${label}`);
}

function meter(c) {
  const bar = el('i');
  bar.style.width = pct(c);
  return el('div', { class: `meter ${tone(c)}` }, bar);
}

const copyBtn = (text, label = 'Copy', cls = 'btn-sm btn-ghost') =>
  el('button', { class: cls, onclick: () => copy(text, `Copied ${text}`) }, label);
const linkBtn = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', class: 'btn-link' }, text);
const statusPill = (e) => el('span', { class: `pill ${tone(e.confidence)}`, title: STATUS_HELP[e.status] || '' }, STATUS[e.status] || e.status || 'Unknown');

// ---------- Result ----------

function bestEmailCard(e) {
  return el('div', { class: 'card hero' },
    el('div', { class: 'hero-label' }, e.type === 'team inbox' ? 'Team inbox' : 'Best match'),
    el('button', { class: 'hero-email', title: 'Click to copy', onclick: () => copy(e.value, 'Email copied') },
      el('span', {}, e.value), el('span', { class: 'copy-hint' }, 'Copy')),
    el('div', { class: 'row' }, statusPill(e), meter(e.confidence), el('span', { class: 'pct' }, pct(e.confidence))),
    el('div', { class: 'basis' }, STATUS_HELP[e.status] || cap([e.basis, e.note].filter(Boolean).join(' · '))),
    (e.basis || e.note) && STATUS_HELP[e.status] ? el('div', { class: 'basis' }, cap([e.basis, e.note].filter(Boolean).join(' · '))) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'btn-sm primary', onclick: () => copy(e.value, 'Email copied') }, 'Copy email'),
      e.url ? linkBtn(e.url, 'View source ↗') : null,
      linkBtn(`mailto:${e.value}`, 'Compose')));
}

function renderResult(r) {
  const p = r.person;
  const llm = r.cost.llm;
  const [best, ...others] = r.emails.slice(0, 2); // older saved results may hold more
  const meta = [
    r.durationMs ? `⏱ ${(r.durationMs / 1000).toFixed(1)}s${r.deep ? ' · deep search' : ''}` : null,
    llm?.web_searches ? `${llm.web_searches} searches` : null,
    llm?.usd != null ? `$${llm.usd.toFixed(3)}` : null,
    r.cost.providerCalls.length ? `${r.cost.providerCalls.length} provider calls` : null,
  ].filter(Boolean);

  return el('div', {},
    el('div', { class: 'card' },
      el('div', { class: 'profile' },
        el('div', { class: 'avatar' }, initials(p.full_name)),
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, p.full_name || '(unknown)'),
          el('div', { class: 'subtitle' }, [p.title, p.company].filter(Boolean).join(' · '))),
        p.linkedin_url ? el('a', { class: 'icon-link', href: p.linkedin_url, target: '_blank', title: 'Open LinkedIn profile' }, '↗') : null),
      el('div', { class: 'chips' },
        p.is_recruiter ? el('span', { class: 'chip accent' }, 'Recruiter') : null,
        p.location ? el('span', { class: 'chip' }, `📍 ${p.location}`) : null,
        p.domain ? el('span', { class: 'chip', title: p.mail_host && p.mail_host !== 'None' ? `Mail handled by ${p.mail_host}` : '' }, `✉ @${p.domain}`) : null)),
    best ? bestEmailCard(best) : el('div', { class: 'card empty-state' },
      el('div', { class: 'big' }, '🔍'),
      el('div', { class: 'name' }, 'No email found'),
      el('p', {}, 'Nothing was published for this person, and the company’s email format couldn’t be confirmed.')),
    r.canDeepen ? el('div', { class: 'card deepen' },
      el('div', { class: 'grow' },
        el('div', { class: 'deepen-title' }, best ? 'Want more certainty?' : 'Try a deeper search'),
        el('div', { class: 'muted' }, 'Checks more sources (press, PDFs, events, GitHub). Takes a little longer.')),
      el('button', { class: 'btn-sm primary', onclick: (ev) => { ev.currentTarget.disabled = true; chrome.runtime.sendMessage({ type: 'deepen' }); } }, 'Search deeper')) : null,
    others.length ? [
      el('div', { class: 'section-title' }, 'Second option'),
      el('div', { class: 'card' }, others.map((e) => el('div', { class: 'item' },
        el('div', { class: 'grow' },
          el('button', { class: 'value linkish', title: 'Click to copy', onclick: () => copy(e.value, `Copied ${e.value}`) }, e.value),
          el('div', { class: 'muted' }, [e.type === 'team inbox' ? 'Team inbox' : null, STATUS[e.status] || e.status, e.basis || e.note].filter(Boolean).join(' · '),
            e.url ? [' · ', el('a', { href: e.url, target: '_blank' }, 'source')] : null),
          el('div', { class: 'row mini' }, meter(e.confidence), el('span', { class: 'pct' }, pct(e.confidence)))),
        copyBtn(e.value)))),
    ] : null,
    r.phones.length ? [
      el('div', { class: 'section-title' }, 'Phone'),
      el('div', { class: 'card' }, r.phones.map((ph) => el('div', { class: 'item' },
        el('div', { class: 'grow' }, el('div', { class: 'value' }, ph.value), el('div', { class: 'muted' }, `${ph.type} · ${ph.source}`)),
        copyBtn(ph.value)))),
    ] : null,
    r.errors.length ? el('details', { class: 'notes' },
      el('summary', {}, `${r.errors.length} note${r.errors.length > 1 ? 's' : ''}`),
      r.errors.map((e) => el('div', { class: 'note' }, el('span', {}, 'ⓘ'), el('span', {}, e)))) : null,
    el('div', { class: 'footer-meta' }, meta.map((m) => el('span', {}, m))),
  );
}

// ---------- Running / errors / empty ----------

let ticker = null;
function renderRunning(cur) {
  const timer = el('span', { class: 'timer' });
  const tick = () => { timer.textContent = `${((Date.now() - (cur.startedAt || Date.now())) / 1000).toFixed(1)}s`; };
  tick();
  ticker = setInterval(tick, 100);
  const steps = cur.steps?.length ? cur.steps : ['Starting'];
  return el('div', { class: 'card' },
    el('div', { class: 'progress-head' },
      el('div', { class: 'spinner' }),
      el('div', { class: 'grow' }, `${cur.deep ? 'Searching deeper for' : 'Finding'} ${cur.name || 'contact'}`),
      timer),
    el('div', { class: 'bar' }, el('i')),
    el('ul', { class: 'timeline' }, steps.map((s, i) => el('li', { class: i === steps.length - 1 ? 'now' : '' }, s))));
}

// Turn raw API errors into something actionable.
function friendly(error = '') {
  if (/api key|x-api-key|authentication|401/i.test(error)) return { title: 'Your Anthropic API key was rejected', body: 'Check the key in Settings. It should start with sk-ant-.', settings: true };
  if (/credit|billing|balance/i.test(error)) return { title: 'Your Anthropic account is out of credits', body: 'Add credits in the Anthropic Console, then try again.' };
  if (/429|rate.?limit|overloaded|529/i.test(error)) return { title: 'Claude is busy right now', body: 'Wait a few seconds and try again.' };
  if (/failed to fetch|networkerror|network/i.test(error)) return { title: 'Couldn’t reach Claude', body: 'Check your internet connection and try again.' };
  if (/not a linkedin profile|reload/i.test(error)) return { title: 'Couldn’t read this page', body: error, reload: true };
  return { title: 'Something went wrong', body: error };
}

function renderError(error) {
  const f = friendly(error);
  return el('div', { class: 'card error' },
    el('div', { class: 'error-title' }, f.title),
    el('div', { class: 'error-body' }, f.body),
    el('div', { class: 'actions' },
      f.settings ? el('button', { class: 'btn-sm', onclick: () => chrome.runtime.openOptionsPage() }, 'Open Settings') : null,
      f.reload && ctx.tabId != null ? el('button', { class: 'btn-sm', onclick: () => chrome.tabs.reload(ctx.tabId) }, 'Reload tab') : null,
      el('button', { class: 'btn-sm primary', onclick: findForActiveTab }, 'Try again')));
}

function welcome() {
  if (!hasKey) {
    return el('div', { class: 'card welcome setup' },
      el('div', { class: 'big' }, '🔑'),
      el('div', { class: 'name' }, 'One step to get started'),
      el('p', {}, 'Add your Anthropic API key. It stays in this browser and is only sent to Anthropic.'),
      el('button', { class: 'btn-sm primary', onclick: () => chrome.runtime.openOptionsPage() }, 'Add API key'));
  }
  return el('div', { class: 'card welcome' },
    el('div', { class: 'big' }, '✉️'),
    el('div', { class: 'name' }, 'Find anyone’s work email'),
    el('ol', { class: 'steps' },
      el('li', {}, 'Open someone’s LinkedIn profile'),
      el('li', {}, 'Press the button above'),
      el('li', {}, 'Copy the best match. Each email shows where it was found')));
}

// The result area only ever shows the profile in the active tab (or a history item the
// user picked). Results are matched by LinkedIn profile URL.
const profileKey = (u = '') => {
  const slug = String(u).match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  if (slug) { try { return `in/${decodeURIComponent(slug).toLowerCase()}`; } catch { return `in/${slug.toLowerCase()}`; } }
  return String(u).split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
};

let current;
let historyCache = [];
let pinned = null; // a history item the user clicked

function resultForTab() {
  const key = ctx.profile?.url ? profileKey(ctx.profile.url) : '';
  if (!key) return null;
  if (current?.status === 'done' && profileKey(current.result.person.linkedin_url) === key) return { r: current.result };
  const saved = historyCache.find((r) => profileKey(r.person.linkedin_url) === key);
  return saved ? { r: saved, saved: true } : null;
}

function readyCard() {
  const name = ctx.profile.heading || 'this person';
  return el('div', { class: 'card ready' },
    el('div', { class: 'profile' },
      el('div', { class: 'avatar' }, initials(name)),
      el('div', { class: 'grow' },
        el('div', { class: 'name' }, name),
        el('div', { class: 'subtitle' }, 'Not looked up yet. Press the button above.'))));
}

function savedBanner(r) {
  return el('div', { class: 'saved-banner' },
    el('span', {}, `Saved result · ${ago(r.at)}`),
    hasKey && ctx.profile ? el('button', { class: 'btn-sm btn-ghost', onclick: findForActiveTab }, 'Refresh') : null);
}

function render() {
  const status = $('status');
  const result = $('result');
  clearInterval(ticker);
  status.replaceChildren();
  renderCta();
  if (current?.status === 'running') {
    result.replaceChildren();
    status.append(renderRunning(current));
    return;
  }
  if (current?.status === 'error') status.append(renderError(current.error));
  const pick = pinned ? { r: pinned, saved: true } : resultForTab();
  if (pick) result.replaceChildren(pick.saved ? savedBanner(pick.r) : '', renderResult(pick.r));
  else result.replaceChildren(current?.status === 'error' ? '' : ctx.profile && hasKey ? readyCard() : welcome());
}

function renderState(cur) {
  const finishedElsewhere = cur?.status === 'done' && current?.status === 'running' && ctx.profile?.url
    && profileKey(cur.result.person.linkedin_url) !== profileKey(ctx.profile.url);
  current = cur;
  pinned = null;
  render();
  if (finishedElsewhere) toast(`✓ Done: ${cur.result.person.full_name}. It’s in Recent`);
}

// ---------- Active tab awareness ----------

const ctx = { tabId: null, onLinkedIn: false, profile: null };
let hasKey = true;

function renderCta() {
  const btn = $('find');
  const hint = $('hint');
  const running = current?.status === 'running';
  const first = ctx.profile?.heading?.trim().split(/\s+/)[0];
  btn.disabled = running || !ctx.profile || !hasKey;
  btn.querySelector('span').textContent = running ? 'Working…' : first ? `Find ${first}’s email` : 'Find contact';
  hint.textContent = !hasKey ? 'Add your Anthropic API key in Settings first.'
    : !ctx.onLinkedIn ? 'Open a LinkedIn profile to start.'
    : !ctx.profile ? 'This LinkedIn page isn’t a profile, or it needs a reload.' : '';
  hint.hidden = !hint.textContent;
}

let ctxTimer;
function refreshContext() {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const before = profileKey(ctx.profile?.url);
    ctx.tabId = tab?.id ?? null;
    ctx.onLinkedIn = !!tab?.url?.includes('linkedin.com');
    ctx.profile = null;
    if (ctx.onLinkedIn) {
      try { ctx.profile = await chrome.tabs.sendMessage(tab.id, { type: 'getProfile' }); } catch { /* content script not loaded yet */ }
    }
    // A different profile: drop the picked history item and any stale error.
    if (profileKey(ctx.profile?.url) !== before) {
      pinned = null;
      if (current?.status === 'error') current = null;
    }
    render();
  }, 150);
}

async function refreshKey() {
  hasKey = !!(await getSettings()).anthropicKey;
  render();
}

// ---------- History ----------

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  historyCache = history;
  const q = $('search').value.trim().toLowerCase();
  const rows = history.filter((r) => !q || [r.person.full_name, r.person.company, r.emails[0]?.value].join(' ').toLowerCase().includes(q));
  $('search').hidden = history.length < 4;
  $('history').replaceChildren(...(rows.length ? rows.slice(0, 50).map((r) =>
    el('div', { class: 'history-item', onclick: () => { pinned = r; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      el('div', { class: 'avatar sm' }, initials(r.person.full_name)),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, [r.person.full_name, r.person.company].filter(Boolean).join(' · ')),
        el('div', { class: 'sub' }, `${r.emails[0]?.value || 'no email'} · ${ago(r.at)}`)),
      r.emails[0] ? el('span', { class: `pill ${tone(r.emails[0].confidence)}` }, pct(r.emails[0].confidence)) : null))
    : [el('div', { class: 'empty' }, q ? 'No matches.' : 'Your lookups will appear here.')]));
  if (!pinned && current?.status !== 'running') render();
}

// ---------- Actions ----------

async function findForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('linkedin.com')) {
    renderState({ status: 'error', error: 'Open a LinkedIn profile in the active tab first.' });
    return;
  }
  let profile = null;
  try { profile = await chrome.tabs.sendMessage(tab.id, { type: 'getProfile' }); } catch { /* content script not loaded */ }
  if (!profile) {
    renderState({ status: 'error', error: 'This page is not a LinkedIn profile, or it needs a reload after installing the extension.' });
    return;
  }
  chrome.runtime.sendMessage({ type: 'lookup', profile, tabId: tab.id });
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function exportCsv() {
  const { history = [] } = await chrome.storage.local.get('history');
  const header = ['name', 'title', 'company', 'domain', 'linkedin', 'best_email', 'email_status', 'email_confidence', 'email_source', 'all_emails', 'phones', 'llm_model', 'llm_tokens', 'llm_usd', 'looked_up_at'];
  const rows = history.map((r) => [
    r.person.full_name, r.person.title, r.person.company, r.person.domain, r.person.linkedin_url,
    r.emails[0]?.value, r.emails[0]?.status, r.emails[0]?.confidence, r.emails[0]?.url,
    r.emails.map((e) => e.value).join('; '), r.phones.map((p) => `${p.value} (${p.type})`).join('; '),
    r.cost.llm?.model, r.cost.llm ? r.cost.llm.input_tokens + r.cost.llm.output_tokens : '', r.cost.llm?.usd ?? '', r.at,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  el('a', { href: url, download: `prospects-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`✓ Exported ${history.length} lookups`);
}

let clearArmed = false;
$('clear').addEventListener('click', async (ev) => {
  // Two-step clear instead of a confirm() dialog.
  if (!clearArmed) {
    clearArmed = true;
    ev.currentTarget.textContent = 'Click again to clear';
    setTimeout(() => { clearArmed = false; $('clear').textContent = 'Clear'; }, 3000);
    return;
  }
  clearArmed = false;
  $('clear').textContent = 'Clear';
  await chrome.storage.local.set({ history: [] });
  toast('History cleared');
});

$('find').addEventListener('click', findForActiveTab);
$('export').addEventListener('click', exportCsv);
$('search').addEventListener('input', renderHistory);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.current) renderState(changes.current.newValue);
  if (area === 'local' && changes.history) renderHistory();
  if (area === 'local' && changes.settings) refreshKey();
});
chrome.tabs.onActivated.addListener(refreshContext);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.url || info.status === 'complete')) refreshContext(); });

chrome.storage.session.get('current').then(({ current: cur }) => renderState(cur));
refreshKey();
refreshContext();
renderHistory();
