"""Background loop: one creator at a time, slowly, for as long as the app runs."""

import asyncio
import contextlib
import logging
import random
import time
import urllib.request

from . import config
from .db import Store
from .source import Blocked, RateLimited

log = logging.getLogger("exosphere.poller")


class Poller:
    def __init__(self, store: Store, source):
        self.store = store
        self.source = source
        self.state = "starting"  # ok | waiting | blocked | none
        self.last_ok = 0
        self.wake = asyncio.Event()

    def nudge(self) -> None:
        """Someone was just added: fetch them now, unless X has told us to wait."""
        if self.state != "waiting":
            self.wake.set()

    def gap(self) -> float:
        """Seconds between requests, jittered so the pattern isn't a metronome."""
        count = max(self.store.creator_count(), 1)
        base = max(config.CYCLE_MINUTES * 60 / count, config.MIN_GAP_SECONDS)
        return base * random.uniform(0.8, 1.2)

    async def poll(self, creator) -> int:
        """Fetch one creator and store what's new. Returns how many posts were added."""
        first = creator["polled_at"] == 0
        posts = await self.source.timeline(creator["id"], config.FIRST_FETCH if first else config.POLL_FETCH)
        if posts and not first and not self.store.known_ids([p["id"] for p in posts]):
            # Nothing overlaps what we have, so there may be a gap. Look further back.
            posts = await self.source.timeline(creator["id"], config.GAP_FETCH)
        added = self.store.save_posts(creator["id"], posts, backfill=first) if posts else 0
        self.store.mark_polled(creator["id"])
        return added

    def _set_state(self, state: str) -> None:
        if state == "blocked" and self.state != "blocked":
            self._notify("Burner X account stopped working")
        self.state = state

    def _notify(self, message: str) -> None:
        if not config.NTFY_URL:
            return
        try:
            request = urllib.request.Request(
                config.NTFY_URL, message.encode(), {"Title": "exosphere", "Tags": "warning"}
            )
            urllib.request.urlopen(request, timeout=10).close()
        except OSError:
            log.warning("ntfy failed")

    async def tick(self) -> float:
        """Do one unit of work and return how long to sleep."""
        creator = self.store.next_due()
        if creator is None:
            return 30
        account = await self.source.account()
        if account["state"] != "ok":
            self._set_state(account["state"])
            return 60
        wait = creator["polled_at"] + config.CYCLE_MINUTES * 60 - time.time()
        if creator["polled_at"] and wait > 0:
            return min(wait, 60)  # also how quickly a newly added creator gets picked up
        try:
            added = await self.poll(creator)
        except RateLimited:
            self._set_state("waiting")
            return config.RATE_LIMIT_BACKOFF_SECONDS
        except Blocked as error:
            log.warning("blocked: %s", error)
            self._set_state("blocked")
            return 300
        except Exception as error:  # one bad creator must not stop the rest
            log.exception("poll failed for %s", creator["handle"])
            self.store.mark_polled(creator["id"], str(error)[:200])
            return self.gap()
        log.info("%s: %d new", creator["handle"], added)
        self.last_ok = int(time.time())
        self._set_state("ok")
        return self.gap()

    async def run(self) -> None:
        while True:
            try:
                delay = await self.tick()
            except Exception:
                log.exception("tick failed")
                delay = 60
            self.wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.wake.wait(), delay)
