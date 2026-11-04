"""SQLite storage. One small file; calls are quick enough to make inline."""

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    protected INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    polled_at INTEGER NOT NULL DEFAULT 0,
    poll_error TEXT
);
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    backfill INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_at ON posts(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS posts_creator_at ON posts(creator_id, at DESC, id DESC);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

FIRST_VISIT_WINDOW = 24 * 3600

# New means fetched since the last read-through. A creator's first fetch is history,
# so only its last day counts, which keeps a new follow from flooding the feed.
NEW_WHERE = "p.fetched_at > :seen AND (p.backfill = 0 OR p.at > :recent)"


class Store:
    def __init__(self, path: Path | str):
        self.db = sqlite3.connect(path, check_same_thread=False)  # all access is on the event loop
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)

    # creators

    def add_creator(self, id: str, handle: str, name: str, avatar: str, protected: bool) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO creators (id, handle, name, avatar, protected, added_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, name = excluded.name,
                       avatar = excluded.avatar, protected = excluded.protected""",
                (id, handle, name, avatar, int(protected), int(time.time())),
            )

    def remove_creator(self, id: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM creators WHERE id = ?", (id,))

    def creator(self, id: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM creators WHERE id = ?", (id,)).fetchone()

    def next_due(self) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM creators ORDER BY polled_at, added_at LIMIT 1").fetchone()

    def creator_count(self) -> int:
        return self.db.execute("SELECT count(*) FROM creators").fetchone()[0]

    def mark_polled(self, id: str, error: str | None = None) -> None:
        with self.db:
            self.db.execute(
                "UPDATE creators SET polled_at = ?, poll_error = ? WHERE id = ?",
                (int(time.time()), error, id),
            )

    def creators(self) -> list[dict]:
        rows = self.db.execute(
            f"""SELECT c.*, count(p.id) AS posts, max(p.at) AS latest,
                       coalesce(sum({NEW_WHERE}), 0) AS new
                FROM creators c LEFT JOIN posts p ON p.creator_id = c.id
                GROUP BY c.id ORDER BY lower(c.name)""",
            self._new_args(),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "handle": r["handle"],
                "name": r["name"],
                "avatar": r["avatar"],
                "protected": bool(r["protected"]),
                "posts": r["posts"],
                "latest": r["latest"],
                "new": r["new"],
                "polled_at": r["polled_at"],
                "error": r["poll_error"],
            }
            for r in rows
        ]

    # posts

    def known_ids(self, ids: list[str]) -> set[str]:
        marks = ",".join("?" * len(ids))
        rows = self.db.execute(f"SELECT id FROM posts WHERE id IN ({marks})", ids)
        return {r["id"] for r in rows}

    def save_posts(self, creator_id: str, posts: list[dict], backfill: bool) -> int:
        now = int(time.time())
        with self.db:
            cursor = self.db.executemany(
                """INSERT OR IGNORE INTO posts (id, creator_id, at, fetched_at, backfill, data)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                [(p["id"], creator_id, p["at"], now, int(backfill), json.dumps(p)) for p in posts],
            )
        return cursor.rowcount

    def _rows(self, where: str, args: dict, limit: int) -> list[dict]:
        rows = self.db.execute(
            f"""SELECT p.data, p.fetched_at, c.id AS cid, c.handle, c.name, c.avatar
                FROM posts p JOIN creators c ON c.id = p.creator_id
                WHERE {where} ORDER BY p.at DESC, p.id DESC LIMIT :limit""",
            {**args, "limit": limit},
        ).fetchall()
        return [
            {
                **json.loads(r["data"]),
                "fetched_at": r["fetched_at"],
                "creator": {"id": r["cid"], "handle": r["handle"], "name": r["name"], "avatar": r["avatar"]},
            }
            for r in rows
        ]

    def new_posts(self, limit: int = 500) -> list[dict]:
        return self._rows(NEW_WHERE, self._new_args(), limit)

    def history(self, limit: int, creator: str | None = None, before: tuple[int, str] | None = None) -> list[dict]:
        """Everything, newest first. `before` is the (at, id) of the last post shown."""
        where, args = ["1"], {}
        if creator:
            where.append("p.creator_id = :creator")
            args["creator"] = creator
        if before:
            where.append("(p.at, p.id) < (:at, :id)")
            args |= {"at": before[0], "id": before[1]}
        return self._rows(" AND ".join(where), args, limit)

    # read position

    def seen(self) -> int:
        row = self.db.execute("SELECT value FROM meta WHERE key = 'seen'").fetchone()
        return int(row["value"]) if row else 0

    def mark_seen(self, until: int) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO meta (key, value) VALUES ('seen', :v)
                   ON CONFLICT(key) DO UPDATE SET value = max(CAST(value AS INTEGER), :v)""",
                {"v": until},
            )

    def _new_args(self) -> dict:
        return {"seen": self.seen(), "recent": int(time.time()) - FIRST_VISIT_WINDOW}
