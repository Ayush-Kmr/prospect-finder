"""CSV export (Google Sheets / Excel compatible) and CSV batch import."""

from __future__ import annotations

import csv
import io

TRACKER_COLUMNS = [
    "Person Name", "Company", "LinkedIn URL", "Professional Email", "Contact Number", "Job Link",
    "Email Status", "Confidence Score", "Source URL", "Mailed", "Called",
]
EXTRA_COLUMNS = ["Title", "Company Domain", "Notes", "Discovered At"]


def _safe(v) -> str:
    s = "" if v is None else str(v)
    # Prevent formula injection when the sheet is opened in Sheets/Excel.
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def _source_url(c) -> str:
    best = next((x for x in c.candidates if x.email == c.best_email), None)
    if best and best.source_url:
        return best.source_url
    ev = next((e for kind in ("published_email", "pattern_sample", "domain")
               for e in c.evidence if e.kind == kind and e.url), None)
    return ev.url if ev else (c.company_website or "")


def contacts_to_csv(contacts) -> str:
    extra_keys = sorted({k for c in contacts for k in (c.extra or {})})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(TRACKER_COLUMNS + EXTRA_COLUMNS + extra_keys)
    for c in contacts:
        row = [
            c.full_name, c.company, c.linkedin_url or "", c.best_email or "", c.phone, c.job_link,
            c.email_status, f"{round(c.confidence * 100)}%", _source_url(c),
            "Yes" if c.mailed else "No", "Yes" if c.called else "No",
            c.title, c.company_domain or "", c.notes, c.created_at.isoformat() if c.created_at else "",
        ] + [(c.extra or {}).get(k, "") for k in extra_keys]
        w.writerow([_safe(v) for v in row])
    return "﻿" + buf.getvalue()  # BOM so Excel detects UTF-8; Sheets ignores it


HEADER_ALIASES = {
    "linkedin_url": {"linkedin url", "linkedin", "linkedin_url", "profile", "profile url"},
    "full_name": {"person name", "name", "full name", "full_name"},
    "company": {"company", "company name", "organization", "employer"},
    "company_domain": {"company domain", "domain", "company_domain", "website"},
    "title": {"title", "job title", "designation", "role"},
    "job_link": {"job link", "job", "job url", "job_link"},
}


def parse_batch_csv(text: str, limit: int) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    mapping = {}
    for h in reader.fieldnames or []:
        key = h.strip().lower()
        for field, aliases in HEADER_ALIASES.items():
            if key in aliases:
                mapping[h] = field
    if not mapping:
        raise ValueError("CSV needs headers such as: LinkedIn URL, Person Name, Company, Company Domain, Title, Job Link")
    rows = []
    for row in reader:
        item = {mapping[h]: (v or "").strip() for h, v in row.items() if h in mapping and (v or "").strip()}
        if item.get("linkedin_url") or item.get("full_name"):
            rows.append(item)
        if len(rows) >= limit:
            break
    return rows
