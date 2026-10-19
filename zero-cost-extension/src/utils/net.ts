// Networking primitives: timeouts, per-host rate limiting, limited concurrency, robots.txt.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class NetError extends Error {
  constructor(message: string, public kind: 'timeout' | 'offline' | 'http' | 'blocked' | 'robots' | 'aborted' | 'other', public status?: number) {
    super(message);
  }
}

export interface NetDeps {
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchWithTimeout(deps: NetDeps, url: string, init: RequestInit = {}, timeoutMs = 10000, outer?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await deps.fetch(url, { ...init, signal: ctl.signal, credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    if (outer?.aborted) throw new NetError('Cancelled', 'aborted');
    if (ctl.signal.aborted) throw new NetError(`Timed out after ${timeoutMs / 1000}s`, 'timeout');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new NetError('You appear to be offline', 'offline');
    throw new NetError((e as Error).message || 'Network error', 'other');
  } finally {
    clearTimeout(t);
    outer?.removeEventListener('abort', onAbort);
  }
}

/** Minimum interval between requests to the same host. */
export class HostRateLimiter {
  private next = new Map<string, number>();
  constructor(private intervalMs: number, private deps: NetDeps) {}

  async wait(url: string): Promise<void> {
    const host = new URL(url).host;
    const now = (this.deps.now ?? Date.now)();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.intervalMs);
    if (at > now) await (this.deps.sleep ?? defaultSleep)(at - now);
  }
}

/** Run tasks with at most `limit` in flight; results in input order (allSettled semantics). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------- robots.txt ----------------

interface RobotsGroup { agents: string[]; rules: { allow: boolean; path: string }[] }

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      if (val || key === 'allow') cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (!rulePath) return false;
  const re = new RegExp('^' + rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
}

/** Longest-match semantics (RFC 9309). Uses the group for `agent` or `*`. */
export function robotsAllows(groups: RobotsGroup[], url: string, agent = 'zero-cost-email-finder'): boolean {
  const u = new URL(url);
  const path = u.pathname + u.search;
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)))
    ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (ruleMatches(r.path, path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) {
      best = { allow: r.allow, len: r.path.length };
    }
  }
  return best ? best.allow : true;
}
