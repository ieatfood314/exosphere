"""`exosphere serve` runs the site. `exosphere account` manages the burner."""

import argparse
import asyncio
import json
import logging
import sys

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


def main() -> None:
    parser = argparse.ArgumentParser(prog="exosphere")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    add = commands.add_parser("account", help="list accounts, or add one with cookies as JSON on stdin")
    add.add_argument("username", nargs="?")
    args = parser.parse_args()
    if args.command == "serve":
        serve()
    else:
        asyncio.run(account(args))
