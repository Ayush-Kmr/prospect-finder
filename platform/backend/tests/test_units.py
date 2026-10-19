import asyncio

from app.services.ai import AIService
from app.services.cache import MemoryCache
from app.services.domain import clean_domain, heuristic_domains, name_match, registrable
from app.services.export import parse_batch_csv
from app.services.extract import candidate_links, emails_in_html
from app.services.linkedin import name_from_slug, normalize_linkedin_url
from app.services.patterns import PatternStats, candidates, match_pattern, render, split_name, structural_guess


def test_linkedin_normalization():
    ref = normalize_linkedin_url("linkedin.com/in/Jane-Smith-1a2b3c4d/?trk=abc")
    assert ref.url == "https://www.linkedin.com/in/jane-smith-1a2b3c4d"
    assert ref.name_guess == "Jane Smith"
    assert normalize_linkedin_url("https://evil.com/in/jane") is None
    assert normalize_linkedin_url("https://www.linkedin.com/company/acme") is None
    assert name_from_slug("jsmith42") == ""
    assert name_from_slug("maria-de-la-cruz") == "Maria De La Cruz"


def test_pattern_render_and_match():
    assert render("{first}.{last}", "José", "Núñez") == "jose.nunez"
    assert render("{f}{last}", "Jane", "") is None
    assert match_pattern("jsmith", "Jane", "Smith") == "{f}{last}"
    assert match_pattern("smith.j", "Jane", "Smith") == "{last}.{f}"
    assert match_pattern("info", "Jane", "Smith") is None
    assert structural_guess("info") is None
    assert structural_guess("a.lovelace") == "{f}.{last}"
    assert split_name("Jane Smith, SHRM-CP (she/her)") == ("Jane", "Smith")


def test_candidates_rank_observed_first():
    st = PatternStats()
    st.add("{f}{last}", "u1", exact=True)
    st.add("{f}{last}", "u2", exact=True)
    st.add("{first}.{last}", "u3", exact=False)
    c = candidates("Jane", "Smith", "example.com", st)
    assert c[0]["email"] == "jsmith@example.com" and c[0]["observed"]
    assert len({x["email"] for x in c}) == len(c)


def test_extract_emails_mailto_obfuscation_and_domain_filter():
    html = """<html><body><script>var x='hidden@acme.example'</script>
      <a href="mailto:Ann.Lee@acme.example?subject=hi">Ann Lee</a>
      <p>Bob Stone: bob [at] acme [dot] example</p><p>other@gmail.com logo@2x.png</p></body></html>"""
    found = {f.email for f in emails_in_html(html, "https://acme.example/team", "acme.example")}
    assert found == {"ann.lee@acme.example", "bob@acme.example"}


def test_candidate_links_same_site_only():
    html = '<a href="/our-team">Team</a><a href="https://other.example/team">x</a><a href="/blog/post">b</a><a href="/about.pdf">About</a>'
    assert candidate_links(html, "https://acme.example/") == ["https://acme.example/our-team"]


def test_domain_helpers():
    assert registrable("www.shop.acme.co.uk") == "acme.co.uk"
    assert clean_domain("https://www.Acme.com/careers") == "acme.com"
    assert name_match("Acme Corp", "acme.com") == 1.0
    assert name_match("Northwind Robotics", "northwindrobotics.example") == 1.0
    assert name_match("Acme", "zzz.com", "Totally Unrelated") == 0.0
    assert "acmerobotics.com" in heuristic_domains("Acme Robotics Inc.")


def test_batch_csv_parsing():
    rows = parse_batch_csv("﻿Person Name,Company,LinkedIn URL\nJane Smith,Acme,\n,,\n", 10)
    assert rows == [{"full_name": "Jane Smith", "company": "Acme"}]


class FakeProvider:
    name = "fake"

    def __init__(self, reply: str):
        self.reply = reply
        self.calls = 0

    async def json_call(self, system, user, schema):
        self.calls += 1
        assert schema["additionalProperties"] is False
        return self.reply, {"model": "fake", "input_tokens": 10, "output_tokens": 5}


def test_ai_guards_and_cache():
    prov = FakeProvider('{"domain": "made-up.com", "reason": "x"}')
    ai = AIService(prov, MemoryCache())
    out = asyncio.run(ai.choose_domain("Acme", [{"domain": "acme.com", "title": "Acme"}]))
    assert out.domain is None  # not in candidate list -> rejected

    prov2 = FakeProvider('{"full_name":"Jane Smith","current_company":"Acme","current_title":"Recruiter",'
                         '"company_domain_guesses":["acme.com"],"email_patterns_ranked":["{first}.{last}","jane@acme.com"],'
                         '"identity_conflicts":[]}')
    ai2 = AIService(prov2, MemoryCache())
    p = asyncio.run(ai2.parse_profile("Jane Smith - Recruiter at Acme"))
    assert p.email_patterns_ranked == ["{first}.{last}"]  # non-pattern output dropped
    asyncio.run(ai2.parse_profile("Jane Smith - Recruiter at Acme"))
    assert prov2.calls == 1  # second call served from cache
