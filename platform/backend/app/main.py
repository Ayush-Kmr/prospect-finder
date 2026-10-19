from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from . import db as dbmod
from .config import Settings, settings as default_settings
from .models import Contact, EmailCandidate, Evidence
from .schemas import (BatchRequest, ContactOut, ContactPatch, DiscoverRequest, EmailStatus, ValidateRequest,
                      ValidationOut)
from .services.ai import make_ai
from .services.cache import DBCache
from .services.discovery import Discovery, DiscoveryResult
from .services.export import contacts_to_csv, parse_batch_csv
from .services.fetcher import PoliteFetcher
from .services.linkedin import normalize_linkedin_url
from .services.search import make_search
from .services.verify import DnsResolver, validate_email


def create_app(settings: Settings | None = None, *, engine=None, http_client: httpx.AsyncClient | None = None,
               resolver=None, search=None, ai=None) -> FastAPI:
    s = settings or default_settings
    eng = engine or dbmod.engine
    SessionFactory = sessionmaker(bind=eng, expire_on_commit=False)
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        dbmod.migrate(eng)
        client = http_client or httpx.AsyncClient(timeout=s.request_timeout_s,
                                                  limits=httpx.Limits(max_connections=20))
        cache = DBCache(SessionFactory)
        cache.purge_expired()
        state.update(
            client=client, cache=cache, shared_fetch_state={},
            resolver=resolver or DnsResolver(cache),
            search=search or make_search(s, client, cache),
            ai_factory=(lambda: ai) if ai else (lambda: make_ai(s, cache)),
            sem=asyncio.Semaphore(s.max_concurrent_discoveries),
        )
        yield
        if not http_client:
            await client.aclose()

    app = FastAPI(title="Contact Discovery API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in s.cors_origins.split(",")],
                       allow_methods=["*"], allow_headers=["*"])

    def get_db():
        with SessionFactory() as session:
            yield session

    def load(session: Session, cid: int) -> Contact | None:
        return session.scalar(select(Contact).where(Contact.id == cid)
                              .options(selectinload(Contact.candidates), selectinload(Contact.evidence)))

    def find_existing(session: Session, req: DiscoverRequest) -> Contact | None:
        li = normalize_linkedin_url(req.linkedin_url)
        if li:
            hit = session.scalar(select(Contact).where(Contact.linkedin_url == li.url))
            if hit:
                return hit
        if req.full_name and req.company:
            return session.scalar(select(Contact).where(
                func.lower(Contact.full_name) == req.full_name.strip().lower(),
                func.lower(Contact.company) == req.company.strip().lower()))
        return None

    def persist(session: Session, req: DiscoverRequest, r: DiscoveryResult, existing: Contact | None) -> Contact:
        c = existing or Contact()
        best = r.best
        c.linkedin_url = r.linkedin_url
        c.full_name, c.first_name, c.last_name = r.full_name, r.first_name, r.last_name
        c.company, c.title = r.company, r.title
        c.company_domain, c.company_website, c.domain_confidence = r.domain.domain, r.domain.website, r.domain.confidence
        c.best_email = best.email if best else None
        c.email_status = (best.status if best else EmailStatus.NOT_FOUND).value
        c.confidence = best.confidence if best else 0.0
        c.explanation = r.explanation
        c.warnings = r.warnings
        if req.job_link:
            c.job_link = req.job_link
        c.extra = {**(c.extra or {})}
        c.candidates = [EmailCandidate(email=x.email, status=x.status.value, confidence=x.confidence, pattern=x.pattern,
                                       basis=x.basis, source_url=x.source_url, verification=x.verification)
                        for x in r.candidates]
        c.evidence = [Evidence(kind=e["kind"], url=e.get("url"), snippet=e.get("snippet", ""), email=e.get("email"))
                      for e in r.evidence]
        session.add(c)
        session.commit()
        return load(session, c.id)

    async def discover_one(session: Session, req: DiscoverRequest) -> Contact:
        existing = find_existing(session, req)
        if existing and not req.force_refresh:
            return load(session, existing.id)  # cached result: no network, no AI tokens
        async with state["sem"]:
            fetcher = PoliteFetcher(state["client"], state["cache"], user_agent=s.user_agent,
                                    per_host_interval_s=s.per_host_interval_s, ttl_hours=s.cache_ttl_hours,
                                    respect_robots=s.respect_robots, shared=state["shared_fetch_state"])
            d = Discovery(settings=s, fetcher=fetcher, resolver=state["resolver"], search=state["search"],
                          ai=state["ai_factory"](), http_client=state["client"])
            result = await d.run(req)
        return persist(session, req, result, existing)

    @app.get("/api/health")
    async def health(session: Session = Depends(get_db)):
        session.execute(select(1))
        ai_svc = state["ai_factory"]()
        return {"status": "ok", "ai_provider": ai_svc.provider.name if ai_svc.enabled else None,
                "search_provider": state["search"].name, "verification_provider": "hunter" if s.hunter_api_key else None,
                "schema_version": max(v for v, _, _ in dbmod.MIGRATIONS)}

    @app.post("/api/contacts/discover", response_model=ContactOut)
    async def discover(req: DiscoverRequest, session: Session = Depends(get_db)):
        return await discover_one(session, req)

    async def run_batch(items: list[DiscoverRequest]):
        if len(items) > s.max_batch_size:
            raise HTTPException(413, f"Batch limited to {s.max_batch_size} items.")

        async def one(item):
            with SessionFactory() as session:  # own session per task
                try:
                    return {"ok": True, "contact": ContactOut.model_validate(await discover_one(session, item))}
                except Exception as e:  # noqa: BLE001 — report per-item failure, keep going
                    return {"ok": False, "input": item.model_dump(exclude_none=True), "error": str(e)}
        return await asyncio.gather(*(one(i) for i in items))

    @app.post("/api/contacts/batch")
    async def batch(req: BatchRequest):
        return await run_batch(req.items)

    @app.post("/api/contacts/batch/csv")
    async def batch_csv(file: UploadFile = File(...)):
        text = (await file.read()).decode("utf-8", errors="replace")
        try:
            rows = parse_batch_csv(text, s.max_batch_size)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        items = []
        for row in rows:
            try:
                items.append(DiscoverRequest(**row))
            except ValueError:
                continue
        return await run_batch(items)

    def filtered(q: str | None, status: str | None):
        stmt = select(Contact).options(selectinload(Contact.candidates), selectinload(Contact.evidence))
        if q:
            like = f"%{q.lower()}%"
            stmt = stmt.where(or_(func.lower(Contact.full_name).like(like), func.lower(Contact.company).like(like),
                                  func.lower(Contact.best_email).like(like), func.lower(Contact.title).like(like)))
        if status:
            stmt = stmt.where(Contact.email_status.in_(status.split(",")))
        return stmt.order_by(Contact.updated_at.desc())

    @app.get("/api/contacts", response_model=list[ContactOut])
    async def list_contacts(q: str | None = None, status: str | None = None, limit: int = Query(100, le=1000),
                            offset: int = 0, session: Session = Depends(get_db)):
        return session.scalars(filtered(q, status).limit(limit).offset(offset)).all()

    @app.get("/api/contacts/export")
    async def export(q: str | None = None, status: str | None = None, session: Session = Depends(get_db)):
        csv_text = contacts_to_csv(session.scalars(filtered(q, status)).all())
        return Response(csv_text, media_type="text/csv; charset=utf-8",
                        headers={"content-disposition": 'attachment; filename="contacts.csv"'})

    @app.get("/api/contacts/{cid}", response_model=ContactOut)
    async def get_contact(cid: int, session: Session = Depends(get_db)):
        c = load(session, cid)
        if not c:
            raise HTTPException(404, "Contact not found")
        return c

    @app.patch("/api/contacts/{cid}", response_model=ContactOut)
    async def patch_contact(cid: int, patch: ContactPatch, session: Session = Depends(get_db)):
        c = load(session, cid)
        if not c:
            raise HTTPException(404, "Contact not found")
        for k, v in patch.model_dump(exclude_none=True).items():
            setattr(c, k, {**(c.extra or {}), **v} if k == "extra" else v)
        session.commit()
        return load(session, cid)

    @app.delete("/api/contacts/{cid}", status_code=204)
    async def delete_contact(cid: int, session: Session = Depends(get_db)):
        c = session.get(Contact, cid)
        if c:
            session.delete(c)
            session.commit()
        return Response(status_code=204)

    @app.post("/api/emails/validate", response_model=ValidationOut)
    async def validate(req: ValidateRequest):
        return await validate_email(req.email, state["resolver"],
                                    provider_key=s.hunter_api_key if req.use_provider else "", client=state["client"])

    return app


def _default_app() -> FastAPI:
    import os
    if os.getenv("DEMO_MODE", "").lower() in {"1", "true", "yes"}:
        from . import demo
        return create_app(http_client=httpx.AsyncClient(transport=demo.mock_transport()),
                          resolver=demo.DemoResolver(), search=demo.DemoSearch())
    return create_app()


app = _default_app()
