# RAFFLEYE

A TypeScript Discord bot that discovers gacha-related giveaways on X and posts compact giveaway cards. Node.js 22.12+ is required. Python under `src/` is retained as the pre-migration reference, not a second production worker.

## Run locally

```powershell
cd D:\Projects\RAFFLEYE
npm ci
npm run validate
npm run demo
npm start
```

Copy `.env.example` to `.env` only on a fresh installation. Never commit credentials. The pinned dependencies ship native binaries; `.npmrc` disables dependency install scripts to avoid npm attempting an unnecessary local C++ rebuild. Validation exercises those binaries. `demo` ignores live credentials, uses mock posts, stores a separate `data/demo-ts.sqlite3`, and sends nothing to Discord. `npm run status` reads operational status; `npm run health` checks the runtime lease, gateway connection, heartbeat and worker progress. A healthy runtime does not guarantee that X is available.

## Discord controls

`/raffleye dashboard` opens the private control center. It includes searchable, paginated giveaway browsing; active, ending-soon, upcoming and all-record filters; account watches; feed setup; help; and readable health/spending status. Browse sessions belong to their user and server and expire after ten idle minutes.

- `/raffleye setup`: choose a channel or pause/resume new cards. Pausing still allows monitoring and edits to existing cards.
- `/raffleye list`, `/raffleye show post_id`: browse saved giveaways or open one directly.
- `/raffleye watchlist`, `/raffleye watch handle priority`, `/raffleye unwatch handle`: account watches. Priorities 1/2/3 check every 5/15/60 minutes. Account mutations require Manage Server. Removed automatic watches stay suppressed until explicitly added again.
- `/raffleye subscribe channel`, `/raffleye unsubscribe`: compatible feed controls. View Channel + Manage Channels in the target channel, or Manage Server, is required. Moving an existing feed requires Manage Server.
- `/raffleye status`, `/raffleye retry`, `/raffleye help`: monitoring, failed jobs and guidance. Retry requires Manage Server.

The bot needs View Channel, Send Messages, Embed Links and Attach Files in its feed. One installation supports one server and one feed. Snowflake IDs remain strings throughout storage and Discord calls.

## Public cards

Cards retain the prize, entry requirements, optional steps, stated sponsors and dates, with a prominent OPEN GIVEAWAY link, Details and Dashboard buttons. Details opens private prize/entry, date, sponsor/link and evidence sections. New cards ping only the Beggars role and are paced at one per five minutes; edits happen in place without another ping. Recreated deleted cards do not ping again. Pause state and pacing survive restarts. Deleted cards are recreated only when the giveaway is not known to have ended or been cancelled, subject to pacing.

Screenshots show the official public X embed from its author through its timestamp. No logged-in browser, cookies or page scraping is used for discovery. X may truncate long posts with Show more; the source link remains available. A failed embed falls back to the link and is retried later. Windows uses isolated headless Edge; Docker uses bundled Chromium. Cached screenshots are reused across restarts and status changes.

## Qualification and discovery

Every extracted claim retains its contiguous source evidence; unknowns stay explicit. Multiple prizes are independent of winner count. In the legacy `all` and `wuwa` modes, a post needs giveaway/entry evidence AND a concrete prize. The `gacha` mode uses the numeric eligibility rule below.

The live TypeScript topic is `gacha`. Author names/bios or post text must identify gacha or a recognized game, such as WuWa, Genshin, Honkai, Zenless Zone Zero, NIKKE, Arknights, Fate/Grand Order, Blue Archive, or other games listed in `app/discovery.ts`. The post itself must contain `giveaway`/`giveaways` and a positive numeric prize amount, supported reward quantity, or winner count. Examples: `5 Welkins giveaway`, `Giveaway: $50`, and `Giveaway — 3 winners`. Dates, URLs, follower milestones, entry fees, and numbered instructions alone do not qualify. A winner count can qualify even when the prize is unstated; the bot leaves the prize unknown rather than inventing it. Ended/results/cancelled posts are not introduced as new giveaways.

Global search is broad enough to find giveaways whose game context appears only in the author's profile. Returned profiles are checked locally; X search does not search author bios. Relevant profiles may receive automatic hourly watches, still capped at five. This is not exhaustive discovery of every gacha account: unknown game names, image-only information, and unrecognized reward wording may be missed. Explicit account watches can improve coverage but do not bypass the post filter. Existing pacing and spending limits remain in force. `wuwa` and `all` modes retain the older concrete-prize requirement; the Python reference does not implement the new `gacha` mode.

Official X is the primary live provider. The first/deep scan covers six days; completed deep scans repeat after 24 hours. Subsequent scans overlap recent coverage. Raw pages and pagination are committed together before advancing coverage. Recent-search retention limits recovery after long outages; coverage warnings remain visible. Full archive mode requires the appropriate X access and configured window. Image-only details and unrecognized wording may be missed.

An optional OpenAI extractor uses bounded structured output and local evidence validation. Configure its key, model and positive per-call reservation. An optional Apify adapter reads an existing explicitly authorized dataset; it never starts actors or obtains cookies. Fallback occurs only for X network/server errors, never to bypass access, billing, rate or budget restrictions.

## Dates and UTC

Supported full dates include year-first, English month names, MM/DD/YYYY and DD/MM/YYYY, with slash/dot/hyphen separators, AM/PM and UTC/GMT offsets. Numeric order must be unambiguous or explicitly declared. The bot never treats winner-announcement time as the entry deadline.

A timezone explicitly stated beside a date or declared for all times in the post takes priority. Otherwise, a recognizable public account profile location supplies an **estimated** IANA timezone. Daylight saving is applied for the giveaway date, and the card identifies the location and timezone used. Profile locations are self-reported, not verified physical locations. Ambiguous or multizone locations such as USA, fictional locations, DST gaps/folds, missing years/clocks and ambiguous numeric dates remain unresolved. `19.10.` alone cannot produce an exact UTC deadline. Resolved cards show the same moment in UTC, JST (UTC+9), Asia/SEA/HMT server time (UTC+8), Europe server time (UTC+1), America server time (UTC-5), and Discord-local time with a relative countdown. Server offsets are fixed; host civil time may observe daylight saving. JST is also accepted explicitly in source posts and takes priority over profile location. Server-clock references: [server selection](https://wutheringwaves.gg/server) and [reset times](https://wutheringwaves.fandom.com/wiki/Reset).

## Spending and persistence

This local deployment retains US$5/day and US$50/month conservative spending reservations, resetting at UTC boundaries. Requests reserve before network calls; failed or uncertain calls keep their reservation. Separate daily request/post-slot limits and persisted provider cooldowns also apply. Restarting does not clear counters. Local estimates are not the provider invoice.

SQLite retains posts, claims, watches, subscriptions, budget counters, delivery IDs, queue retries and pagination. A renewable runtime lease prevents simultaneous TypeScript writers. Delivery uses stable Discord nonces and persisted message IDs, reducing duplicate sends, but does not promise indefinite exactly-once delivery after a crash. Do not run the Python reference alongside TypeScript or put the SQLite file on a network filesystem.

## Local automatic deployment

`npm run deploy` deploys committed `HEAD`. `npm run deploy:watch` watches commits and monitors health. Each release is an isolated Git snapshot under `.deploy/releases/<commit>`, with its own locked dependencies. Validation runs before stopping the active bot. Deployment then stops it gracefully, creates a consistent SQLite backup, starts the candidate, checks its process-specific health and records the active commit. A candidate startup failure restarts the previous code while retaining live data. Failed validation leaves the running release untouched. Uncommitted changes do not deploy.

The watcher checks every 15 seconds, restarts after repeated failed health checks, and does not keep retrying a failed new commit. `powershell -File ops/start-watcher.ps1 -AtLogon` starts it hidden and adds a current-user Windows Startup shortcut. Inspect `.deploy/watcher-*.log` and `data/ts-*.log` for errors. To stop the watcher, create `.deploy/stop-watcher`; to stop the bot, create the `stop_file` named in `data/typescript-process.json`. Remove the watcher stop marker before deliberately starting it again. Remove the RAFFLEYE watcher shortcut from Windows Startup to disable logon startup. Manual rollback: `powershell -File ops/deploy.ps1 -Ref <previous-commit>`; stop the watcher first so it does not redeploy HEAD. Backups are in `data/backups` and are not automatically deleted.

The bot depends on this PC remaining on and awake. No remote server has been purchased or configured.

## Docker

Docker Desktop/WSL2 must already be available. Stop the native watcher and bot before switching; only one writer may use `data/live.sqlite3`.

```powershell
docker compose up --build -d
docker compose logs -f
```

Compose runs the TypeScript bot as a non-root user, with a read-only root, dropped capabilities, a writable `./data` bind mount, health checks and restart policy. The same live database and budget history are retained. Docker build/runtime has not been validated on this PC because Docker/WSL setup was blocked. The supplied container is a deployment option, not the currently running engine.

## Validation

```powershell
npm run validate
npm run demo
.\.venv\Scripts\ruff check src tests
.\.venv\Scripts\ruff format --check src tests
.\.venv\Scripts\python -m pytest -q
```

See `docs/VALIDATION.md` for recorded checks. CI validates TypeScript, the retained Python reference and a Docker build/demo. A committed workflow is not evidence that remote CI has run.

## Closing giveaways from host updates

A same-author results/ended/cancelled post linking directly to the original giveaway closes that original. Closure evidence and source IDs persist separately from original-post extraction, so re-extraction cannot reopen it. Startup also reconciles cached results. All delivered copies update to ENDED/CANCELLED with a host-update link, including copies in a previous feed channel. Result posts are not advertised as fresh giveaways. Scheduled winner announcements and unrelated authors do not establish closure. Unlinked updates are not automatically matched by prize similarity.

## Host-created quick giveaway heads-ups

Public heads-ups include publisher-only **Edit heads-up**, **Image** and **Cancel heads-up** buttons. Cancel deletes the public announcement; failed deletions retry automatically. Start and end UTC times are bold at the top, followed by local countdowns and other server clocks. The **Image** button also appears in draft previews: upload one PNG/JPG/GIF/WebP prize picture (up to 8 MB), or paste one public X post URL to capture its official embed. Uploaded files are saved locally and attached to Discord, surviving subsequent edits and restarts. Images can be replaced through the same button. Scheduled/unpublished X posts cannot be captured; upload a prize image first and replace it once the post is public. RAFFLEYE does not publish or schedule X posts.

New `/raffleye headsup` requests use the picture-first giveaway creator described below. Existing announcement-only posts remain under Dashboard → Announcements (no entries), where their publisher can edit the prize, start, duration, entry details and link. These legacy posts do not collect UID/server entries.

Drafts are bound to their creator, server and destination. Previews expire after ten minutes; editing refreshes them. Double-click publication is guarded, with a stable Discord nonce. Published records survive restarts, and scheduled-start, ended and cancelled labels update during monitoring cycles. The public announcement’s Edit heads-up button (also available under My heads-ups → Manage) lets the creator update the prize, start, duration, entry details and link on the same public message. Only the original publisher can open or submit edits, even if another user has administrator permissions. Everyone can see the public button; the editor and denial responses are private. Saving the form applies changes immediately. Unchanged past start times are preserved for detail corrections; a changed start must be in the future. Both start and end show Discord’s automatically updating relative countdowns. My heads-ups also lets the creator cancel the announcement; cancellation deletes its public card. The host still conducts entry collection and winner selection. No real announcement is created by installation or testing.


## Discord-only giveaways

Use Dashboard → Create giveaway, `/raffleye giveaway` → Create Discord giveaway, or `/raffleye headsup`. Select a pictured prize; fill in its name/amount per winner, quantity (number of distinct winners), and description. The preview attaches the selected image automatically. Starts and Ends offer presets or exact dates; plain dates use Taipei UTC+8. Publishing announces it immediately and pings Beggars, while entries open at the scheduled start. Entrants submit UID followed by Server and can correct their details until closing. The publisher can Draw now, change the image, Cancel or privately download submissions. Cancellation deletes the announcement.

A separate five-second timer checks deadlines independently of X discovery. When due, or when the publisher clicks Draw now, a SQLite transaction closes entry and selects one entrant with Node's cryptographic randomInt. The winner, entrant count and draw time are stored before editing the original card. Retries and restarts reuse that result and never redraw. Empty raffles end with no winner. Entries close at the recorded deadline even during an outage; overdue draws resume when the bot returns. Result cards are silent and do not ping; the publisher handles prize delivery. An uncertain initial send stays marked as publishing to avoid automatically creating a duplicate.

The Image picker in both heads-ups and Discord giveaways includes four sourced LDSHOP pictures: Lunite, Lunite Subscription, Insider Channel and Connoisseur Channel, plus upload / X screenshot and Remove image. Presets change only the image, never prize quantities. Source URLs are in assets/prizes/SOURCES.md and on image cards; images do not imply sponsorship.


## Giveaway notification reaction roles

Use `/raffleye reactionrole role:@Beggars channel:#roles` to publish a silent opt-in message with a gift emoji reaction. Channel defaults to the command's current channel. Members add the gift reaction to receive Beggars and remove it to leave. The notification role does not automatically enter members in giveaways. All new discovery cards, heads-ups and Discord giveaways ping the unique role named Beggars. Updates stay silent. Beggars must be mentionable, or the bot must have Mention Everyone permission in the destination; no other role, user or everyone mention is enabled.

Both the command user and bot need Manage Roles and a higher role position than the selected role (the server owner bypasses only the creator's hierarchy check). Only unmanaged roles with zero extra permission bits are accepted, preventing staff/administrator roles from becoming self-assignable. The destination also requires View Channel, Send Messages, Embed Links, Read Message History and Add Reactions for the bot. It does not need Administrator, Message Content, or the privileged Server Members intent; raw GuildMessageReactions events work for uncached messages after restart.

Role mappings and desired membership are stored in SQLite. Failed role updates retry; version checks preserve newer opt-outs. Startup and periodic reaction-list reconciliation recover changes made while the bot was offline. Only one active panel per role is allowed. `/raffleye reactionrole-remove message_id:...` disables/deletes the panel while retaining existing member roles. The creator or a server manager must also have Manage Roles to remove it.

Reaction-role creation opens a form for a custom title (256 characters) and multiline description (3,500 characters), including emojis and Discord Markdown. Submit publishes the message. Use `/raffleye reactionrole-edit message_id:...` to change the wording in place without changing reactions or roles. The creator or a server manager with Manage Roles can edit.


## Private monthly activity reports

Run `/raffleye activity-report action:enable` once from your Discord account (Manage Server required). Raffleye verifies DMs, binds the recipient to the invoking account, starts metadata collection and sends the first report after 30 days, then every 30 days. `minimum_giveaways` defaults to 3. Preview, Status and Disable are available through the same command; disabling stops collection and scheduled reports. Fresh Manage Server membership is checked before sending monthly data.

The report lists each participant's distinct giveaway posts, Raffleye entry count, gift/celebration reaction-post count, regular chat message count and active chat days. The review flag means at least the configured number of giveaway posts and zero regular messages observed, not a claim about intent. It includes below-threshold participants too. Entry edits, leaving/rejoining and repeat reactions do not inflate counts. Entries include later withdrawals; reactions are observations, not verified external-bot entries. Gift/celebration reactions in the configured giveaway feed and channels used by Raffleye announcements are included, excluding notification-role panels. Entries and reactions on the same message count once toward the threshold.

GuildMessages is enabled without MessageContent. Bot and webhook messages, giveaway channels and their threads are excluded from chat totals. Only Discord IDs, timestamps and channel IDs are stored; no message text, attachments or DMs are collected. Voice participation, reading, external X participation and inaccessible-channel messages are not measured. Monitoring begins on enable and does not backfill history or reactions missed while offline. Minute-level gateway coverage is disclosed. Event metadata expires after 90 days even if reporting is disabled; only the latest three delivered report snapshots are retained. Reports use private DMs and mention suppression, with JSON counts attached. Delivery failures retry hourly; pending report contents and nonce are persisted across restarts. No bans or role changes are made from this report.

Public giveaway cards do not display activity-report reminders or member flags. Private activity reports separately highlight repeat participants with zero messages and with only 1–2 messages; these are review prompts, not eligibility rules or judgments about friendship. Entry eligibility and random draws remain unchanged.


### Simplified creation flow

Use Dashboard → Create giveaway or `/raffleye headsup` (now an alias for the picture-first entry giveaway creator). Choose Lunite, Monthly Pass (Lunite Subscription), Battle Pass (Insider Channel), or Premium Battle Pass (Connoisseur Channel). Selection opens exactly three fields: prize name/amount per winner, quantity/number of winners, and description. Example: name `3,280 Lunite`, quantity `3` means three distinct winners receive 3,280 each. The selected picture is attached automatically. Next set Starts and Ends and review before publishing; incomplete new drafts cannot publish. Participants see exactly UID followed by Server, and can edit while entries are open. The older announcement-only posts remain manageable under Announcements (no entries); new creation buttons lead to this unified flow.

After a draw, click **Winner info** on the result card to view every winner’s UID and server privately. Only the original publisher can open it; everyone else receives a private denial. The same button is available under My giveaways → Manage. Existing result posts receive the button automatically without re-drawing or pinging.
