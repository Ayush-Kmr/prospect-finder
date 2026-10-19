import csv
import io

from app.demo import DOMAIN


def discover(client, **body):
    r = client.post("/api/contacts/discover", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_health(client):
    r = client.get("/api/health").json()
    assert r["status"] == "ok" and r["search_provider"] == "demo" and r["ai_provider"] is None


def test_predicts_from_observed_company_pattern(client, transport):
    c = discover(client, full_name="Jane Smith", company="Northwind Robotics")
    assert c["company_domain"] == DOMAIN
    assert c["best_email"] == f"jane.smith@{DOMAIN}"
    assert c["email_status"] == "PATTERN_PREDICTED"
    assert 0.5 <= c["confidence"] <= 0.75
    kinds = {e["kind"] for e in c["evidence"]}
    assert {"domain", "pattern_sample"} <= kinds
    # robots.txt disallows /private/: the page that would "confirm" Jane must not be fetched
    assert not any("/private/" in u for u in transport.urls)
    assert not any(x["status"] == "PUBLICLY_CONFIRMED" for x in c["candidates"])
    # LinkedIn is never contacted
    assert not any("linkedin.com" in u for u in transport.urls)


def test_publicly_confirmed_on_company_site(client):
    c = discover(client, full_name="Maria Gonzalez", company="Northwind Robotics")
    assert c["best_email"] == f"maria.gonzalez@{DOMAIN}"
    assert c["email_status"] == "PUBLICLY_CONFIRMED"
    assert c["candidates"][0]["source_url"] == f"https://{DOMAIN}/team"
    assert c["confidence"] >= 0.9


def test_publicly_confirmed_on_external_page_via_search(client):
    c = discover(client, full_name="Alex Chen", company="Northwind Robotics",
                 linkedin_url="https://www.linkedin.com/in/alex-chen-77aa11bb")
    assert c["email_status"] == "PUBLICLY_CONFIRMED"
    assert c["candidates"][0]["source_url"] == "https://events.example/speakers/2026"
    assert c["linkedin_url"] == "https://www.linkedin.com/in/alex-chen-77aa11bb"


def test_obfuscated_press_contact_is_confirmed(client):
    c = discover(client, full_name="Priya Nair", company="Northwind Robotics")
    assert c["best_email"] == f"priya.nair@{DOMAIN}" and c["email_status"] == "PUBLICLY_CONFIRMED"


def test_linkedin_url_alone_asks_for_company(client):
    c = discover(client, linkedin_url="https://www.linkedin.com/in/jane-smith-1a2b3c4d")
    assert c["email_status"] == "NOT_FOUND"
    assert c["full_name"] == "Jane Smith"
    assert any("inferred from the LinkedIn URL" in w for w in c["warnings"])
    assert any("Provide the person's company" in w for w in c["warnings"])


def test_slug_name_plus_company_and_cache(client, transport):
    body = dict(linkedin_url="https://www.linkedin.com/in/jane-smith-1a2b3c4d", company="Northwind Robotics")
    first = discover(client, **body)
    assert first["email_status"] == "PATTERN_PREDICTED"
    n = len(transport.urls)
    again = discover(client, **body)
    assert again["id"] == first["id"] and len(transport.urls) == n  # served from DB, no network
    discover(client, **body, force_refresh=True)
    assert len(client.get("/api/contacts").json()) == 1  # refresh updates in place


def test_unknown_company_without_domain(client):
    c = discover(client, full_name="Pat Doe", company="Nonexistent Widgets Ltd")
    assert c["email_status"] == "NOT_FOUND" and c["company_domain"] is None
    assert any("Could not confirm an official domain" in w for w in c["warnings"])


def test_provided_domain_without_mx(client):
    c = discover(client, full_name="Pat Doe", company="Events Co", company_domain="events.example")
    assert any("no MX" in w for w in c["warnings"])
    assert all(x["status"] != "DOMAIN_VALID_ONLY" for x in c["candidates"])


def test_patch_export_and_filters(client):
    c = discover(client, full_name="Jane Smith", company="Northwind Robotics", job_link="https://jobs.example/1")
    r = client.patch(f"/api/contacts/{c['id']}", json={"mailed": True, "phone": "=HYPERLINK(1)", "extra": {"Stage": "Applied"}})
    assert r.status_code == 200 and r.json()["mailed"] is True
    discover(client, full_name="Maria Gonzalez", company="Northwind Robotics")

    assert len(client.get("/api/contacts", params={"status": "PUBLICLY_CONFIRMED"}).json()) == 1
    assert len(client.get("/api/contacts", params={"q": "jane"}).json()) == 1

    text = client.get("/api/contacts/export").text.lstrip("﻿")
    rows = list(csv.DictReader(io.StringIO(text)))
    assert list(rows[0].keys())[:11] == ["Person Name", "Company", "LinkedIn URL", "Professional Email", "Contact Number",
                                         "Job Link", "Email Status", "Confidence Score", "Source URL", "Mailed", "Called"]
    jane = next(r for r in rows if r["Person Name"] == "Jane Smith")
    assert jane["Mailed"] == "Yes" and jane["Called"] == "No" and jane["Stage"] == "Applied"
    assert jane["Contact Number"].startswith("'=")  # formula injection neutralized
    assert jane["Job Link"] == "https://jobs.example/1"


def test_batch_json_and_csv(client):
    r = client.post("/api/contacts/batch", json={"items": [
        {"full_name": "Tom Becker", "company": "Northwind Robotics"},
        {"full_name": "Jane Smith", "company": "Northwind Robotics"},
    ]}).json()
    assert [x["ok"] for x in r] == [True, True]
    assert r[0]["contact"]["email_status"] == "PUBLICLY_CONFIRMED"

    data = "Person Name,Company\nSamir Haddad,Northwind Robotics\n"
    r = client.post("/api/contacts/batch/csv", files={"file": ("b.csv", data, "text/csv")}).json()
    assert r[0]["contact"]["best_email"] == f"samir.haddad@{DOMAIN}"

    bad = client.post("/api/contacts/batch/csv", files={"file": ("b.csv", "foo,bar\n1,2\n", "text/csv")})
    assert bad.status_code == 400


def test_validate_email(client):
    v = client.post("/api/emails/validate", json={"email": f"someone@{DOMAIN}"}).json()
    assert v["status"] == "DOMAIN_VALID_ONLY" and "does NOT confirm" in v["note"]
    assert client.post("/api/emails/validate", json={"email": "not-an-email"}).json()["status"] == "NOT_FOUND"
    assert client.post("/api/emails/validate", json={"email": "x@events.example"}).json()["status"] == "UNVERIFIED"
    assert client.post("/api/emails/validate", json={"email": f"info@{DOMAIN}"}).json()["role_account"] is True


def test_validation_errors(client):
    assert client.post("/api/contacts/discover", json={}).status_code == 422
    assert client.get("/api/contacts/9999").status_code == 404
