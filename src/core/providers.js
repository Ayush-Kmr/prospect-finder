// Licensed contact-data providers. Each returns a normalized result:
//   { source, emails: [{value, type, status, confidence}], phones: [{value, type}],
//     domain?, pattern?, acceptAll? }
// Every provider is optional; it is skipped when its key is not configured.

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) return null; // "no match" on PDL / Hunter
  if (!res.ok) {
    const msg = body?.error?.message || body?.errors?.[0]?.details || body?.error || res.statusText;
    throw new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}

// ---------- Apollo (official API: POST /api/v1/people/match) ----------
// Note: Apollo only reveals mobile numbers asynchronously via a webhook URL,
// so this returns work/personal emails, any phones already on the record and
// the company switchboard number.
export async function apollo(person, s, fetchImpl = fetch) {
  const body = await getJson(fetchImpl, 'https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-api-key': s.apolloKey },
    body: JSON.stringify({
      first_name: person.first_name || undefined,
      last_name: person.last_name || undefined,
      organization_name: person.current_company || undefined,
      domain: person.domain || undefined,
      linkedin_url: person.linkedin_url || undefined,
      reveal_personal_emails: !!s.revealPersonalEmails,
    }),
  });
  const p = body?.person;
  if (!p) return { source: 'Apollo', emails: [], phones: [] };
  const emails = [];
  if (str(p.email) && !/email_not_unlocked/.test(p.email)) {
    const verified = p.email_status === 'verified';
    emails.push({ value: p.email, type: 'work', status: p.email_status || 'unknown', confidence: verified ? 0.95 : 0.7 });
  }
  (p.personal_emails || []).filter(str).forEach((e) => emails.push({ value: e, type: 'personal', status: 'unknown', confidence: 0.6 }));
  const phones = [];
  (p.phone_numbers || []).forEach((n) => {
    const v = str(n.sanitized_number) || str(n.raw_number);
    if (v) phones.push({ value: v, type: n.type || 'direct' });
  });
  const orgPhone = str(p.organization?.sanitized_phone) || str(p.organization?.phone);
  if (orgPhone) phones.push({ value: orgPhone, type: 'company' });
  return { source: 'Apollo', emails, phones, domain: str(p.organization?.primary_domain) };
}

// ---------- People Data Labs (GET /v5/person/enrich) ----------
export async function pdl(person, s, fetchImpl = fetch) {
  const q = new URLSearchParams({ min_likelihood: '6', titlecase: 'false' });
  if (person.linkedin_url) q.set('profile', person.linkedin_url);
  if (person.full_name) q.set('name', person.full_name);
  if (person.current_company) q.set('company', person.current_company);
  const body = await getJson(fetchImpl, `https://api.peopledatalabs.com/v5/person/enrich?${q}`, {
    headers: { 'x-api-key': s.pdlKey },
  });
  const d = body?.data;
  if (!d) return { source: 'PDL', emails: [], phones: [] };
  const conf = Math.min(0.9, 0.5 + (body.likelihood || 0) * 0.04);
  const emails = [];
  // Some PDL plans return `true` instead of the value for gated fields; str() drops those.
  if (str(d.work_email)) emails.push({ value: d.work_email, type: 'work', status: 'unverified', confidence: conf });
  (d.emails || []).forEach((e) => {
    const v = str(e?.address);
    if (v) emails.push({ value: v, type: e.type === 'professional' ? 'work' : (e.type || 'other'), status: 'unverified', confidence: conf - 0.1 });
  });
  (d.personal_emails || []).filter(str).forEach((v) => emails.push({ value: v, type: 'personal', status: 'unverified', confidence: conf - 0.1 }));
  const phones = [];
  if (str(d.mobile_phone)) phones.push({ value: d.mobile_phone, type: 'mobile' });
  (d.phone_numbers || []).filter(str).forEach((v) => phones.push({ value: v, type: 'other' }));
  return { source: 'PDL', emails, phones, domain: str(d.job_company_website) };
}

// ---------- Hunter ----------
export async function hunterDomain(company, s, fetchImpl = fetch) {
  const q = new URLSearchParams({ company, limit: '1', api_key: s.hunterKey });
  const body = await getJson(fetchImpl, `https://api.hunter.io/v2/domain-search?${q}`);
  const d = body?.data;
  return d ? { domain: str(d.domain), pattern: str(d.pattern), acceptAll: !!d.accept_all } : null;
}

export async function hunterFinder(person, s, fetchImpl = fetch) {
  if (!person.domain || !person.first_name || !person.last_name) return { source: 'Hunter', emails: [], phones: [] };
  const q = new URLSearchParams({
    domain: person.domain, first_name: person.first_name, last_name: person.last_name, api_key: s.hunterKey,
  });
  const body = await getJson(fetchImpl, `https://api.hunter.io/v2/email-finder?${q}`);
  const d = body?.data;
  const emails = [];
  const phones = [];
  if (str(d?.email)) {
    const status = d.verification?.status || 'unknown';
    const score = (d.score || 0) / 100;
    emails.push({ value: d.email, type: 'work', status, confidence: status === 'valid' ? Math.max(0.9, score) : score });
  }
  if (str(d?.phone_number)) phones.push({ value: d.phone_number, type: 'direct' });
  return { source: 'Hunter', emails, phones };
}

export async function hunterVerify(email, s, fetchImpl = fetch) {
  const q = new URLSearchParams({ email, api_key: s.hunterKey });
  const body = await getJson(fetchImpl, `https://api.hunter.io/v2/email-verifier?${q}`);
  return body?.data ? { status: body.data.status, score: (body.data.score || 0) / 100 } : null;
}
