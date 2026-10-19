# Validation record

Date interpretation and UTC restoration on 2026-10-17: numeric month/day and day/month formats with slash, dot or hyphen separators now resolve when only one calendar interpretation is valid, or when the post explicitly states its date order. Added year-first variants and day-first English month names; UTC/GMT offsets, AM/PM and parentheses normalize to UTC. Ambiguous numeric dates and incomplete source times remain quoted with the unresolved information explained. Public cards again show explicit UTC, Discord-local time and countdown together. Tests cover order disambiguation, leap/invalid dates, offsets and rollover, AI grounding, multiple date roles, cancelled countdowns, and preserving partial source dates.

Concrete-prize admission update on 2026-10-17: 131 tests pass. New coverage rejects vague teasers, TBD/surprise prizes, winner counts and purchase amounts; accepts stated monthly passes, Lunite rewards, gift cards and labelled prizes; prevents positive classification alone and legacy queued rows from bypassing the filter. Cached live posts distinguish the conditional teaser from four posts offering concrete rewards.

Essential-details layout correction on 2026-10-17: 117 tests and lint/format checks passed. Public cards now retain date/countdown, stated sponsor, and participation requirements as concise labelled lines in the description, rather than large field blocks or hidden-only details. Known dates use a compact local date plus relative countdown; unclear times remain explicit. Rules extraction now includes multiline and unlabelled entry actions, retaining optional wording and eligibility constraints. Details/Help controls and source screenshots remain available.


Discord-native discoverability update on 2026-10-17: 114 tests passed with lint and formatting checks passing. Added persistent Details/Help card controls, private detail topic menus, a `/raffleye help` menu covering all features and permissions, and readable status/budget information. Tests cover reconstructing a persistent control after restart, reading current records, private-only replies/edits, cross-server and out-of-scope rejection, help topic size limits, clickable command references, and explicit missing information. Public cards remain compact; controls make the available features discoverable without external documentation. Live Discord read-back verified all three existing cards have OPEN GIVEAWAY, Details and Help controls, with screenshots retained and no extra detail fields. Guild command synchronization includes `/raffleye help` alongside all nine previous commands. The gateway is connected and the update queue is clear. Actual human clicks were not observed; callback behavior was exercised in the automated tests.


Compact feed update on 2026-10-17: 100 tests pass, with lint and formatting passing. The public card uses author/prize, known winner count, one relevant countdown, its existing screenshot and one link button. Empty fields, repeated links and diagnostic footer content are omitted. Evidence/requirements/sponsor fields and full timestamps are available privately through `/raffleye show`; no stored evidence or budget counters were removed.


Post screenshots and link visibility update on 2026-10-17: 100 tests passed, lint/format passed, and pip dependency checks passed. A real official X embedded post was rendered with isolated headless Edge and visually inspected: author, text, media/quoted content and timestamp were present; reply controls and login banners were excluded. The original X embed retained its Show more truncation. Tests cover cache reuse, failure cooldown/link fallback, prominent source buttons, and attachment send/edit behavior while preserving pacing. Docker browser installation was added but Docker remains untested on this machine. Both existing live Wuwa cards were edited in place; a Discord read-back verified their new source-link titles, link buttons and embedded screenshot images. The restarted gateway was connected with zero screenshot failures; pending new cards retained their pacing.


Wuwa scope correction on 2026-10-17: 95 tests passed. Global/watch queries, local extraction, Discord delivery/list/show now enforce the configured topic. Tests cover Wuwa aliases/hashtags, profile-based eligibility, bounded automatic profile watches, rejection of non-announcement chatter, same-author short-link reuploads, and silent one-card-per-300-seconds pacing across restarts. With explicit user approval, all 30 unrelated Discord messages from the initial broad search were deleted successfully; no other messages were targeted.

Two bounded Wuwa search checks succeeded; the second verified live author name/description expansion. Reprocessing produced five distinct eligible cards, including one upcoming teaser. No returned author profile matched both Wuwa and giveaway wording in this sample, so profile-only discovery is unit-tested but not yet observed live. Local budget counters were preserved; five total X requests had reserved US$1.00 at this checkpoint. The API query is targeted, but semantic accuracy is still limited by the rules extractor.


Catch-up and live deployment validated on 2026-10-17 (Asia/Taipei): **67 tests passed**, with lint and formatting checks passing. New checks cover six-day initial scans, restart continuation, outage overlap, periodic rescans, expired recent-search cursors, archive-mode isolation, budget interruption, atomic checkpoint rollback, and suppression of expired new/deleted Discord cards.

Live X smoke search succeeded with ten posts. Continuous live mode then fetched a second page, bringing the observed total to 20 real X posts; all were processed without source/extraction errors. Discord gateway connection succeeded and at least seven real cards were acknowledged by Discord during the first observed delivery cycle; remaining cards were queued. No sample posts were present in the live database. Mentions remain disabled. The process is running hidden on this computer, using `data/live.sqlite3` and the existing subscription. No automatic startup task is configured.

Approved local estimated-spend caps: US$5/day and US$50/month. Ten-post X pages reserve US$0.20 each; observed cumulative reservation after two requests was US$0.40. This is not actual invoiced spending or confirmation of a provider-side billing cap. Full six-day catch-up has not yet completed, and complete coverage is not guaranteed within these budgets. Full-archive access and live AI/Apify remain untested.

## Earlier validation history


Channel setup update validated on 2026-10-17 (Asia/Taipei): 59 tests pass, including target-channel authorization for subscriptions, rejection of unauthorized redirection/unsubscription, and missing bot permissions. Lint and formatting passed. Live Discord login and command synchronization succeeded in sample mode; channel delivery still requires the user to subscribe a permitted channel. Mock cards are clearly labelled Sample. User/role/everyone mentions remain disabled.

Countdown update validated on 2026-10-17 (Asia/Taipei): lint and formatting passed; 52 tests passed; offline demo completed with four giveaways and no paid usage. Added Discord-native relative timestamps for known start, deadline and scheduled announcement times, timezone-equivalence checks, unknown-time handling, and suppression for cancelled giveaways. Actual rendering in a live Discord server remains unverified. The previously built wheel below predates this update; local editable installs use the updated source.

Validated locally on 2026-10-15 (Asia/Taipei), Windows, Python 3.11.9.

| Check | Result |
| --- | --- |
| `ruff check src tests` | Passed |
| `ruff format --check src tests` | Passed; 16 files |
| `pytest -q` | 50 passed |
| `python -m pip check` | No broken requirements |
| `raffleye demo` | Four giveaways, zero pending extractions, zero paid usage |
| Repeated demo | No duplicate giveaway records |
| Wheel build | `dist/raffleye-0.1.0-py3-none-any.whl` produced |
| Wheel contents | Runtime modules and mock fixtures included |
| Project size | Approximately 89 MiB including `.venv`, caches and local artifacts |

Tests cover English and Traditional Chinese labelled extraction, prizes and requirements, UTC offset conversion, fully specified English month dates, future announcements, ambiguous/invalid date handling, fabricated evidence, altered timestamps, terminal lifecycle states, deduplication, revisions, durable pagination, transactional daily/monthly budgets, UTC rollover, watchlist fairness, query-injection rejection, notification retries, stale delivery acknowledgements, X request/response mapping, cooldowns, Apify normalization, structured AI requests/refusals/incomplete responses, fallback, recoverable extraction, authorization checks, Discord message sends/edits, and CLI offline/locking behavior.

One upstream warning remains: discord.py imports Python 3.11's deprecated `audioop` module. RAFFLEYE does not use voice/audio features. The reference Docker runtime is Python 3.11; no claim is made that every newer Python version has been tested.

At the initial October 15 validation, live X, live Apify, paid AI, real Discord registration, Docker and hosted CI were not executed. X and Discord have since been exercised as recorded above. Docker is not installed on this machine. HTTP adapters and Discord send/edit paths were exercised with mocks. These do not prove account permissions, live schema compatibility for every Apify actor, or real-world extraction accuracy.

The container files and CI workflow are supplied for those remaining environment checks. Use the live smoke-test sequence in `OPERATIONS.md` before enabling continuous paid monitoring. No background worker was left running at that initial validation; the current live deployment is recorded above.

## TypeScript migration validation (2026-10-17)

- Strict TypeScript compilation, ESLint and 54 Vitest checks passed. Tests cover existing extraction and date formats; location inference and DST gaps/folds; explicit timezone precedence; budget reservation/cooldown; transactional page staging; runtime lease exclusion; silent delivery pacing and edits; channel permission boundaries; private interaction routing and browse-session isolation.
- All 162 Python reference tests passed, with Ruff lint/format checks.
- Offline TypeScript demo produced four saved qualifying sample offers, no network usage or notifications.
- Compared TypeScript extraction values and legacy content hashes against Python for all 44 cached live posts using a consistent database snapshot: no mismatches. The snapshot retained 34 historical rows (topic filtering hides irrelevant history), one subscription, and no pending deliveries at comparison time.
- A fresh official-X-embed screenshot rendered successfully through TypeScript/Playwright/Edge; visually checked author, post text, media and timestamp with no surrounding page or reply bar.
- Dependency audit after updating Vitest: zero reported vulnerabilities.
- Docker/WSL installation was blocked on this PC; no successful local container build/run is claimed. Remote CI has not run because no remote repository is configured.

## Host-to-server time display (2026-10-17)

59 TypeScript tests now pass, including year/month rollovers, explicit JST precedence, New York summer/winter source conversion versus fixed server clocks, cancelled countdown suppression, and public/private host-location disclosure. Existing Python reference checks also pass. Complete source dates render UTC, JST, Asia/SEA/HMT, Europe, America and Discord-local time as one instant; incomplete dates remain unresolved.

## Linked results regression (2026-10-17)

The cached Slugy_Cs results post 2110020450088812863 explicitly links to original 2109978259664539895. The old implementation retained both raw posts but failed to apply the relationship. Added tests for cached-result reconciliation, results arriving before originals, persistent terminal status on re-extraction, edits to every delivered copy, rejecting unrelated authors/unlinked results, and excluding scheduled announcements/new results posts. 64 TypeScript tests and 162 Python reference tests pass.

## Heads-up option (2026-10-18)

75 TypeScript tests pass, including quick/absolute source times, explicit JST, invalid prize/date/duration/URL rejection, owner/server binding, destination changes, expired previews, duplicate publication claims, persistent records, lifecycle rendering and an interaction-to-send/cancel flow using mocked Discord transport. Publication uses no mentions and the silent flag; no fabricated live announcement was sent. Python reference lint/format and all 162 tests also pass.


## Published heads-up editing and presets (2026-10-18)

77 TypeScript tests and 162 Python tests pass, with strict build/lint and Python formatting checks. Added same-message public editing, preserved past start times for detail corrections, revision-aware refresh, ownership/cancel guards, start/end relative countdowns and all five start-delay presets. Mocked Discord verifies the edit changes the original message without sending another announcement.

Public edit button: mocked public-message clicks verify the publisher receives a private editor and another user receives a private denial. Legacy published cards refresh to add the button without resending the announcement.


Public cancellation and images: 81 TypeScript tests cover publisher-only controls, modal upload serialization, durable image storage, size/host/type validation, official screenshot delegation, unavailable posts, same-message media edits, retained draft images and prominent UTC fields. Python lint/format and all 162 reference tests pass. Existing cards refresh through layout version 2.


## Discord-only raffle and prize catalog (2026-10-18)

88 TypeScript tests and all 162 Python reference tests pass with strict build/lint and formatting checks. Raffle tests cover publication ownership/destination/expiry, unique entries, leave/rejoin, host/bot exclusion, exact deadline closure, uniform-index random selection, saved results across retries/recreation, manual draw ownership, no-entrant results, cancellation and retry after Discord failures. Mocked Discord verifies one announcement is edited and cancellation deletes it. Heads-up cancellation now deletes too. All four LDSHOP image assets were visually inspected; the catalog test copies and validates each durable WebP attachment. No real raffle was published or drawn during validation.


## Giveaway notification reaction roles (2026-10-18)

96 TypeScript tests and 162 Python reference tests pass with strict build/lint and formatting checks. New tests cover notification-only role safety, creator/bot hierarchy, missing Manage Roles, silent panel publication and emoji seeding, duplicate prevention, persisted mapping, uncached gateway add/remove events, bot exclusion, privilege changes after setup, versioned opt-out races, reconciliation after downtime, and panel removal without changing existing member roles. Command schema now includes reactionrole and reactionrole-remove. Live preflight found Beggars already present below RAFFLEYE with no permissions, but RAFFLEYE lacked Manage Roles; user was asked to enable it. No member roles were changed during testing.

Reaction-role wording: 97 TypeScript tests pass, including custom multiline Markdown, modal serialization, persisted title/description, same-message editing without reseeding reactions, and unauthorized/empty edit rejection. Python reference checks pass (162 tests).

Editable giveaway entries and Beggars notifications: 100 TypeScript tests pass, covering private UID/server forms, entrant-bound submissions, correction without duplicate entries, persistence, withdrawal, deadline validation, publisher-only downloads, role mention permissions, new-post-only pings and silent edits/deleted-card recreation. Strict checks pass; Python reference checks pass (162 tests, Ruff checks and format). Live read-only preflight confirms one Beggars role, mentionable=true.

Guided giveaway setup: 104 TypeScript tests pass, including four attached prize gallery images, serialized amount/start/end controls and modals, private single-message setup, ownership and published-draft protection, delayed opening and draw rejection before start, exact Taipei/UTC schedules, invalid ranges and relative timing anchored to publication. Strict lint/build pass; 162 Python reference tests and Ruff checks/format pass.

Monthly private activity reporting: 111 TypeScript tests pass, including enabled-only metadata collection, bot/webhook/channel exclusion, unique participation across edits/withdrawal/rejoin, opt-in reaction exclusion, distinct combined giveaway counts, chat days and coverage, private recipient binding, Manage Server checks, blocked-DM setup, persisted monthly reports, retry pacing/restart deduplication, and 90-day pruning while disabled. Strict checks/build and 162 Python reference tests with Ruff checks/format pass. No real member report or test DM sent during verification; account binding requires the user's Discord enable command.

Community-first giveaway wording and limited-chat review: hosted raffle/heads-up embeds now carry the welcoming no-spam expectation. Monthly reports separately include repeat participants with 1–2 observed messages alongside the existing zero-chat group, with chat-day counts and human-review wording. Existing report test verifies the separate low_chat signal; 111 TypeScript tests, strict lint/build and 162 Python reference tests with Ruff pass. Eligibility and draw behavior unchanged.

Removed the public community reminder from hosted giveaway embeds at the user's request. Private activity reports and review flags are unchanged. 111 TypeScript tests, strict lint/build and 162 Python tests plus Ruff checks/format pass.

Multi-winner draw support for the requested three 3,280-Lunite prizes: 112 TypeScript tests pass, including sampling distinct winners without replacement, storing all winners before delivery, restart reuse, smaller entrant pools and invalid winner counts. Private submissions export includes the complete winner list. Strict lint/build and 162 Python reference tests with Ruff pass.

Unified creation UI: 112 TypeScript tests pass, including pictured prize selection opening a three-field name/quantity/description modal, persistence of three winners and selected image, incomplete-draft publish rejection, owner/published-draft protections and participant UID then Server ordering. Main and former heads-up creation routes use the same entry-giveaway creator; legacy published announcements remain manageable. Strict checks/build and 162 Python tests plus Ruff pass.

Private winner details: completed results now expose a Winner info button, including existing posts via control-version refresh. Publisher-only ephemeral replies show all winner UID/server details; unauthorized users and other guilds cannot retrieve them. Public embeds remain free of entry details. 113 TypeScript tests pass including real interaction privacy routing; strict checks/build and 162 Python reference tests plus Ruff pass. Live read-only verification confirmed all three current winners have stored entry details.
