export type EmailStatus =
  | 'PUBLICLY_CONFIRMED'
  | 'PROVIDER_VERIFIED'
  | 'PATTERN_PREDICTED'
  | 'DOMAIN_VALID_ONLY'
  | 'UNVERIFIED'
  | 'NOT_FOUND';

export interface Candidate {
  email: string;
  status: EmailStatus;
  confidence: number;
  pattern: string | null;
  basis: string;
  source_url: string | null;
  verification: Record<string, unknown>;
}

export interface EvidenceItem {
  kind: string;
  url: string | null;
  snippet: string;
  email: string | null;
}

export interface Contact {
  id: number;
  linkedin_url: string | null;
  full_name: string;
  company: string;
  title: string;
  company_website: string | null;
  company_domain: string | null;
  domain_confidence: number;
  best_email: string | null;
  email_status: EmailStatus;
  confidence: number;
  explanation: string;
  warnings: string[];
  phone: string;
  job_link: string;
  mailed: boolean;
  called: boolean;
  notes: string;
  extra: Record<string, string>;
  created_at: string;
  updated_at: string;
  candidates: Candidate[];
  evidence: EvidenceItem[];
}

export interface DiscoverInput {
  linkedin_url?: string;
  full_name?: string;
  company?: string;
  company_domain?: string;
  title?: string;
  profile_text?: string;
  job_link?: string;
  force_refresh?: boolean;
}

export interface BatchItemResult {
  ok: boolean;
  contact?: Contact;
  input?: DiscoverInput;
  error?: string;
}

export interface Health {
  status: string;
  ai_provider: string | null;
  search_provider: string;
  verification_provider: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body?.detail;
    const msg = Array.isArray(detail) ? detail.map((d: { msg: string }) => d.msg).join('; ') : detail;
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const clean = (o: DiscoverInput) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));

export const api = {
  health: () => req<Health>('/api/health'),
  discover: (input: DiscoverInput) => req<Contact>('/api/contacts/discover', json('POST', clean(input))),
  list: (q: string, status: string) =>
    req<Contact[]>(`/api/contacts?${new URLSearchParams({ q, status, limit: '500' })}`),
  patch: (id: number, patch: Partial<Contact>) => req<Contact>(`/api/contacts/${id}`, json('PATCH', patch)),
  remove: (id: number) => req<void>(`/api/contacts/${id}`, { method: 'DELETE' }),
  batchCsv: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<BatchItemResult[]>('/api/contacts/batch/csv', { method: 'POST', body: fd });
  },
  exportUrl: (q: string, status: string) => `/api/contacts/export?${new URLSearchParams({ q, status })}`,
};
