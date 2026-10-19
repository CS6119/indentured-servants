import argparse
import asyncio
import json
import logging
import signal
from pathlib import Path

import httpx
from filelock import FileLock, Timeout

from .config import Settings
from .discord_bot import RaffleyeBot, giveaway_embed
from .models import utcnow
from .service import Service
from .storage import Store


async def run(args, settings):
    store = Store(settings.db_path)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45), follow_redirects=False) as client:
            service = Service(store, settings, client) if args.command not in ("status", "health") else None
            if args.command in ("once", "demo"):
                await service.tick()
                print(json.dumps(store.status(), indent=2))
                if args.command == "demo":
                    destination = settings.db_path.parent / "demo-embeds.json"
                    destination.write_text(
                        json.dumps(
                            [giveaway_embed(row).to_dict() for row in store.list_giveaways(25)],
                            indent=2,
                            ensure_ascii=False,
                        ),
                        encoding="utf-8",
                    )
                    print(f"Discord embed preview: {destination.resolve()}")
            elif args.command == "status":
                print(json.dumps(store.status(), indent=2))
            elif args.command == "watch":
                store.watch(args.handle, args.priority)
                print("Watchlist updated.")
            elif args.command == "retry":
                store.retry_failed()
                print("Failed jobs queued.")
            elif args.command == "worker":
                stop = asyncio.Event()
                loop = asyncio.get_running_loop()
                for sig in (signal.SIGINT, signal.SIGTERM):
                    try:
                        loop.add_signal_handler(sig, stop.set)
                    except NotImplementedError:
                        pass  # Windows console cancellation is handled by asyncio.run.
                await service.run(stop)
            elif args.command == "bot":
                if not settings.discord_token.get_secret_value() or not settings.discord_guild_id:
                    raise ValueError("Set RAFFLEYE_DISCORD_TOKEN and RAFFLEYE_DISCORD_GUILD_ID first")
                async with RaffleyeBot(service) as bot:
                    await bot.start(settings.discord_token.get_secret_value())
            elif args.command == "health":
                last = store.get_meta("last_progress") or store.get_meta("last_tick")
                from .models import aware

                if not last or (utcnow() - aware(last)).total_seconds() > settings.poll_seconds * 3 + 120:
                    raise ValueError("Worker heartbeat is stale")
                print("Worker heartbeat is fresh")
    finally:
        store.close()


def main():
    parser = argparse.ArgumentParser(prog="raffleye")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("demo", "once", "worker", "bot", "status", "retry", "health"):
        sub.add_parser(name)
    watch = sub.add_parser("watch")
    watch.add_argument("handle")
    watch.add_argument("--priority", type=int, choices=(1, 2, 3), default=2)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        # Demo always overrides environment and credentials, and uses a separate database.
        settings = (
            Settings(
                _env_file=None,
                source="mock",
                extractor="rules",
                apify_fallback=False,
                db_path=Path("data/demo.sqlite3"),
            )
            if args.command == "demo"
            else Settings()
        )
        settings.db_path.parent.mkdir(parents=True, exist_ok=True)
        if args.command in ("health", "status"):
            asyncio.run(run(args, settings))
        else:
            with FileLock(str(settings.db_path) + ".lock", timeout=0):
                asyncio.run(run(args, settings))
    except Timeout:
        parser.exit(1, "Another RAFFLEYE process is using this database. Run one worker per database.\n")
    except (ValueError, KeyboardInterrupt) as exc:
        # Pydantic errors may contain input values: don't print them, which could expose secrets.
        from pydantic import ValidationError

        message = (
            "Invalid configuration. Check .env.example and required live-provider fields."
            if isinstance(exc, ValidationError)
            else str(exc)
        )
        parser.exit(1, message + "\n")


if __name__ == "__main__":
    main()
