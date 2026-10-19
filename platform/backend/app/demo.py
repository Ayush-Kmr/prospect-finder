"""Fictional sample world for tests and DEMO_MODE (no network, no keys).

Everything uses the reserved .example TLD (RFC 2606); no real people or companies.
"""

from __future__ import annotations

import httpx

from .services.search import SearchResult

DOMAIN = "northwindrobotics.example"

PAGES = {
    f"https://{DOMAIN}/robots.txt": ("text/plain", "User-agent: *\nDisallow: /private/\n"),
    f"https://{DOMAIN}/": ("text/html", f"""
<html><head><title>Northwind Robotics | Warehouse automation</title></head>
<body><nav><a href="/team">Our Team</a> <a href="/press">Press</a> <a href="/private/staff">Staff portal</a>
<a href="/pricing">Pricing</a></nav><p>Contact us: info@{DOMAIN}</p></body></html>"""),
    f"https://{DOMAIN}/team": ("text/html", f"""
<html><head><title>Team - Northwind Robotics</title></head><body>
<h2>Leadership</h2>
<div><h3>Maria Gonzalez</h3><p>Chief Technology Officer</p><a href="mailto:maria.gonzalez@{DOMAIN}">Email Maria</a></div>
<div><h3>Tom Becker</h3><p>VP Sales — tom.becker@{DOMAIN}</p></div>
<div><h3>Samir Haddad</h3><p>Head of People. Reach Samir Haddad at samir.haddad@{DOMAIN}</p></div>
</body></html>"""),
    f"https://{DOMAIN}/press": ("text/html", f"""
<html><head><title>Press - Northwind Robotics</title></head><body>
<p>Media contact: Priya Nair, priya.nair [at] northwindrobotics [dot] example</p>
<p>General enquiries: press@{DOMAIN}</p></body></html>"""),
    f"https://{DOMAIN}/private/staff": ("text/html", f"<p>Jane Smith jane.smith@{DOMAIN}</p>"),  # robots-disallowed
    "https://events.example/speakers/2026": ("text/html", f"""
<html><head><title>AutomateConf 2026 Speakers</title></head><body>
<div class="speaker"><h3>Alex Chen</h3><p>Talent Acquisition Lead, Northwind Robotics.
Contact: alex.chen@{DOMAIN}</p></div></body></html>"""),
}

MX = {DOMAIN: ["aspmx.l.google.com"], "events.example": []}

SEARCH = {
    '"Northwind Robotics" official website': [
        SearchResult(f"https://{DOMAIN}/", "Northwind Robotics | Warehouse automation", "Warehouse robots."),
        SearchResult("https://www.linkedin.com/company/northwind-robotics", "Northwind Robotics | LinkedIn", ""),
        SearchResult("https://www.crunchbase.com/organization/northwind-robotics", "Northwind Robotics - Crunchbase", ""),
    ],
    f'"Alex Chen" "@{DOMAIN}"': [
        SearchResult("https://events.example/speakers/2026", "AutomateConf 2026 Speakers",
                     "Alex Chen, Talent Acquisition Lead, Northwind Robotics ..."),
    ],
}


def mock_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url in PAGES:
            ctype, body = PAGES[url]
            return httpx.Response(200, headers={"content-type": f"{ctype}; charset=utf-8"}, text=body)
        if url.endswith("/robots.txt"):
            return httpx.Response(404)
        return httpx.Response(404, headers={"content-type": "text/html"}, text="not found")
    return httpx.MockTransport(handler)


class DemoResolver:
    async def mx(self, domain: str) -> list[str]:
        return MX.get(domain, [])


class DemoSearch:
    name = "demo"

    async def search(self, query: str, count: int = 10):
        return SEARCH.get(query, [])[:count]
