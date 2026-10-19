#!/usr/bin/env node
// Same lookup pipeline as the extension, from the terminal.
//
//   Structured input (no LLM call; e.g. when Claude Code already parsed the profile):
//     find-contact --first Jane --last Doe --company "Acme Corp" [--domain acme.com] [--linkedin URL]
//   Raw profile text (one Claude request with web research, billed to your Anthropic key):
//     find-contact --profile-file profile.txt [--linkedin URL]
//
// Keys from env: ANTHROPIC_API_KEY, APOLLO_API_KEY, PDL_API_KEY, HUNTER_API_KEY
// Optional: ANTHROPIC_MODEL. Add --json for machine-readable output.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runLookup } from '../src/core/pipeline.js';

const { values: a } = parseArgs({
  options: {
    first: { type: 'string' }, last: { type: 'string' }, name: { type: 'string' },
    company: { type: 'string' }, domain: { type: 'string' }, title: { type: 'string' },
    linkedin: { type: 'string' }, 'profile-file': { type: 'string' },
    'no-verify': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  },
});

if (a.help || (!a['profile-file'] && !(a.company || a.domain || a.linkedin))) {
  console.error('Usage: find-contact (--first F --last L | --name "F L") --company C [--domain D] [--linkedin URL] [--json]\n' +
    '       find-contact --profile-file FILE [--linkedin URL] [--json]');
  process.exit(a.help ? 0 : 2);
}

const env = process.env;
const settings = {
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  apolloKey: env.APOLLO_API_KEY || '',
  pdlKey: env.PDL_API_KEY || '',
  hunterKey: env.HUNTER_API_KEY || '',
  verifyGuesses: !a['no-verify'],
  revealPersonalEmails: false,
};

let input;
if (a['profile-file']) {
  input = { profile: { url: a.linkedin || '', heading: '', text: await readFile(a['profile-file'], 'utf8') } };
} else {
  const [first = '', ...rest] = (a.name || '').trim().split(/\s+/);
  const firstName = a.first || first;
  const lastName = a.last || rest.join(' ');
  input = {
    person: {
      first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim(),
      current_company: a.company || '', current_title: a.title || '', domain: a.domain || '',
      linkedin_url: a.linkedin || null,
    },
  };
}

try {
  const r = await runLookup(input, settings, { onProgress: (m) => !a.json && console.error(`… ${m}`) });
  if (a.json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const p = r.person;
  console.log(`\n${p.full_name}${p.title ? ` — ${p.title}` : ''}${p.company ? ` @ ${p.company}` : ''}`);
  if (p.domain) console.log(`domain: ${p.domain} (${p.mail_host})`);
  console.log('\nEmails:');
  if (!r.emails.length) console.log('  (none)');
  r.emails.forEach((e) => console.log(`  ${e.value.padEnd(40)} ${String(Math.round(e.confidence * 100)).padStart(3)}%  ${e.status}  [${e.source}]${e.url ? `  ${e.url}` : ''}`));
  console.log('\nPhones:');
  if (!r.phones.length) console.log('  (none)');
  r.phones.forEach((ph) => console.log(`  ${ph.value.padEnd(20)} ${ph.type}  [${ph.source}]`));
  if (r.cost.llm) console.log(`\nClaude: ${r.cost.llm.model} ${r.cost.llm.input_tokens}+${r.cost.llm.output_tokens} tokens, ${r.cost.llm.web_searches} searches${r.cost.llm.usd != null ? ` ≈ $${r.cost.llm.usd.toFixed(4)}` : ''}`);
  if (r.cost.providerCalls.length) console.log(`Provider calls: ${r.cost.providerCalls.join(', ')}`);
  r.errors.forEach((e) => console.error(`! ${e}`));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
