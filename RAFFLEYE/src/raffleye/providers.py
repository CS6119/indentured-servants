import json
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from importlib.resources import files
from typing import Protocol

import httpx
from pydantic import ValidationError

from .config import Settings
from .models import Post, utcnow
from .storage import Store


class ProviderError(Exception):
    def __init__(self, code: str, delay: float = 300, fallback: bool = False):
        super().__init__(code)
        self.delay = delay
        self.fallback = fallback


@dataclass
class Page:
    posts: list[Post]
    next_token: str | None = None


class Source(Protocol):
    name: str

    async def fetch(self, query: str, cursor: dict) -> Page: ...


class Budget:
    def __init__(self, store: Store, settings: Settings):
        self.store, self.settings = store, settings

    def reserve(self, source: str):
        s = self.settings
        metrics = {f"{source}_requests": 1, "estimated_usd": getattr(s, f"{source}_request_reserve_usd")}
        if source == "x":
            metrics["x_posts"] = s.page_size
        limits = {key: getattr(s, "daily_" + key) for key in metrics}
        self.store.reserve(metrics, limits, s.monthly_estimated_usd)


class HTTP:
    def __init__(self, client: httpx.AsyncClient, budget: Budget):
        self.client, self.budget = client, budget

    async def request(self, provider: str, method: str, url: str, **kwargs):
        store = self.budget.store
        now = utcnow()
        cooldown = float(store.get_meta(f"cooldown:{provider}", "0"))
        if cooldown > now.timestamp():
            raise ProviderError(f"{provider}:cooldown", cooldown - now.timestamp())
        self.budget.reserve(provider)
        try:
            response = await self.client.request(method, url, **kwargs)
        except httpx.RequestError:
            raise ProviderError(f"{provider}:network", fallback=True) from None
        if response.status_code >= 400:
            delay = 300
            if response.status_code == 429:
                delay = 900
                retry = response.headers.get("retry-after")
                try:
                    if retry:
                        delay = max(delay, float(retry))
                except ValueError:
                    try:
                        delay = max(delay, (parsedate_to_datetime(retry) - now).total_seconds())
                    except (TypeError, ValueError):
                        pass
                try:
                    delay = max(
                        delay, float(response.headers.get("x-rate-limit-reset", "0")) - now.timestamp()
                    )
                except ValueError:
                    pass
            elif response.status_code in (401, 403, 402):
                delay = 3600
            if response.status_code in (401, 402, 403, 429):
                store.set_meta(f"cooldown:{provider}", now.timestamp() + delay)
            raise ProviderError(
                f"{provider}:http_{response.status_code}", delay, fallback=response.status_code >= 500
            )
        try:
            return response.json()
        except ValueError:
            raise ProviderError(f"{provider}:invalid_json") from None


class XSource:
    name = "x"

    def __init__(self, http: HTTP, settings: Settings):
        self.http, self.settings = http, settings

    async def fetch(self, query: str, cursor: dict) -> Page:
        params = {
            "query": query,
            "max_results": self.settings.page_size,
            "tweet.fields": "created_at,author_id,entities",
            "expansions": "author_id",
            "user.fields": "username,name,description",
            "start_time": cursor["start"],
            "end_time": cursor["end"],
        }
        if cursor.get("token"):
            params["next_token"] = cursor["token"]
        body = await self.http.request(
            "x",
            "GET",
            f"https://api.x.com/2/tweets/search/{self.settings.x_search_mode}",
            params=params,
            headers={"Authorization": "Bearer " + self.settings.x_bearer_token.get_secret_value()},
        )
        try:
            if not isinstance(body, dict) or body.get("errors") or "meta" not in body:
                raise ValueError("Partial API response")
            if (
                not isinstance(body.get("data", []), list)
                or len(body.get("data", [])) > self.settings.page_size
            ):
                raise ValueError("Invalid page size")
            users = {u["id"]: u for u in body.get("includes", {}).get("users", [])}
            posts = [
                Post(
                    id=t["id"],
                    text=t["text"],
                    author=users[t["author_id"]]["username"],
                    author_name=users[t["author_id"]].get("name", ""),
                    author_description=users[t["author_id"]].get("description", ""),
                    profile_fetched=True,
                    created_at=t["created_at"],
                    source="x",
                    urls=[u.get("expanded_url") or u["url"] for u in t.get("entities", {}).get("urls", [])],
                )
                for t in body.get("data", [])
            ]
            return Page(posts, body.get("meta", {}).get("next_token"))
        except (AttributeError, KeyError, TypeError, ValueError, ValidationError):
            raise ProviderError("x:invalid_or_partial_page") from None


class ApifySource:
    """Read only an operator-authorized dataset. Never launches actors or browser sessions."""

    name = "apify"

    def __init__(self, http: HTTP, settings: Settings):
        self.http, self.settings = http, settings

    async def fetch(self, query: str, cursor: dict) -> Page:
        from urllib.parse import quote

        offset = int(cursor.get("token") or "0")
        body = await self.http.request(
            "apify",
            "GET",
            f"https://api.apify.com/v2/datasets/{quote(self.settings.apify_dataset_id, safe='')}/items",
            params={"format": "json", "clean": "true", "offset": offset, "limit": self.settings.page_size},
            headers={"Authorization": "Bearer " + self.settings.apify_token.get_secret_value()},
        )
        posts = []
        try:
            if not isinstance(body, list) or len(body) > self.settings.page_size:
                raise ValueError("Expected dataset items")
            for item in body:
                author = item["author"]
                if isinstance(author, dict):
                    author = author.get("userName") or author.get("username")
                created = item.get("created_at") or item["createdAt"]
                try:
                    datetime.fromisoformat(created.replace("Z", "+00:00"))
                except ValueError:
                    created = parsedate_to_datetime(created).isoformat()
                post = Post(
                    id=str(item["id"]),
                    author=author,
                    text=item["text"],
                    created_at=created,
                    source="apify",
                    urls=item.get("urls", []),
                )
                if query.startswith("from:") and post.author.lower() != query.split()[0][5:].lower():
                    continue
                posts.append(post)
            token = str(offset + len(body)) if len(body) == self.settings.page_size else None
            return Page(posts, token)
        except (AttributeError, KeyError, TypeError, ValueError, ValidationError):
            raise ProviderError("apify:dataset_schema_mismatch") from None


class MockSource:
    name = "mock"

    async def fetch(self, query: str, cursor: dict) -> Page:
        rows = json.loads(files("raffleye").joinpath("fixtures/posts.json").read_text(encoding="utf-8"))
        posts = [Post.model_validate(row) for row in rows]
        if query.startswith("from:"):
            posts = [p for p in posts if p.author.lower() == query.split()[0][5:].lower()]
        return Page(posts)
