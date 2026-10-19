import { useEffect, useState } from 'react';
import { isStale, STAGE_LABELS, type LookupState, type StageKey } from '../services/discovery-orchestrator';
import { identityFromManual, identityKey, type Identity } from '../services/identity';
import type { SourceVisit } from '../services/public-discovery';
import { STATUS_TEXT, WEIGHTS, type RankedCandidate, type Status } from '../services/ranking-engine';
import { canonicalDomain } from '../utils/domain';
import { send, type PendingAction } from '../shared/messages';

type Tab = chrome.tabs.Tab;

const STATUS_TONE: Record<Status, string> = {
  PUBLICLY_CONFIRMED: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  PATTERN_SUPPORTED: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  PREDICTED: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  DOMAIN_VALID_ONLY: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  UNVERIFIED: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  NOT_FOUND: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
};

const VISIT_TEXT: Record<SourceVisit['status'], string> = {
  ok: 'read', blocked: 'blocked automated access (not bypassed)', robots: 'disallowed by robots.txt',
  'not-found': 'not found', timeout: 'timed out', error: 'error', 'not-html': 'not a web page', 'no-permission': 'access not granted',
};

const isProfileUrl = (u?: string) => !!u && /linkedin\.com\/(in|talent\/.*profile|sales\/(lead|people))\//i.test(u);
const isLinkedIn = (u?: string) => !!u && /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(u);
const isWebUrl = (u?: string) => !!u && /^https?:\/\//.test(u) && !isLinkedIn(u);
const siteOrigins = (domain: string) => [`https://*.${domain}/*`];

function useSession() {
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    chrome.storage.session.get(['lookup', 'identity']).then((s) => {
      setLookup((s.lookup as LookupState) ?? null);
      setIdentity((s.identity as Identity) ?? null);
    });
    const onChange = (ch: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if ('lookup' in ch) setLookup((ch.lookup.newValue as LookupState) ?? null);
      if ('identity' in ch) setIdentity((ch.identity.newValue as Identity) ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return { lookup, identity, setIdentity };
}

/** Request site access. If the prompt closes the popup, the service worker resumes `pending`. */
async function requestWithResume(origins: string[], pending: PendingAction, resume: () => void): Promise<boolean> {
  if (await chrome.permissions.contains({ origins })) { resume(); return true; }
  await send({ type: 'setPending', pending });
  const granted = await chrome.permissions.request({ origins });
  if (!granted) await send({ type: 'setPending', pending: null });
  return granted; // when granted, the worker's permissions.onAdded handler resumes the work
}

function Copy({ text, label = 'COPY EMAIL', primary }: { text: string; label?: string; primary?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={primary ? 'btn border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-500 dark:border-indigo-500 dark:bg-indigo-600' : 'btn'}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* clipboard unavailable */ }
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

function SafeLink({ url, children }: { url: string; children?: React.ReactNode }) {
  // Only http(s) links are rendered as links; text is rendered as text (React escapes it).
  if (!/^https?:\/\//i.test(url)) return <span>{children ?? url}</span>;
  return <a className="link break-all" href={url} target="_blank" rel="noreferrer noopener">{children ?? url}</a>;
}

function Notice({ tone, children }: { tone: 'info' | 'warn' | 'error'; children: React.ReactNode }) {
  const cls = {
    info: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    error: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  }[tone];
  return <div className={`rounded-md p-2 text-xs ${cls}`}>{children}</div>;
}

function PersonCard({ identity, website, onChange, editable }: {
  identity: Identity; website: string; editable: boolean;
  onChange: (i: Identity, website: string) => void;
}) {
  const [edit, setEdit] = useState(!identity.name.full || !identity.company);
  const [name, setName] = useState(identity.name.full);
  const [company, setCompany] = useState(identity.company);
  const [title, setTitle] = useState(identity.title);
  const [site, setSite] = useState(website);
  useEffect(() => {
    setName(identity.name.full); setCompany(identity.company); setTitle(identity.title);
    if (!identity.name.full || !identity.company) setEdit(true);
  }, [identity]);
  useEffect(() => setSite(website), [website]);

  const commit = (patch: Partial<{ name: string; company: string; title: string }> = {}, siteValue = site) => {
    const next = identityFromManual({ name: patch.name ?? name, company: patch.company ?? company, title: patch.title ?? title, linkedinUrl: identity.linkedinUrl ?? undefined });
    onChange({ ...next, companyLinkedInUrl: identity.companyLinkedInUrl, source: identity.source, companyOptions: identity.companyOptions.filter((c) => c !== next.company).concat(identity.company && identity.company !== next.company ? [identity.company] : []) }, siteValue);
  };

  if (edit) {
    return (
      <div className="card space-y-2">
        <div className="label">Person</div>
        <input className="input" aria-label="Full name" placeholder="Full name (e.g. Jane Smith)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" aria-label="Company" placeholder="Company (e.g. Example Technologies)" value={company} onChange={(e) => setCompany(e.target.value)} />
        <input className="input" aria-label="Role" placeholder="Role (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input" aria-label="Company website" placeholder="Company website (optional, e.g. example.com)" value={site} onChange={(e) => setSite(e.target.value)} />
        <div className="flex justify-end">
          <button className="btn" disabled={!name.trim() || (!company.trim() && !site.trim())} onClick={() => { commit(); setEdit(false); }}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <div className="card" data-testid="person">
      <div className="flex items-start justify-between">
        <div className="label">Person — confirm before searching</div>
        {editable && <button className="link text-xs" onClick={() => setEdit(true)}>Edit</button>}
      </div>
      <div className="mt-1 text-base font-semibold">{identity.name.full}</div>
      {identity.title && <div className="text-sm text-slate-600 dark:text-slate-300">{identity.title}</div>}
      <div className="text-sm text-slate-600 dark:text-slate-300">{identity.company}</div>
      {editable && identity.companyOptions.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
          Not this employer?
          {identity.companyOptions.map((c) => <button key={c} className="btn px-1.5 py-0.5 text-[11px]" onClick={() => commit({ company: c })}>{c}</button>)}
        </div>
      )}
      {website && <div className="mt-2"><div className="label">Company website</div><div className="text-sm">{website}</div></div>}
      {identity.notes.map((n) => <div key={n} className="mt-1 text-xs text-amber-700 dark:text-amber-300">{n}</div>)}
    </div>
  );
}

function Progress({ lookup }: { lookup: LookupState }) {
  return (
    <ul className="card space-y-1 text-sm" aria-label="Progress">
      {(Object.keys(STAGE_LABELS) as StageKey[]).map((k) => {
        const st = lookup.stages[k];
        const icon = { done: '✓', running: '…', failed: '✕', skipped: '–', pending: '○' }[st.state];
        const tone = { done: 'text-emerald-600', running: 'text-indigo-600 animate-pulse', failed: 'text-rose-600', skipped: 'text-slate-400', pending: 'text-slate-300' }[st.state];
        return (
          <li key={k} className="flex gap-2" data-stage={k} data-state={st.state}>
            <span className={`w-4 text-center font-bold ${tone}`}>{icon}</span>
            <span className="flex-1">
              {STAGE_LABELS[k]}
              {st.detail && <span className="block text-xs text-slate-500 dark:text-slate-400">{st.detail}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DomainCard({ lookup, onUse }: { lookup: LookupState; onUse: (domain: string) => void }) {
  const d = lookup.domain;
  const [val, setVal] = useState('');
  if (!d) return null;
  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between">
        <div className="label">Company domain</div>
        {d.domain && <span className="text-[11px] text-slate-500">{d.confidence} confidence</span>}
      </div>
      {d.domain && (
        <div className="font-mono text-sm">
          {d.domain}
          {lookup.mailDomain && lookup.mailDomain !== d.domain && <span className="text-slate-500"> · email: {lookup.mailDomain}{lookup.mailDomainInferred ? ' (unconfirmed)' : ''}</span>}
        </div>
      )}
      {d.needsConfirmation && !d.networkError && (
        <Notice tone="warn">
          {d.domain ? 'Please confirm the company domain.' : 'Company website unknown. Pick one or enter it below.'}
          {d.candidates.filter((c) => c.resolves).length > (d.domain ? 1 : 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {d.candidates.filter((c) => c.resolves).slice(0, 4).map((c) => (
                <button key={c.domain} className="btn" title={c.signals.join('\n')} onClick={() => onUse(c.domain)}>{c.domain}</button>
              ))}
            </div>
          )}
        </Notice>
      )}
      {d.notes.map((n) => <div key={n} className="text-xs text-slate-500">{n}</div>)}
      <div className="flex gap-1">
        <input className="input" aria-label="Different domain" placeholder="Use a different domain…" value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn" disabled={!canonicalDomain(val)} onClick={() => onUse(canonicalDomain(val)!)}>Use</button>
      </div>
    </div>
  );
}

function Evidence({ c, lookup }: { c: RankedCandidate; lookup: LookupState }) {
  return (
    <div className="mt-3 space-y-2 border-t border-slate-200 pt-2 text-xs dark:border-slate-800" data-testid="evidence">
      <div className="label">Score breakdown (evidence score, not a probability)</div>
      <ul className="space-y-0.5">
        {c.signals.map((s, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span>{s.label}</span>
            <span className={`font-mono ${s.points > 0 ? 'text-emerald-600' : s.points < 0 ? 'text-rose-600' : 'text-slate-400'}`}>{s.points > 0 ? '+' : ''}{s.points}</span>
          </li>
        ))}
      </ul>
      {c.evidence.length > 0 ? (
        <>
          <div className="label">{c.status === 'PUBLICLY_CONFIRMED' ? 'Where it is published' : 'Pages showing the company format'}</div>
          <ul className="space-y-1">
            {c.evidence.map((e, i) => (
              <li key={i}><SafeLink url={e.url} /><div className="text-slate-500">{e.snippet}</div></li>
            ))}
          </ul>
        </>
      ) : (
        <div className="text-slate-500">No public evidence: no page shows this address or the company's format. It is derived from common formats.</div>
      )}
      {lookup.visits.length > 0 && (
        <>
          <div className="label">Pages checked</div>
          <ul className="space-y-0.5">
            {lookup.visits.map((v) => (
              <li key={v.url} className="flex justify-between gap-2">
                <SafeLink url={v.url}>{v.url.replace(/^https?:\/\//, '')}</SafeLink>
                <span className={v.status === 'ok' ? 'text-slate-500' : 'text-amber-600'}>{VISIT_TEXT[v.status]}{v.emails ? ` · ${v.emails}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Result({ lookup, onRetry }: { lookup: LookupState; onRetry: () => void }) {
  const [showEv, setShowEv] = useState(false);
  const [showAlt, setShowAlt] = useState(false);
  const cands = lookup.ranking?.candidates ?? [];
  const best = cands[0];
  if (!best) {
    return (
      <div className="card space-y-2" data-testid="result">
        <div className="label">Result</div>
        <div className="text-base font-semibold">Not Found</div>
        <div className="text-sm text-slate-600 dark:text-slate-300">{lookup.error ?? lookup.ranking?.summary ?? 'No supported result.'}</div>
        {lookup.ranking?.notes.map((n) => <div key={n} className="text-xs text-slate-500">{n}</div>)}
        <button className="btn" onClick={onRetry}>RETRY</button>
      </div>
    );
  }
  return (
    <div className="card" data-testid="result">
      <div className="label">{best.status === 'PUBLICLY_CONFIRMED' ? 'Best evidenced email' : 'Best prediction'}</div>
      <div className="mt-1 break-all font-mono text-[15px] font-semibold" data-testid="best-email">{best.email}</div>
      <div className={`mt-2 inline-block rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_TONE[best.status]}`} data-testid="best-status">{STATUS_TEXT[best.status]}</div>
      <div className="mt-2 text-sm">{best.explanation}</div>
      <div className="mt-1 text-xs text-slate-500">Evidence score: {best.score}/100 ({best.strength}) · not a probability</div>
      {lookup.ranking?.notes.map((n) => <div key={n} className="mt-1 text-xs text-amber-700 dark:text-amber-300">{n}</div>)}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <Copy text={best.email} primary />
        <button className="btn" onClick={() => setShowEv(!showEv)}>{showEv ? 'HIDE EVIDENCE' : 'VIEW EVIDENCE'}</button>
        <button className="btn" disabled={cands.length < 2} onClick={() => setShowAlt(!showAlt)}>{showAlt ? 'HIDE ALTERNATIVES' : `SHOW ALTERNATIVES (${cands.length - 1})`}</button>
        <button className="btn" onClick={onRetry}>RETRY</button>
      </div>
      {showEv && <Evidence c={best} lookup={lookup} />}
      {showAlt && (
        <ul className="mt-3 space-y-1.5 border-t border-slate-200 pt-2 dark:border-slate-800" data-testid="alternatives">
          {cands.slice(1).map((c) => (
            <li key={c.email} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">{c.email}</div>
                <div className="text-[11px] text-slate-500">{STATUS_TEXT[c.status]} · score {c.score}</div>
                {c.evidence[0] && c.status === 'PUBLICLY_CONFIRMED' && <SafeLink url={c.evidence[0].url}><span className="text-[11px]">source</span></SafeLink>}
              </div>
              <Copy text={c.email} label="Copy" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Assist({ lookup, tab }: { lookup: LookupState; tab: Tab | null }) {
  const [open, setOpen] = useState(lookup.ranking?.outcome !== 'confirmed');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const report = (r: Awaited<ReturnType<typeof send>>, what: string) =>
    setMsg(r.ok ? `${what}: ${r.found ?? 0} relevant address(es) found${r.skipped ? `; ${r.skipped} tab(s) skipped (no site access)` : ''}.` : r.error);

  const analyzeUrl = async () => {
    setMsg('');
    let u: URL;
    try { u = new URL(url); } catch { setMsg('Enter a full https:// URL.'); return; }
    if (isLinkedIn(url)) { setMsg('LinkedIn pages are not analyzed.'); return; }
    const origins = [`${u.protocol}//${u.hostname}/*`];
    const ok = await requestWithResume(origins, { kind: 'analyzeUrl', origins, url }, async () => report(await send({ type: 'analyzeUrl', url }), 'Analyzed'));
    if (!ok) setMsg('Access to that site was not granted.');
  };
  const openAll = (engine: string) => {
    const urls = lookup.searchLinks.map((l) => l.engines.find((e) => e.name === engine)!.url);
    void chrome.windows.create({ url: urls, focused: true });
  };

  return (
    <div className="card">
      <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(!open)}>
        <span className="label">Search public sources yourself</span>
        <span className="text-xs text-slate-500">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-slate-500">Search engines offer no free API for this, so searches open as normal tabs. Open promising results, then come back here and analyze them.</p>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-slate-500">Open all searches in a new window:</span>
            {['Google', 'Bing', 'DuckDuckGo'].map((e) => <button key={e} className="btn" onClick={() => openAll(e)}>{e}</button>)}
          </div>
          {lookup.searchLinks.map((l) => (
            <div key={l.query}>
              <div className="font-medium">{l.label}</div>
              <div className="truncate font-mono text-[11px] text-slate-500" title={l.query}>{l.query}</div>
              <div className="mt-0.5 flex gap-1">
                {l.engines.map((e) => <button key={e.name} className="btn" onClick={() => chrome.tabs.create({ url: e.url })}>{e.name}</button>)}
              </div>
            </div>
          ))}
          <div className="space-y-1.5 border-t border-slate-200 pt-2 dark:border-slate-800">
            {isWebUrl(tab?.url) && (
              <button className="btn w-full" onClick={async () => report(await send({ type: 'analyzeTab', tabId: tab!.id! }), 'This page')}>Analyze current tab</button>
            )}
            {tab?.windowId != null && (
              <button className="btn w-full" onClick={async () => report(await send({ type: 'analyzeTabs', windowId: tab.windowId }), 'Open tabs in this window')}>
                Analyze all open result tabs in this window
              </button>
            )}
            <div className="flex gap-1">
              <input className="input" aria-label="Page URL" placeholder="…or paste a public page URL" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn" onClick={analyzeUrl}>Analyze</button>
            </div>
            <p className="text-[11px] text-slate-500">Tip: right-click any page → “Email Finder: analyze this page”.</p>
            {msg && <div className="text-slate-600 dark:text-slate-300" data-testid="assist-msg">{msg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Situational messages; never a success state unless the evidence supports it. */
function StatusMessages({ lookup, online }: { lookup: LookupState; online: boolean }) {
  const out: { tone: 'info' | 'warn' | 'error'; text: string }[] = [];
  if (!online) out.push({ tone: 'error', text: 'You are offline. Discovery needs an internet connection.' });
  if (lookup.errorKind === 'offline') out.push({ tone: 'error', text: lookup.error! });
  else if (lookup.errorKind === 'no-domain') out.push({ tone: 'warn', text: lookup.error! });
  else if (lookup.errorKind === 'cancelled' || lookup.errorKind === 'interrupted' || lookup.errorKind === 'internal') out.push({ tone: 'warn', text: lookup.error! });
  if (lookup.done && !lookup.dnsOk && lookup.domain?.domain) out.push({ tone: 'error', text: 'DNS validation failed; results could not be checked.' });
  const blocked = lookup.visits.filter((v) => v.status === 'blocked' || v.status === 'robots').length;
  if (blocked) out.push({ tone: 'warn', text: `${blocked} page(s) blocked automated access or are disallowed by robots.txt. Open them yourself and use “Analyze current tab”.` });
  const r = lookup.ranking;
  if (r && lookup.done) out.push({ tone: r.outcome === 'confirmed' ? 'info' : 'warn', text: r.summary });
  return <>{out.map((m) => <Notice key={m.text} tone={m.tone}>{m.text}</Notice>)}</>;
}

export default function App() {
  const { lookup: stored, identity, setIdentity } = useSession();
  const [tab, setTab] = useState<Tab | null>(null);
  const [website, setWebsite] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [reading, setReading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true); const down = () => setOnline(false);
    addEventListener('online', up); addEventListener('offline', down);
    return () => { removeEventListener('online', up); removeEventListener('offline', down); };
  }, []);

  useEffect(() => {
    (async () => {
      // ?tabId= lets automated tests target a tab; normally the popup uses the active tab.
      const forced = Number(new URLSearchParams(location.search).get('tabId'));
      const t = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      setTab(t ?? null);
      if (t?.id != null && isProfileUrl(t.url)) {
        const r = await send({ type: 'readProfile', tabId: t.id }).catch((e) => ({ ok: false as const, error: String(e) }));
        if (r.ok && r.identity) setIdentity(r.identity);
        else if (!r.ok) setErr(r.error);
      } else if (isLinkedIn(t?.url)) {
        setNotice('Profile not detected: open a person’s profile (linkedin.com/in/…), or enter details below.');
      }
      setReading(false);
    })();
  }, [setIdentity]);

  // Show a stored lookup only if it belongs to the person on screen (or we're analyzing another site).
  const current = identity ?? identityFromManual({ name: '', company: '' });
  const belongs = !!stored && (!identity || stored.key === identityKey(identity) || isWebUrl(tab?.url));
  const lookup = belongs ? stored : null;
  const stale = !!lookup && isStale(lookup);
  const running = !!lookup && !lookup.done && !stale;

  useEffect(() => { if (lookup?.website) setWebsite(lookup.website); }, [lookup?.website]);

  const find = async (id: Identity = current, site: string = website) => {
    setErr('');
    const r = await send({ type: 'find', identity: id, website: site || null });
    if (!r.ok) setErr(r.error);
  };

  const scanSite = async (domain: string, all = false) => {
    const origins = all ? ['https://*/*'] : siteOrigins(domain);
    const site = website || domain;
    const ok = await requestWithResume(origins, { kind: 'scan', origins, identity: lookup!.identity, website: site }, () => void find(lookup!.identity, site));
    if (!ok) setErr(`Permission not granted. Without access to ${domain}, only predictions are shown.`);
  };

  return (
    <div className="space-y-2.5 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-sm font-bold tracking-tight">Email Finder</h1>
        <button className="text-xs text-slate-500 hover:underline" onClick={() => { void send({ type: 'clear' }); setIdentity(null); setWebsite(''); }}>Clear</button>
      </header>

      {reading ? (
        <div className="card text-sm text-slate-500">Reading profile…</div>
      ) : (
        <>
          {notice && <Notice tone="warn">{notice}</Notice>}
          {!identity && !isLinkedIn(tab?.url) && !lookup && <div className="text-xs text-slate-500">Open a LinkedIn profile, or enter details below.</div>}
          <PersonCard
            identity={current}
            website={website}
            editable={!running}
            onChange={(i, site) => { setIdentity(i); setWebsite(site); void send({ type: 'saveIdentity', identity: i }); }}
          />
          {err && <Notice tone="error">{err}</Notice>}
          <button className="btn-primary" disabled={running || !online || !current.name.first || (!current.company && !website)} onClick={() => find()}>
            {running ? 'SEARCHING…' : 'FIND PROFESSIONAL EMAIL'}
          </button>
          {running && <button className="btn w-full" onClick={() => send({ type: 'cancel' })}>Cancel</button>}
        </>
      )}

      {lookup && (
        <>
          <Progress lookup={lookup} />
          {stale && <Notice tone="warn">This lookup stopped responding (the extension was suspended). Press Retry.</Notice>}
          <StatusMessages lookup={lookup} online={online} />
          <DomainCard lookup={lookup} onUse={(d) => { setWebsite(d); void find(lookup.identity, d); }} />
          {lookup.needsSitePermission && lookup.domain?.domain && (
            <div className="card space-y-2 text-xs" data-testid="permission">
              <div><b>Permission needed.</b> Allow access to <b>{lookup.domain.domain}</b> to scan its public team, about, press and contact pages for published addresses. Until then, results are predictions only.</div>
              <div className="flex gap-1">
                <button className="btn" onClick={() => scanSite(lookup.domain!.domain!)}>Allow &amp; scan</button>
                <button className="btn" onClick={() => scanSite(lookup.domain!.domain!, true)}>Allow all sites</button>
              </div>
            </div>
          )}
          {(lookup.done || stale) && <Result lookup={lookup} onRetry={() => find(lookup.identity, website)} />}
          {lookup.done && lookup.searchLinks.length > 0 && <Assist lookup={lookup} tab={tab} />}
          {lookup.done && (
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer">How scores work</summary>
              <p className="mt-1">Scores add fixed points for evidence found in this lookup (exact address published +{WEIGHTS.exactPublished}, next to the person’s name +{WEIGHTS.nameAdjacent}, matches the company’s observed format up to +{WEIGHTS.conventionMax}, no mail server {WEIGHTS.noMx}). They rank candidates; they are not the probability that a mailbox exists. Mailboxes are never probed.</p>
            </details>
          )}
        </>
      )}
      <footer className="pt-1 text-center text-[10px] text-slate-400">Local algorithms only · nothing stored after the browser session</footer>
    </div>
  );
}
