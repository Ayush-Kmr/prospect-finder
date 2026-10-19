import { useCallback, useEffect, useState } from 'react';
import { api, type BatchItemResult, type Contact, type DiscoverInput, type EmailStatus, type Health } from './api';

const STATUS_LABEL: Record<EmailStatus, { label: string; tone: string; help: string }> = {
  PUBLICLY_CONFIRMED: { label: 'Found', tone: 'good', help: 'Published on a public page tied to this person' },
  PROVIDER_VERIFIED: { label: 'Found', tone: 'good', help: 'Verified by an authorized verification provider' },
  PATTERN_PREDICTED: { label: 'Predicted', tone: 'warn', help: "Built from the company's observed email format" },
  DOMAIN_VALID_ONLY: { label: 'Unverified', tone: 'muted', help: 'Common format; only the domain is known to accept mail' },
  UNVERIFIED: { label: 'Unverified', tone: 'bad', help: 'Guess; the domain could not be validated' },
  NOT_FOUND: { label: 'Not found', tone: 'bad', help: 'No address found or predicted' },
};

function StatusBadge({ status }: { status: EmailStatus }) {
  const s = STATUS_LABEL[status];
  return (
    <span className={`badge ${s.tone}`} title={`${status}: ${s.help}`}>
      {s.label}
    </span>
  );
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="conf" title={`${pct}% confidence`}>
      <span className="bar"><span style={{ width: `${pct}%` }} /></span>
      {pct}%
    </span>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost small"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function ResultCard({ c }: { c: Contact }) {
  return (
    <section className="card result">
      <div className="result-head">
        <div>
          <h2>{c.full_name || 'Unknown person'}</h2>
          <div className="muted">
            {[c.title, c.company].filter(Boolean).join(' · ')}
            {c.company_domain && (
              <>
                {' · '}
                <a href={c.company_website || `https://${c.company_domain}`} target="_blank" rel="noreferrer">
                  {c.company_domain}
                </a>{' '}
                <span title="Domain confidence">({Math.round(c.domain_confidence * 100)}%)</span>
              </>
            )}
          </div>
          {c.linkedin_url && (
            <a className="muted small-text" href={c.linkedin_url} target="_blank" rel="noreferrer">
              {c.linkedin_url}
            </a>
          )}
        </div>
        <StatusBadge status={c.email_status} />
      </div>

      {c.best_email ? (
        <div className="best">
          <code>{c.best_email}</code>
          <Copy text={c.best_email} />
          <Confidence value={c.confidence} />
        </div>
      ) : (
        <div className="best muted">No email</div>
      )}
      <p className="explain">{c.explanation}</p>
      {c.warnings.map((w) => (
        <div key={w} className="warning">⚠ {w}</div>
      ))}

      {c.candidates.length > 0 && (
        <>
          <h3>Candidates</h3>
          <table>
            <thead>
              <tr><th>Email</th><th>Status</th><th>Confidence</th><th>Basis</th></tr>
            </thead>
            <tbody>
              {c.candidates.map((x) => (
                <tr key={x.email}>
                  <td><code>{x.email}</code></td>
                  <td><StatusBadge status={x.status} /></td>
                  <td><Confidence value={x.confidence} /></td>
                  <td className="small-text">
                    {x.basis}
                    {x.source_url && (
                      <> <a href={x.source_url} target="_blank" rel="noreferrer">source</a></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {c.evidence.length > 0 && (
        <>
          <h3>Evidence</h3>
          <ul className="evidence">
            {c.evidence.map((e, i) => (
              <li key={i}>
                <span className="kind">{e.kind.replace('_', ' ')}</span>
                <span className="small-text">{e.snippet}</span>
                {e.url && (
                  <a className="small-text" href={e.url} target="_blank" rel="noreferrer">{e.url}</a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DiscoverForm({ onResult }: { onResult: (c: Contact) => void }) {
  const [f, setF] = useState<DiscoverInput>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showText, setShowText] = useState(false);
  const set = (k: keyof DiscoverInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      onResult(await api.discover(f));
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Find professional email</h2>
      <label>
        LinkedIn profile URL
        <input placeholder="https://www.linkedin.com/in/…" value={f.linkedin_url || ''} onChange={set('linkedin_url')} />
      </label>
      <div className="grid2">
        <label>
          Full name
          <input placeholder="Jane Smith" value={f.full_name || ''} onChange={set('full_name')} />
        </label>
        <label>
          Company
          <input placeholder="Northwind Robotics" value={f.company || ''} onChange={set('company')} />
        </label>
        <label>
          Company domain <span className="muted">(optional)</span>
          <input placeholder="northwindrobotics.example" value={f.company_domain || ''} onChange={set('company_domain')} />
        </label>
        <label>
          Job link <span className="muted">(optional)</span>
          <input placeholder="https://…" value={f.job_link || ''} onChange={set('job_link')} />
        </label>
      </div>
      <button type="button" className="ghost small" onClick={() => setShowText(!showText)}>
        {showText ? 'Hide' : 'Paste'} profile text (parsed by AI)
      </button>
      {showText && (
        <textarea rows={6} placeholder="Paste the profile text you copied…" value={f.profile_text || ''} onChange={set('profile_text')} />
      )}
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={!!f.force_refresh} onChange={(e) => setF({ ...f, force_refresh: e.target.checked })} />
          Refresh (ignore saved result)
        </label>
        <button className="primary" disabled={busy}>{busy ? 'Searching public sources…' : 'Find email'}</button>
      </div>
      <p className="muted small-text">
        LinkedIn pages are never fetched. The URL is stored for your records; give the name and company (or paste profile text) to search.
      </p>
      {err && <div className="error">{err}</div>}
    </form>
  );
}

function BatchUpload({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  async function upload(file: File) {
    setBusy(true);
    setSummary('');
    try {
      const res: BatchItemResult[] = await api.batchCsv(file);
      const ok = res.filter((r) => r.ok);
      const found = ok.filter((r) => ['PUBLICLY_CONFIRMED', 'PROVIDER_VERIFIED'].includes(r.contact!.email_status)).length;
      const predicted = ok.filter((r) => r.contact!.email_status === 'PATTERN_PREDICTED').length;
      setSummary(`${res.length} rows · ${found} found · ${predicted} predicted · ${res.length - ok.length} failed`);
      onDone();
    } catch (e) {
      setSummary((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Batch CSV</h2>
      <p className="muted small-text">Columns: Person Name, Company, LinkedIn URL, Company Domain, Title, Job Link.</p>
      <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      {busy && <p className="muted">Processing…</p>}
      {summary && <p>{summary}</p>}
    </section>
  );
}

function EditableCell({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="cell"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function History({ refreshKey, onSelect }: { refreshKey: number; onSelect: (c: Contact) => void }) {
  const [rows, setRows] = useState<Contact[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.list(q, status).then(setRows).catch((e) => setErr(e.message));
  }, [q, status]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  async function patch(c: Contact, p: Partial<Contact>) {
    const updated = await api.patch(c.id, p);
    setRows((rs) => rs.map((r) => (r.id === c.id ? updated : r)));
  }

  return (
    <section className="card">
      <div className="row">
        <h2>Contacts</h2>
        <div className="row">
          <input placeholder="Search name, company, email…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="PUBLICLY_CONFIRMED,PROVIDER_VERIFIED">Found</option>
            <option value="PATTERN_PREDICTED">Predicted</option>
            <option value="DOMAIN_VALID_ONLY,UNVERIFIED">Unverified</option>
            <option value="NOT_FOUND">Not found</option>
          </select>
          <a className="button" href={api.exportUrl(q, status)}>Export CSV</a>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Person</th><th>Company</th><th>Email</th><th>Status</th><th>Conf.</th>
              <th>Contact number</th><th>Job link</th><th>Mailed</th><th>Called</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><button className="link" onClick={() => onSelect(c)}>{c.full_name || '—'}</button></td>
                <td>{c.company}</td>
                <td>{c.best_email ? <code>{c.best_email}</code> : <span className="muted">—</span>}</td>
                <td><StatusBadge status={c.email_status} /></td>
                <td>{Math.round(c.confidence * 100)}%</td>
                <td><EditableCell value={c.phone} placeholder="business no." onSave={(phone) => patch(c, { phone })} /></td>
                <td><EditableCell value={c.job_link} placeholder="https://…" onSave={(job_link) => patch(c, { job_link })} /></td>
                <td><input type="checkbox" checked={c.mailed} onChange={(e) => patch(c, { mailed: e.target.checked })} /></td>
                <td><input type="checkbox" checked={c.called} onChange={(e) => patch(c, { called: e.target.checked })} /></td>
                <td>
                  <button className="ghost small" onClick={async () => { await api.remove(c.id); load(); }}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={10} className="muted">No contacts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function App() {
  const [result, setResult] = useState<Contact | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Contact Discovery</h1>
        <div className="muted small-text">
          {health
            ? `AI: ${health.ai_provider ?? 'off'} · Search: ${health.search_provider} · Verifier: ${health.verification_provider ?? 'off'}`
            : 'API offline'}
        </div>
      </header>
      <main>
        <div className="left">
          <DiscoverForm onResult={(c) => { setResult(c); setRefreshKey((k) => k + 1); }} />
          <BatchUpload onDone={() => setRefreshKey((k) => k + 1)} />
        </div>
        <div className="right">{result ? <ResultCard c={result} /> : <section className="card muted">Results appear here.</section>}</div>
      </main>
      <History refreshKey={refreshKey} onSelect={setResult} />
    </div>
  );
}
