from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import discord
import httpx

from raffleye.discord_bot import RaffleyeBot, giveaway_embed, post_link_view
from raffleye.extraction import RulesExtractor
from raffleye.screenshots import PostScreenshots
from raffleye.service import Service


async def test_disabled_and_mock_screenshots_never_launch_browser(settings, post):
    renderer = PostScreenshots(settings)
    renderer.capture = AsyncMock(side_effect=AssertionError("Must stay offline"))
    assert await renderer.get(post) is None
    settings.post_screenshots = True
    assert await renderer.get(post) is None
    renderer.capture.assert_not_awaited()


async def test_screenshot_cache_reused_across_renderer_restart(settings, post):
    settings.post_screenshots = True
    post.source = "x"
    renderer = PostScreenshots(settings)

    async def capture(_, path):
        path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")

    renderer.capture = AsyncMock(side_effect=capture)
    path = await renderer.get(post)
    assert path and path.exists()
    restarted = PostScreenshots(settings)
    restarted.capture = AsyncMock(side_effect=AssertionError("Must reuse screenshot"))
    assert await restarted.get(post) == path
    assert renderer.capture.await_count == 1
    restarted.capture.assert_not_awaited()


async def test_failed_embed_never_attached_and_retry_cooled_down(settings, post):
    settings.post_screenshots = True
    post.source = "x"
    renderer = PostScreenshots(settings)
    renderer.capture = AsyncMock(side_effect=ValueError("Expected post not rendered"))
    assert await renderer.get(post) is None
    assert await renderer.get(post) is None
    assert renderer.capture.await_count == 1
    assert not renderer.cache_path(post).exists()


async def test_prominent_link_and_button_target_original_post(store, post, now):
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    embed = giveaway_embed(store.giveaway(post.id))
    assert embed.title == "Sample · keyboard"
    assert not embed.url
    assert post.url not in (embed.description or "")
    button = post_link_view(post).children[0]
    assert button.url == post.url
    assert button.style == discord.ButtonStyle.link
    assert button.label == "OPEN GIVEAWAY ↗"


async def test_send_and_edit_attach_screenshot_and_link_without_new_spam(
    store, settings, post, now, tmp_path
):
    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    path = tmp_path / "post.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        bot.screenshots.get = AsyncMock(return_value=path)
        channel = MagicMock(spec=discord.TextChannel)
        channel.guild.id = settings.discord_guild_id
        message = MagicMock(id=12345)
        message.edit = AsyncMock()
        channel.send = AsyncMock(return_value=message)
        channel.get_partial_message.return_value = message
        bot.get_channel = MagicMock(return_value=channel)
        await bot.notify()
        sent = channel.send.call_args.kwargs
        assert sent["embed"].image.url == f"attachment://post-{post.id}.png"
        assert sent["file"].filename == f"post-{post.id}.png"
        assert sent["view"].children[0].url == post.url
        assert sent["silent"] is True
        sent["file"].close()
        store.refresh_statuses(now + timedelta(days=2), 60)
        await bot.notify()
        edited = message.edit.call_args.kwargs
        assert edited["attachments"][0].filename == f"post-{post.id}.png"
        edited["attachments"][0].close()
        assert channel.send.await_count == 1
        await bot.close()
