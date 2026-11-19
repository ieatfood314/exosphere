"""`exosphere serve` runs the site. `exosphere account` manages the burner. `exosphere mirror`
sends a read-only copy of the feed to the public mirror."""

import argparse
import asyncio
import json
import logging
import sys
import time

from . import config


def serve() -> None:
    import uvicorn

    from .app import create_app

    logging.basicConfig(level=logging.INFO, format="%(name)s %(message)s")
    uvicorn.run(create_app(), host=config.HOST, port=config.PORT, log_level="warning")


async def account(args) -> None:
    from .source import Source

    config.DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = Source(config.ACCOUNTS_PATH)
    if args.username:
        # Cookies come in on stdin so they stay out of shell history and `ps`.
        cookies = json.loads(sys.stdin.read())
        await source.api.pool.add_account_cookies(args.username, json.dumps(cookies))
        config.ACCOUNTS_PATH.chmod(0o600)
    for item in await source.api.pool.accounts_info():
        print(item["username"], "active" if item["active"] else f"inactive: {item['error_msg']}")


def mirror(args) -> None:
    import hashlib

    from .mirror import push, snapshot

    if not config.MIRROR_URL:
        sys.exit("Set EXOSPHERE_MIRROR_URL")
    body = snapshot(config.DB_PATH)
    if args.dry_run:
        print(f"{len(body)} bytes, {len(json.loads(body)['posts'])} posts")
        return
    # Only send what changed: every push spends a write from the mirror's small daily quota.
    digest = hashlib.sha256(body.split(",", 1)[1].encode()).hexdigest()  # pushed_at comes first
    last = config.MIRROR_STATE / "last"
    if not args.force and last.exists() and last.read_text() == digest:
        stamp = config.MIRROR_STATE / "stamped"
        if stamp.exists() and time.time() - stamp.stat().st_mtime < config.MIRROR_HEARTBEAT:
            return
    secret = config.MIRROR_SECRET_FILE.read_text().strip()
    print(push(config.MIRROR_URL, secret, body))
    config.MIRROR_STATE.mkdir(parents=True, exist_ok=True)
    last.write_text(digest)
    (config.MIRROR_STATE / "stamped").touch()


def main() -> None:
    parser = argparse.ArgumentParser(prog="exosphere")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    add = commands.add_parser("account", help="list accounts, or add one with cookies as JSON on stdin")
    add.add_argument("username", nargs="?")
    send = commands.add_parser("mirror", help="send the feed to the public mirror, if it changed")
    send.add_argument("--dry-run", action="store_true", help="build the snapshot and print its size")
    send.add_argument("--force", action="store_true", help="send even if nothing changed")
    args = parser.parse_args()
    if args.command == "serve":
        serve()
    elif args.command == "mirror":
        mirror(args)
    else:
        asyncio.run(account(args))
