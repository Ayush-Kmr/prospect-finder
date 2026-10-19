# Zero-Cost Email Finder

A personal Chrome extension (Manifest V3) that finds **publicly published** professional email addresses for the LinkedIn profile you're viewing. When nothing is published, it gives **evidence-ranked predictions** based on the company's observed email format.

- **No AI and no API keys:** every step is a local TypeScript algorithm.
- **No backend, no database, no subscriptions.**
- **Nothing stored:** lookup data lives only in Chrome's in-memory session storage.

## Install

Requires Node 18+ and Chrome 116+.

```bash
cd zero-cost-extension
npm install
npm run build        # type-checks, then builds into dist/
npm test             # unit/integration tests (Vitest)
npm run test:e2e     # builds, then runs the extension in real Chromium (Playwright)
```

`test:e2e` needs a Playwright Chromium. If it says none was found, run `npx playwright install chromium` (about 150 MB) or set `CHROMIUM_PATH`.

**Load into Chrome:**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `zero-cost-extension/dist` folder.
4. Optional: pin the extension from the puzzle-piece menu.

After changing code, run `npm run build` again and click ↻ on the extension card.

## Use

1. Open a LinkedIn profile (`linkedin.com/in/...`) and click the extension icon.
2. The popup reads the name, role and current company from the page you're viewing. Click **Edit** to correct them or to enter details by hand on any page.
3. Click **FIND PROFESSIONAL EMAIL**. You'll see each stage complete:
   ✓ Profile identified → ✓ Company domain resolved → ✓ Public sources checked → ✓ Email patterns evaluated → ✓ DNS validation completed
4. **Confirm the domain if asked.** If the company domain is uncertain or conflicting, pick a suggestion or type the website.
5. **Allow the company site, the first time for each company.** Choose **Allow & scan** (just that site) or **Allow all sites** (no more prompts). This lets the extension read that company's public team, about, press and contact pages. Without it you still get predictions.
6. **The result** shows the email, its status, the explanation and the evidence. The buttons are **COPY EMAIL · VIEW EVIDENCE · SHOW ALTERNATIVES · RETRY**.
7. **Optional: search yourself.** Under **Search public sources yourself**, the extension prepares targeted searches:
   - the exact predicted addresses
   - name + email domain
   - name + role + company
   - speaker, press and bio pages
   - public PDFs
   - the company's email format

   Open them one at a time, or all at once in a new window with **Google**, **Bing** or **DuckDuckGo**. Then send result pages back in any of these ways:
   - **Analyze current tab**: on a result page, click the extension.
   - **Analyze all open result tabs in this window**: needs access to those sites, or "Allow all sites".
   - **Right-click any page → "Email Finder: analyze this page".** The toolbar badge shows how many relevant addresses it found.
   - Paste a URL.

   Results are re-ranked automatically.

## How it works

```
LinkedIn tab (read once, on click; activeTab + scripting)
  → identity.ts             name / role / company; manual fallback
  → company-resolver.ts     user website · Wikidata P856 · DuckDuckGo "Official site" · LinkedIn slug · name guesses
                            (queried with and without legal suffixes: "Stripe, Inc." -> "Stripe")
                            email domain may differ from the website: evidenced alias (published staff addresses)
                            or a sibling domain with MX (flagged "unconfirmed")
                            → DNS must resolve → MX → name match → homepage title (if permitted)
                            → confidence high / medium / low; ask the user when unsure or conflicting
  → public-discovery.ts     company site: homepage → sitemap.xml → team/about/press links → common paths
                            robots.txt honoured · 0.8 s between requests per host · 3 in parallel · 10 s timeout
                            403/429/503 or a bot-challenge page = "blocked" (reported, never bypassed)
                            follows links to the person's own bio page (/team/jane-smith); 45 s crawl budget
                            + user-assisted pages (search links you open; "Analyze current tab" or paste a URL)
  → email-extractor.ts      text + mailto links + schema.org JSON-LD/microdata · HTML entities · Unicode NFKC
                            "(at)/[dot]/{at}" decoding · role addresses flagged · freemail never collected
                            names next to each address + all names on the page (grid-style team pages)
  → pattern-engine.ts       format of each published staff address (from the name next to it) → company convention
                            candidates with middle-name, hyphenated, multi-word-surname and transliteration variants
  → dns-validator.ts        syntax · A/MX over DNS-over-HTTPS (Cloudflare, Google fallback)
  → ranking-engine.ts       fixed weights → status, evidence score, explanation
  → popup (React + Tailwind) progressive updates from the service worker
```

### Statuses

| Status | Requires |
|---|---|
| `PUBLICLY_CONFIRMED` | The exact address is on a public page, and either matches the person's name or is printed next to it. This is the only status based on direct evidence |
| `PATTERN_SUPPORTED` | Generated in the company's format, as seen in published staff addresses. The mailbox isn't verified |
| `PREDICTED` | No company format seen. A common format on a confirmed company domain that accepts mail |
| `DOMAIN_VALID_ONLY` | A common format; the domain accepts mail, but its link to the company is weak |
| `UNVERIFIED` | The domain has no mail server, or DNS couldn't be checked (offline) |
| `NOT_FOUND` | No usable domain or identity |

### Scoring (deterministic; shown in VIEW EVIDENCE)

| Signal | Points |
|---|---|
| Exact address published on a public page | +45 |
| …next to the person's full name (otherwise +10 if it matches their name) | +20 |
| …on the company's own website | +10 |
| Each additional independent source (max 2) | +5 |
| Matches the observed company format | up to +35, scaled by the number of samples and the format's share |
| Common-format prior (most common first) | +12 → +2 |
| Company domain: high / medium confidence | +10 / +5 |
| Domain accepts email (MX) / has no MX | +5 / −25 |
| Several plausible domains · company uses several formats | −10 each |
| Alternative spelling of the name · surname unknown | −5 · −15 |

The score shows how well a candidate is supported by evidence found in this lookup. **It is not the probability that the mailbox exists**, and the popup says so.

## Network requests (complete list)

| Destination | When | What is sent |
|---|---|---|
| The LinkedIn tab you're on | When you open the popup on a profile | Nothing. The visible page is read locally |
| `cloudflare-dns.com`, `dns.google` | Each lookup | Domain names (company domain candidates) |
| `www.wikidata.org` | Each lookup | The company name |
| `api.duckduckgo.com` (Instant Answer API) | Each lookup | The company name |
| The company's own website | Only after you grant access to that site | Normal page requests: robots.txt, sitemap and about/team/press/contact pages. No cookies are sent (`credentials: 'omit'`) |
| A page you paste into "Analyze" | Only when you click Analyze and grant access to that site | A normal page request |
| Search engines | Only when **you** click a search button | A normal browser tab; the extension doesn't read it unless you click "Analyze current tab" |

There's no telemetry, analytics or remote code. The extension never fetches LinkedIn pages; that's blocked in code.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Read the profile in the tab you clicked from, and "Analyze current tab". No access to other tabs |
| `contextMenus` | The right-click "analyze this page" item. A right-click grants access to that one tab only |
| `storage` | Only `chrome.storage.session`: in memory, cleared when the browser closes or when you click **Clear** |
| Host: DNS-over-HTTPS, Wikidata, DuckDuckGo API | Domain resolution and MX checks |
| Optional host `https://*/*` | Requested at runtime for each company site you approve, or once with "Allow all sites" |

The content security policy is `script-src 'self'`: no `eval`, no remote scripts. External text is displayed as text, and only `http(s)` links are made clickable.

## Testing

- **`npm test` (Vitest, Node):**
  - name, domain, pattern, extraction, DNS and ranking rules
  - the full pipeline against a fictional company world: published, pattern-only, generic-only, blocked, robots-disallowed, timeouts, errors, offline, cancellation, crawl budget, bio-page following, sibling mail domain
  - the LinkedIn reader against five hand-written LinkedIn-like layouts, plus delayed rendering (jsdom)
- **`npm run test:e2e` (Playwright, real Chromium, the built `dist/`):**
  - service worker start and popup rendering
  - profile reading through `chrome.scripting`
  - Find, Retry, Cancel, Copy and Clear
  - closing and reopening the popup, keeping edits
  - session-storage contents, interrupted-lookup display
  - permission-needed state
  - Analyze current tab and Analyze open tabs
  - no channel from web pages to the extension

  Network traffic is served from fixtures; nothing touches real sites.
- **Not automated:**
  - Chrome's permission prompt, the toolbar-icon click (activeTab) and the right-click menu. These are native browser UI. The e2e copy of the manifest pre-grants the fixture origins instead; that is its only difference from production.
  - LinkedIn's live markup. The fixtures don't prove compatibility, so use [MANUAL_TESTING.md](MANUAL_TESTING.md).

## Limitations

- **Most people will get a prediction, not a confirmed address.** The extension only knows what's published. Staff addresses appear on public pages mainly for leadership, press contacts, speakers and small companies. Commercial tools also draw on large proprietary databases, which this deliberately doesn't use.
- **Mailbox existence can't be verified for free without SMTP probing.** The extension doesn't probe, so it can't detect catch-all domains or confirm a predicted mailbox. An MX record only means the domain accepts mail.
- **No automatic web search.** Google, Bing and DuckDuckGo offer no free programmatic search that permits this use, so searching is user-assisted. Domain discovery uses Wikidata and DuckDuckGo's Instant Answer API, which cover established companies well and small or new companies poorly. In that case you'll be asked for the website.
- **LinkedIn's page layout changes often.** If the name or company isn't read correctly, use **Edit**.
- **Blocked sites stay blocked.** Sites behind bot protection, or that disallow crawling in robots.txt, are reported as such and not bypassed. Open them yourself and use **Analyze current tab**.
- **Cloudflare "email protection" (`[email protected]`) isn't decoded by the automatic crawl**, because it's an anti-harvesting measure. When you open the page yourself, your browser decodes it, and **Analyze current tab** reads the rendered page.
- **PDFs aren't parsed.** The PDF search link helps you find them; open one and copy what you need.
- **Use it responsibly.** Outreach is subject to the GDPR, CAN-SPAM, CASL and similar laws.

## Project layout

```
public/manifest.json                MV3 manifest (copied to dist/)
src/background/service-worker.ts    runs lookups; state in chrome.storage.session
src/content/profile-reader.ts       self-contained function injected into the LinkedIn tab
src/popup/                          React + Tailwind popup (400 px, light/dark)
src/services/                       identity, company-resolver, public-discovery, email-extractor,
                                    pattern-engine, dns-validator, ranking-engine, discovery-orchestrator
src/utils/                          normalization, domain, net (timeouts, rate limit, robots.txt)
src/shared/messages.ts              popup ↔ service-worker messages
tests/                              Vitest; fictional fixtures on .example domains
```
