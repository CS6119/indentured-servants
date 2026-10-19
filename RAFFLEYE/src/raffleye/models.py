import hashlib
import json
import re
import unicodedata
from datetime import UTC, datetime
from typing import Generic, Literal, TypeVar
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .timeparse import explicit_times


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def aware(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timestamp needs an explicit timezone")
    return result.astimezone(UTC)


def safe_url(value: str) -> bool:
    try:
        parts = urlsplit(value)
        return parts.scheme in {"http", "https"} and bool(parts.hostname) and not parts.username
    except ValueError:
        return False


class Post(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^\d+$")
    author: str = Field(pattern=r"^[A-Za-z0-9_]{1,15}$")
    author_name: str = ""
    author_description: str = ""
    profile_fetched: bool = False
    text: str = Field(max_length=30000)
    created_at: datetime
    urls: list[str] = Field(default_factory=list)
    source: Literal["mock", "x", "apify"]

    @field_validator("created_at")
    @classmethod
    def timestamp(cls, value):
        if value.tzinfo is None:
            raise ValueError("created_at must have a timezone")
        return value.astimezone(UTC)

    @field_validator("urls")
    @classmethod
    def urls_safe(cls, values):
        return list(dict.fromkeys(v for v in values if safe_url(v)))[:30]

    @property
    def url(self) -> str:
        return f"https://x.com/{self.author}/status/{self.id}"

    @property
    def content_hash(self) -> str:
        data = [self.author.lower(), self.text, sorted(self.urls), self.author_name, self.author_description]
        return hashlib.sha256(json.dumps(data, ensure_ascii=False).encode()).hexdigest()

    @property
    def campaign_hash(self) -> str:
        # Reuploads often change only X's short media links. Keep actual terms and external URLs.
        text = re.sub(r"https?://t\.co/\S+", "", self.text)
        text = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
        return hashlib.sha256((self.author.casefold() + "\n" + text).encode()).hexdigest()

    @property
    def evidence_text(self) -> str:
        return self.text + "\n" + "\n".join(self.urls)


T = TypeVar("T")


class Claim(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")
    value: T | None
    evidence: str | None
    confidence: Literal["high", "medium", "low", "unknown"]

    @model_validator(mode="after")
    def support(self):
        if self.value is None:
            self.evidence = None
            self.confidence = "unknown"
        elif not self.evidence or self.confidence == "unknown":
            raise ValueError("Known claims require evidence and confidence")
        return self


def unknown() -> dict:
    return {"value": None, "evidence": None, "confidence": "unknown"}


def claim(value, evidence: str, confidence: str = "medium") -> dict:
    return {"value": value, "evidence": evidence, "confidence": confidence}


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_giveaway: Claim[bool]
    announcement: Claim[Literal["open", "upcoming", "ended", "cancelled", "update"]]
    prizes: Claim[list[str]]
    winner_count: Claim[int]
    requirements: Claim[list[str]]
    sponsor: Claim[str]
    sponsor_websites: Claim[list[str]]
    starts_at: Claim[str]
    deadline_at: Claim[str]
    announcement_at: Claim[str]

    def grounded(self, post: Post) -> "Extraction":
        """Reject fabricated quotes; keep unsupported claims explicitly unknown."""
        data = self.model_dump()
        for key, item in data.items():
            if item["value"] is not None and (
                not item["evidence"] or item["evidence"] not in post.evidence_text
            ):
                data[key] = unknown()
        for key in ("starts_at", "deadline_at", "announcement_at"):
            item = data[key]
            if item["value"] is not None:
                try:
                    # No year/timezone guessing. Rules and AI must cite an explicit timezone.
                    parsed = aware(item["value"])
                    if parsed not in [date for _, date in explicit_times(item["evidence"], post.text)]:
                        raise ValueError("Timestamp not supported by an explicit date in evidence")
                    item["value"] = iso(parsed)
                except (ValueError, TypeError):
                    data[key] = unknown()
        winners = data["winner_count"]["value"]
        if winners is not None and (winners < 1 or winners > 1000000):
            data["winner_count"] = unknown()
        sites = data["sponsor_websites"]["value"]
        if sites and any(not safe_url(url) or url not in post.evidence_text for url in sites):
            data["sponsor_websites"] = unknown()
        start, end = data["starts_at"]["value"], data["deadline_at"]["value"]
        if start and end and aware(start) >= aware(end):
            data["starts_at"] = unknown()
            data["deadline_at"] = unknown()
        return Extraction.model_validate(data)

    def status(self, now: datetime, ending_minutes: int = 60) -> str:
        state = self.announcement.value
        if state in {"ended", "cancelled"}:
            return state
        if self.starts_at.value and aware(self.starts_at.value) > now:
            return "upcoming"
        if self.deadline_at.value:
            remaining = (aware(self.deadline_at.value) - now).total_seconds()
            if remaining <= 0:
                return "ended"
            if remaining <= ending_minutes * 60:
                return "ending_soon"
        if state == "upcoming" and not self.starts_at.value:
            return "upcoming"
        if self.starts_at.value and aware(self.starts_at.value) <= now:
            return "open"
        return "open" if state == "open" else "unknown"
