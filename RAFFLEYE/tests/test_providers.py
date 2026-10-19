import json
from datetime import timedelta

import httpx
import pytest

from raffleye.extraction import OpenAIExtractor, RulesExtractor
from raffleye.models import iso
from raffleye.providers import HTTP, ApifySource, Budget, ProviderError, XSource
from raffleye.service import Service
from raffleye.storage import BudgetExceeded


def http(store, settings, handler):
    return HTTP(httpx.AsyncClient(transport=httpx.MockTransport(handler)), Budget(store, settings))


async def test_x_mapping_pagination_and_request_budget(store, settings, now):
    def handler(request):
        assert request.url.params["next_token"] == "next"
        assert request.url.params["max_results"] == "25"
        assert "access_token" not in request.url.params
        assert "Authorization" in request.headers
        assert "description" in request.url.params["user.fields"]
        return httpx.Response(
            200,
            json={
                "data": [{"id": "123", "text": "Giveaway", "author_id": "1", "created_at": iso(now)}],
                "includes": {
                    "users": [
                        {
                            "id": "1",
                            "username": "host",
                            "name": "Wuwa host",
                            "description": "Weekly giveaways",
                        }
                    ]
                },
                "meta": {"next_token": "next2"},
            },
        )

    transport = http(store, settings, handler)
    page = await XSource(transport, settings).fetch(
        "giveaway", {"start": iso(now), "end": iso(now), "token": "next"}
    )
    assert page.next_token == "next2"
    assert page.posts[0].url == "https://x.com/host/status/123"
    assert page.posts[0].author_description == "Weekly giveaways"
    assert page.posts[0].profile_fetched is True
    assert store.usage()["x_posts"] == 25
    await transport.client.aclose()


async def test_rate_limit_cooldown_survives_without_second_call(store, settings, now):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429, headers={"retry-after": "1800"})

    transport = http(store, settings, handler)
    for _ in range(2):
        with pytest.raises(ProviderError) as error:
            await transport.request("x", "GET", "https://api.x.com/test")
        assert not error.value.fallback
    assert len(calls) == 1
    assert store.get_meta("cooldown:x")
    await transport.client.aclose()


async def test_budget_denies_network(store, settings):
    settings.daily_x_requests = 0
    transport = http(store, settings, lambda _: pytest.fail("Must not call network"))
    with pytest.raises(BudgetExceeded):
        await transport.request("x", "GET", "https://api.x.com/test")
    await transport.client.aclose()


async def test_apify_dataset_mapping_and_watch_filter(store, settings, now):
    def handler(request):
        assert "/datasets/" in request.url.path
        assert request.method == "GET"
        return httpx.Response(
            200,
            json=[
                {"id": "123", "text": "Giveaway", "createdAt": iso(now), "author": {"userName": "host"}},
                {"id": "124", "text": "Giveaway", "created_at": iso(now), "author": "other"},
            ],
        )

    transport = http(store, settings, handler)
    page = await ApifySource(transport, settings).fetch("from:host -is:retweet", {})
    assert [post.id for post in page.posts] == ["123"]
    assert page.next_token is None
    await transport.client.aclose()


async def test_structured_ai_request_and_response(store, settings, post):
    expected = await RulesExtractor().extract(post)

    def handler(request):
        body = json.loads(request.content)
        assert body["store"] is False
        assert body["text"]["format"]["strict"] is True
        assert body["text"]["format"]["schema"]["additionalProperties"] is False
        assert not body.get("tools")
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": expected.model_dump_json()}],
                    }
                ],
            },
        )

    transport = http(store, settings, handler)
    result = await OpenAIExtractor(transport, settings).extract(post)
    assert result.winner_count.value == 2
    await transport.client.aclose()


@pytest.mark.parametrize(
    "body",
    [
        {"status": "incomplete"},
        {
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "No"}]}],
        },
        {
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}],
        },
    ],
)
async def test_ai_failure_not_silently_accepted(store, settings, post, body):
    transport = http(store, settings, lambda _: httpx.Response(200, json=body))
    with pytest.raises(ProviderError):
        await OpenAIExtractor(transport, settings).extract(post)
    await transport.client.aclose()


async def test_end_to_end_mock_no_network_and_restart_idempotency(store, settings, now):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: pytest.fail("Offline mode made a request"))
    ) as client:
        service = Service(store, settings, client)
        await service.tick(now)
        assert store.status()["giveaways"] == 4
        assert store.status()["pending_extractions"] == 0
        await Service(store, settings, client).tick(now + timedelta(minutes=20))
        assert store.status()["giveaways"] == 4
        assert all(row["revision"] == 1 for row in store.list_giveaways())


async def test_transient_x_failure_uses_fallback_preserves_cursor(store, settings, now):
    from raffleye.providers import Page

    class Broken:
        name = "x"

        async def fetch(self, query, cursor):
            raise ProviderError("x:http_503", fallback=True)

    class Fallback:
        async def fetch(self, query, cursor):
            return Page([], "25")

    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.source, service.fallback = Broken(), Fallback()
        await service.tick(now)
        query = store.queries()[0]
        assert json.loads(query["cursor"])["source"] == "x"
        assert query["error"] == "x:http_503"
        assert store.get_meta("fallback:global") == "25"


async def test_failed_extraction_raw_post_retained(store, settings, now):
    class Broken:
        async def extract(self, post):
            raise ProviderError("ai:unavailable")

    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.extractor = Broken()
        await service.tick(now)
        assert store.status()["pending_extractions"] == 5
        service.extractor = RulesExtractor()
        await service.tick(now + timedelta(minutes=6))
        assert store.status()["pending_extractions"] == 0


@pytest.mark.parametrize(
    "body",
    [{}, [], {"errors": [{"title": "Partial failure"}], "meta": {}}, {"data": [{"id": "123"}], "meta": {}}],
)
async def test_invalid_x_page_rejected_without_cursor_advance(store, settings, now, body):
    transport = http(store, settings, lambda _: httpx.Response(200, json=body))
    with pytest.raises(ProviderError):
        await XSource(transport, settings).fetch("giveaway", {"start": iso(now), "end": iso(now)})
    await transport.client.aclose()


async def test_ai_cooldown_does_not_quarantine_unattempted_posts(store, settings, now):
    class CoolingDown:
        async def extract(self, post):
            raise ProviderError("ai:cooldown")

    async with httpx.AsyncClient() as client:
        service = Service(store, settings, client)
        service.extractor = CoolingDown()
        for i in range(6):
            await service.tick(now + timedelta(minutes=i))
        assert store.status()["quarantined_extractions"] == 0
        assert store.status()["pending_extractions"] == 5
        assert store.status()["extraction_warning"] == "ai:cooldown"
