---
name: find-contact
description: Find a work email and phone number for a person (e.g. a recruiter) from their LinkedIn URL, pasted profile text, or name + company, using the Prospect Finder pipeline (Apollo / People Data Labs / Hunter + email-pattern inference with MX checks). Use when the user asks to find someone's email or phone, look up a recruiter's contact details, or enrich a LinkedIn profile.
---

# Find contact

Runs `cli/find-contact.mjs` from this repo. You (Claude) do the parsing, so the CLI's own LLM call is skipped and the lookup uses this session's tokens.

## Steps

1. **Work out the person's details** from what the user gave you:
   - first and last name, with credentials, emojis and pronouns removed
   - **current** employer (if they're an agency recruiter, the agency)
   - the company's email domain if you know it confidently (e.g. `stripe.com`)
   - LinkedIn URL if one was given

   Do not fetch or scrape linkedin.com. If the user only gave a LinkedIn URL and you can't tell the name and company from the URL slug, ask them to paste the profile text or give you the name and company.

2. **Run the lookup** from the repo root:

   ```bash
   node cli/find-contact.mjs --first "Jane" --last "Doe" --company "Acme Corp" \
     [--domain acme.com] [--linkedin "https://www.linkedin.com/in/janedoe"] --json
   ```

   For a batch, run it once per person; don't run them in parallel, so you don't use up provider rate limits.

   Provider keys come from the environment: `APOLLO_API_KEY`, `PDL_API_KEY`, `HUNTER_API_KEY`. If none are set, tell the user that results will be **pattern guesses only** and that phone numbers need a provider key.

3. **Report the results** clearly:
   - The best email with its status and confidence. Label anything with `status: "guess"` as an unverified guess, never as the person's email.
   - Phone numbers with their type (`mobile`, `direct`, `company`). A `company` number is the switchboard, not the person.
   - Which providers answered, and any `errors`.

## Rules

- Never make up an email or phone number. Report only what the CLI returns.
- If the user wants to contact recruiters, a work email is usually the right channel. Only offer personal emails or mobile numbers when a provider returned them.
