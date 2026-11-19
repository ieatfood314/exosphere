"""A public, read-only copy of the feed, hosted elsewhere (see `mirror/`).

This side only reads. It opens the database read-only, never touches X or the burner, and
sends one snapshot to the mirror, which has no way to reach back. The mirror keeps every
visitor's read position in their own browser, so nobody there can move yours.
"""

import hashlib
import json
import sqlite3
import time
import urllib.request
from pathlib import Path

# The mirror's host stores at most 1 MiB, so send the newest posts that fit in this.
MAX_BYTES = 640 * 1024
KEEP_EACH = 10


def snapshot(db_path: Path | str, max_bytes: int = MAX_BYTES) -> str:
    """The creators and as many of the newest posts as fit, newest first, as ASCII-only JSON."""
    db = sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        creators = [
            {
                "id": r["id"],
                "handle": r["handle"],
                "name": r["name"],
                "avatar": r["avatar"],
                "protected": bool(r["protected"]),
                "polled_at": r["polled_at"],
                "error": "Fetch failed" if r["poll_error"] else None,  # the reason stays here
            }
            for r in db.execute("SELECT * FROM creators ORDER BY lower(name)")
        ]
        rows = db.execute(
            """SELECT p.data, p.fetched_at, p.backfill, p.creator_id FROM posts p
               JOIN creators c ON c.id = p.creator_id ORDER BY p.at DESC, p.id DESC"""
        )
        items = [
            ({**json.loads(r["data"]), "fetched_at": r["fetched_at"], "backfill": bool(r["backfill"]), "cid": r["creator_id"]})
            for r in rows
        ]
    finally:
        db.close()
    head = {"pushed_at": int(time.time()), "creators": creators}
    budget = max_bytes - len(json.dumps(head)) - 16
    # Everyone keeps their newest few, so one busy account can't push the quiet ones out.
    per_creator = {}
    for i, item in enumerate(items):
        per_creator.setdefault(item["cid"], []).append(i)
    reserved = [i for ids in per_creator.values() for i in ids[:KEEP_EACH]]
    taken = set()
    for i in reserved + list(range(len(items))):
        if i in taken:
            continue
        size = len(json.dumps(items[i])) + 1
        if size > budget:
            if i in reserved:
                continue
            break
        taken.add(i)
        budget -= size
    posts = [items[i] for i in sorted(taken)]
    return json.dumps({**head, "posts": posts}, separators=(",", ":"))


def push(url: str, secret: str, body: str, timeout: int = 60) -> dict:
    request = urllib.request.Request(
        url.rstrip("/") + "/api/mirror",
        data=body.encode("ascii"),
        method="POST",
        headers={
            "authorization": f"Bearer {secret}",
            "content-type": "application/json",
            "user-agent": "exosphere-mirror",
            "x-snapshot-sha256": hashlib.sha256(body.encode()).hexdigest(),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")
