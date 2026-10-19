import pytest

from raffleye.discord_bot import giveaway_embed
from raffleye.extraction import RulesExtractor
from raffleye.models import claim
from raffleye.panels import detail_embed
from raffleye.timeparse import explicit_times


@pytest.mark.parametrize(
    "source,expected",
    [
        ("10/19/2026 20:30 UTC+8", "2026-10-19T12:30:00+00:00"),
        ("19/10/2026 20:30 GMT+08:00", "2026-10-19T12:30:00+00:00"),
        ("19.10.2026 at 8:30 PM (UTC +8)", "2026-10-19T12:30:00+00:00"),
        ("10-19-2026 8:30 PM -0400", "2026-10-20T00:30:00+00:00"),
        ("2026/10/19 8:30 PM UTC", "2026-10-19T20:30:00+00:00"),
        ("2026.10.19 20:30 Z", "2026-10-19T20:30:00+00:00"),
        ("19th October 2026 at 12 AM UTC", "2026-10-19T00:00:00+00:00"),
        ("October 19, 2026 at 12 PM GMT-3:30", "2026-10-19T15:30:00+00:00"),
        ("12/12/2026 12:00 UTC", "2026-12-12T12:00:00+00:00"),
        ("29/02/2028 12:00 UTC", "2028-02-29T12:00:00+00:00"),
    ],
)
async def test_numeric_orders_and_offsets_are_normalized_and_grounded(post, source, expected):
    post.text = "Giveaway!\nPrize: keyboard\nEnds on " + source
    result = await RulesExtractor().extract(post)
    assert result.deadline_at.value == expected
    assert result.grounded(post).deadline_at.value == expected


@pytest.mark.parametrize(
    "source",
    [
        "04/05/2026 8 PM UTC",
        "04.05.2026 20:00 UTC",
        "04-05-2026 20:00 UTC",
        "31/02/2026 20:00 UTC",
        "29/02/2026 20:00 UTC",
        "13/14/2026 20:00 UTC",
        "19/10/2026 25:00 UTC",
        "19/10/2026 13 PM UTC",
        "19/10/2026 20:00 UTC+25",
        "19/10/2026 20:00 CST",
        "19/10/2026 20:00",
        "19/10 20:00 UTC",
        "19.10.",
    ],
)
def test_ambiguous_incomplete_and_invalid_dates_not_invented(source):
    assert explicit_times(source) == []


@pytest.mark.parametrize(
    "hint,expected",
    [
        ("DD/MM/YYYY", "2026-05-04T20:00:00+00:00"),
        ("MM/DD/YYYY", "2026-04-05T20:00:00+00:00"),
    ],
)
async def test_explicit_post_format_disambiguates_without_machine_locale(post, hint, expected):
    post.text = f"Giveaway!\nDates use {hint}\nDeadline: 04/05/2026 8 PM UTC"
    result = await RulesExtractor().extract(post)
    assert result.deadline_at.value == expected
    assert result.grounded(post).deadline_at.value == expected


async def test_ai_cannot_guess_ambiguous_numeric_order(post):
    post.text = "Giveaway!\nDeadline: 04/05/2026 8 PM UTC"
    result = await RulesExtractor().extract(post)
    result.deadline_at = type(result.deadline_at)(**claim("2026-04-05T20:00:00Z", post.text))
    assert result.grounded(post).deadline_at.value is None


async def test_separate_dates_on_one_line_keep_their_roles(post):
    post.text = "Giveaway! Starts: 10/19/2026 20:00 UTC Ends: 20/10/2026 20:00 UTC"
    result = await RulesExtractor().extract(post)
    assert result.starts_at.value == "2026-10-19T20:00:00+00:00"
    assert result.deadline_at.value == "2026-10-20T20:00:00+00:00"


async def test_public_and_private_dates_keep_utc_local_and_countdown(store, post, now):
    post.text = "Giveaway!\nPrize: keyboard\nEnds: 19/10/2026 20:00 UTC+8"
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    row = store.giveaway(post.id)
    public = giveaway_embed(row).description
    private = str(detail_embed(row, "dates").to_dict())
    for rendered in [public, private]:
        assert "2026-10-19 12:00 UTC" in rendered
        assert "<t:" in rendered and ":R>" in rendered
    assert "Local" in public
    row["status"] = "cancelled"
    assert "UTC" in giveaway_embed(row).description
    assert ":R>" not in giveaway_embed(row).description


@pytest.mark.parametrize(
    "raw,reason",
    [
        ("19.10.", "year/time/timezone missing"),
        ("04/05/2026 8 PM UTC", "MM/DD or DD/MM unclear"),
        ("19/10/2026 20:00", "timezone missing"),
    ],
)
async def test_unresolved_original_date_shown_instead_of_discarded(store, post, now, raw, reason):
    post.text = "Giveaway!\nPrize: keyboard\nEnds: " + raw
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    row = store.giveaway(post.id)
    for rendered in [giveaway_embed(row).description, str(detail_embed(row, "dates").to_dict())]:
        assert raw in rendered and reason in rendered and "UTC unavailable" in rendered
        assert "<t:" not in rendered
