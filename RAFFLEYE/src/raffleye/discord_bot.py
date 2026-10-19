import asyncio
import contextlib
import logging
import re

import discord
from discord import app_commands

from .discovery import matches_topic
from .models import Extraction, Post, aware, iso, utcnow
from .panels import DetailsButton, DetailsPanel, HelpButton, HelpPanel, detail_embed, help_embed
from .screenshots import PostScreenshots
from .service import Service
from .timeparse import labelled_times, unresolved_time_reason


def clean(value, size=700):
    if value is None:
        return "Unknown"
    if isinstance(value, list):
        value = "\n".join(str(v) for v in value) or "Unknown"
    return discord.utils.escape_mentions(discord.utils.escape_markdown(str(value)))[:size]


def timestamp(value, *, relative=True):
    if not value:
        return "Unknown — no unambiguous time supplied"
    date = aware(value)
    seconds = int(date.timestamp())
    result = f"{date:%Y-%m-%d %H:%M UTC}\n<t:{seconds}:F>"
    if relative:
        result += f"\n⏳ <t:{seconds}:R>"
    return result


def giveaway_embed(row, *, detailed=False) -> discord.Embed:
    post = Post.model_validate_json(row["post"])
    extracted = Extraction.model_validate_json(row["extraction"])
    prize = ", ".join(extracted.prizes.value or [])
    title = clean(prize, 160) if prize else "Giveaway"
    if post.source == "mock":
        title = "Sample · " + title
    embed = discord.Embed(
        title=title,
        color={
            "open": 0x26AD81,
            "upcoming": 0x7586FA,
            "ending_soon": 0xF0AB3D,
            "ended": 0x808080,
            "cancelled": 0xD84855,
        }.get(row["status"], 0x808080),
    )
    embed.set_author(name=clean("@" + post.author, 100))
    summary = []
    if extracted.winner_count.value:
        count = extracted.winner_count.value
        summary.append(f"{count} winner{'s' if count != 1 else ''}")
    if not detailed:
        timing = []
        stated_times = labelled_times(post.text)
        for label, key in [
            ("Starts", "starts_at"),
            ("Ends", "deadline_at"),
            ("Announcement", "announcement_at"),
        ]:
            value = getattr(extracted, key).value
            if value:
                date = aware(value)
                seconds = int(date.timestamp())
                rendered = f"{date:%Y-%m-%d %H:%M UTC}\nLocal · <t:{seconds}:f>"
                if row["status"] != "cancelled":
                    rendered += f" (<t:{seconds}:R>)"
                timing.append(f"**{label}** · {rendered}")
            elif stated_times[key]:
                raw = " / ".join(value for _, value in stated_times[key])
                timing.append(f"**{label}** · {clean(raw, 160)} — {unresolved_time_reason(raw, post.text)}")
        summary.extend(timing or ["**Time** · Not clearly stated"])
        if extracted.sponsor.value:
            sponsor = " ".join(str(extracted.sponsor.value).split())
            summary.append("**Sponsor** · " + clean(sponsor, 200))
        if extracted.requirements.value:
            requirements = " • ".join(
                " ".join(re.sub(r"https?://t\.co/\S+", "", value).split())
                for value in extracted.requirements.value
            )
            if len(requirements) > 600:
                requirements = requirements[:597].rsplit(" ", 1)[0] + "…"
            summary.append("**To enter** · " + clean(requirements, 700))
        else:
            summary.append("**To enter** · See original post")
    if summary:
        embed.description = "\n".join(summary)
    if row["status"] in {"upcoming", "ending_soon", "ended", "cancelled"}:
        embed.set_footer(text=row["status"].replace("_", " ").title())
    if detailed:
        for label, item in [
            ("How to enter", extracted.requirements),
            ("Sponsor", extracted.sponsor),
            ("Sponsor websites", extracted.sponsor_websites),
        ]:
            if item.value:
                embed.add_field(name=label, value=clean(item.value, 700), inline=False)
        for label, item in [
            ("Starts", extracted.starts_at),
            ("Entry deadline", extracted.deadline_at),
            ("Scheduled announcement", extracted.announcement_at),
        ]:
            if item.value:
                embed.add_field(
                    name=label,
                    value=timestamp(item.value, relative=row["status"] != "cancelled"),
                    inline=False,
                )
        evidence = list(
            dict.fromkeys(
                getattr(extracted, name).evidence
                for name in Extraction.model_fields
                if getattr(extracted, name).evidence
            )
        )
        if evidence:
            embed.add_field(name="Source excerpts", value=clean("\n".join(evidence), 900), inline=False)
    return embed


def post_link_view(post: Post) -> discord.ui.View:
    view = discord.ui.View(timeout=None)
    view.add_item(discord.ui.Button(label="OPEN GIVEAWAY ↗", style=discord.ButtonStyle.link, url=post.url))
    view.add_item(DetailsButton(post.id))
    view.add_item(HelpButton())
    return view


def can_manage_notification_channel(interaction: discord.Interaction, channel: discord.TextChannel) -> bool:
    if not interaction.guild or channel.guild.id != interaction.guild_id:
        return False
    if not isinstance(interaction.user, discord.Member):
        return False
    if interaction.user.guild_permissions.manage_guild:
        return True
    permissions = channel.permissions_for(interaction.user)
    return permissions.view_channel and permissions.manage_channels


class RaffleyeBot(discord.Client):
    def __init__(self, service: Service):
        intents = discord.Intents.none()
        intents.guilds = True
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.service, self.store = service, service.store
        self.screenshots = PostScreenshots(service.settings)
        self.tree = app_commands.CommandTree(self)
        self.stop_event = asyncio.Event()
        self.worker = None
        self.add_dynamic_items(DetailsButton, HelpButton)
        self.register_commands()

    async def setup_hook(self):
        # Single configured server: watchlists and budgets are shared within this installation.
        guild = discord.Object(id=self.service.settings.discord_guild_id)
        self.tree.copy_global_to(guild=guild)
        commands = await self.tree.sync(guild=guild)
        for command in commands:
            if command.name == "raffleye":
                self.store.set_meta("discord_command_id", command.id)
        self.worker = asyncio.create_task(self.work(), name="raffleye-scheduler")

    async def work(self):
        await self.wait_until_ready()
        await self.service.run(self.stop_event, self.notify)

    async def close(self):
        self.stop_event.set()
        if self.worker:
            self.worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.worker
        await super().close()

    async def notify(self):
        for item in self.store.pending_notifications(utcnow()):
            self.store.set_meta("last_progress", iso(utcnow()))
            row = self.store.giveaway(item["post_id"])
            if not row:
                continue
            if not self.visible(row):
                self.store.discard_notification(item)
                continue
            if not item["message_id"] and row["status"] in {"ended", "cancelled"}:
                self.store.discard_notification(item)
                continue
            pace_key = "notification_after:" + str(item["channel_id"])
            can_send = float(self.store.get_meta(pace_key, "0")) <= utcnow().timestamp()
            if not item["message_id"] and not can_send:
                continue
            sent_new = False
            try:
                channel = self.get_channel(int(item["channel_id"])) or await self.fetch_channel(
                    int(item["channel_id"])
                )
                if (
                    not isinstance(channel, discord.TextChannel)
                    or channel.guild.id != self.service.settings.discord_guild_id
                ):
                    raise ValueError("Invalid configured channel")
                embed, view, screenshot = await self.post_presentation(row)

                def attachment(path=screenshot, post_id=item["post_id"]):
                    return discord.File(path, filename=f"post-{post_id}.png") if path else None

                if item["message_id"]:
                    try:
                        message = channel.get_partial_message(int(item["message_id"]))
                        await message.edit(
                            embed=embed,
                            view=view,
                            attachments=[attachment()] if screenshot else [],
                            allowed_mentions=discord.AllowedMentions.none(),
                        )
                    except discord.NotFound:
                        if row["status"] in {"ended", "cancelled"}:
                            self.store.discard_notification(item)
                            continue
                        if not can_send:
                            continue
                        message = await channel.send(
                            embed=embed,
                            view=view,
                            **({"file": attachment()} if screenshot else {}),
                            allowed_mentions=discord.AllowedMentions.none(),
                            silent=True,
                        )
                        sent_new = True
                else:
                    message = await channel.send(
                        embed=embed,
                        view=view,
                        **({"file": attachment()} if screenshot else {}),
                        allowed_mentions=discord.AllowedMentions.none(),
                        silent=True,
                    )
                    sent_new = True
                if sent_new:
                    self.store.set_meta(
                        pace_key, utcnow().timestamp() + self.service.settings.notification_interval_seconds
                    )
                self.store.delivered(item, message.id)
            except (discord.HTTPException, ValueError) as exc:
                self.store.delivery_failed(item, type(exc).__name__, utcnow())

    def visible(self, row):
        return bool(Extraction.model_validate_json(row["extraction"]).prizes.value) and matches_topic(
            Post.model_validate_json(row["post"]), self.service.settings.giveaway_topic
        )

    async def post_presentation(self, row, *, detailed=False):
        post = Post.model_validate_json(row["post"])
        embed = giveaway_embed(row, detailed=detailed)
        screenshot = await self.screenshots.get(post)
        if screenshot:
            embed.set_image(url=f"attachment://post-{post.id}.png")
        return embed, post_link_view(post), screenshot

    def command_ref(self, name):
        command_id = self.store.get_meta("discord_command_id")
        return f"</raffleye {name}:{command_id}>" if command_id else f"`/raffleye {name}`"

    async def panel_allowed(self, interaction):
        if interaction.guild_id != self.service.settings.discord_guild_id:
            await interaction.response.send_message(
                "This server is not configured for RAFFLEYE.", ephemeral=True
            )
            return False
        return True

    async def send_details(self, interaction, post_id):
        if not await self.panel_allowed(interaction):
            return
        row = self.store.giveaway(post_id)
        if not row or not self.visible(row):
            await interaction.response.send_message(
                "This giveaway is no longer available in this feed.", ephemeral=True
            )
            return
        await interaction.response.send_message(
            embed=detail_embed(row), view=DetailsPanel(self, row), ephemeral=True
        )

    async def send_help(self, interaction, section="home"):
        if await self.panel_allowed(interaction):
            await interaction.response.send_message(
                embed=help_embed(self, section), view=HelpPanel(self, section), ephemeral=True
            )

    def register_commands(self):
        group = app_commands.Group(
            name="raffleye", description="Giveaway discovery and monitoring", guild_only=True
        )

        async def configured(interaction: discord.Interaction) -> bool:
            if interaction.guild_id != self.service.settings.discord_guild_id:
                raise app_commands.CheckFailure("This server is not configured")
            return True

        @group.command(name="help", description="Explore features, giveaway details and channel setup")
        @app_commands.check(configured)
        async def help_command(interaction: discord.Interaction):
            await self.send_help(interaction)

        @group.command(name="status", description="Show monitoring health, queues and budget usage")
        @app_commands.check(configured)
        async def status(interaction: discord.Interaction):
            await self.send_help(interaction, "status")

        @group.command(name="list", description="Show the latest discovered giveaways")
        @app_commands.check(configured)
        async def listing(interaction: discord.Interaction):
            rows = self.store.list_giveaways(5, predicate=self.visible)
            # Separate messages avoid Discord's aggregate 6,000-character embed limit.
            await interaction.response.defer(ephemeral=True)
            if not rows:
                await interaction.followup.send("No giveaways found yet.", ephemeral=True)
            for row in rows:
                embed, view, screenshot = await self.post_presentation(row)
                files = (
                    {"file": discord.File(screenshot, filename=f"post-{row['id']}.png")} if screenshot else {}
                )
                await interaction.followup.send(embed=embed, view=view, **files, ephemeral=True)

        @group.command(name="show", description="Show one giveaway and its evidence")
        @app_commands.check(configured)
        async def show(interaction: discord.Interaction, post_id: str):
            await self.send_details(interaction, post_id)

        @group.command(name="watch", description="Add/update an account; 1=high, 2=normal, 3=low priority")
        @app_commands.check(configured)
        @app_commands.checks.has_permissions(manage_guild=True)
        @app_commands.default_permissions(manage_guild=True)
        async def watch(
            interaction: discord.Interaction, handle: str, priority: app_commands.Range[int, 1, 3] = 2
        ):
            try:
                self.store.watch(handle, priority)
                await interaction.response.send_message("Watchlist updated.", ephemeral=True)
            except ValueError as exc:
                await interaction.response.send_message(str(exc), ephemeral=True)

        @group.command(name="unwatch", description="Remove a watched account")
        @app_commands.check(configured)
        @app_commands.checks.has_permissions(manage_guild=True)
        @app_commands.default_permissions(manage_guild=True)
        async def unwatch(interaction: discord.Interaction, handle: str):
            self.store.unwatch(handle)
            await interaction.response.send_message("Account removed from watchlist.", ephemeral=True)

        @group.command(name="watchlist", description="Show prioritized account watches")
        @app_commands.check(configured)
        async def watchlist(interaction: discord.Interaction):
            rows = [
                f"{q['key'][6:]} · priority {q['priority']} · every {q['interval_s'] // 60}m"
                for q in self.store.queries()
                if q["key"].startswith("watch:")
            ]
            await interaction.response.send_message(
                clean("\n".join(rows) or "Watchlist is empty.", 1900), ephemeral=True
            )

        @group.command(name="subscribe", description="Send giveaway notifications to this channel")
        @app_commands.check(configured)
        async def subscribe(interaction: discord.Interaction, channel: discord.TextChannel):
            if channel.guild.id != interaction.guild_id:
                await interaction.response.send_message("Choose a channel in this server.", ephemeral=True)
                return
            if not can_manage_notification_channel(interaction, channel):
                await interaction.response.send_message(
                    "You need View Channel and Manage Channels in the selected channel, or Manage Server.",
                    ephemeral=True,
                )
                return
            existing = self.store.subscription(interaction.guild_id)
            if existing and existing != channel.id and not interaction.user.guild_permissions.manage_guild:
                await interaction.response.send_message(
                    "This server already has a notification channel. Ask someone with Manage Server to move it.",
                    ephemeral=True,
                )
                return
            permissions = channel.permissions_for(interaction.guild.me)
            if not (permissions.view_channel and permissions.send_messages and permissions.embed_links):
                await interaction.response.send_message(
                    "I need View Channel, Send Messages, and Embed Links here.", ephemeral=True
                )
                return
            self.store.subscribe(interaction.guild_id, channel.id)
            mode = "SAMPLE giveaways" if self.service.source.name == "mock" else "giveaways"
            await interaction.response.send_message(
                f"Subscribed. Up to 25 recent {mode} are queued, delivered silently one at a time every "
                f"{self.service.settings.notification_interval_seconds // 60} minutes. No pings.",
                ephemeral=True,
            )

        @group.command(name="unsubscribe", description="Stop notifications for this server")
        @app_commands.check(configured)
        async def unsubscribe(interaction: discord.Interaction):
            channel_id = self.store.subscription(interaction.guild_id)
            if not channel_id:
                await interaction.response.send_message("No notification channel is set.", ephemeral=True)
                return
            channel = interaction.guild.get_channel(channel_id)
            server_manager = (
                isinstance(interaction.user, discord.Member)
                and interaction.user.guild_permissions.manage_guild
            )
            if not server_manager and (
                not isinstance(channel, discord.TextChannel)
                or not can_manage_notification_channel(interaction, channel)
            ):
                await interaction.response.send_message(
                    "You need to manage the subscribed channel, or have Manage Server, to stop its notifications.",
                    ephemeral=True,
                )
                return
            self.store.unsubscribe(interaction.guild_id)
            await interaction.response.send_message("Notifications stopped.", ephemeral=True)

        @group.command(
            name="retry", description="Retry failed extraction and notification jobs within budgets"
        )
        @app_commands.check(configured)
        @app_commands.checks.has_permissions(manage_guild=True)
        @app_commands.default_permissions(manage_guild=True)
        async def retry(interaction: discord.Interaction):
            self.store.retry_failed()
            await interaction.response.send_message("Failed jobs queued for retry.", ephemeral=True)

        @self.tree.error
        async def error(interaction: discord.Interaction, exc: app_commands.AppCommandError):
            message = (
                "You need Manage Server permission, and this must be the configured server."
                if isinstance(exc, app_commands.CheckFailure)
                else "Command failed. Check bot status and logs."
            )
            logging.getLogger(__name__).warning("Command error: %s", type(exc).__name__)
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)

        self.tree.add_command(group)
