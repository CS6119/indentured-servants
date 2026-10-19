from unittest.mock import AsyncMock, MagicMock

import discord
import httpx
import pytest

from raffleye.discord_bot import RaffleyeBot, post_link_view
from raffleye.extraction import RulesExtractor
from raffleye.panels import (
    DETAIL_SECTIONS,
    HELP_SECTIONS,
    DetailsButton,
    DetailsPanel,
    HelpButton,
    HelpPanel,
    detail_embed,
    help_embed,
)
from raffleye.service import Service


def interaction(bot, guild_id=None):
    result = MagicMock(spec=discord.Interaction)
    result.client = bot
    result.guild_id = bot.service.settings.discord_guild_id if guild_id is None else guild_id
    result.response.send_message = AsyncMock()
    result.response.edit_message = AsyncMock()
    return result


async def test_public_card_controls_and_restarted_details_callback(store, settings, post, now):
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    async with httpx.AsyncClient() as client:
        old = RaffleyeBot(Service(store, settings, client))
        view = post_link_view(post)
        assert view.is_persistent()
        assert [getattr(item, "item", item).label for item in view.children] == [
            "OPEN GIVEAWAY ↗",
            "Details",
            "Help",
        ]
        custom_id = view.children[1].custom_id
        await old.close()
        bot = RaffleyeBot(Service(store, settings, client))
        post.text = post.text.replace("2 winners", "3 winners")
        store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
        event = interaction(bot)
        restored = await DetailsButton.from_custom_id(
            event, None, DetailsButton(post.id).template.fullmatch(custom_id)
        )
        await restored.callback(event)
        sent = event.response.send_message.call_args.kwargs
        assert sent["ephemeral"] is True
        assert next(f.value for f in sent["embed"].fields if f.name == "Winners") == "3"
        assert isinstance(sent["view"], DetailsPanel)
        await bot.close()


@pytest.mark.parametrize("section", DETAIL_SECTIONS)
async def test_detail_sections_edit_private_panel_only(store, settings, post, now, section):
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        panel = DetailsPanel(bot, store.giveaway(post.id))
        event = interaction(bot)
        assert await panel.interaction_check(event)
        select = panel.children[0]
        select._values = [section]
        await select.callback(event)
        sent = event.response.edit_message.call_args.kwargs
        assert sent["embed"].title == DETAIL_SECTIONS[section][0]
        assert len(sent["embed"]) <= 6000
        event.response.send_message.assert_not_awaited()
        await bot.close()


async def test_panels_reject_wrong_server_and_hidden_post(store, settings, post, now):
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        wrong = interaction(bot, settings.discord_guild_id + 1)
        await bot.send_details(wrong, post.id)
        assert "embed" not in wrong.response.send_message.call_args.kwargs
        assert wrong.response.send_message.call_args.kwargs["ephemeral"] is True
        settings.giveaway_topic = "wuwa"
        hidden = interaction(bot)
        await bot.send_details(hidden, post.id)
        assert "no longer available" in hidden.response.send_message.call_args.args[0]
        await bot.close()


@pytest.mark.parametrize("section", HELP_SECTIONS)
async def test_help_topics_private_and_within_discord_limits(store, settings, section):
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        event = interaction(bot)
        await bot.send_help(event, section)
        sent = event.response.send_message.call_args.kwargs
        assert sent["ephemeral"] is True
        assert isinstance(sent["view"], HelpPanel)
        assert len(sent["embed"]) < 6000
        assert all(len(field.value) <= 1024 for field in sent["embed"].fields)
        await bot.close()


async def test_help_permissions_commands_and_persistent_callback(store, settings):
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        store.set_meta("discord_command_id", "12345")
        setup = str(help_embed(bot, "setup").to_dict())
        assert "Manage Channels" in setup and "Manage Server" in setup
        assert "</raffleye subscribe:12345>" in setup
        accounts = str(help_embed(bot, "accounts").to_dict())
        assert "Manage Server required" in accounts
        assert "raffleye retry" in accounts
        button = HelpButton()
        event = interaction(bot)
        restored = await HelpButton.from_custom_id(event, None, button.template.fullmatch(button.custom_id))
        await restored.callback(event)
        assert event.response.send_message.call_args.kwargs["ephemeral"] is True
        await bot.close()


async def test_details_make_missing_data_explicit_without_inventing_it(store, post, now):
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    embed = detail_embed(store.giveaway(post.id), "sponsors")
    assert all(f.value == "Not clearly stated in the post." for f in embed.fields)
