# Prospect Finder

A Chrome extension (Manifest V3) that works like Apollo's: open a LinkedIn profile, click **Find contact**, and get a work email (and a phone number where a data provider has one), with a confidence score, the source, and the cost of the lookup.

The same pipeline runs from the terminal (`cli/find-contact.mjs`) and as a Claude Code skill (`/find-contact`).

## How a lookup works

```
LinkedIn profile on screen (read only when you click)
        │
        ▼
1. Claude research ── 1 request, billed to your Anthropic key, tokens/searches/$ shown per lookup
   → clean name, current employer, the company's real email domain
   → web search + page fetch, streamed live to the panel (≤3 searches, ≤2 pages; LinkedIn and data-broker sites blocked)
     for the person's own published email and other employees' published addresses
        │
        ▼
2. Verify ── an address is "published" only if it appears in the text Claude actually retrieved,
   and it's credited to the person only if it fits their name or their name is beside it on the page
   (namesakes and team inboxes like careers@ are labelled, not mistaken for them).
   Colleagues' verified addresses vote on the company format; agreement raises confidence, a split lowers it.
   Nothing verified? The panel offers "Search deeper": a broader pass (more sources, new queries)
   that keeps everything the quick pass found. The default lookup stays on the fast pass.
        │
        ▼
3. Domain ── published address → Claude's domain → Hunter domain-search → provider hints, each confirmed by DNS MX
        │
        ▼
4. Providers (in parallel, each optional)
   • Apollo  people/match    → verified work email, personal emails*, company phone
   • PDL     person/enrich   → work email, mobile and phone numbers
   • Hunter  email-finder    → email with a deliverability score
        │
        ▼
5. Fallback ── if no published/verified work email: pattern candidates (formats seen in real
   published addresses first, then Hunter's pattern, then Claude's ranking), top 2 verified with Hunter
        │
        ▼
Side panel: emails and phones with status, confidence and source · copy · history · CSV export
```

\* only when you turn on "Ask Apollo for personal emails".

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this folder.
2. Open the extension's **Settings** (right-click the icon → Options) and add:
   - **an Anthropic API key** (default model `claude-opus-5-5`; `claude-sonnet-5-5` costs about half)
   - **optional data-provider keys:** Apollo, People Data Labs and/or Hunter (needed for phone numbers and deliverability checks)
3. Open any `linkedin.com/in/...` profile (Recruiter and Sales Navigator profile pages work too) and click **Find contact**.

## What to expect

| Keys configured | Work email | Phone |
|---|---|---|
| Claude only | The person's address when it's published anywhere public (with a source link); otherwise the company format from real published addresses, or ranked guesses | None |
| Claude + Hunter | Verified email for most people at companies with their own domain | Rarely |
| Claude + Apollo | Verified email for most B2B profiles | Company switchboard; mobile numbers need Apollo's webhook flow (not built in) |
| Claude + PDL (paid plan) | Good | Best coverage of mobile numbers |
| All three | Highest coverage; agreement between sources raises confidence | Best available |

No tool finds 100%. Statuses: **published** (found verbatim on a public page; source linked), **unconfirmed** (Claude reported it but it wasn't in the retrieved text; treat with care), **valid/verified** (provider-checked), **guess** (pattern only).

## Cost per lookup

- **Claude:** one request at low effort with up to 3 web searches ($0.01 each) and 2 page fetches; most of the input tokens are search results and fetched pages. The exact tokens, searches and $ appear on every result and in the CSV export. `claude-sonnet-5-5` roughly halves the token cost.
- **Providers:** each call uses that provider's credits. A lookup makes at most 1 Apollo call, 1 PDL call, and 2–4 Hunter calls (domain search, finder, and up to 2 verifications). Turn off verification in Settings to save Hunter credits.

## CLI and Claude Code skill

```bash
export HUNTER_API_KEY=... APOLLO_API_KEY=... PDL_API_KEY=...

# Structured input, no LLM call
node cli/find-contact.mjs --name "Jane Doe" --company "Acme Corp" --linkedin https://www.linkedin.com/in/janedoe

# Raw profile text, one LLM call
ANTHROPIC_API_KEY=... node cli/find-contact.mjs --profile-file profile.txt --json
```

In Claude Code, from this folder, run `/find-contact Jane Doe, recruiter at Acme`. Claude parses the input itself, using the session's tokens, and runs the CLI.

## Layout

```
manifest.json
src/background.js         service worker: runs lookups, stores history
src/content.js/.css       "Find contact" button; reads the profile on screen
src/settings.js           chrome.storage settings
src/core/                 environment-neutral pipeline (extension and Node)
  llm.js                  Claude request: profile parsing + public web research
  providers.js            Apollo, PDL, Hunter clients
  email.js                pattern generation, DNS-over-HTTPS MX lookup
  pipeline.js             orchestration, merging, confidence
  pricing.js              token → USD
src/ui/                   side panel and options page
cli/find-contact.mjs      terminal entry point
.claude/skills/find-contact/SKILL.md
test/                     node --test (mocked HTTP)
```

`npm test` runs the test suite. `npm run zip` packages the extension.

## Responsible use

- The extension reads only the profile you're looking at, when you click. It does not crawl LinkedIn or send it any requests. Automated scraping breaks LinkedIn's User Agreement and gets accounts restricted.
- Contact data comes from licensed providers under their terms. Outreach is still subject to GDPR, CAN-SPAM and TCPA (no automated calls or texts to mobile numbers without consent), and similar laws where you operate.
- API keys stay in `chrome.storage.local` on your machine and go only to the service they belong to.

