import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta

import httpx

from .config import Settings
from .discovery import matches_topic, profile_qualified, scoped_query
from .extraction import OpenAIExtractor, RulesExtractor
from .models import Post, aware, iso, utcnow
from .providers import HTTP, ApifySource, Budget, MockSource, ProviderError, XSource
from .storage import BudgetExceeded, Store

log = logging.getLogger(__name__)


class Service:
    def __init__(self, store: Store, settings: Settings, client: httpx.AsyncClient):
        self.store, self.settings = store, settings
        self.http = HTTP(client, Budget(store, settings))
        self.source = {
            "mock": lambda: MockSource(),
            "x": lambda: XSource(self.http, settings),
            "apify": lambda: ApifySource(self.http, settings),
        }[settings.source]()
        self.fallback = ApifySource(self.http, settings) if settings.apify_fallback else None
        self.extractor = (
            OpenAIExtractor(self.http, settings) if settings.extractor == "openai" else RulesExtractor()
        )
        self.lock = asyncio.Lock()
        store.add_query(
            "global",
            scoped_query(settings.global_query, settings.giveaway_topic),
            2,
            settings.global_interval_seconds,
        )

    def scan_key(self, query: dict) -> str:
        effective = self.query_text(query)
        identity = f"{self.source.name}:{self.settings.x_search_mode}:{effective}"
        return "scan:" + hashlib.sha256(identity.encode()).hexdigest()

    def query_text(self, query: dict) -> str:
        if query["key"].startswith(("profile:", "watch:")):
            key = "profile:" + query["key"].split(":", 1)[1]
            if self.store.get_meta(key) == "eligible":
                return query["query"] + (" -is:reply" if "-is:reply" not in query["query"] else "")
        return scoped_query(query["query"], self.settings.giveaway_topic)

    def observe_profile(self, post: Post):
        if self.settings.giveaway_topic != "wuwa":
            return
        key = "profile:" + post.author.lower()
        if not profile_qualified(post):
            if post.profile_fetched:
                self.store.set_meta(key, "ineligible")
                with self.store.db:
                    self.store.db.execute("DELETE FROM queries WHERE key=?", (key,))
            return
        queries = self.store.queries()
        if any(q["key"] == "watch:" + post.author.lower() for q in queries):
            self.store.set_meta(key, "eligible")
            return
        if (
            not any(q["key"] == key for q in queries)
            and sum(q["key"].startswith("profile:") for q in queries) >= self.settings.profile_watch_limit
        ):
            return
        self.store.set_meta(key, "eligible")
        self.store.add_query(key, f"from:{post.author} -is:retweet -is:reply", 3, 3600)

    def cursor(self, query: dict, now: datetime) -> dict:
        old = json.loads(query["cursor"]) if query["cursor"] else None
        key = self.scan_key(query)
        # X recent search has a seven-day horizon. An expired backlog is visible in status/logs.
        expired_backlog = False
        if old and old.get("source") == self.source.name and old.get("scan_key", key) == key:
            if (
                self.source.name != "x"
                or self.settings.x_search_mode == "all"
                or aware(old["start"]) > now - timedelta(days=6, hours=23)
            ):
                return old
            expired_backlog = True
            self.store.set_meta(
                "coverage_warning", "X backlog exceeded recent-search retention; window restarted"
            )
            log.warning("X backlog expired; coverage gap recorded")
        start = now - timedelta(hours=self.settings.lookback_hours)
        deep = False
        if self.source.name == "x":
            checkpoint = json.loads(self.store.get_meta(key, "{}"))
            floor = now - timedelta(hours=self.settings.backfill_hours)
            last_deep = checkpoint.get("deep_scan_at")
            deep = (
                expired_backlog
                or not last_deep
                or aware(last_deep) <= now - timedelta(hours=self.settings.backfill_interval_hours)
            )
            if deep:
                start = floor
            else:
                covered = aware(checkpoint["covered_until"]) - timedelta(minutes=5)
                start = max(floor, min(start, covered))
            if checkpoint.get("covered_until") and aware(checkpoint["covered_until"]) < floor:
                self.store.set_meta(
                    "coverage_warning",
                    "Outage exceeds configured backfill window; older posts may be missing",
                )
        return {
            "source": self.source.name,
            "scan_key": key,
            "deep": deep,
            "start": iso(start),
            "end": iso(now - timedelta(seconds=15)),
            "token": None,
        }

    async def poll(self, query: dict, now: datetime):
        cursor = self.cursor(query, now)
        try:
            page = await self.source.fetch(self.query_text(query), cursor)
            cursor["token"] = page.next_token
            checkpoint = None
            if self.source.name == "x" and not page.next_token:
                key = self.scan_key(query)
                progress = json.loads(self.store.get_meta(key, "{}"))
                progress["covered_until"] = cursor["end"]
                if cursor.get("deep"):
                    progress["deep_scan_at"] = iso(now)
                checkpoint = (key, progress)
            self.store.stage_page(
                query, page.posts, cursor if page.next_token else None, now, checkpoint=checkpoint
            )
        except ProviderError as exc:
            # No fallback on 429, auth/payment failure, malformed data or exhausted local budgets.
            if self.source.name == "x" and self.fallback and exc.fallback:
                fallback_key = "fallback:" + query["key"]
                token = self.store.get_meta(fallback_key) or None
                try:
                    page = await self.fallback.fetch(query["query"], {"token": token})
                    # Preserve X page position so recovery resumes official API coverage.
                    self.store.stage_page(query, page.posts, cursor, now)
                    self.store.set_meta(fallback_key, page.next_token or "")
                except (ProviderError, BudgetExceeded) as fallback_error:
                    log.warning("Fallback unavailable: %s", type(fallback_error).__name__)
            self.store.query_failed(query["key"], exc.delay, str(exc), now)
            log.warning("Source query delayed: %s", exc)
        except BudgetExceeded as exc:
            self.store.query_failed(query["key"], 3600, str(exc), now)

    async def tick(self, now: datetime | None = None):
        if self.lock.locked():
            return
        async with self.lock:
            now = now or utcnow()
            for query in self.store.due_queries(self.settings.queries_per_tick, now):
                self.store.set_meta("last_progress", iso(utcnow()))
                await self.poll(query, now)
            for row in self.store.pending(self.settings.extraction_batch, now):
                self.store.set_meta("last_progress", iso(utcnow()))
                post = Post.model_validate_json(row["body"])
                self.observe_profile(post)
                if not matches_topic(post, self.settings.giveaway_topic):
                    self.store.mark_filtered(post.id)
                    continue
                try:
                    extraction = await self.extractor.extract(post)
                    self.store.save_extraction(post, extraction, now, self.settings.ending_soon_minutes)
                    self.store.set_meta("extraction_warning", "")
                except BudgetExceeded as exc:
                    self.store.set_meta("extraction_warning", str(exc))
                    break
                except ProviderError as exc:
                    if str(exc) in {
                        "ai:cooldown",
                        "ai:http_429",
                        "ai:http_401",
                        "ai:http_402",
                        "ai:http_403",
                    }:
                        self.store.set_meta("extraction_warning", str(exc))
                        break
                    self.store.extraction_failed(post.id, str(exc), now)
                    log.warning("Extraction deferred: %s", exc)
            self.store.refresh_statuses(now, self.settings.ending_soon_minutes)
            self.store.set_meta("last_tick", iso(now))
            self.store.set_meta("last_progress", iso(utcnow()))

    async def run(self, stop: asyncio.Event, notify=None):
        while not stop.is_set():
            try:
                await self.tick()
                if notify:
                    await notify()
                self.store.set_meta("worker_error", "")
            except Exception as exc:
                # Avoid dumping raw responses, credentials or user content into logs.
                self.store.set_meta("worker_error", type(exc).__name__)
                log.error("Worker cycle failed (%s)", type(exc).__name__)
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.settings.poll_seconds)
            except TimeoutError:
                pass
