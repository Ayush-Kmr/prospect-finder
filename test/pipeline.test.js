import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPattern, candidateEmails, cleanDomain, patternFromExample } from '../src/core/email.js';
import { runLookup, normalizeLinkedIn } from '../src/core/pipeline.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) if (String(url).includes(match)) return handler(String(url), init);
    throw new Error(`unmocked ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const mx = (host) => json({ Status: 0, Answer: [{ type: 15, data: `10 ${host}.` }] });
const person = {
  first_name: 'José', last_name: "O'Neil", full_name: "José O'Neil", current_title: 'Senior Technical Recruiter',
  current_company: 'Acme Corp', company_email_domain: 'acme.com', company_domain_guesses: ['acme.com'], location: 'Austin, TX',
  is_recruiter: true, public_emails: [], pattern_evidence: [], email_patterns_ranked: ['{first}.{last}', '{f}{last}'], notes: '',
};
// A final Claude message: optional server-tool blocks, then the JSON result in a fence.
const claude = (data, { blocks = [], stop = 'end_turn', searches = 0 } = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: stop,
  usage: { input_tokens: 2000, output_tokens: 150, server_tool_use: { web_search_requests: searches } },
  content: [...blocks, ...(data ? [{ type: 'text', text: `Done.\n\n\`\`\`json\n${JSON.stringify({ ...person, ...data })}\n\`\`\`` }] : [])],
});
const fetched = (url, text) => ({ type: 'web_fetch_tool_result', tool_use_id: 't', content: { type: 'web_fetch_result', url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text } } } });
const llmReply = claude({});

test('applyPattern strips accents and punctuation', () => {
  assert.equal(applyPattern('{first}.{last}', 'José', "O'Neil", 'acme.com'), 'jose.oneil@acme.com');
  assert.equal(applyPattern('{f}{last}', 'Ann', 'Lee', 'x.io'), 'alee@x.io');
  assert.equal(applyPattern('{first}<script>', 'a', 'b', 'x.io'), null);
});

test('candidateEmails puts known pattern first and dedupes', () => {
  const c = candidateEmails({ first: 'Ann', last: 'Lee', domain: 'x.io', knownPattern: '{f}{last}', llmPatterns: ['{f}{last}', '{first}'] });
  assert.equal(c[0].value, 'alee@x.io');
  assert.equal(new Set(c.map((x) => x.value)).size, c.length);
});

test('cleanDomain / normalizeLinkedIn', () => {
  assert.equal(cleanDomain('https://www.Acme.com/careers'), 'acme.com');
  assert.equal(normalizeLinkedIn('https://www.linkedin.com/in/Jane-Doe-123/?trk=x'), 'https://www.linkedin.com/in/jane-doe-123');
});

test('full pipeline with Claude + all providers', async () => {
  const f = mockFetch([
    ['api.anthropic.com', () => json(llmReply)],
    ['cloudflare-dns.com', () => mx('aspmx.l.google.com')],
    ['hunter.io/v2/domain-search', () => json({ data: { domain: 'acme.com', pattern: '{first}.{last}', accept_all: false } })],
    ['hunter.io/v2/email-finder', () => json({ data: { email: 'jose.oneil@acme.com', score: 94, verification: { status: 'valid' } } })],
    ['api.apollo.io', () => json({ person: { email: 'jose.oneil@acme.com', email_status: 'verified', phone_numbers: [], organization: { primary_domain: 'acme.com', sanitized_phone: '+15125550100' } } })],
    ['peopledatalabs.com', () => json({ status: 200, likelihood: 8, data: { work_email: true, mobile_phone: '+15125550199', phone_numbers: ['+1 (512) 555-0199'] } })],
  ]);
  const r = await runLookup({ profile: { url: 'https://www.linkedin.com/in/jose', text: '...' } },
    { anthropicKey: 'k', apolloKey: 'a', pdlKey: 'p', hunterKey: 'h', verifyGuesses: true },
    { fetchImpl: f });

  assert.equal(r.person.domain, 'acme.com');
  assert.equal(r.person.mail_host, 'Google Workspace');
  assert.equal(r.emails[0].value, 'jose.oneil@acme.com');
  assert.match(r.emails[0].source, /Hunter/);
  assert.match(r.emails[0].source, /Apollo/);
  assert.ok(r.emails[0].confidence >= 0.95);
  // PDL's gated `work_email: true` must not become an email; duplicate phone formats merge.
  assert.ok(!r.emails.some((e) => e.value === 'true'));
  assert.deepEqual(r.phones.map((p) => p.type).sort(), ['company', 'mobile']);
  assert.ok(Math.abs(r.cost.llm.usd - (2000 * 4 + 150 * 20) / 1e6) < 1e-9);
  // Verified email found -> no pattern guesses, no verifier spend.
  assert.ok(!f.calls.some((c) => c.url.includes('email-verifier')));
  // Anthropic request shape: web research tools, no structured-output format (incompatible with citations)
  const req = JSON.parse(f.calls.find((c) => c.url.includes('anthropic')).init.body);
  assert.deepEqual(req.tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.ok(req.tools.every((t) => t.blocked_domains.includes('linkedin.com')));
  assert.equal(req.output_config.format, undefined);
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.stream, true);
  assert.equal(req.fallbacks, 'default');
});

test('no provider keys -> pattern guesses with warning', async () => {
  const f = mockFetch([
    ['api.anthropic.com', () => json(llmReply)],
    ['cloudflare-dns.com', () => mx('acme-com.mail.protection.outlook.com')],
  ]);
  const r = await runLookup({ profile: { url: '', text: '...' } }, { anthropicKey: 'k' }, { fetchImpl: f });
  assert.equal(r.emails[0].value, 'jose.oneil@acme.com');
  assert.equal(r.emails[0].status, 'guess');
  assert.equal(r.phones.length, 0);
  assert.match(r.errors.join(' '), /No data-provider keys/);
});

test('verifier marks invalid guesses and stops at first valid', async () => {
  const f = mockFetch([
    ['cloudflare-dns.com', () => mx('mx.acme.com')],
    ['hunter.io/v2/domain-search', () => json({ data: { domain: 'acme.com', pattern: null } })],
    ['hunter.io/v2/email-finder', () => json({ data: { email: null } })],
    ['hunter.io/v2/email-verifier', (url) => json({ data: url.includes('ann.lee') ? { status: 'invalid', score: 0 } : { status: 'valid', score: 91 } })],
  ]);
  const r = await runLookup({ person: { first_name: 'Ann', last_name: 'Lee', current_company: 'Acme', email_patterns_ranked: ['{first}.{last}', '{f}{last}'] } },
    { hunterKey: 'h', verifyGuesses: true }, { fetchImpl: f });
  assert.ok(!r.emails.some((e) => e.value === 'ann.lee@acme.com'));
  assert.equal(r.emails[0].value, 'alee@acme.com');
  assert.equal(r.emails[0].status, 'valid');
});

test('provider errors are reported, not thrown', async () => {
  const f = mockFetch([
    ['cloudflare-dns.com', () => mx('mx.acme.com')],
    ['api.apollo.io', () => json({ error: 'Invalid access credentials.' }, 401)],
  ]);
  const r = await runLookup({ person: { first_name: 'Ann', last_name: 'Lee', current_company: 'Acme', domain: 'acme.com' } },
    { apolloKey: 'bad' }, { fetchImpl: f });
  assert.match(r.errors[0], /Apollo.*401/);
  assert.ok(r.emails.length > 0);
});


const profile = { url: 'https://www.linkedin.com/in/jose', heading: "José O'Neil", text: '...' };
const dns = ['cloudflare-dns.com', () => mx('aspmx.l.google.com')];

test('published email found on a fetched page -> "published" with source, no guesses needed', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { public_emails: [{ email: 'Jose.ONeil@acme.com', url: 'https://acme.com/team', context: 'Talent team' }] },
    { blocks: [fetched('https://acme.com/team', 'Talent team: José O\'Neil, jose.oneil@acme.com')], searches: 2 },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  assert.equal(r.emails.length, 1);
  assert.equal(r.emails[0].value, 'jose.oneil@acme.com');
  assert.equal(r.emails[0].status, 'published');
  assert.equal(r.emails[0].confidence, 0.97);
  assert.equal(r.emails[0].url, 'https://acme.com/team');
  assert.equal(r.canDeepen, false);
  assert.equal(r.cost.llm.web_searches, 2);
  assert.ok(Math.abs(r.cost.llm.usd - ((2000 * 4 + 150 * 20) / 1e6 + 0.02)) < 1e-9);
});

test('an address Claude claims but that is not in retrieved text stays "unconfirmed"', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { public_emails: [{ email: 'jose@acme.com', url: 'javascript:alert(1)' }] },
    { blocks: [fetched('https://acme.com/team', 'No addresses here.')] },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  // Unverified claim (≤30%) is outranked by the company-format guesses, so it isn't in the top 2.
  assert.equal(r.emails.length, 2);
  assert.ok(!r.emails.some((e) => e.value === 'jose@acme.com'));
  assert.ok(r.emails.every((e) => e.status === 'guess'));
});

test('format learned from a colleague\'s published address outranks generic patterns', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { pattern_evidence: [{ email: 'mlopez@acme.com', first_name: 'Maria', last_name: 'Lopez', url: 'https://acme.com/press' }] },
    { blocks: [fetched('https://acme.com/press', 'Press contact: Maria Lopez, mlopez@acme.com')] },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  assert.equal(r.emails[0].value, 'joneil@acme.com');
  assert.equal(r.emails[0].confidence, 0.71);
  assert.match(r.emails[0].basis, /published address/);
});

test('pause_turn resumes with the turn so far and sums usage', async () => {
  let n = 0;
  const f = mockFetch([dns, ['api.anthropic.com', () => json(n++ === 0
    ? claude(null, { stop: 'pause_turn', blocks: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], searches: 1 })
    : claude({}, { searches: 1 }))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  const reqs = f.calls.filter((c) => c.url.includes('anthropic')).map((c) => JSON.parse(c.init.body));
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].messages.length, 2);
  assert.equal(reqs[1].messages[1].role, 'assistant');
  assert.equal(reqs[1].messages[1].content[0].type, 'server_tool_use');
  assert.equal(r.cost.llm.input_tokens, 4000);
  assert.equal(r.cost.llm.web_searches, 2);
});

test('missing Anthropic key -> clear error', async () => {
  await assert.rejects(runLookup({ profile }, {}, { fetchImpl: mockFetch([]) }), /Anthropic API key/);
});

test('patternFromExample', () => {
  assert.equal(patternFromExample('jane.doe@acme.com', 'Jane', 'Doe'), '{first}.{last}');
  assert.equal(patternFromExample('jdoe@acme.com', 'Jane', 'Doe'), '{f}{last}');
  assert.equal(patternFromExample('ceo@acme.com', 'Jane', 'Doe'), null);
});

test('page text returned via dynamic-filtering code output still verifies the address', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { public_emails: [{ email: 'jose.oneil@acme.com', url: 'https://acme.com/team' }] },
    { blocks: [{ type: 'bash_code_execution_tool_result', tool_use_id: 'c', content: { stdout: 'match: jose.oneil@acme.com', stderr: '', return_code: 0 } }] },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  assert.equal(r.emails[0].status, 'published');
  assert.equal(r.emails[0].url, 'https://acme.com/team');
});

test('streamed response: rebuilt from SSE events, live steps for each search and page', async () => {
  const result = { ...person, public_emails: [{ email: 'jose.oneil@acme.com', url: 'https://acme.com/team' }] };
  const events = [
    { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 3000, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"\\"Jose O\'Neil\\" acme' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '.com"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', id: 's2', name: 'web_fetch', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"url":"https://www.acme.com/team"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: fetched('https://acme.com/team', 'Contact jose.oneil@acme.com') },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: '```json\n' + JSON.stringify(result).slice(0, 40) } },
    { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: JSON.stringify(result).slice(40) + '\n```' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 400, server_tool_use: { web_search_requests: 1 } } },
    { type: 'message_stop' },
  ];
  // Split the SSE text at odd points to exercise chunk reassembly.
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const chunks = sse.match(/[\s\S]{1,37}/g).map((c) => new TextEncoder().encode(c));
  const stream = new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
  const f = mockFetch([dns, ['api.anthropic.com', () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })]]);
  const steps = [];
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f, onProgress: (m) => steps.push(m) });
  assert.ok(steps.includes(`Searching: "Jose O'Neil" acme.com`));
  assert.ok(steps.includes('Reading acme.com'));
  assert.equal(r.emails[0].status, 'published');
  assert.equal(r.cost.llm.input_tokens, 3000);
  assert.equal(r.cost.llm.output_tokens, 400);
  assert.equal(r.cost.llm.web_searches, 1);
});

test('ownership: namesakes and team inboxes are not treated as the person', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { public_emails: [
      { email: 'r.kumar@acme.com', url: 'https://acme.com/a' },   // another person entirely
      { email: 'careers@acme.com', url: 'https://acme.com/jobs' }, // shared inbox
      { email: 'jose.r@acme.com', url: 'https://acme.com/team' },  // name in address and beside it
      { email: 'recruit1@acme.com', url: 'https://acme.com/team' }, // only beside it
    ] },
    { blocks: [
      fetched('https://acme.com/a', 'Rahul Kumar, Finance: r.kumar@acme.com'),
      fetched('https://acme.com/jobs', 'Apply: careers@acme.com'),
      fetched('https://acme.com/team', 'Recruiting lead José O\'Neil (jose.r@acme.com); desk recruit1@acme.com'),
    ] },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  // Only the top 2 are returned: their own address first, then the namesake (45%);
  // the team inboxes (35%) rank below both.
  assert.deepEqual(r.emails.map((e) => [e.value, e.confidence]), [['jose.r@acme.com', 0.88], ['r.kumar@acme.com', 0.45]]);
  assert.equal(r.canDeepen, false); // 0.88 counts as found
});

test('team inboxes are labelled as such', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { public_emails: [{ email: 'careers@acme.com', url: 'https://acme.com/jobs' }, { email: 'recruit1@acme.com', url: 'https://acme.com/jobs' }] },
    { blocks: [fetched('https://acme.com/jobs', 'Apply: careers@acme.com or recruit1@acme.com')] },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  // A personal-format guess outranks shared inboxes, so neither inbox is the top match.
  assert.equal(r.emails.length, 2);
  assert.notEqual(r.emails[0].type, 'team inbox');
  assert.ok(r.emails.every((e) => !/^(careers|recruit1)@/.test(e.value) || (e.type === 'team inbox' && e.confidence < 0.4)));
});

test('a name only beside the address is weak evidence, and offers a deeper search', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
    { public_emails: [{ email: 'jjo@acme.com', url: 'https://acme.com/team' }] },
    { blocks: [fetched('https://acme.com/team', 'Contact José O\'Neil at jjo@acme.com')] },
  ))]]);
  const r = await runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  assert.equal(r.emails[0].value, 'jjo@acme.com');
  assert.equal(r.emails[0].confidence, 0.6);
  assert.equal(r.canDeepen, true);
});

test('format voting: agreeing colleagues raise confidence, a split vote lowers it', async () => {
  const run = async (examples) => {
    const f = mockFetch([dns, ['api.anthropic.com', () => json(claude(
      { pattern_evidence: examples.map(([email, first, last]) => ({ email, first_name: first, last_name: last, url: 'https://acme.com/p' })) },
      { blocks: [fetched('https://acme.com/p', examples.map((e) => e[0]).join(' '))] },
    ))]]);
    return runLookup({ profile }, { anthropicKey: 'k' }, { fetchImpl: f });
  };
  const agree = await run([['mlopez@acme.com', 'Maria', 'Lopez'], ['tchen@acme.com', 'Tom', 'Chen'], ['asmith@acme.com', 'Ann', 'Smith']]);
  assert.equal(agree.emails[0].value, 'joneil@acme.com');
  assert.equal(agree.emails[0].confidence, 0.92);
  assert.equal(agree.canDeepen, false);
  const split = await run([['mlopez@acme.com', 'Maria', 'Lopez'], ['tom.chen@acme.com', 'Tom', 'Chen']]);
  assert.ok(split.emails[0].confidence < 0.6);
  // Duplicate example counted once
  const dup = await run([['mlopez@acme.com', 'Maria', 'Lopez'], ['mlopez@acme.com', 'Maria', 'Lopez']]);
  assert.equal(dup.emails[0].confidence, 0.71);
});

test('deep pass: broader request, avoids earlier searches, keeps earlier evidence', async () => {
  const f = mockFetch([dns, ['api.anthropic.com', () => json(claude({}, { blocks: [] }))]]);
  const prior = {
    public_emails: [],
    pattern_evidence: [{ email: 'mlopez@acme.com', first_name: 'Maria', last_name: 'Lopez', url: 'https://acme.com/p' }],
    sources: [{ url: 'https://acme.com/p', text: 'mlopez@acme.com' }],
    queries: ['"Jose O\'Neil" acme email'],
  };
  const r = await runLookup({ profile, prior }, { anthropicKey: 'k' }, { fetchImpl: f, deep: true });
  const req = JSON.parse(f.calls.find((c) => c.url.includes('anthropic')).init.body);
  assert.equal(req.output_config.effort, 'medium');
  assert.equal(req.tools[0].max_uses, 5);
  assert.match(req.messages[0].content, /Already searched: "\"Jose O'Neil\" acme email"|Already searched: ""Jose O'Neil" acme email"/);
  assert.equal(r.emails[0].value, 'joneil@acme.com'); // format from the quick pass still counts
  assert.equal(r.deep, true);
  assert.equal(r.canDeepen, false);
});
