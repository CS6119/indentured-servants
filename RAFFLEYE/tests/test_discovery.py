from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from raffleye.discord_bot import RaffleyeBot
from raffleye.discovery import WUWA_QUERY, matches_topic, profile_qualified, scoped_query
from raffleye.extraction import RulesExtractor
from raffleye.providers import Page
from raffleye.service import Service


@pytest.mark.parametrize("title", ["Wuwa", "Wuthering Waves", "#WutheringWaves", "鳴潮", "鸣潮", "Ｗｕｗａ"])
def test_wuwa_aliases(post, title):
    post.text = f"{title} giveaway! To enter: follow and repost."
    assert matches_topic(post, "wuwa")


@pytest.mark.parametrize(
    "text",
    [
        "CS2 skin giveaway",
        "Genshin giveaway",
        "Congratulations! Drop your crypto wallet",
        "@Wuwa giveaway",
        "Giveaway https://example.com/wuwa",
        "NotWuwa giveaway",
    ],
)
def test_unrelated_and_incidental_matches_rejected(post, text):
    post.text = text
    assert not matches_topic(post, "wuwa")
    assert matches_topic(post, "all")


async def test_global_and_watch_queries_scoped_and_unrelated_response_filtered(store, settings, now, post):
    settings.giveaway_topic = "wuwa"
    store.watch("host", 1)
    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source = MagicMock()
        service.source.name = "x"
        service.source.fetch = AsyncMock(return_value=Page([post]))
        await service.tick(now)
        calls = service.source.fetch.call_args_list
        assert len(calls) == 2
        assert all(WUWA_QUERY in c.args[0] and "-is:reply" in c.args[0] for c in calls)
        assert store.status()["giveaways"] == 0
        assert store.status()["pending_extractions"] == 0
        global_query = next(q for q in store.queries() if q["key"] == "global")
        assert scoped_query(global_query["query"], "wuwa") == global_query["query"]


async def test_existing_unrelated_records_hidden_and_pending_delivery_dropped(store, settings, post, now):
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    settings.giveaway_topic = "wuwa"
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        bot.get_channel = MagicMock(side_effect=AssertionError("Must not deliver unrelated record"))
        assert store.list_giveaways(5, predicate=bot.visible) == []
        await bot.notify()
        assert store.status()["pending_notifications"] == 0
        post.id = "456"
        post.text = "Wuwa " + post.text
        store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
        assert [r["id"] for r in store.list_giveaways(5, predicate=bot.visible)] == ["456"]
        await bot.close()


async def test_topic_change_does_not_resume_broad_cursor(store, settings, now):
    import json

    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source.name = "x"
        query = store.queries()[0]
        cursor = service.cursor(query, now)
        cursor["token"] = "broad-page-2"
        query["cursor"] = json.dumps(cursor)
        settings.giveaway_topic = "wuwa"
        assert service.cursor(query, now)["token"] is None


@pytest.mark.parametrize(
    "text",
    [
        "Would anyone be interested if I did giveaway currency for Wuthering Waves?",
        "Chances of winning giveaway are low but never zero. Thanks to my favorite wuwa creator!",
        "How we thinking about a Lunite subscription giveaway wuwa players?",
        "Thanks for this Wuwa giveaway!",
    ],
)
async def test_giveaway_chatter_is_not_an_announcement(post, text):
    post.text = text
    assert (await RulesExtractor().extract(post)).is_giveaway.value is not True


async def test_reclassification_clears_stale_pending_card(store, post, now):
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    post.text = "How we thinking about a Wuwa giveaway?"
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    assert store.giveaway(post.id) is None
    assert store.pending_notifications(now) == []


@pytest.mark.parametrize(
    "tag", ["#WuwaTwt", "#WutheringWavesGiveaway", "#WutheringWavesFanart", "#WuWaGiveaways"]
)
def test_related_hashtags(post, tag):
    post.text = f"Giveaway! {tag}"
    assert matches_topic(post, "wuwa")


async def test_profile_topic_still_requires_post_announcement(post):
    post.author_name = "Wuwa Community"
    post.author_description = "Weekly giveaways for our players"
    post.text = "3x monthly passes! To enter: Follow me and repost."
    assert profile_qualified(post)
    assert matches_topic(post, "wuwa")
    assert (await RulesExtractor().extract(post)).is_giveaway.value is True
    post.text = "Good morning everyone"
    assert (await RulesExtractor().extract(post)).is_giveaway.value is None
    post.author_description = "Weekly streams"
    assert not profile_qualified(post)


async def test_profile_watches_bounded_and_revoked(store, settings, post):
    settings.giveaway_topic = "wuwa"
    settings.profile_watch_limit = 1
    post.author_description = "Wuwa giveaways"
    post.profile_fetched = True
    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.observe_profile(post)
        query = next(q for q in store.queries() if q["key"].startswith("profile:"))
        assert WUWA_QUERY not in service.query_text(query)
        another = post.model_copy(update={"author": "second"})
        service.observe_profile(another)
        assert len([q for q in store.queries() if q["key"].startswith("profile:")]) == 1
        post.author_description = "I play other games now"
        service.observe_profile(post)
        assert not any(q["key"].startswith("profile:") for q in store.queries())
        assert WUWA_QUERY in service.query_text(query)


async def test_reuploaded_campaign_short_links_deduplicated(store, post, now):
    post.text += " https://t.co/first"
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    second = post.model_copy(update={"id": "456", "text": post.text.replace("t.co/first", "t.co/second")})
    store.save_extraction(second, await RulesExtractor().extract(second), now, 60)
    assert len(store.list_giveaways()) == 1
    second.text = second.text.replace("keyboard", "headphones")
    store.save_extraction(second, await RulesExtractor().extract(second), now, 60)
    assert len(store.list_giveaways()) == 2


async def test_new_cards_paced_across_restart_and_sent_silently(store, settings, post, now, monkeypatch):
    from datetime import timedelta

    import discord

    import raffleye.discord_bot as module

    current = now
    monkeypatch.setattr(module, "utcnow", lambda: current)
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    second = post.model_copy(update={"id": "456", "text": post.text.replace("keyboard", "headphones")})
    store.save_extraction(second, await RulesExtractor().extract(second), now, 60)
    channel = MagicMock(spec=discord.TextChannel)
    channel.guild.id = settings.discord_guild_id
    channel.send = AsyncMock(return_value=MagicMock(id=1234))
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        bot.get_channel = MagicMock(return_value=channel)
        await bot.notify()
        assert channel.send.await_count == 1
        assert channel.send.call_args.kwargs["silent"] is True
        assert channel.send.call_args.kwargs["allowed_mentions"].to_dict()["parse"] == []
        await bot.close()
        bot = RaffleyeBot(Service(store, settings, client))
        bot.get_channel = MagicMock(return_value=channel)
        current = now + timedelta(seconds=299)
        await bot.notify()
        assert channel.send.await_count == 1
        current = now + timedelta(seconds=300)
        await bot.notify()
        assert channel.send.await_count == 2
        await bot.close()
