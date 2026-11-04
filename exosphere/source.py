"""The only module that talks to X."""

import re
from dataclasses import dataclass

from . import config  # noqa: F401  (turns off twscrape telemetry before the import below)
from twscrape import API, NoAccountError

from .normalize import avatar, post

HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
PROFILE_URL = re.compile(r"(?:twitter|x)\.com/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)", re.I)


class Blocked(Exception):
    """No usable burner: none added, or X has shut the one we had."""


class RateLimited(Exception):
    """The burner is fine but X wants us to wait."""


@dataclass
class Profile:
    id: str
    handle: str
    name: str
    avatar: str
    protected: bool


def as_handle(query: str) -> str | None:
    """A handle if the query is one (`jack`, `@jack`, a profile URL), otherwise None."""
    query = query.strip()
    if match := PROFILE_URL.search(query):
        return match.group(1)
    query = query.removeprefix("@")
    return query if HANDLE.match(query) else None


def profile(user) -> Profile:
    return Profile(str(user.id), user.username, user.displayname, avatar(user.profileImageUrl), bool(user.protected))


class Source:
    def __init__(self, accounts_path):
        self.api = API(str(accounts_path), raise_when_no_account=True)

    async def _no_account(self) -> Exception:
        accounts = await self.api.pool.accounts_info()
        if any(a["active"] for a in accounts):
            return RateLimited()
        return Blocked(accounts[0]["error_msg"] if accounts else "No account")

    async def account(self) -> dict:
        accounts = await self.api.pool.accounts_info()
        if not accounts:
            return {"state": "none"}
        live = [a for a in accounts if a["active"]]
        return {"state": "ok" if live else "blocked", "username": (live or accounts)[0]["username"]}

    async def find(self, query: str) -> list[Profile]:
        """Best matches for a name or handle. An exact handle wins outright. Searching by
        name needs a phone-verified account, so it can fail where a handle works."""
        try:
            if handle := as_handle(query):
                if user := await self.api.user_by_login(handle):
                    return [profile(user)]
            return [profile(u) async for u in self.api.search_user(query.strip(), limit=5)][:5]
        except NoAccountError:
            raise await self._no_account()

    async def timeline(self, creator_id: str, limit: int) -> list[dict]:
        """A creator's own posts, replies and reposts, newest first."""
        try:
            tweets = [t async for t in self.api.user_tweets_and_replies(int(creator_id), limit=limit)]
        except NoAccountError:
            raise await self._no_account()
        batch = {t.id: t for t in tweets}
        # The response also holds other people's posts (quotes, reply parents).
        return [post(t, batch) for t in tweets if str(t.user.id) == str(creator_id)]
