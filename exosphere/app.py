"""The website: a small JSON API and the static front end.

It binds to loopback and is reached through Tailscale, so there is no login. Writes
check Origin so that a page elsewhere can't drive it from the same browser.
"""

import asyncio
import contextlib
import logging
from pathlib import Path
from urllib.parse import urlsplit

from starlette.applications import Starlette
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import config
from .db import Store
from .offline import offline_urls
from .poller import Poller
from .source import Blocked, RateLimited, Source, as_handle

STATIC = Path(__file__).parent / "static"
PAGE = 30
CSP = (
    "default-src 'self'; img-src 'self' https://pbs.twimg.com; "
    "media-src https://video.twimg.com; style-src 'self'; script-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


def error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": message}, status)


def same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    return origin is None or urlsplit(origin).netloc == request.headers.get("host")


def own_only(request: Request) -> bool:
    return request.query_params.get("only") == "posts"


async def index(request: Request) -> Response:
    return FileResponse(STATIC / "index.html")


async def state(request: Request) -> Response:
    app = request.app.state
    account = await app.source.account()
    status = app.poller.state if account["state"] == "ok" else account["state"]
    return JSONResponse(
        {
            "status": status,
            "last_ok": app.poller.last_ok,
            "creators": app.store.creators(own_only(request)),
            "seen": app.store.seen(),
        }
    )


async def feed(request: Request) -> Response:
    """Default: what's new since you last checked, all of it, and nothing else.
    With `creator` or `before`: one page of history. `only=posts` drops replies and reposts."""
    store = request.app.state.store
    own = own_only(request)
    creator, before = request.query_params.get("creator"), request.query_params.get("before")
    if creator is None and before is None:
        posts = store.new_posts(own_only=own)
        return JSONResponse({"posts": posts, "more": bool(store.history(1, own_only=own))})
    cursor = None
    if before:
        at, _, id = before.partition(":")
        if not at.isdigit() or not id.isdigit():
            return error("Bad cursor", 400)
        cursor = (int(at), id)
    posts = store.history(PAGE + 1, creator, cursor, own)
    return JSONResponse({"posts": posts[:PAGE], "more": len(posts) > PAGE})


async def add_creator(request: Request) -> Response:
    app = request.app.state
    try:
        body = await request.json()
    except ValueError:
        return error("Bad request", 400)
    query = str(body.get("query", "")).strip()[:100] if isinstance(body, dict) else ""
    if not query:
        return error("Enter a name", 400)
    try:
        found = await app.source.find(query)
    except Blocked:
        return error("No X account", 503)
    except RateLimited:
        return error("X says wait. Try again soon", 429)
    except Exception:
        logging.exception("lookup failed")
        return error("Search failed. Try their @handle", 502)
    if not found:
        return error("Nobody found. Try their @handle", 404)
    # Only an exact @handle follows straight away. Anything else is a guess, so ask.
    handle = (as_handle(query) or "").lower()
    person = next((p for p in found if p.handle.lower() == handle), None)
    if person is None:
        return JSONResponse({"matches": [vars(p) for p in found]})
    app.store.add_creator(person.id, person.handle, person.name, person.avatar, person.protected)
    app.poller.nudge()
    return JSONResponse({"added": vars(person)})


async def remove_creator(request: Request) -> Response:
    request.app.state.store.remove_creator(request.path_params["id"])
    return Response(status_code=204)


async def seen(request: Request) -> Response:
    try:
        until = int((await request.json())["until"])
    except (ValueError, KeyError, TypeError):
        return error("Bad request", 400)
    request.app.state.store.mark_seen(until)
    return Response(status_code=204)


async def offline(request: Request) -> Response:
    """One URL per line, so the app can read it without a JSON parser in its sync."""
    return PlainTextResponse("\n".join(offline_urls(request.app.state.store, STATIC, PAGE)))


class Guard:
    """Refuses cross-site writes and sets security headers on every response."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        if request.method not in ("GET", "HEAD") and not same_origin(request):
            return await error("Forbidden", 403)(scope, receive, send)

        async def with_headers(message):
            if message["type"] == "http.response.start":
                message["headers"] += [
                    (b"content-security-policy", CSP.encode()),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-content-type-options", b"nosniff"),
                ]
            await send(message)

        await self.app(scope, receive, with_headers)


def create_app(store: Store | None = None, source=None, poll: bool = True) -> Starlette:
    @contextlib.asynccontextmanager
    async def lifespan(app):
        config.DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        app.state.store = store or Store(config.DB_PATH)
        app.state.source = source or Source(config.ACCOUNTS_PATH)
        app.state.poller = Poller(app.state.store, app.state.source)
        task = asyncio.create_task(app.state.poller.run()) if poll else None
        yield
        if task:
            task.cancel()

    app = Starlette(
        routes=[
            Route("/", index),
            Route("/api/state", state),
            Route("/api/feed", feed),
            Route("/api/creators", add_creator, methods=["POST"]),
            Route("/api/creators/{id}", remove_creator, methods=["DELETE"]),
            Route("/api/seen", seen, methods=["POST"]),
            Route("/api/offline", offline),
            Mount("/static", StaticFiles(directory=STATIC)),
        ],
        lifespan=lifespan,
    )
    app.add_middleware(Guard)
    app.add_middleware(GZipMiddleware)  # the phone is often on mobile data, and JSON shrinks to a quarter
    return app
