from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EmailStatus(str, Enum):
    PUBLICLY_CONFIRMED = "PUBLICLY_CONFIRMED"  # published on a public page, tied to this person
    PROVIDER_VERIFIED = "PROVIDER_VERIFIED"    # an authorized verification provider says the mailbox is valid
    PATTERN_PREDICTED = "PATTERN_PREDICTED"    # built from the company's observed published email format
    DOMAIN_VALID_ONLY = "DOMAIN_VALID_ONLY"    # generic guess; only the domain's MX is known to exist
    UNVERIFIED = "UNVERIFIED"                  # guess; domain could not be validated
    NOT_FOUND = "NOT_FOUND"


class DiscoverRequest(BaseModel):
    linkedin_url: str | None = None
    full_name: str | None = None
    company: str | None = None
    company_domain: str | None = Field(None, description="Optional: skip domain discovery")
    title: str | None = None
    profile_text: str | None = Field(None, max_length=30000, description="Optional profile text you copied (parsed by AI)")
    job_link: str | None = None
    force_refresh: bool = False

    @model_validator(mode="after")
    def _need_something(self):
        if not (self.linkedin_url or self.full_name or self.profile_text):
            raise ValueError("Provide a LinkedIn URL, a full name, or profile text.")
        return self


class BatchRequest(BaseModel):
    items: list[DiscoverRequest]


class ValidateRequest(BaseModel):
    email: str
    use_provider: bool = False


class CandidateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    email: str
    status: EmailStatus
    confidence: float
    pattern: str | None = None
    basis: str = ""
    source_url: str | None = None
    verification: dict = {}


class EvidenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    kind: str
    url: str | None = None
    snippet: str = ""
    email: str | None = None


class ContactOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    linkedin_url: str | None
    full_name: str
    first_name: str
    last_name: str
    company: str
    title: str
    company_website: str | None
    company_domain: str | None
    domain_confidence: float
    best_email: str | None
    email_status: EmailStatus
    confidence: float
    explanation: str
    warnings: list[str]
    phone: str
    job_link: str
    mailed: bool
    called: bool
    notes: str
    extra: dict
    created_at: datetime
    updated_at: datetime
    candidates: list[CandidateOut] = []
    evidence: list[EvidenceOut] = []


class ContactPatch(BaseModel):
    full_name: str | None = None
    company: str | None = None
    title: str | None = None
    best_email: str | None = None
    phone: str | None = None
    job_link: str | None = None
    mailed: bool | None = None
    called: bool | None = None
    notes: str | None = None
    extra: dict | None = None


class ValidationOut(BaseModel):
    email: str
    syntax_valid: bool
    domain: str | None
    mx_hosts: list[str]
    disposable: bool
    role_account: bool
    provider: dict | None = None
    status: EmailStatus
    note: str
