import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from .models import Extraction, Post, iso, utcnow


class BudgetExceeded(Exception):
    pass


class Store:
    def __init__(self, path: str | Path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS posts(
                id TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL,
                processed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                available REAL NOT NULL DEFAULT 0, error TEXT, seen_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS pending_posts ON posts(processed,available);
            CREATE TABLE IF NOT EXISTS giveaways(
                id TEXT PRIMARY KEY, hash TEXT NOT NULL, post TEXT NOT NULL, extraction TEXT NOT NULL,
                status TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS giveaway_hash ON giveaways(hash);
            CREATE TABLE IF NOT EXISTS queries(
                key TEXT PRIMARY KEY, query TEXT NOT NULL, priority INTEGER NOT NULL,
                interval_s INTEGER NOT NULL, next_due REAL NOT NULL DEFAULT 0,
                cursor TEXT, last_ok TEXT, error TEXT);
            CREATE TABLE IF NOT EXISTS budgets(
                period TEXT NOT NULL, metric TEXT NOT NULL, used REAL NOT NULL,
                PRIMARY KEY(period,metric));
            CREATE TABLE IF NOT EXISTS subscriptions(
                guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS deliveries(
                channel_id TEXT NOT NULL, post_id TEXT NOT NULL, message_id TEXT NOT NULL,
                PRIMARY KEY(channel_id,post_id));
            CREATE TABLE IF NOT EXISTS outbox(
                channel_id TEXT NOT NULL, post_id TEXT NOT NULL, revision INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, available REAL NOT NULL DEFAULT 0, error TEXT,
                PRIMARY KEY(channel_id,post_id));
            INSERT OR IGNORE INTO meta VALUES ('schema_version','1');
        """)
        if self.get_meta("schema_version") != "1":
            raise RuntimeError("Unsupported database schema")

    def close(self):
        self.db.close()

    def get_meta(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, str(value)))

    def reserve(
        self,
        metrics: dict[str, float],
        limits: dict[str, float],
        monthly_usd: float,
        now: datetime | None = None,
    ):
        now = now or utcnow()
        day, month = now.strftime("day:%Y-%m-%d"), now.strftime("month:%Y-%m")
        entries = [(day, key, amount, limits[key]) for key, amount in metrics.items()]
        entries.append((month, "estimated_usd", metrics.get("estimated_usd", 0), monthly_usd))
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            for period, key, amount, limit in entries:
                row = self.db.execute(
                    "SELECT used FROM budgets WHERE period=? AND metric=?", (period, key)
                ).fetchone()
                if (row[0] if row else 0) + amount > limit + 1e-9:
                    raise BudgetExceeded(f"{period} {key} limit reached")
            for period, key, amount, _ in entries:
                self.db.execute(
                    """INSERT INTO budgets VALUES (?,?,?) ON CONFLICT(period,metric)
                    DO UPDATE SET used=used+excluded.used""",
                    (period, key, amount),
                )

    def usage(self):
        day = utcnow().strftime("day:%Y-%m-%d")
        return {
            r["metric"]: r["used"] for r in self.db.execute("SELECT * FROM budgets WHERE period=?", (day,))
        }

    def add_query(self, key: str, query: str, priority: int, interval: int):
        with self.db:
            self.db.execute(
                """INSERT INTO queries(key,query,priority,interval_s) VALUES (?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET
                cursor=CASE WHEN queries.query=excluded.query THEN queries.cursor ELSE NULL END,
                query=excluded.query,priority=excluded.priority,interval_s=excluded.interval_s""",
                (key, query, priority, interval),
            )

    def watch(self, handle: str, priority: int):
        handle = handle.lstrip("@").lower()
        if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle) or priority not in (1, 2, 3):
            raise ValueError("Use an X handle and priority 1 (highest), 2, or 3")
        self.add_query(
            "watch:" + handle, f"from:{handle} -is:retweet", priority, {1: 300, 2: 900, 3: 3600}[priority]
        )

    def unwatch(self, handle: str):
        with self.db:
            self.db.execute("DELETE FROM queries WHERE key=?", ("watch:" + handle.lstrip("@").lower(),))

    def queries(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM queries ORDER BY priority,key")]

    def due_queries(self, limit: int, now: datetime):
        rows = [
            dict(r)
            for r in self.db.execute(
                "SELECT * FROM queries WHERE next_due<=? ORDER BY next_due,priority,key", (now.timestamp(),)
            )
        ]
        # Reserve one slot for global discovery; overdue-first prevents watchlist starvation.
        global_rows = [r for r in rows if r["key"] == "global"]
        return (global_rows + [r for r in rows if r["key"] != "global"])[:limit]

    def query_failed(self, key: str, delay: float, error: str, now: datetime):
        with self.db:
            self.db.execute(
                "UPDATE queries SET next_due=?,error=? WHERE key=?",
                (now.timestamp() + max(10, delay), error[:200], key),
            )

    def stage_page(
        self,
        query: dict,
        posts: list[Post],
        cursor: dict | None,
        now: datetime,
        checkpoint: tuple[str, dict] | None = None,
    ):
        # Raw data and pagination advance atomically: extraction failures cannot lose posts.
        with self.db:
            if checkpoint:
                self.db.execute(
                    "INSERT OR REPLACE INTO meta VALUES (?,?)", (checkpoint[0], json.dumps(checkpoint[1]))
                )
            for post in posts:
                self.db.execute(
                    """INSERT INTO posts(id,hash,body,seen_at) VALUES (?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                    processed=CASE WHEN posts.hash=excluded.hash THEN posts.processed ELSE 0 END,
                    attempts=CASE WHEN posts.hash=excluded.hash THEN posts.attempts ELSE 0 END,
                    available=CASE WHEN posts.hash=excluded.hash THEN posts.available ELSE 0 END,
                    hash=excluded.hash,body=excluded.body,seen_at=excluded.seen_at""",
                    (post.id, post.content_hash, post.model_dump_json(), iso(now)),
                )
            self.db.execute(
                "UPDATE queries SET cursor=?,next_due=?,last_ok=?,error=NULL WHERE key=?",
                (
                    json.dumps(cursor) if cursor else None,
                    now.timestamp() + (10 if cursor else query["interval_s"]),
                    iso(now),
                    query["key"],
                ),
            )

    def pending(self, limit: int, now: datetime):
        return self.db.execute(
            "SELECT * FROM posts WHERE processed=0 AND attempts<5 AND available<=? ORDER BY seen_at,id LIMIT ?",
            (now.timestamp(), limit),
        ).fetchall()

    def extraction_failed(self, post_id: str, error: str, now: datetime):
        with self.db:
            self.db.execute(
                "UPDATE posts SET attempts=attempts+1,available=?,error=? WHERE id=?",
                (now.timestamp() + 300, error[:200], post_id),
            )

    def mark_filtered(self, post_id: str):
        with self.db:
            self.db.execute("UPDATE posts SET processed=1,error=NULL WHERE id=?", (post_id,))

    def retry_failed(self):
        with self.db:
            self.db.execute("UPDATE posts SET attempts=0,available=0,error=NULL WHERE processed=0")
            self.db.execute("UPDATE outbox SET attempts=0,available=0,error=NULL")

    def _queue(self, post_id: str, revision: int, channel: str | None = None):
        row = self.db.execute("SELECT status FROM giveaways WHERE id=?", (post_id,)).fetchone()
        channels = (
            [channel] if channel else [r[0] for r in self.db.execute("SELECT channel_id FROM subscriptions")]
        )
        for channel_id in channels:
            if row and row["status"] in {"ended", "cancelled"}:
                # Existing cards still get terminal edits; never introduce an expired discovery.
                delivered = self.db.execute(
                    "SELECT 1 FROM deliveries WHERE channel_id=? AND post_id=?", (channel_id, post_id)
                ).fetchone()
                pending = self.db.execute(
                    "SELECT 1 FROM outbox WHERE channel_id=? AND post_id=?", (channel_id, post_id)
                ).fetchone()
                if not delivered and not pending:
                    continue
            self.db.execute(
                """INSERT INTO outbox(channel_id,post_id,revision) VALUES (?,?,?)
                ON CONFLICT(channel_id,post_id) DO UPDATE SET revision=excluded.revision,attempts=0,available=0,error=NULL""",
                (channel_id, post_id, revision),
            )

    def save_extraction(self, post: Post, extraction: Extraction, now: datetime, ending_minutes: int):
        with self.db:
            self.db.execute("UPDATE posts SET processed=1,error=NULL WHERE id=?", (post.id,))
            if extraction.is_giveaway.value is not True or not extraction.prizes.value:
                self.db.execute("DELETE FROM outbox WHERE post_id=?", (post.id,))
                self.db.execute("DELETE FROM giveaways WHERE id=?", (post.id,))
                return
            duplicate = self.db.execute(
                "SELECT id FROM giveaways WHERE hash=? AND id<>?", (post.content_hash, post.id)
            ).fetchone()
            if duplicate:
                return
            for other in self.db.execute(
                "SELECT id,post FROM giveaways WHERE json_extract(post,'$.author')=? COLLATE NOCASE AND id<>?",
                (post.author, post.id),
            ):
                if Post.model_validate_json(other["post"]).campaign_hash == post.campaign_hash:
                    # A repeated announcement with only different short links is not a new card.
                    return
            old = self.db.execute("SELECT * FROM giveaways WHERE id=?", (post.id,)).fetchone()
            payload, status = extraction.model_dump_json(), extraction.status(now, ending_minutes)
            if (
                old
                and old["extraction"] == payload
                and old["status"] == status
                and old["hash"] == post.content_hash
            ):
                return
            revision = old["revision"] + 1 if old else 1
            self.db.execute(
                "INSERT OR REPLACE INTO giveaways VALUES (?,?,?,?,?,?,?)",
                (post.id, post.content_hash, post.model_dump_json(), payload, status, revision, iso(now)),
            )
            self._queue(post.id, revision)

    def refresh_statuses(self, now: datetime, ending_minutes: int):
        with self.db:
            for row in self.db.execute(
                "SELECT * FROM giveaways WHERE status NOT IN ('ended','cancelled')"
            ).fetchall():
                state = Extraction.model_validate_json(row["extraction"]).status(now, ending_minutes)
                if state != row["status"]:
                    revision = row["revision"] + 1
                    self.db.execute(
                        "UPDATE giveaways SET status=?,revision=?,updated_at=? WHERE id=?",
                        (state, revision, iso(now), row["id"]),
                    )
                    self._queue(row["id"], revision)

    def list_giveaways(self, limit=10, predicate=None):
        rows = []
        for row in self.db.execute("SELECT * FROM giveaways ORDER BY updated_at DESC,id DESC"):
            row = dict(row)
            if predicate is None or predicate(row):
                rows.append(row)
                if len(rows) >= limit:
                    break
        return rows

    def giveaway(self, post_id):
        row = self.db.execute("SELECT * FROM giveaways WHERE id=?", (post_id,)).fetchone()
        return dict(row) if row else None

    def subscription(self, guild_id: int) -> int | None:
        row = self.db.execute(
            "SELECT channel_id FROM subscriptions WHERE guild_id=?", (str(guild_id),)
        ).fetchone()
        return int(row[0]) if row else None

    def subscribe(self, guild_id: int, channel_id: int):
        with self.db:
            old = self.db.execute(
                "SELECT channel_id FROM subscriptions WHERE guild_id=?", (str(guild_id),)
            ).fetchone()
            if old and old[0] != str(channel_id):
                self.db.execute("DELETE FROM outbox WHERE channel_id=?", (old[0],))
            self.db.execute(
                "INSERT OR REPLACE INTO subscriptions VALUES (?,?)", (str(guild_id), str(channel_id))
            )
            for row in self.db.execute(
                "SELECT * FROM giveaways WHERE status NOT IN ('ended','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 25"
            ).fetchall():
                self._queue(row["id"], row["revision"], str(channel_id))

    def discard_notification(self, item):
        with self.db:
            self.db.execute(
                "DELETE FROM outbox WHERE channel_id=? AND post_id=? AND revision=?",
                (item["channel_id"], item["post_id"], item["revision"]),
            )

    def unsubscribe(self, guild_id: int):
        with self.db:
            self.db.execute(
                "DELETE FROM outbox WHERE channel_id IN (SELECT channel_id FROM subscriptions WHERE guild_id=?)",
                (str(guild_id),),
            )
            self.db.execute("DELETE FROM subscriptions WHERE guild_id=?", (str(guild_id),))

    def pending_notifications(self, now: datetime):
        return [
            dict(r)
            for r in self.db.execute(
                """SELECT o.*,d.message_id FROM outbox o LEFT JOIN deliveries d
            ON o.channel_id=d.channel_id AND o.post_id=d.post_id WHERE o.available<=? AND o.attempts<8 LIMIT 25""",
                (now.timestamp(),),
            )
        ]

    def delivered(self, item, message_id):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO deliveries VALUES (?,?,?)",
                (item["channel_id"], item["post_id"], str(message_id)),
            )
            self.db.execute(
                "DELETE FROM outbox WHERE channel_id=? AND post_id=? AND revision=?",
                (item["channel_id"], item["post_id"], item["revision"]),
            )

    def delivery_failed(self, item, error: str, now: datetime):
        with self.db:
            self.db.execute(
                "UPDATE outbox SET attempts=attempts+1,available=?,error=? WHERE channel_id=? AND post_id=?",
                (
                    now.timestamp() + min(3600, 30 * 2 ** item["attempts"]),
                    error[:200],
                    item["channel_id"],
                    item["post_id"],
                ),
            )

    def status(self):
        return {
            "giveaways": self.db.execute("SELECT COUNT(*) FROM giveaways").fetchone()[0],
            "pending_extractions": self.db.execute("SELECT COUNT(*) FROM posts WHERE processed=0").fetchone()[
                0
            ],
            "quarantined_extractions": self.db.execute(
                "SELECT COUNT(*) FROM posts WHERE processed=0 AND attempts>=5"
            ).fetchone()[0],
            "pending_notifications": self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
            "failed_notifications": self.db.execute(
                "SELECT COUNT(*) FROM outbox WHERE attempts>=8"
            ).fetchone()[0],
            "query_errors": {r["key"]: r["error"] for r in self.queries() if r["error"]},
            "last_tick": self.get_meta("last_tick"),
            "last_progress": self.get_meta("last_progress"),
            "worker_error": self.get_meta("worker_error"),
            "coverage_warning": self.get_meta("coverage_warning"),
            "extraction_warning": self.get_meta("extraction_warning"),
            "usage_today": self.usage(),
        }
