"""What the Android app keeps for reading offline, as a list of URLs.

It lives here so the app needs no idea how paging works. The answer comes from SQLite only,
so a sync costs nothing on X.
"""

from pathlib import Path

from .db import Store

NEWEST = (2**40, "9")  # a cursor above every post, the same one the site uses
PAGES_OF_EVERYONE = 10
PAGES_PER_PERSON = 3


def embedded(post: dict) -> list[dict]:
    """The post itself and any shown inside it."""
    parent = (post.get("reply_to") or {}).get("post")
    found = [post]
    for inner in (post.get("repost"), post.get("quote"), parent):
        if inner:
            found += embedded(inner)
    return found


def media_of(post: dict) -> list[str]:
    urls = []
    for item in embedded(post):
        urls.append((item.get("creator") or item.get("author") or {}).get("avatar"))
        for media in item.get("media") or []:
            urls += [media.get("poster"), media["url"]]
    return [url for url in urls if url]


def feed_url(creator: str | None, before: tuple[int, str] | None, own: bool) -> str:
    """In the order the site builds its requests, so a saved page is found under the same URL."""
    params = []
    if creator:
        params.append(f"creator={creator}")
    if before:
        params.append(f"before={before[0]}:{before[1]}")
    if own:
        params.append("only=posts")
    return "/api/feed" + ("?" + "&".join(params) if params else "")


def walk(store: Store, page: int, pages: int, creator: str | None, own: bool, first: tuple | None):
    """The pages of history a reader would step through, as (url, posts)."""
    cursor = None
    for _ in range(pages):
        posts = store.history(page + 1, creator, cursor, own)
        yield feed_url(creator, cursor or first, own), posts[:page]
        if len(posts) <= page:
            return
        cursor = (posts[page - 1]["at"], posts[page - 1]["id"])


def offline_urls(store: Store, static: Path, page: int) -> list[str]:
    """Pages first, because they're small and what matters most. Media comes after, newest
    first, since the app stops when it runs out of room."""
    pages = ["/"]
    pages += [f"/static/{p.relative_to(static).as_posix()}" for p in sorted(static.rglob("*")) if p.is_file() and p.suffix != ".txt"]
    creators = store.creators()
    media = [creator["avatar"] for creator in creators]
    for own in (False, True):
        pages += ["/api/state?only=posts" if own else "/api/state", feed_url(None, None, own)]
        media += [url for post in store.new_posts(own_only=own) for url in media_of(post)]
        histories = [walk(store, page, PAGES_OF_EVERYONE, None, own, NEWEST)]  # the All page opens on NEWEST
        histories += [walk(store, page, PAGES_PER_PERSON, creator["id"], own, None) for creator in creators]
        for history in histories:
            for url, posts in history:
                pages.append(url)
                media += [url for post in posts for url in media_of(post)]
    return list(dict.fromkeys(pages + [url for url in media if url]))
