// Free DNS checks via public DNS-over-HTTPS (Cloudflare, Google fallback).
// No SMTP. MX presence means the domain accepts mail, never that a mailbox exists.
import { fetchWithTimeout, NetError, type NetDeps } from '../utils/net';

const ENDPOINTS = [
  (name: string, type: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  (name: string, type: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
];
const TYPE_CODE: Record<string, number> = { A: 1, CNAME: 5, MX: 15, AAAA: 28 };

export interface DnsResult { ok: boolean; records: string[]; error?: string }

export class DnsValidator {
  private cache = new Map<string, Promise<DnsResult>>(); // per-lookup memory only
  constructor(private deps: NetDeps, private timeoutMs = 6000) {}

  query(name: string, type: 'A' | 'MX' | 'AAAA'): Promise<DnsResult> {
    const key = `${type}:${name}`;
    if (!this.cache.has(key)) this.cache.set(key, this.queryUncached(name, type));
    return this.cache.get(key)!;
  }

  private async queryUncached(name: string, type: string): Promise<DnsResult> {
    let lastErr = '';
    for (const ep of ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(this.deps, ep(name, type), { headers: { accept: 'application/dns-json' } }, this.timeoutMs);
        if (!res.ok) { lastErr = `DNS HTTP ${res.status}`; continue; }
        const body = await res.json() as { Status: number; Answer?: { type: number; data: string }[] };
        if (body.Status === 3) return { ok: true, records: [] }; // NXDOMAIN
        if (body.Status !== 0) { lastErr = `DNS status ${body.Status}`; continue; }
        const records = (body.Answer ?? [])
          .filter((a) => a.type === TYPE_CODE[type])
          .map((a) => (type === 'MX' ? a.data.split(/\s+/).pop()! : a.data).replace(/\.$/, '').toLowerCase())
          .filter((r) => r && r !== '.');
        return { ok: true, records };
      } catch (e) {
        lastErr = e instanceof NetError ? e.message : String(e);
        if (e instanceof NetError && e.kind === 'offline') break;
      }
    }
    return { ok: false, records: [], error: lastErr || 'DNS lookup failed' };
  }

  async mx(domain: string) { return this.query(domain, 'MX'); }

  async resolves(domain: string): Promise<DnsResult> {
    const a = await this.query(domain, 'A');
    if (!a.ok || a.records.length) return a;
    return this.query(`www.${domain}`, 'A');
  }
}

export const EMAIL_SYNTAX = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function validSyntax(email: string): boolean {
  return EMAIL_SYNTAX.test(email) && !email.includes('..');
}

export function mailHostLabel(mx: string[]): string {
  const s = mx.join(' ');
  if (/google\.com|googlemail\.com/.test(s)) return 'Google Workspace';
  if (/outlook\.com|microsoft\.com/.test(s)) return 'Microsoft 365';
  if (/pphosted|mimecast|barracuda|messagelabs|iphmx|proofpoint/.test(s)) return 'Email security gateway';
  if (/zoho/.test(s)) return 'Zoho Mail';
  return mx.length ? 'Other mail provider' : 'No mail server';
}
