from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


class Contact(Base):
    __tablename__ = "contacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    linkedin_url: Mapped[str | None] = mapped_column(String(300), index=True)
    full_name: Mapped[str] = mapped_column(String(200), default="")
    first_name: Mapped[str] = mapped_column(String(100), default="")
    last_name: Mapped[str] = mapped_column(String(100), default="")
    company: Mapped[str] = mapped_column(String(200), default="", index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    company_website: Mapped[str | None] = mapped_column(String(300))
    company_domain: Mapped[str | None] = mapped_column(String(200), index=True)
    domain_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    best_email: Mapped[str | None] = mapped_column(String(254))
    email_status: Mapped[str] = mapped_column(String(32), default="NOT_FOUND", index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    explanation: Mapped[str] = mapped_column(Text, default="")
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    # Outreach-tracker fields (user editable)
    phone: Mapped[str] = mapped_column(String(50), default="")
    job_link: Mapped[str] = mapped_column(String(500), default="")
    mailed: Mapped[bool] = mapped_column(Boolean, default=False)
    called: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    extra: Mapped[dict] = mapped_column(JSON, default=dict)  # user-defined extra columns
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    candidates: Mapped[list["EmailCandidate"]] = relationship(
        back_populates="contact", cascade="all, delete-orphan", order_by="EmailCandidate.confidence.desc()")
    evidence: Mapped[list["Evidence"]] = relationship(back_populates="contact", cascade="all, delete-orphan")


class EmailCandidate(Base):
    __tablename__ = "email_candidates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(254))
    status: Mapped[str] = mapped_column(String(32))
    confidence: Mapped[float] = mapped_column(Float)
    pattern: Mapped[str | None] = mapped_column(String(40))
    basis: Mapped[str] = mapped_column(Text, default="")
    source_url: Mapped[str | None] = mapped_column(String(1000))
    verification: Mapped[dict] = mapped_column(JSON, default=dict)

    contact: Mapped[Contact] = relationship(back_populates="candidates")


class Evidence(Base):
    __tablename__ = "evidence"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # published_email | pattern_sample | domain | identity | search_snippet
    url: Mapped[str | None] = mapped_column(String(1000))
    snippet: Mapped[str] = mapped_column(Text, default="")
    email: Mapped[str | None] = mapped_column(String(254))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    contact: Mapped[Contact] = relationship(back_populates="evidence")


class CacheEntry(Base):
    __tablename__ = "cache_entries"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
