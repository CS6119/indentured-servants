from datetime import timedelta

import pytest

from raffleye.extraction import RulesExtractor
from raffleye.models import iso
from raffleye.storage import BudgetExceeded, Store


def stage(store, post, now):
    store.add_query("global", "giveaway", 2, 900)
    query = store.queries()[0]
    store.stage_page(query, [post], None, now)


async def test_dedup_updates_and_durable_outbox(store, post, now):
    store.subscribe(1, 2)
    stage(store, post, now)
    extraction = await RulesExtractor().extract(post)
    store.save_extraction(post, extraction, now, 60)
    store.save_extraction(post, extraction, now, 60)
    assert len(store.list_giveaways()) == 1
    assert len(store.pending_notifications(now)) == 1
    item = store.pending_notifications(now)[0]
    store.delivered(item, 999)
    assert not store.pending_notifications(now)
    store.refresh_statuses(now + timedelta(days=1), 60)
    pending = store.pending_notifications(now + timedelta(days=1))[0]
    assert pending["message_id"] == "999"
    assert store.giveaway(post.id)["status"] == "ended"
    assert pending["revision"] == 2


async def test_exact_content_dedup_cross_ids(store, post, now):
    stage(store, post, now)
    result = await RulesExtractor().extract(post)
    store.save_extraction(post, result, now, 60)
    duplicate = post.model_copy(update={"id": "456", "source": "apify"})
    stage(store, duplicate, now)
    store.save_extraction(duplicate, result, now, 60)
    assert len(store.list_giveaways()) == 1


async def test_changed_post_requeues_extraction(store, post, now):
    stage(store, post, now)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    assert not store.pending(10, now)
    post.text = post.text.replace("2 winners", "3 winners")
    stage(store, post, now)
    assert len(store.pending(10, now)) == 1
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    assert store.giveaway(post.id)["revision"] == 2


def test_budget_atomic_persistent_and_utc_rollover(tmp_path, now):
    db = tmp_path / "budget.sqlite3"
    store = Store(db)
    store.reserve({"x_requests": 1, "estimated_usd": 0.5}, {"x_requests": 1, "estimated_usd": 1}, 2, now)
    with pytest.raises(BudgetExceeded):
        store.reserve({"x_requests": 1, "estimated_usd": 0.5}, {"x_requests": 1, "estimated_usd": 1}, 2, now)
    assert (
        store.db.execute(
            "SELECT used FROM budgets WHERE metric='estimated_usd' AND period LIKE 'day:%'"
        ).fetchone()[0]
        == 0.5
    )
    store.close()
    store = Store(db)
    with pytest.raises(BudgetExceeded):
        store.reserve({"x_requests": 1}, {"x_requests": 1}, 2, now)
    store.reserve({"x_requests": 1}, {"x_requests": 1}, 2, now + timedelta(days=1))
    with pytest.raises(BudgetExceeded):
        store.reserve({"estimated_usd": 2}, {"estimated_usd": 10}, 2, now + timedelta(days=1))
    store.close()


def test_cursor_and_raw_page_survive_restart(tmp_path, post, now):
    path = tmp_path / "restart.sqlite3"
    store = Store(path)
    store.add_query("global", "giveaway", 2, 60)
    cursor = {"token": "page-two", "start": iso(now), "source": "x"}
    store.stage_page(store.queries()[0], [post], cursor, now)
    store.close()
    store = Store(path)
    assert "page-two" in store.queries()[0]["cursor"]
    assert len(store.pending(10, now)) == 1
    store.close()


def test_query_fairness_and_priorities(store, now):
    store.add_query("global", "giveaway", 2, 900)
    store.watch("high", 1)
    store.watch("low", 3)
    due = store.due_queries(2, now)
    assert [r["key"] for r in due] == ["global", "watch:high"]
    for row in due:
        store.stage_page(row, [], None, now)
    assert store.due_queries(2, now)[0]["key"] == "watch:low"


def test_watch_query_injection_rejected(store):
    with pytest.raises(ValueError):
        store.watch("name OR from:anyone", 1)


async def test_notification_failure_retry_and_unsubscribe(store, post, now):
    stage(store, post, now)
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    item = store.pending_notifications(now)[0]
    store.delivery_failed(item, "Forbidden", now)
    assert not store.pending_notifications(now)
    assert store.pending_notifications(now + timedelta(seconds=31))[0]["attempts"] == 1
    store.unsubscribe(1)
    assert not store.pending_notifications(now + timedelta(days=1))


async def test_delivery_ack_does_not_delete_new_revision(store, post, now):
    stage(store, post, now)
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    old = store.pending_notifications(now)[0]
    store.refresh_statuses(now + timedelta(days=1), 60)
    store.delivered(old, 12345)
    assert store.pending_notifications(now + timedelta(days=1))[0]["revision"] == 2
