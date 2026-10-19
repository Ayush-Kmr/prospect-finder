// One Claude request per lookup: parse the profile, then research public sources
// (server-side web search + web fetch) for the person's published work email and
// the company's email format. Claude's claims are checked in code against the text
// it actually retrieved, so "published" means we saw the address, not that the model said so.
//
// Raw fetch rather than the SDK: this runs inside an unbundled MV3 service worker
// and in a dependency-free Node CLI.

// People-search / data-broker sites: paywalled, often wrong, and not public publication.
const BLOCKED = [
  'linkedin.com', 'rocketreach.co', 'zoominfo.com', 'contactout.com', 'lusha.com', 'apollo.io',
  'signalhire.com', 'leadiq.com', 'seamless.ai', 'adapt.io', 'datanyze.com', 'clearbit.com',
];

// Two depths. The quick pass has tight caps (every search/fetch is a round trip, and their
// results are most of the input tokens); the deep pass runs only when the quick one found
// nothing verifiable. Haiku only supports the basic tool versions.
const DEPTH = {
  quick: { effort: 'low', searches: 3, fetches: 2 },
  deep: { effort: 'medium', searches: 5, fetches: 4 },
};

function tools(model, depth) {
  const basic = /haiku/.test(model);
  return [
    { type: basic ? 'web_search_20250305' : 'web_search_20260209', name: 'web_search', max_uses: depth.searches, blocked_domains: BLOCKED },
    { type: basic ? 'web_fetch_20250910' : 'web_fetch_20260209', name: 'web_fetch', max_uses: depth.fetches, blocked_domains: BLOCKED, max_content_tokens: 6000 },
  ];
}

const DEEP_HINT = `A quick first pass found nothing verifiable. Try different sources than before: press releases and news with media contacts, PDFs (filetype:pdf "@domain"), conference speaker and event pages, GitHub profiles and READMEs, the person's personal site or blog, the company's contact/careers/legal/privacy pages, regional or subsidiary sites, and other people at the company with the same role (recruiters often list their address on job posts).`;

const SYSTEM = `You find the professional contact email of the person whose LinkedIn profile text you are given, using only public web sources.
Research only that one person (the profile owner named in the page heading). Ignore anyone else the page text mentions: suggested profiles, endorsers, commenters, colleagues.

Steps:
1. From the profile text, identify the person's name, current title, current employer (for agency recruiters, the agency) and location.
2. Find the employer's corporate email domain. It can differ from the website (rebrands, acquisitions, regional domains), so check.
3. Look for the person's own address published publicly: company team/contact/press pages, personal site, GitHub, talks, papers, press releases. Useful queries: "First Last" "@domain"; "First Last" Company email.
4. Look for the company's email format: addresses of other named employees published on public pages (press contacts, team pages, PDFs). Collect up to 4 different people on the person's own email domain, so the format can be cross-checked.
5. Open a page with web_fetch before reporting an address from it. Report only addresses that appear verbatim on a page you fetched or in a search result, copied exactly. Never construct or guess an address in public_emails or pattern_evidence.
6. Be careful with namesakes: only put an address in public_emails if the page ties it to this person (same name and same employer or role). Team inboxes (hr@, careers@, info@) are fine to report, but don't mistake them for the person's own address.

Be fast: run your first searches together in one step (the person's own address, and the company's email format), fetch only pages whose snippet suggests an address, stop as soon as you have the person's own published address, and don't repeat searches. If nothing is published, say so; that is a normal outcome.

End with only a JSON object in a \`\`\`json code block, with these fields:
{
  "first_name": "", "last_name": "", "full_name": "",
  "current_title": "", "current_company": "", "company_email_domain": "",
  "company_domain_guesses": ["up to 3 corporate email domains, most likely first"],
  "location": "", "is_recruiter": false,
  "public_emails": [{"email": "", "url": "page where it appears", "context": "short quote around it"}],
  "pattern_evidence": [{"email": "", "first_name": "", "last_name": "", "url": ""}],
  "email_patterns_ranked": ["up to 5 of {first}.{last} {f}{last} {first} {first}{l} {first}_{last} etc., most likely first"],
  "notes": "one line on what you found"
}
Names: drop credentials, emojis, pronouns and bracketed nicknames ("Jane Doe, SHRM-CP (she/her)" -> "Jane", "Doe"); keep accents. Use "" or [] for unknowns.`;

const MAX_CONTINUATIONS = 3;

// `onStep(text)` gets live progress ("Searching: …", "Reading example.com") while Claude works.
// `deep` asks for a second, broader pass that avoids the searches in `tried`.
export async function researchProfile(profile, settings, fetchImpl = fetch, onStep = () => {}, { deep = false, tried = [] } = {}) {
  if (!settings.anthropicKey) throw new Error('Add your Anthropic API key in Settings.');
  const model = settings.anthropicModel || 'claude-opus-5-5';
  const depth = deep ? DEPTH.deep : DEPTH.quick;
  const hint = deep ? `\n\n${DEEP_HINT}${tried.length ? `\nAlready searched: ${tried.map((q) => `"${q}"`).join('; ')}` : ''}` : '';
  const user = { role: 'user', content: `Profile URL: ${profile.url || ''}\nPage heading: ${profile.heading || ''}\n\nPage text:\n"""\n${profile.text || ''}\n"""${hint}` };

  const content = [];
  const usage = { provider: 'anthropic', model, input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let body;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    // On pause_turn, resend the turn so far; the server resumes where it stopped.
    const messages = content.length ? [user, { role: 'assistant', content }] : [user];
    body = await call(model, depth, messages, settings, fetchImpl, onStep);
    content.push(...(body.content || []));
    usage.model = body.model || model;
    usage.input_tokens += body.usage?.input_tokens || 0;
    usage.output_tokens += body.usage?.output_tokens || 0;
    usage.web_searches += body.usage?.server_tool_use?.web_search_requests || 0;
    if (body.stop_reason !== 'pause_turn') break;
  }
  if (body.stop_reason === 'refusal') throw new Error('Claude declined this request (refusal).');
  if (body.stop_reason === 'max_tokens') throw new Error('Claude response truncated (max_tokens).');

  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const queries = content.filter((b) => b.type === 'server_tool_use' && b.name === 'web_search' && b.input?.query).map((b) => b.input.query);
  return { data: normalize(lastJson(text)), sources: retrievedText(content), usage, queries };
}

async function call(model, depth, messages, s, fetchImpl, onStep) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      // Required for calls from a browser/extension origin.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: tools(model, depth),
      // Structured outputs can't be combined with web-search citations, so the JSON
      // comes back in a fenced block and is validated by normalize().
      // Quick pass at low effort (fewer, consolidated tool calls); the deep pass reasons more.
      output_config: { effort: depth.effort },
      fallbacks: 'default',
      stream: true,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Anthropic ${res.status}: ${body?.error?.message || res.statusText}`);
  }
  if (!/event-stream/.test(res.headers.get('content-type') || '')) return res.json();
  return readStream(res, onStep);
}

// Rebuilds the final message from SSE events, reporting each search and page as it starts.
// Blocks are kept exactly as streamed (thinking signatures included) for pause_turn resends.
async function readStream(res, onStep) {
  const msg = { content: [], usage: {} };
  const partial = new Map(); // block index -> accumulated tool-input JSON
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, cut).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      buf = buf.slice(cut + 2);
      if (data) applyEvent(msg, partial, JSON.parse(data), onStep);
    }
  }
  return msg;
}

function applyEvent(msg, partial, ev, onStep) {
  switch (ev.type) {
    case 'message_start':
      Object.assign(msg, { ...ev.message, content: [] });
      break;
    case 'content_block_start':
      msg.content[ev.index] = structuredClone(ev.content_block);
      break;
    case 'content_block_delta': {
      const b = msg.content[ev.index];
      const d = ev.delta;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'input_json_delta') partial.set(ev.index, (partial.get(ev.index) || '') + d.partial_json);
      else if (d.type === 'citations_delta') (b.citations ||= []).push(d.citation);
      else if (d.type === 'thinking_delta') b.thinking += d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      break;
    }
    case 'content_block_stop': {
      const b = msg.content[ev.index];
      if (partial.has(ev.index)) {
        try { b.input = JSON.parse(partial.get(ev.index) || '{}'); } catch { b.input = {}; }
        partial.delete(ev.index);
      }
      if (b.type === 'server_tool_use' && b.name === 'web_search' && b.input?.query) onStep(`Searching: ${b.input.query}`);
      if (b.type === 'server_tool_use' && b.name === 'web_fetch' && b.input?.url) onStep(`Reading ${hostOf(b.input.url)}`);
      break;
    }
    case 'message_delta':
      Object.assign(msg, ev.delta);
      msg.usage = { ...msg.usage, ...ev.usage };
      break;
    case 'error':
      throw new Error(`Anthropic stream error: ${ev.error?.message || 'unknown'}`);
  }
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

// Text Claude actually retrieved: fetched pages, plus quoted search snippets (citations).
export function retrievedText(content) {
  const out = [];
  for (const b of content) {
    if (b.type === 'web_fetch_tool_result' && b.content?.type === 'web_fetch_result') {
      const src = b.content.content?.source;
      if (src?.type === 'text' && src.data) out.push({ url: b.content.url, text: src.data });
    }
    // Dynamic filtering may hand page content back as code-execution output instead.
    if (/code_execution_tool_result$/.test(b.type) && typeof b.content?.stdout === 'string') {
      out.push({ url: null, text: b.content.stdout });
    }
    if (b.type === 'text') {
      for (const c of b.citations || []) if (c.cited_text) out.push({ url: c.url, text: c.cited_text });
    }
  }
  return out;
}

function lastJson(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidate = fenced.length ? fenced.at(-1) : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Claude did not return a result. Try again.');
  return JSON.parse(candidate.slice(start, end + 1));
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);

function normalize(d) {
  return {
    first_name: str(d.first_name),
    last_name: str(d.last_name),
    full_name: str(d.full_name),
    current_title: str(d.current_title),
    current_company: str(d.current_company),
    company_email_domain: str(d.company_email_domain),
    company_domain_guesses: arr(d.company_domain_guesses).map(str).filter(Boolean).slice(0, 3),
    location: str(d.location),
    is_recruiter: d.is_recruiter === true,
    public_emails: arr(d.public_emails).filter((e) => str(e?.email).includes('@'))
      .map((e) => ({ email: str(e.email).toLowerCase(), url: str(e.url), context: str(e.context) })),
    pattern_evidence: arr(d.pattern_evidence).filter((e) => str(e?.email).includes('@'))
      .map((e) => ({ email: str(e.email).toLowerCase(), first_name: str(e.first_name), last_name: str(e.last_name), url: str(e.url) })),
    email_patterns_ranked: arr(d.email_patterns_ranked).map(str).filter(Boolean),
    notes: str(d.notes),
  };
}
