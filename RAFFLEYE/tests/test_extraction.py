from datetime import timedelta

import pytest

from raffleye.extraction import RulesExtractor
from raffleye.models import Extraction, claim


async def test_prizes_counts_requirements_and_timezone(post, now):
    post.text += "\nStarts: 2026-10-15T08:00:00+08:00\nWinners announced: 2026-10-18T10:00:00Z"
    result = await RulesExtractor().extract(post)
    assert result.prizes.value == ["keyboard"]
    assert result.winner_count.value == 2
    assert result.requirements.value == ["Follow and tag 2 friends."]
    assert result.starts_at.value == "2026-10-15T00:00:00+00:00"
    assert result.announcement_at.value == "2026-10-18T10:00:00+00:00"
    assert result.status(now) == "open"
    assert result.status(now + timedelta(hours=11, minutes=30)) == "ending_soon"
    assert result.status(now + timedelta(hours=12)) == "ended"


async def test_unknown_dates_are_not_invented(post):
    post.text = "Giveaway coming soon! Deadline: Friday 8pm. Winners announced tomorrow."
    result = await RulesExtractor().extract(post)
    assert result.deadline_at.value is None
    assert result.starts_at.value is None
    assert result.announcement_at.value is None
    assert result.status(post.created_at) == "upcoming"


async def test_chinese_and_sponsor_links(post):
    post.text = "抽獎\n獎品：遊戲序號\n3名得獎者\n參加方式：追蹤並留言，限台灣。\n贊助：Demo\n贊助網站：https://sponsor.example"
    result = await RulesExtractor().extract(post)
    assert result.winner_count.value == 3
    assert result.sponsor.value == "Demo"
    assert result.sponsor_websites.value == ["https://sponsor.example"]
    assert result.requirements.value == ["追蹤並留言，限台灣。"]


async def test_multiline_rules_keep_optional_and_eligibility(post):
    post.text = (
        "Wuthering Waves giveaway!\nRules:\n★ follow me\n★ like and RT this post\n\n"
        "★ (optional) question: What character do you want to build?\n"
        "★ Open to Taiwan residents, age 18+ only.\n\nGiveaway ends: 19.10.\n#WutheringWaves"
    )
    result = await RulesExtractor().extract(post)
    assert result.requirements.value == [
        "follow me",
        "like and RT this post",
        "(optional) question: What character do you want to build?",
        "Open to Taiwan residents, age 18+ only.",
    ]
    assert result.requirements.evidence in post.text
    assert result.deadline_at.value is None


async def test_unlabelled_entry_actions_and_sponsor_punctuation(post):
    post.text = (
        "Wuthering Waves giveaway v3.7\n- RT and Like\n"
        "- Follow me @Scyrptor and @Slugy_Cs\n"
        "- Comment which character you find most attractive\n\n"
        "–> 3x Lunite Subscription\n(sponsored by @Slugy_Cs )"
    )
    result = await RulesExtractor().extract(post)
    assert result.requirements.value == [
        "RT and Like",
        "Follow me @Scyrptor and @Slugy_Cs",
        "Comment which character you find most attractive",
    ]
    assert result.sponsor.value == "@Slugy_Cs"
    assert result.sponsor.evidence in post.text


async def test_entry_heading_with_multiple_lines_stops_at_metadata(post):
    post.text = (
        "Giveaway! To enter now\nTo enter:\nFollow me\nLike this post\n"
        "Deadline: 2026-10-20T00:00:00Z\nPrize: keyboard\nSponsor: Example (Games)"
    )
    result = await RulesExtractor().extract(post)
    assert result.requirements.value == ["Follow me", "Like this post"]
    assert result.sponsor.value == "Example (Games)"


async def test_fabricated_evidence_removed(post):
    result = await RulesExtractor().extract(post)
    data = result.model_dump()
    data["sponsor"] = claim("Invented", "not actually present")
    data["sponsor_websites"] = claim(["https://evil.example"], "Giveaway")
    checked = Extraction.model_validate(data).grounded(post)
    assert checked.sponsor.value is None
    assert checked.sponsor_websites.value is None


async def test_deadline_not_announcement(post):
    post.text = "Giveaway coming soon. Winners announced: 2026-12-01T12:00:00Z"
    result = await RulesExtractor().extract(post)
    assert result.announcement_at.value
    assert result.deadline_at.value is None


async def test_contradictory_times_are_unknown(post):
    post.text += "\nStarts: 2027-01-01T00:00:00Z"
    result = await RulesExtractor().extract(post)
    assert result.starts_at.value is None
    assert result.deadline_at.value is None


@pytest.mark.parametrize("text,state", [("Giveaway cancelled", "cancelled"), ("Giveaway ended", "ended")])
async def test_terminal_status(post, text, state):
    post.text = text
    result = await RulesExtractor().extract(post)
    assert result.status(post.created_at) == state


async def test_non_giveaway(post):
    post.text = "My new keyboard is great"
    assert (await RulesExtractor().extract(post)).is_giveaway.value is None


@pytest.mark.parametrize(
    "date,expected",
    [
        ("October 16, 2026 at 8 PM UTC", "2026-10-16T20:00:00+00:00"),
        ("Oct 16 2026 20:30 GMT+8", "2026-10-16T12:30:00+00:00"),
        ("2026-10-16 20:30 UTC+08:00", "2026-10-16T12:30:00+00:00"),
        ("2026-10-16T12:30:00Z", "2026-10-16T12:30:00+00:00"),
        ("October 16 at 8 PM UTC", None),
        ("2026-10-16 20:30", None),
        ("2026-02-30T12:00:00Z", None),
    ],
)
async def test_explicit_dates_only(post, date, expected):
    post.text = "Giveaway!\nDeadline: " + date
    assert (await RulesExtractor().extract(post)).deadline_at.value == expected


async def test_ai_cannot_substitute_different_instant(post):
    result = await RulesExtractor().extract(post)
    result.deadline_at.value = "2030-01-01T00:00:00Z"
    assert result.grounded(post).deadline_at.value is None
