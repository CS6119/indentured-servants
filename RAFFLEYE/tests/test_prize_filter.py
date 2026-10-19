from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from raffleye.discord_bot import RaffleyeBot
from raffleye.extraction import RulesExtractor
from raffleye.models import claim, unknown
from raffleye.service import Service


@pytest.mark.parametrize(
    "text",
    [
        "Wuwa giveaway if true and premium. Stay tuned.",
        "Wuwa giveaway! To enter: Follow me. 10 winners!",
        "Wuwa giveaway! Prize: TBD\nTo enter: Follow me",
        "Wuwa giveaway! Prize: surprise prize\nTo enter: Follow me",
        "Wuwa giveaway! Prize: 10 winners\nTo enter: Follow me",
        "Wuwa giveaway! To enter: Spend $10 and follow me",
        "Wuwa giveaway! To enter: Follow me\nI bought 3 monthly passes",
    ],
)
async def test_no_concrete_prize_never_queued(store, post, now, text):
    store.subscribe(1, 2)
    post.text = text
    result = await RulesExtractor().extract(post)
    assert result.prizes.value is None
    store.save_extraction(post, result, now, 60)
    assert store.giveaway(post.id) is None
    assert store.pending_notifications(now) == []


@pytest.mark.parametrize(
    "reward,expected",
    [
        ("5x monthly pass giveaway", ["5x monthly pass"]),
        ("3,280 LUNITE (WuWa) X 10 WINNERS", ["3,280 LUNITE"]),
        (
            "3x Lunite Subscription\n1x 980 Lunite Pack\n2x 3280 Lunite Pack",
            [
                "3x Lunite Subscription",
                "1x 980 Lunite Pack",
                "2x 3280 Lunite Pack",
            ],
        ),
        ("$50 gift card", ["$50 gift card"]),
        ("Prize: keyboard", ["keyboard"]),
    ],
)
async def test_named_rewards_admitted_with_source_evidence(store, post, now, reward, expected):
    store.subscribe(1, 2)
    post.text = "Wuwa giveaway!\n" + reward + "\nTo enter: Follow me and repost"
    result = await RulesExtractor().extract(post)
    assert result.prizes.value == expected
    assert result.prizes.evidence in post.text
    store.save_extraction(post, result, now, 60)
    assert len(store.pending_notifications(now)) == 1


async def test_positive_classifier_alone_cannot_bypass_storage_gate(store, post, now):
    store.subscribe(1, 2)
    result = await RulesExtractor().extract(post)
    store.save_extraction(post, result, now, 60)
    result.prizes = type(result.prizes)(**unknown())
    result.is_giveaway = type(result.is_giveaway)(**claim(True, "Giveaway"))
    store.save_extraction(post, result, now, 60)
    assert store.giveaway(post.id) is None
    assert store.pending_notifications(now) == []


async def test_legacy_prizeless_rows_hidden_and_not_delivered(store, settings, post, now):
    store.subscribe(1, 2)
    result = await RulesExtractor().extract(post)
    store.save_extraction(post, result, now, 60)
    result.prizes = type(result.prizes)(**unknown())
    with store.db:
        store.db.execute("UPDATE giveaways SET extraction=?", (result.model_dump_json(),))
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        bot.get_channel = MagicMock(side_effect=AssertionError("Must not send a prizeless card"))
        bot.screenshots.get = AsyncMock(side_effect=AssertionError("Must not render filtered card"))
        assert store.list_giveaways(5, predicate=bot.visible) == []
        await bot.notify()
        assert store.pending_notifications(now) == []
        await bot.close()
