"""Non-intrusive email validation.

Done locally: syntax, MX lookup, disposable-domain list, role-account detection.
Optional: an authorized verification provider (Hunter Email Verifier API).
There is deliberately no SMTP RCPT probing. An MX record shows the domain
accepts mail, never that a specific mailbox exists.
"""

from __future__ import annotations

import re

import dns.asyncresolver
import dns.exception
import dns.resolver
import httpx

from ..schemas import EmailStatus
from .cache import cache_key
from .patterns import ROLE_LOCALS

SYNTAX_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)

# Small built-in list; extend via DISPOSABLE_DOMAINS or swap for a maintained list.
DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
    "trashmail.com", "getnada.com", "dispostable.com", "sharklasers.com", "maildrop.cc", "fakeinbox.com",
    "throwawaymail.com", "mintemail.com", "mohmal.com", "emailondeck.com", "spamgourmet.com", "burnermail.io",
}
FREEMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
    "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com", "yandex.com", "mail.com",
}


class DnsResolver:
    def __init__(self, cache=None, ttl_hours: float = 24):
        self.cache = cache
        self.ttl = ttl_hours

    async def mx(self, domain: str) -> list[str]:
        key = cache_key("mx", domain)
        if self.cache and (hit := self.cache.get(key)) is not None:
            return hit
        try:
            ans = await dns.asyncresolver.resolve(domain, "MX", lifetime=6)
            hosts = sorted((r.preference, str(r.exchange).rstrip(".").lower()) for r in ans)
            out = [h for _, h in hosts if h]  # null MX "." means "accepts no mail"
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
            out = []
        except dns.exception.DNSException:
            return []  # transient; don't cache
        if self.cache:
            self.cache.set(key, out, self.ttl)
        return out


def mail_host_label(mx: list[str]) -> str:
    s = " ".join(mx)
    if re.search(r"google\.com|googlemail\.com", s):
        return "Google Workspace"
    if re.search(r"outlook\.com|microsoft\.com", s):
        return "Microsoft 365"
    if re.search(r"pphosted|mimecast|barracuda|messagelabs|iphmx|proofpoint", s):
        return "Security gateway"
    return "Other" if mx else "None"


async def hunter_verify(email: str, api_key: str, client: httpx.AsyncClient) -> dict | None:
    """Authorized third-party verification (consumes Hunter credits)."""
    try:
        r = await client.get("https://api.hunter.io/v2/email-verifier", params={"email": email, "api_key": api_key})
        if r.status_code != 200:
            return {"provider": "hunter", "error": f"HTTP {r.status_code}"}
        d = r.json().get("data") or {}
        return {"provider": "hunter", "status": d.get("status"), "score": d.get("score"),
                "accept_all": d.get("accept_all"), "disposable": d.get("disposable")}
    except httpx.HTTPError as e:
        return {"provider": "hunter", "error": str(e)}


async def validate_email(email: str, resolver: DnsResolver, *, provider_key: str = "",
                         client: httpx.AsyncClient | None = None) -> dict:
    email = email.strip().lower()
    syntax = bool(SYNTAX_RE.match(email))
    domain = email.rsplit("@", 1)[1] if syntax else None
    local = email.rsplit("@", 1)[0] if syntax else ""
    mx = await resolver.mx(domain) if domain else []
    disposable = bool(domain and domain in DISPOSABLE_DOMAINS)
    provider = None
    if syntax and mx and provider_key and client:
        provider = await hunter_verify(email, provider_key, client)

    if not syntax:
        status, note = EmailStatus.NOT_FOUND, "Invalid syntax."
    elif provider and provider.get("status") == "valid" and not provider.get("accept_all"):
        status, note = EmailStatus.PROVIDER_VERIFIED, "Verified by an authorized provider."
    elif mx:
        status = EmailStatus.DOMAIN_VALID_ONLY
        note = "Domain accepts email (MX found). This does NOT confirm the mailbox exists."
        if provider and provider.get("accept_all"):
            note += " Provider reports the domain is catch-all, so mailbox-level verification is not possible."
    else:
        status, note = EmailStatus.UNVERIFIED, "Domain has no MX records; it cannot receive email."
    return {
        "email": email, "syntax_valid": syntax, "domain": domain, "mx_hosts": mx, "disposable": disposable,
        "role_account": local in ROLE_LOCALS, "provider": provider, "status": status, "note": note,
    }
