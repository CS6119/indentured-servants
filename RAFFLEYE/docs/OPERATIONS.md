# Operations

## Start and stop

Run `raffleye bot` for Discord plus ingestion, or `raffleye worker` for ingestion alone. Ctrl+C stops local operation. Compose sends termination signals through an init process. SQLite transactions and the outbox survive restart. One process owns a database; a second writer exits rather than running overlapping schedules. Do not put SQLite on a network share.

Use `raffleye status` without stopping the worker. `raffleye health` checks recent scheduler heartbeat; it is a liveness check, not proof of upstream access or successful delivery. Inspect `query_errors`, pending/quarantined extractions and pending/failed notifications as well.

## Failures and recovery

| Symptom | Behavior and response |
| --- | --- |
| X 401/402/403 | One-hour persisted cooldown; verify token, billing and access. No automatic fallback. |
| X 429 | Persisted cooldown using reset/retry headers; reduce watchlist or cadence. |
| X network/5xx | Delay and optional authorized Apify fallback; official cursor retained. |
| Partial or invalid provider page | Cursor does not advance. Fix adapter/export contract. |
| Budget exhausted | No network request; retry on later cycles subject to UTC reset. Do not reset the database. |
| AI refusal/schema failure | Raw post retained; up to five delayed attempts, then quarantine. |
| Discord missing permissions | Exponential retry, up to eight attempts; repair permissions then `/raffleye retry`. |
| Discord message deleted | Recreate nonterminal records only; discard terminal notification jobs. |
| Expired X paging window | Restart within recent retention; store a coverage warning. Lost historical coverage is not reconstructed. |

`raffleye retry` is available while the main worker is stopped; the slash command works while the bot runs. Retrying never bypasses budget checks. Logs contain error types/codes, not tokens or full post bodies. Query errors include no raw HTTP response body.

## Backups and storage

For a simple consistent backup, stop the bot and copy the database together with any existing `-wal` and `-shm` files, or use SQLite's online backup API. Preserve the whole data directory when moving installations. Validate a restore in a separate offline location first. Restoring an old backup also restores old budget counters; reconcile usage before resuming paid providers.

Version 0.1 retains posts indefinitely. Monitor the data directory and log volume. There is no automatic pruning or X deletion-compliance feed yet; set an operating retention policy before a wider launch. Stop the service for manual maintenance and preserve records needed to avoid duplicate notifications. Check provider terms and your permissions for storing and redistributing content. The bot does not fetch destination websites.

## Live smoke test

1. Keep the default fixture demo isolated from the live database.
2. Configure low request/post caps and conservative cost reserves from your actual provider plan.
3. Enable X, run one cycle, and verify an official post's text/author/link against the database output.
4. Test AI on a small batch; inspect prize, winner count, restrictions, sponsor evidence and times. Ambiguous values must stay unknown.
5. Start the Discord bot in the configured test server, subscribe a channel, and confirm message creation and subsequent edits.
6. Test Apify with an authorized, append-only dataset using the documented contract; it cannot create data by itself.
7. Inspect provider billing dashboards and adjust reserves before expanding cadence or watchlists.

Nothing in the local automated validation spends API credits or sends Discord messages.

## Current local deployment

The approved local estimated-spend caps are US$5 per UTC day and US$50 per UTC month. Live X uses ten posts per request with a conservative US$0.20 reservation, including possible author expansions. The smoke request is included in the same persistent counters. These reservations are local accounting, not the provider invoice or an X dashboard cap. Rules extraction incurs no AI charges.

Live state is `data/live.sqlite3`; prior sample state is retained separately. The hidden Windows process metadata is `data/bot-process.json`. The bot runs while this computer and process remain on; no Windows startup task has been installed. Preserve counters and paging state during restarts.

Catch-up defaults to six days and is repeated daily after scans complete. A broad global query may exceed budget before all pages are read. Narrow the global query or prioritize specific accounts when coverage matters. Older active posts require full-archive mode and a longer configured window; unknown deadlines cannot establish that a giveaway is still running.

The current feed is Wuthering Waves only (`RAFFLEYE_GIVEAWAY_TOPIC=wuwa`). Topic restrictions apply to global and watched-account searches plus local extraction and all Discord delivery/list/show paths. Changing topic invalidates incompatible paging cursors while preserving spent-budget counters. Unrelated historical data is retained locally for audit but hidden from Discord commands.

New cards are paced one per channel every 300 seconds and use Discord silent delivery. The timer survives restart; failed sends do not consume a slot, and existing message edits can proceed. Account profile names and descriptions are returned with X search expansions. A profile mentioning both Wuwa and giveaways qualifies for automatic watching (maximum five, hourly base interval); ordinary posts are still rejected. Bio-only accounts can be discovered after the bot encounters them in search, not by an exhaustive directory search.

Post screenshots use the official public X embed and are stored under `data/post-screenshots`. No browser account profile or cookies are loaded. An unsuccessful render is retried after an hour and the card retains its prominent original-post link. Old screenshots are not recaptured merely for lifecycle/status changes. Remove a specific cached PNG while stopped only when you intentionally need a fresh visual. Attach Files permission is required. Local Windows uses installed Edge; Docker uses bundled Chromium and needs the browser channel left empty.

Discord cards include persistent Details and Help buttons. These open private menus and perform no paid lookups or giveaway entry actions. The public buttons survive restarts; private menus expire after ten minutes and can be reopened from the card. `/raffleye help` covers all commands and their permission requirements, and `/raffleye status` uses the readable status panel. Help uses clickable command references after successful guild command synchronization. Management permissions remain enforced on the actual commands.

## TypeScript migration (2026-10-17)

Production entrypoint is now `node dist/cli.js bot`. Use README instructions for current local release/deployment operations; earlier Python command examples in this document describe the retained reference implementation.

The native watcher deploys validated committed snapshots, backs up SQLite while the bot is stopped, checks candidate health by PID, and restores the prior code release on startup failure. `.deploy/active.json` records the active commit. Logs and backups stay local and contain no credential dumps. Do not restore a database backup merely to roll back code, since that could rewind budgets and delivery records. The Python reference cannot directly read newly added profile-location fields; use TypeScript releases for normal rollback.

Profile timezone inference uses the public X user `location` field requested with search expansions. Missing locations in old cached posts remain missing until X returns those posts again. No extra account-lookup call is required. Country/city mappings must resolve to one IANA zone; DST ambiguity rejects the conversion. Full date and clock are still required.
