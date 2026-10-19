import httpx
import pytest

from raffleye.discord_bot import RaffleyeBot, giveaway_embed, timestamp
from raffleye.extraction import RulesExtractor
from raffleye.service import Service


async def test_embed_safe_mentions_and_limits(store, post, now):
    post.text += "\nSponsored by: @everyone " + "X" * 2000
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    embed = giveaway_embed(store.giveaway(post.id), detailed=True)
    assert len(embed) <= 6000
    assert all(len(field.value) <= 1024 for field in embed.fields)
    assert "@everyone" not in str(embed.to_dict())
    assert "UTC" in str(embed.to_dict())


def test_countdown_same_instant_across_timezones_and_unknown():
    utc = timestamp("2026-10-20T12:00:00Z")
    local = timestamp("2026-10-20T20:00:00+08:00")
    assert utc == local
    assert ":R>" in utc and ":F>" in utc
    assert "<t:" not in timestamp(None)


async def test_scheduled_countdowns_and_cancelled_suppression(store, post, now):
    post.text = (
        "Giveaway coming soon!\nPrize: keyboard\nStarts: 2026-10-20T12:00:00Z\n"
        "Deadline: 2026-10-22T12:00:00Z\nWinners announced: 2026-10-23T12:00:00Z"
    )
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    row = store.giveaway(post.id)
    fields = {field.name: field.value for field in giveaway_embed(row, detailed=True).fields}
    for name in ("Starts", "Entry deadline", "Scheduled announcement"):
        assert ":R>" in fields[name]
    row["status"] = "cancelled"
    assert all(":R>" not in field.value for field in giveaway_embed(row, detailed=True).fields)


async def test_commands_registration_and_admin_runtime_checks(store, settings):
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        group = bot.tree.get_command("raffleye")
        commands = {command.name: command for command in group.commands}
        assert set(commands) == {
            "help",
            "status",
            "list",
            "show",
            "watch",
            "unwatch",
            "watchlist",
            "subscribe",
            "unsubscribe",
            "retry",
        }
        for name in ("watch", "unwatch", "retry"):
            assert len(commands[name].checks) == 2
        for name in ("subscribe", "unsubscribe"):
            assert len(commands[name].checks) == 1  # Target-channel authorization runs inside the callback.
        await bot.close()


def channel_interaction(settings, *, manage_channel=True, manage_server=False, bot_can_send=True):
    from unittest.mock import AsyncMock, MagicMock

    import discord

    interaction = MagicMock(spec=discord.Interaction)
    interaction.guild_id = settings.discord_guild_id
    interaction.guild = MagicMock(spec=discord.Guild)
    interaction.guild.id = settings.discord_guild_id
    interaction.user = MagicMock(spec=discord.Member)
    interaction.user.guild_permissions = discord.Permissions(manage_guild=manage_server)
    interaction.permissions = discord.Permissions.none()  # Invocation channel does not grant target access.
    interaction.response.send_message = AsyncMock()
    channel = MagicMock(spec=discord.TextChannel)
    channel.id = 1234
    channel.guild = interaction.guild
    actor_permissions = discord.Permissions(view_channel=True, manage_channels=manage_channel)
    bot_permissions = discord.Permissions(view_channel=True, send_messages=bot_can_send, embed_links=True)
    channel.permissions_for.side_effect = lambda member: (
        bot_permissions if member is interaction.guild.me else actor_permissions
    )
    interaction.guild.get_channel.return_value = channel
    return interaction, channel


@pytest.mark.parametrize(
    "manage_channel,manage_server,allowed", [(True, False, True), (False, False, False), (False, True, True)]
)
async def test_subscribe_target_channel_permissions(store, settings, manage_channel, manage_server, allowed):
    interaction, channel = channel_interaction(
        settings, manage_channel=manage_channel, manage_server=manage_server
    )
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        await bot.tree.get_command("raffleye").get_command("subscribe").callback(interaction, channel)
        assert store.subscription(settings.discord_guild_id) == (channel.id if allowed else None)
        if allowed:
            assert "SAMPLE giveaways" in interaction.response.send_message.call_args.args[0]
        await bot.close()


async def test_channel_manager_cannot_redirect_other_subscription(store, settings):
    interaction, channel = channel_interaction(settings)
    store.subscribe(settings.discord_guild_id, 9999)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        await bot.tree.get_command("raffleye").get_command("subscribe").callback(interaction, channel)
        assert store.subscription(settings.discord_guild_id) == 9999
        await bot.close()


async def test_subscription_requires_bot_permissions(store, settings):
    interaction, channel = channel_interaction(settings, bot_can_send=False)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        await bot.tree.get_command("raffleye").get_command("subscribe").callback(interaction, channel)
        assert store.subscription(settings.discord_guild_id) is None
        await bot.close()


@pytest.mark.parametrize("manage_channel", [True, False])
async def test_unsubscribe_uses_subscribed_channel_permissions(store, settings, manage_channel):
    interaction, channel = channel_interaction(settings, manage_channel=manage_channel)
    store.subscribe(settings.discord_guild_id, channel.id)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        await bot.tree.get_command("raffleye").get_command("unsubscribe").callback(interaction)
        assert store.subscription(settings.discord_guild_id) == (None if manage_channel else channel.id)
        await bot.close()


def test_live_config_fails_closed():
    from pydantic import ValidationError

    from raffleye.config import Settings

    with pytest.raises(ValidationError):
        Settings(_env_file=None, source="x")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, source="apify", apify_token="token", apify_dataset_id="dataset")


async def test_admin_check_denies_member(store, settings):
    from unittest.mock import MagicMock

    import discord
    from discord import app_commands

    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        command = bot.tree.get_command("raffleye").get_command("watch")
        interaction = MagicMock()
        interaction.guild_id = settings.discord_guild_id
        interaction.permissions = discord.Permissions.none()
        with pytest.raises(app_commands.MissingPermissions):
            for check in command.checks:
                result = check(interaction)
                if hasattr(result, "__await__"):
                    await result
        await bot.close()


async def test_discord_send_then_edit_existing_message(store, settings, post, now):
    from datetime import timedelta
    from unittest.mock import AsyncMock, MagicMock

    import discord

    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        channel = MagicMock(spec=discord.TextChannel)
        channel.guild.id = settings.discord_guild_id
        message = MagicMock()
        message.id = 12345
        message.edit = AsyncMock()
        channel.send = AsyncMock(return_value=message)
        channel.get_partial_message.return_value = message
        bot.get_channel = MagicMock(return_value=channel)
        await bot.notify()
        assert channel.send.await_count == 1
        assert store.status()["pending_notifications"] == 0
        store.refresh_statuses(now + timedelta(days=1), 60)
        await bot.notify()
        assert message.edit.await_count == 1
        assert channel.send.await_count == 1
        await bot.close()


async def test_discord_failure_retained_for_retry(store, settings, post, now):
    from unittest.mock import AsyncMock, MagicMock

    import discord

    store.subscribe(1, 2)
    store.save_extraction(post, await RulesExtractor().extract(post), now, 60)
    async with httpx.AsyncClient() as client:
        bot = RaffleyeBot(Service(store, settings, client))
        channel = MagicMock(spec=discord.TextChannel)
        channel.guild.id = settings.discord_guild_id
        response = MagicMock(status=403, reason="Forbidden")
        channel.send = AsyncMock(side_effect=discord.Forbidden(response, "denied"))
        bot.get_channel = MagicMock(return_value=channel)
        await bot.notify()
        assert store.status()["pending_notifications"] == 1
        assert store.db.execute("SELECT attempts FROM outbox").fetchone()[0] == 1
        await bot.close()
