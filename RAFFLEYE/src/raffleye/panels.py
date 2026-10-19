"""Small Discord-native help and detail panels; all interactions are private."""

import discord

from .models import Extraction, Post, aware, utcnow
from .timeparse import labelled_times, unresolved_time_reason


def safe(value, limit=900):
    if isinstance(value, list):
        value = "\n".join(str(v) for v in value)
    return discord.utils.escape_mentions(discord.utils.escape_markdown(str(value)))[:limit]


DETAIL_SECTIONS = {
    "entry": ("Prize & entry", "Prizes, winner count and participation rules"),
    "dates": ("Dates & countdowns", "Start, deadline and scheduled announcement"),
    "sponsors": ("Sponsors & links", "Sponsor information and links from the post"),
    "evidence": ("Source evidence", "The original excerpts behind the details"),
}


def detail_embed(row, section="entry"):
    post = Post.model_validate_json(row["post"])
    data = Extraction.model_validate_json(row["extraction"])
    embed = discord.Embed(title=DETAIL_SECTIONS[section][0], color=0x26AD81)
    embed.set_author(name=safe("@" + post.author, 100))
    missing = "Not clearly stated in the post."
    if section == "entry":
        for label, item in [
            ("Prize", data.prizes),
            ("Winners", data.winner_count),
            ("How to enter", data.requirements),
        ]:
            embed.add_field(
                name=label, value=safe(item.value) if item.value is not None else missing, inline=False
            )
    elif section == "dates":
        stated_times = labelled_times(post.text)
        for label, key in [
            ("Starts", "starts_at"),
            ("Entry deadline", "deadline_at"),
            ("Scheduled announcement", "announcement_at"),
        ]:
            item = getattr(data, key)
            value = missing
            if item.value:
                date = aware(item.value)
                seconds = int(date.timestamp())
                value = f"<t:{seconds}:F>\n{date:%Y-%m-%d %H:%M UTC}"
                if row["status"] != "cancelled":
                    value += f"\n<t:{seconds}:R>"
            elif stated_times[key]:
                raw = " / ".join(value for _, value in stated_times[key])
                value = safe(raw, 300) + "\n" + unresolved_time_reason(raw, post.text)
            embed.add_field(name=label, value=value, inline=False)
        embed.set_footer(text="Times adapt to your timezone. An announcement time is not an entry deadline.")
    elif section == "sponsors":
        embed.add_field(
            name="Sponsor", value=safe(data.sponsor.value) if data.sponsor.value else missing, inline=False
        )
        embed.add_field(
            name="Sponsor websites",
            value=safe(data.sponsor_websites.value) if data.sponsor_websites.value else missing,
            inline=False,
        )
        if post.urls:
            embed.add_field(name="Other links in the post", value=safe(post.urls), inline=False)
        embed.set_footer(
            text="Links and sponsor claims come from the post; they are not independently verified."
        )
    else:
        excerpts = list(
            dict.fromkeys(
                getattr(data, name).evidence
                for name in Extraction.model_fields
                if getattr(data, name).evidence
            )
        )
        embed.description = (
            safe("\n\n".join(excerpts), 3500)
            if excerpts
            else "No clear evidence was extracted. Open the original post to check its terms."
        )
    if not embed.footer.text:
        embed.set_footer(text="Missing details are left unknown. Open the original post for its full terms.")
    return embed


HELP_SECTIONS = {
    "home": ("Start here", "How to use RAFFLEYE"),
    "browse": ("Browse giveaways", "Latest discoveries and how to open one"),
    "cards": ("Understand the cards", "Details, screenshots, countdowns and updates"),
    "setup": ("Channel notifications", "Set up or stop the public feed"),
    "accounts": ("Accounts & priorities", "View or manage watched accounts"),
    "status": ("Status & budget", "Monitoring, delivery queues and budget limits"),
}


def help_embed(bot, section="home"):
    ref = bot.command_ref
    embed = discord.Embed(title="RAFFLEYE · " + HELP_SECTIONS[section][0], color=0x26AD81)
    if section == "home":
        embed.description = "Find giveaways and explore their details right here in Discord. Choose a topic below; only you can see this menu."
        embed.add_field(
            name="On every card",
            value="**OPEN GIVEAWAY** opens X. **Details** shows entry rules, dates, sponsors and source evidence. **Help** opens this menu.",
            inline=False,
        )
        embed.add_field(
            name="Browse or check the bot",
            value=f"{ref('list')} — latest giveaways\n{ref('watchlist')} — watched accounts\n{ref('status')} — monitoring and budget",
            inline=False,
        )
        embed.add_field(
            name="Set up the feed",
            value="Choose **Channel notifications** below. Account management is under **Accounts & priorities**.",
            inline=False,
        )
    elif section == "browse":
        rows = bot.store.list_giveaways(5, predicate=bot.visible)
        lines = []
        for row in rows:
            post = Post.model_validate_json(row["post"])
            data = Extraction.model_validate_json(row["extraction"])
            label = safe(", ".join(data.prizes.value or []) or "Giveaway", 90)
            lines.append(f"• [{label}]({post.url}) — {safe('@' + post.author, 80)}")
        embed.description = "\n".join(lines) or "No giveaways have been discovered yet."
        embed.add_field(
            name="Explore a giveaway",
            value=f"Use {ref('list')} for cards with **Details** buttons. {ref('show')} also accepts a post ID from an X link.",
            inline=False,
        )
    elif section == "cards":
        minutes = bot.service.settings.notification_interval_seconds // 60
        embed.description = "The feed stays compact. Click **Details** for everything the bot could extract."
        embed.add_field(
            name="Available details",
            value="Prizes and winner counts · participation rules · sponsor and websites · start/deadline/announcement times · source excerpts",
            inline=False,
        )
        embed.add_field(
            name="Screenshots & time",
            value="Post-only screenshots exclude login prompts and reply controls. X may shorten long posts. Known times include a countdown; unclear dates stay unknown.",
            inline=False,
        )
        embed.add_field(
            name="Quiet updates",
            value=f"At most one new card every {minutes} minutes, silently and without pings. Status changes edit the same card. Repeated copies are filtered.",
            inline=False,
        )
    elif section == "setup":
        embed.description = "Channel managers can set up the feed without needing full server administration."
        embed.add_field(
            name="Start or stop",
            value=f"{ref('subscribe')} — choose the destination channel\n{ref('unsubscribe')} — stop this server's feed",
            inline=False,
        )
        embed.add_field(
            name="Your permissions",
            value="View Channel + Manage Channels in the destination, or Manage Server. Moving an existing feed to a different channel requires Manage Server.",
            inline=False,
        )
        embed.add_field(
            name="Bot permissions",
            value="View Channel, Send Messages, Embed Links, and Attach Files for post screenshots.",
            inline=False,
        )
    elif section == "accounts":
        embed.add_field(
            name="View accounts",
            value=f"{ref('watchlist')} — anyone in this server can check the watchlist.",
            inline=False,
        )
        embed.add_field(
            name="Manage Server required",
            value=f"{ref('watch')} — add an X handle and choose a priority\n{ref('unwatch')} — remove a manual watch\n{ref('retry')} — retry failed extraction or delivery after fixing the issue",
            inline=False,
        )
        embed.add_field(
            name="Priorities",
            value="1: every 5 minutes · 2: every 15 minutes · 3: every hour. Actual checks depend on the shared budget.",
            inline=False,
        )
        embed.add_field(
            name="Discovery",
            value="Global Wuwa search also runs. Relevant hashtags and qualifying account bios are checked; up to five discovered Wuwa giveaway accounts can be watched automatically. A post must announce an offer and state a concrete prize to enter the feed; vague teasers and winner counts alone do not qualify.",
            inline=False,
        )
    else:
        data = bot.store.status()
        channel = bot.store.subscription(bot.service.settings.discord_guild_id)
        issues = bool(
            data["query_errors"]
            or data["worker_error"]
            or data["failed_notifications"]
            or data["extraction_warning"]
        )
        embed.description = (
            "Some monitoring or delivery work needs attention." if issues else "The bot is running."
        )
        embed.add_field(
            name="Feed",
            value=(f"<#{channel}>" if channel else "No destination yet — use /raffleye subscribe.")
            + f"\n{data['pending_notifications']} cards/updates queued",
            inline=False,
        )
        settings = bot.service.settings
        day = data["usage_today"].get("estimated_usd", 0)
        month = bot.store.db.execute(
            "SELECT used FROM budgets WHERE period=? AND metric='estimated_usd'",
            (utcnow().strftime("month:%Y-%m"),),
        ).fetchone()
        embed.add_field(
            name="Budget reserved",
            value=f"Today: US${day:.2f} / ${settings.daily_estimated_usd:g}\nThis month: US${month[0] if month else 0:.2f} / ${settings.monthly_estimated_usd:g}",
            inline=False,
        )
        embed.add_field(
            name="Delivery",
            value=f"One silent new card every {settings.notification_interval_seconds // 60} minutes. Existing cards update in place.",
            inline=False,
        )
        if data["coverage_warning"]:
            embed.add_field(name="Coverage", value=safe(data["coverage_warning"]), inline=False)
        if issues:
            errors = list(data["query_errors"].values())
            reason = (
                "The API budget is exhausted; discovery resumes when its limit resets."
                if any("limit reached" in str(e) for e in errors)
                else "A source, extraction or delivery error is pending. Ask a server manager to check access and retry."
            )
            embed.add_field(name="Next step", value=reason, inline=False)
        embed.set_footer(text="Budget reservations are estimates, not the X invoice.")
    return embed


class PrivatePanel(discord.ui.View):
    def __init__(self, bot):
        super().__init__(timeout=600)
        self.bot = bot

    async def interaction_check(self, interaction):
        return await self.bot.panel_allowed(interaction)


class DetailSelect(discord.ui.Select):
    def __init__(self, bot, post_id, section):
        self.bot, self.post_id = bot, post_id
        super().__init__(
            placeholder="Choose giveaway details…",
            options=[
                discord.SelectOption(label=label, value=key, description=description, default=key == section)
                for key, (label, description) in DETAIL_SECTIONS.items()
            ],
        )

    async def callback(self, interaction):
        row = self.bot.store.giveaway(self.post_id)
        if not row or not self.bot.visible(row):
            await interaction.response.send_message(
                "This giveaway is no longer available in this feed.", ephemeral=True
            )
            return
        section = self.values[0]
        await interaction.response.edit_message(
            embed=detail_embed(row, section), view=DetailsPanel(self.bot, row, section)
        )


class DetailsPanel(PrivatePanel):
    def __init__(self, bot, row, section="entry"):
        super().__init__(bot)
        post = Post.model_validate_json(row["post"])
        self.add_item(DetailSelect(bot, post.id, section))
        self.add_item(
            discord.ui.Button(label="OPEN GIVEAWAY ↗", style=discord.ButtonStyle.link, url=post.url)
        )
        self.add_item(HelpButton())


class HelpSelect(discord.ui.Select):
    def __init__(self, bot, section):
        self.bot = bot
        super().__init__(
            placeholder="What would you like to do?",
            options=[
                discord.SelectOption(label=label, value=key, description=description, default=key == section)
                for key, (label, description) in HELP_SECTIONS.items()
            ],
        )

    async def callback(self, interaction):
        section = self.values[0]
        await interaction.response.edit_message(
            embed=help_embed(self.bot, section), view=HelpPanel(self.bot, section)
        )


class HelpPanel(PrivatePanel):
    def __init__(self, bot, section="home"):
        super().__init__(bot)
        self.add_item(HelpSelect(bot, section))


class DetailsButton(
    discord.ui.DynamicItem[discord.ui.Button], template=r"raffleye:details:(?P<post_id>[0-9]+)"
):
    def __init__(self, post_id):
        self.post_id = post_id
        super().__init__(
            discord.ui.Button(
                label="Details", style=discord.ButtonStyle.secondary, custom_id=f"raffleye:details:{post_id}"
            )
        )

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls(match["post_id"])

    async def callback(self, interaction):
        await interaction.client.send_details(interaction, self.post_id)


class HelpButton(discord.ui.DynamicItem[discord.ui.Button], template=r"raffleye:help"):
    def __init__(self):
        super().__init__(
            discord.ui.Button(label="Help", style=discord.ButtonStyle.secondary, custom_id="raffleye:help")
        )

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls()

    async def callback(self, interaction):
        await interaction.client.send_help(interaction)
