# Contact Discovery Platform

A self-hosted tool that finds **publicly published** professional email addresses, with the evidence behind each one. When nothing is published, it gives a clearly labelled **prediction** based on the format the company is seen using.

You give it a LinkedIn URL plus a name and company, or just a name and company. It searches permitted public sources and returns:
- the email address
- its status
- a confidence score
- the source URLs

Stack: FastAPI · SQLAlchemy (SQLite or Postgres) · httpx · BeautifulSoup · dnspython · Claude or OpenAI (optional) · React + TypeScript (Vite).

## What it does and doesn't do

| Does | Doesn't |
|---|---|
| Reads public company pages (team, about, press, contact) and public pages found through an authorized search API | Fetch linkedin.com. It's blocked in code; LinkedIn forbids automated access |
| Follows robots.txt, waits between requests to the same host, caches pages | Query Apollo/Hunter databases, private endpoints or paywalled data |
| Learns a company's email format from published staff addresses | SMTP mailbox probing (`RCPT TO`) or any guessing at whether a mailbox exists |
| Checks syntax, MX records, disposable domains and role accounts locally | Treat an MX record as proof that a mailbox exists |
| Optional: verifies mailboxes through an authorized provider (Hunter Email Verifier API) | Present AI output as fact. The AI never produces email addresses |

## How tools like Apollo and Hunter work, and what this reproduces

Based on how these products are publicly documented and how they visibly behave:
- **Hunter** crawls the public web for addresses on a domain, keeps the source pages, works out each company's email format, and verifies addresses with its own mail-server checks.
- **Apollo, RocketReach and Clearbit** add large licensed and contributed contact databases, including data contributed through browser extensions and email-account syncing.

This project rebuilds the public-web half on its own:

| Capability | Commercial tools | Here |
|---|---|---|
| Domain discovery | Firmographic database | Search API, name heuristics, MX and homepage checks, AI tie-break |
| Published-email discovery | Web crawl index | Live, polite crawl of the company site plus search-result pages |
| Format inference | Pattern stats across their index | Pattern stats from the addresses found during the lookup, matched to names on the page |
| Verification | Their mail-server checks | MX checks, plus an optional authorized provider API |
| Contact database | Hundreds of millions of records | Your own local database of contacts you've looked up |

The big gap is their **database**. A tool that only uses the public web finds a published address for some people, mostly leadership, press contacts, speakers and small companies. Everyone else gets a **prediction**. This tool is honest about which one you're getting.

## Architecture

```
                ┌──────────────── React dashboard (Vite) ────────────────┐
                │ discover form · result + evidence · batch CSV · history │
                │ editable tracker (phone, job link, mailed, called)      │
                └───────────────────────────┬─────────────────────────────┘
                                            │ /api
┌───────────────────────────────────────────▼──────────────────────────────────────────┐
│ FastAPI  (concurrency semaphore · per-item batch errors · DB result reuse)            │
│                                                                                       │
│  1 Identity      linkedin.py   normalize URL, infer name from slug (labelled inferred)│
│                  ai.py         parse profile text you pasted → schema-checked JSON    │
│  2 Domain        domain.py     search results + heuristics + AI guesses               │
│                                → MX check → homepage title match → AI tie-break       │
│  3 Published     fetcher.py    robots.txt · per-host throttle · 2 MB cap · cache      │
│    emails        extract.py    regex + mailto + "[at]/[dot]" decoding, context, names │
│                  search.py     Brave API / SearXNG: "Name" "@domain", "@domain"       │
│  4 Patterns      patterns.py   match found addresses to nearby names → format stats   │
│  5 Verify        verify.py     syntax · MX · disposable · role · optional Hunter API  │
│  6 Score         discovery.py  status + confidence + explanation                      │
└──────┬─────────────────────────────────────────────────┬─────────────────────────────┘
       │ SQLAlchemy                                       │ outbound HTTP (polite)
┌──────▼─────────────────────────────┐        company sites · public pages · search API
│ contacts · email_candidates ·      │        · DNS (MX) · AI API · optional Hunter
│ evidence · cache_entries ·         │
│ schema_version                     │
└────────────────────────────────────┘
```

### Statuses and confidence

| Status | Meaning | Typical confidence |
|---|---|---|
| `PUBLICLY_CONFIRMED` | Published on a public page, and the address matches the person's name or appears next to it | 80–95% |
| `PROVIDER_VERIFIED` | Predicted, then confirmed by an authorized verification provider; not a catch-all domain | 90% |
| `PATTERN_PREDICTED` | Built from the company's observed published format | 30–75%, rising with the number of samples and the format's share |
| `DOMAIN_VALID_ONLY` | Common format; only the domain's MX is known | 5–25% |
| `UNVERIFIED` | Guess; the domain has no MX records | 5% |
| `NOT_FOUND` | No domain confirmed, or not enough identity information | 0% |

### Data model

- **contacts:** identity, company, domain and `domain_confidence`, `best_email`, `email_status`, `confidence`, `explanation`, `warnings`, plus tracker fields (`phone`, `job_link`, `mailed`, `called`, `notes`, and `extra` for any columns you add).
- **email_candidates:** `email`, `status`, `confidence`, `pattern`, `basis`, `source_url`, `verification`.
- **evidence:** `kind` (`identity`, `domain`, `published_email` or `pattern_sample`), `url`, `snippet`, `email`.
- **cache_entries:** pages, search results, MX lookups and AI responses, each with an expiry time.
- **schema_version:** forward-only migrations (`app/db.py: MIGRATIONS`).

### API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/contacts/discover` | `{linkedin_url?, full_name?, company?, company_domain?, title?, profile_text?, job_link?, force_refresh?}` | Contact with candidates and evidence |
| POST | `/api/contacts/batch` | `{items: [DiscoverRequest]}` (≤ `MAX_BATCH_SIZE`) | `[{ok, contact} or {ok: false, input, error}]` |
| POST | `/api/contacts/batch/csv` | multipart `file` (Person Name, Company, LinkedIn URL, Company Domain, Title, Job Link) | same |
| GET | `/api/contacts` | `q`, `status` (comma list), `limit`, `offset` | Contact[] |
| GET | `/api/contacts/{id}` | | Contact |
| PATCH | `/api/contacts/{id}` | tracker fields, `extra` (merged) | Contact |
| DELETE | `/api/contacts/{id}` | | 204 |
| POST | `/api/emails/validate` | `{email, use_provider?}` | syntax, MX, disposable, role, provider result, status, note |
| GET | `/api/contacts/export` | `q`, `status` | CSV (Sheets/Excel compatible) |
| GET | `/api/health` | | which providers are configured |

Interactive API docs are at `http://localhost:8000/docs`.

The CSV export has the tracker columns first: **Person Name, Company, LinkedIn URL, Professional Email, Contact Number, Job Link, Email Status, Confidence Score, Source URL, Mailed, Called**. After those come Title, Company Domain, Notes, Discovered At, and then any `extra` keys you've added. Values that look like spreadsheet formulas are neutralized.

## Run locally

```bash
# Backend
cd platform/backend
uv venv -p python3.12 .venv && uv pip install -p .venv/bin/python -r requirements.txt
#   (or: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt)
cp .env.example .env            # add keys you have (all optional)
.venv/bin/uvicorn app.main:app --reload --port 8000

# Frontend (second terminal)
cd platform/frontend
npm install
npm run dev                     # http://localhost:5173 (proxies /api to :8000)
```

**Demo with fictional data (no keys, no network):**

```bash
cd platform/backend
DEMO_MODE=1 DATABASE_URL=sqlite:///./demo.db .venv/bin/uvicorn app.main:app --port 8000
# In the dashboard, try:  "Maria Gonzalez" / "Alex Chen" / "Jane Smith" / "Priya Nair" @ "Northwind Robotics"
.venv/bin/python scripts/demo.py   # same scenarios from the terminal
```

**Tests:** `cd platform/backend && .venv/bin/python -m pytest -q`

**Docker (not tested here, because Docker wasn't installed):**

```bash
cd platform
cp backend/.env.example backend/.env
docker compose up --build                 # dashboard at http://localhost:8080
docker compose --profile search up        # also runs a self-hosted SearXNG
```

## What's free and what costs money

| Piece | Cost |
|---|---|
| Crawling public company pages, extraction, pattern engine, MX/syntax/disposable checks, SQLite, dashboard | **Free.** Runs locally |
| Web search | **SearXNG self-hosted: free.** It relies on upstream engines that may rate-limit it. **Brave Search API:** has a free tier; check current limits. A lookup makes about 4 searches |
| AI (Claude/OpenAI) | **Paid per token, optional.** Only used to parse pasted profile text and break ties between domains, and results are cached. Roughly 1–3k tokens a call, about $0.01 with `claude-opus-5-5` and a small fraction of a cent with `claude-haiku-5-5`. AI access doesn't give you contact data. It can only reason about what the tool finds |
| Mailbox verification | **Optional, paid by credits.** Hunter's free plan is about 50 credits a month |
| Lookups you've done before | **Free.** Served from the database unless you choose Refresh |

**Without a search provider,** the tool can still find the domain, if you supply it or name heuristics confirm it. It crawls the company's own site and predicts from the formats it sees there. Setting up search (SearXNG or Brave) adds discovery on outside pages such as conference speaker pages and press releases. It's the biggest single improvement to results.

## Responsible use

- Outreach is subject to the GDPR, CAN-SPAM, CASL and similar laws. Keep a lawful basis, offer an opt-out, and delete records when asked: there's a Delete button and `DELETE /api/contacts/{id}`.
- Phone numbers are only stored when you enter them yourself.
- Set `CRAWLER_USER_AGENT` to something that identifies you, and keep `RESPECT_ROBOTS=true`.
