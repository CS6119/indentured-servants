import json
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import discord
import httpx
import pytest

from raffleye.discord_bot import RaffleyeBot
from raffleye.extraction import RulesExtractor
from raffleye.models import aware, iso
from raffleye.providers import Page, XSource
from raffleye.service import Service
from raffleye.storage import BudgetExceeded


async def test_backfill_resume_then_checkpoint(store, settings, now, post):
    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source = MagicMock(name="source")
        service.source.name = "x"
        service.source.fetch = AsyncMock(return_value=Page([post], "page2"))
        query = store.queries()[0]
        await service.poll(query, now)
        assert store.get_meta(service.scan_key(query)) is None
        saved = json.loads(store.queries()[0]["cursor"])
        assert aware(saved["start"]) == now - timedelta(days=6)
        assert saved["token"] == "page2"
        restarted = Service(store, settings, client)
        restarted.source = service.source
        assert restarted.cursor(store.queries()[0], now + timedelta(hours=2)) == saved
        restarted.source.fetch.return_value = Page([])
        await restarted.poll(store.queries()[0], now + timedelta(hours=2))
        checkpoint = json.loads(store.get_meta(restarted.scan_key(query)))
        assert checkpoint["covered_until"] == saved["end"]
        assert store.queries()[0]["cursor"] is None
        assert len(store.pending(25, now)) == 1


async def test_outage_catchup_and_periodic_rescan(store, settings, now):
    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source = XSource(service.http, settings)
        query = store.queries()[0]
        store.set_meta(
            service.scan_key(query),
            json.dumps(
                {
                    "covered_until": iso(now - timedelta(hours=40)),
                    "deep_scan_at": iso(now - timedelta(hours=2)),
                }
            ),
        )
        cursor = service.cursor(query, now)
        assert aware(cursor["start"]) == now - timedelta(hours=40, minutes=5)
        assert not cursor["deep"]
        cursor = service.cursor(query, now + timedelta(days=1))
        assert cursor["deep"]
        assert aware(cursor["start"]) == now - timedelta(days=5)


async def test_expired_backlog_and_mode_isolation(store, settings, now):
    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source = XSource(service.http, settings)
        query = store.queries()[0]
        old = service.cursor(query, now - timedelta(days=2))
        old["token"] = "stale"
        query["cursor"] = json.dumps(old)
        assert service.cursor(query, now)["token"] is None
        assert store.get_meta("coverage_warning")
        settings.x_search_mode = "all"
        settings.backfill_hours = 720
        archive = service.cursor(query, now)
        assert aware(archive["start"]) == now - timedelta(days=30)
        assert archive["scan_key"] != old["scan_key"]
        archive["token"] = "archive-page"
        query["cursor"] = json.dumps(archive)
        assert service.cursor(query, now + timedelta(days=10)) == archive


async def test_budget_interruption_preserves_incomplete_scan(store, settings, now):
    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source = MagicMock()
        service.source.name = "x"
        service.source.fetch = AsyncMock(return_value=Page([], "next"))
        await service.poll(store.queries()[0], now)
        query = store.queries()[0]
        service.source.fetch.side_effect = BudgetExceeded("limit")
        await service.poll(query, now + timedelta(minutes=1))
        assert store.queries()[0]["cursor"] == query["cursor"]
        assert store.get_meta(service.scan_key(query)) is None


def test_checkpoint_rolls_back_with_failed_page(store, settings, now, post):
    store.add_query("global", "giveaway", 2, 900)
    store.db.execute("CREATE TRIGGER fail_post BEFORE INSERT ON posts BEGIN SELECT RAISE(ABORT, 'test'); END")
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        store.stage_page(store.queries()[0], [post], None, now, checkpoint=("scan:test", {"done": True}))
    assert store.get_meta("scan:test") is None
    assert store.queries()[0]["last_ok"] is None


async def test_expired_discovery_stored_but_never_announced(store, post, now):
    store.subscribe(1, 2)
    awaitable = RulesExtractor().extract(post)
    store.save_extraction(post, await awaitable, now + timedelta(days=2), 60)
    assert store.giveaway(post.id)["status"] == "ended"
    assert store.pending_notifications(now) == []
    store.subscribe(1, 2)
    assert store.pending_notifications(now) == []


@pytest.mark.parametrize("already_delivered", [False, True])
async def test_expired_queued_or_deleted_card_not_sent(store, settings, post, now, already_delivered):
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    if already_delivered:
        store.delivered(store.pending_notifications(now)[0], 123)
    store.refresh_statuses(now + timedelta(days=2), 60)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        channel = MagicMock(spec=discord.TextChannel)
        channel.guild.id = settings.discord_guild_id
        channel.send = AsyncMock()
        channel.get_partial_message.return_value.edit = AsyncMock(
            side_effect=discord.NotFound(MagicMock(status=404, reason="Not Found"), "gone")
        )
        bot.get_channel = MagicMock(return_value=channel)
        await bot.notify()
        channel.send.assert_not_awaited()
        assert store.status()["pending_notifications"] == 0
        await bot.close()
