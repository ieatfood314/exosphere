import json
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from exosphere import config
from exosphere.app import create_app
from exosphere.db import Store
from exosphere.normalize import post
from exosphere.poller import Poller
from exosphere.source import Blocked, Profile, RateLimited, Source, as_handle
from twscrape.models import parse_tweets

FIXTURE = Path(__file__).parent / "fixtures/raw_user_tweets_and_replies.json"
XDEV = "2244994945"


@pytest.fixture(scope="module")
def tweets():
    return list(parse_tweets(json.loads(FIXTURE.read_text())))


def make(id, at=None, **extra):
    return {"id": str(id), "url": "u", "at": at or int(time.time()), "kind": "post", "text": "t", "media": [], **extra}


class FakeSource:
    def __init__(self):
        self.calls, self.pages, self.fail, self.found, self.state = [], [], None, [], "ok"

    async def account(self):
        return {"state": self.state}

    async def find(self, query):
        if self.fail:
            raise self.fail
        return self.found

    async def timeline(self, creator_id, limit):
        self.calls.append((creator_id, limit))
        if self.fail:
            raise self.fail
        return self.pages.pop(0) if self.pages else []


@pytest.fixture
def store(tmp_path):
    store = Store(tmp_path / "t.db")
    store.add_creator("1", "a", "Ann", "", False)
    return store


# normalize


def test_batch_holds_other_people_and_own_posts_are_separable(tweets):
    own = [t for t in tweets if str(t.user.id) == XDEV]
    assert own and len(own) < len(tweets)


def test_reply_hides_leading_mentions(tweets):
    reply = next(t for t in tweets if t.id == 2107953088623747102)
    data = post(reply, {t.id: t for t in tweets})
    assert data["kind"] == "reply" and data["text"] == "🚀"
    assert data["reply_to"]["handle"] == "pjvann"


def test_repost_keeps_full_original_text(tweets):
    repost = next(t for t in tweets if t.retweetedTweet)
    data = post(repost, {})
    assert data["kind"] == "repost" and data["text"] == ""
    assert not data["repost"]["text"].startswith("RT @")
    assert data["repost"]["author"]["handle"] == repost.retweetedTweet.user.username


def test_links_expanded_and_media_links_removed(tweets):
    for tweet in tweets:
        data = post(tweet, {})
        assert "t.co/" not in data["text"]
        assert "&amp;" not in data["text"]


def test_video_picks_a_playable_mp4(tweets):
    video = next(t for t in tweets if t.media.videos)
    item = next(m for m in post(video, {})["media"] if m["type"] == "video")
    assert ".mp4" in item["url"] and item["poster"]


@pytest.mark.parametrize(
    "query,handle",
    [
        ("jack", None),
        ("tibo", None),
        ("@jack", "jack"),
        ("https://x.com/jack/status/1", "jack"),
        ("twitter.com/jack?s=20", "jack"),
        ("Jack Dorsey", None),
        ("name-with-dash", None),
    ],
)
def test_as_handle(query, handle):
    assert as_handle(query) == handle


# storage


def test_first_fetch_is_history_except_the_last_day(store):
    now = int(time.time())
    store.save_posts("1", [make(1, now - 3600), make(2, now - 5 * 86400)], backfill=True)
    assert [p["id"] for p in store.new_posts()] == ["1"]


def test_late_fetched_old_post_still_counts_as_new(store):
    """Polling lags, so a post written before a check can arrive after it."""
    store.mark_seen(int(time.time()) - 5)
    store.save_posts("1", [make(1, int(time.time()) - 3600)], backfill=False)
    assert [p["id"] for p in store.new_posts()] == ["1"]


def test_new_follow_only_counts_posts_since_the_last_check(store):
    now = int(time.time())
    store.mark_seen(now - 3600)
    store.save_posts("1", [make(1, now - 7200), make(2, now - 60)], backfill=True)
    assert [p["id"] for p in store.new_posts()] == ["2"]


def test_seen_clears_new_and_never_moves_back(store):
    store.save_posts("1", [make(1)], backfill=False)
    mark = store.new_posts()[0]["fetched_at"]
    store.mark_seen(mark)
    store.mark_seen(mark - 100)
    assert store.seen() == mark and store.new_posts() == []


def test_history_pages_without_skipping_ties(store):
    store.save_posts("1", [make(i, 1000) for i in range(1, 6)], backfill=False)
    first = store.history(2)
    last = first[-1]
    rest = store.history(10, before=(last["at"], last["id"]))
    assert len(first) + len(rest) == 5
    assert not {p["id"] for p in first} & {p["id"] for p in rest}


def own_posts_mix():
    return [
        make(1),
        make(2, kind="reply", reply_to={"handle": "bob"}),
        make(3, kind="repost", repost={}),
        make(4, kind="reply", reply_to={"handle": "A"}),  # a thread, and handles ignore case
        make(5, quote={}),
        make(6, kind="reply", reply_to={"handle": None}),
    ]


def test_own_posts_keep_threads_and_quotes_only(store):
    store.save_posts("1", own_posts_mix(), backfill=False)
    assert {p["id"] for p in store.new_posts(own_only=True)} == {"1", "4", "5"}
    assert {p["id"] for p in store.history(10, own_only=True)} == {"1", "4", "5"}
    assert len(store.new_posts()) == 6


def test_own_posts_filter_narrows_new_counts_only(store):
    store.save_posts("1", own_posts_mix(), backfill=False)
    ann = store.creators(own_only=True)[0]
    assert (ann["new"], ann["posts"]) == (3, 6)
    assert store.creators()[0]["new"] == 6


def test_removing_creator_removes_posts(store):
    store.save_posts("1", [make(1)], backfill=False)
    store.remove_creator("1")
    assert store.history(5) == []


# poller


async def test_first_poll_backfills(store):
    source = FakeSource()
    source.pages = [[make(1)]]
    assert await Poller(store, source).poll(store.creator("1")) == 1
    assert source.calls == [("1", config.FIRST_FETCH)]
    assert store.history(1)


async def test_no_overlap_looks_further_back(store):
    store.save_posts("1", [make(1)], backfill=True)
    store.mark_polled("1")
    source = FakeSource()
    source.pages = [[make(9)], [make(9), make(8), make(1)]]
    assert await Poller(store, source).poll(store.creator("1")) == 2
    assert source.calls[1] == ("1", config.GAP_FETCH)


async def test_overlap_stops_there(store):
    store.save_posts("1", [make(1)], backfill=True)
    store.mark_polled("1")
    source = FakeSource()
    source.pages = [[make(2), make(1)]]
    await Poller(store, source).poll(store.creator("1"))
    assert len(source.calls) == 1


async def test_rate_limit_backs_off_and_retries_same_creator(store):
    source = FakeSource()
    source.fail = RateLimited()
    poller = Poller(store, source)
    assert await poller.tick() == config.RATE_LIMIT_BACKOFF_SECONDS
    assert poller.state == "waiting" and store.creator("1")["polled_at"] == 0


async def test_block_notifies_once(store, monkeypatch):
    source = FakeSource()
    source.fail = Blocked("banned")
    poller = Poller(store, source)
    sent = []
    monkeypatch.setattr(poller, "_notify", sent.append)
    await poller.tick()
    await poller.tick()
    assert poller.state == "blocked" and len(sent) == 1


async def test_one_bad_creator_does_not_stop_the_loop(store):
    source = FakeSource()
    source.fail = ValueError("parse failed")
    poller = Poller(store, source)
    await poller.tick()
    row = store.creator("1")
    assert row["polled_at"] > 0 and "parse failed" in row["poll_error"]


async def test_no_requests_without_an_account(store):
    source = FakeSource()
    source.state = "none"
    poller = Poller(store, source)
    await poller.tick()
    assert source.calls == [] and poller.state == "none"


async def test_polled_creator_is_not_refetched_early(store):
    store.mark_polled("1")
    source = FakeSource()
    await Poller(store, source).tick()
    assert source.calls == []


async def test_adding_someone_wakes_the_sleeping_loop(store):
    poller = Poller(store, FakeSource())
    poller.nudge()
    assert poller.wake.is_set()


async def test_adding_someone_does_not_cut_a_rate_limit_short(store):
    poller = Poller(store, FakeSource())
    poller.state = "waiting"
    poller.nudge()
    assert not poller.wake.is_set()


# web


@pytest.fixture
def client(store):
    source = FakeSource()
    with TestClient(create_app(store, source, poll=False), base_url="http://exo.test") as client:
        client.source = source
        client.store = store
        yield client


def person(id="2", handle="bob"):
    return Profile(id, handle, handle.title(), "", False)


def test_page_and_security_headers(client):
    response = client.get("/")
    assert response.status_code == 200 and "script-src 'self'" in response.headers["content-security-policy"]


def test_feed_is_finite_new_only(client):
    client.store.save_posts("1", [make(1), make(2, 1000)], backfill=True)
    assert [p["id"] for p in client.get("/api/feed").json()["posts"]] == ["1"]


def test_paging_has_a_cursor_and_rejects_junk(client):
    client.store.save_posts("1", [make(i, 1000 + i) for i in range(1, 40)], backfill=False)
    page = client.get("/api/feed?creator=1").json()
    assert len(page["posts"]) == 30 and page["more"]
    last = page["posts"][-1]
    rest = client.get(f"/api/feed?creator=1&before={last['at']}:{last['id']}").json()
    assert len(rest["posts"]) == 9 and not rest["more"]
    assert client.get("/api/feed?before=x'--").status_code == 400


def test_feed_can_show_only_own_posts(client):
    client.store.save_posts("1", own_posts_mix(), backfill=False)
    assert len(client.get("/api/feed?only=posts").json()["posts"]) == 3
    assert len(client.get("/api/feed?creator=1&only=posts").json()["posts"]) == 3
    assert len(client.get("/api/feed").json()["posts"]) == 6
    assert client.get("/api/state?only=posts").json()["creators"][0]["new"] == 3


def test_only_posts_pages_and_says_when_nothing_is_left(client):
    replies = [make(i, 1000 + i, kind="reply", reply_to={"handle": "bob"}) for i in range(1, 40)]
    client.store.save_posts("1", replies, backfill=True)
    assert client.get("/api/feed").json()["more"]
    assert not client.get("/api/feed?only=posts").json()["more"]
    client.store.save_posts("1", [make(i, 2000 + i) for i in range(50, 90)], backfill=True)
    page = client.get("/api/feed?creator=1&only=posts").json()
    last = page["posts"][-1]
    rest = client.get(f"/api/feed?creator=1&only=posts&before={last['at']}:{last['id']}").json()
    assert len(page["posts"]) == 30 and page["more"] and len(rest["posts"]) == 10 and not rest["more"]


def test_add_single_match(client):
    client.source.found = [person()]
    assert client.post("/api/creators", json={"query": "@bob"}).json()["added"]["handle"] == "bob"
    assert client.store.creator("2")


def test_one_name_match_still_asks(client):
    client.source.found = [person()]
    assert client.post("/api/creators", json={"query": "bob"}).json()["matches"][0]["handle"] == "bob"
    assert client.store.creator("2") is None


def test_handle_that_misses_never_follows_a_search_result(client):
    client.source.found = [person("2", "bobby")]
    assert "matches" in client.post("/api/creators", json={"query": "@bob"}).json()
    assert client.store.creator("2") is None


def test_handle_case_does_not_matter(client):
    client.source.found = [person("2", "Bob")]
    assert client.post("/api/creators", json={"query": "@bob"}).json()["added"]["id"] == "2"


class FakeUser:
    id, username, displayname, profileImageUrl, protected, rawDescription = 2, "bob", "Bob", "", False, "hi"


class FakeApi:
    def __init__(self):
        self.logins, self.searches = [], []

    async def user_by_login(self, handle):
        self.logins.append(handle)
        return FakeUser()

    async def search_user(self, query, limit):
        self.searches.append(query)
        yield FakeUser()


@pytest.mark.parametrize(
    "query,logins,searches", [("tibo", [], ["tibo"]), ("Tibo Sottiaux", [], ["Tibo Sottiaux"]), ("@tibo", ["tibo"], [])]
)
async def test_bare_word_is_a_name_search(query, logins, searches):
    source = Source.__new__(Source)
    source.api = FakeApi()
    assert (await source.find(query))[0].bio == "hi"
    assert (source.api.logins, source.api.searches) == (logins, searches)


def test_add_many_matches_asks_then_adds(client):
    client.source.found = [person("2", "bob"), person("3", "bobby")]
    assert len(client.post("/api/creators", json={"query": "Bob"}).json()["matches"]) == 2
    assert client.store.creator("2") is None


@pytest.mark.parametrize(
    "failure,status", [(Blocked("x"), 503), (RateLimited(), 429), (RuntimeError("x"), 502)]
)
def test_add_failures_are_readable(client, failure, status):
    client.source.fail = failure
    response = client.post("/api/creators", json={"query": "bob"})
    assert response.status_code == status and response.json()["error"]


def test_add_rejects_empty_and_bad_bodies(client):
    assert client.post("/api/creators", json={"query": "  "}).status_code == 400
    assert client.post("/api/creators", json=["x"]).status_code == 400
    assert client.post("/api/creators", content="nope").status_code == 400


def test_unfollow_removes_person_and_their_posts_everywhere(client):
    client.store.save_posts("1", [make(1)], backfill=False)
    assert client.delete("/api/creators/1").status_code == 204
    assert client.get("/api/state").json()["creators"] == []
    assert client.get("/api/feed").json()["posts"] == []
    assert client.get("/api/feed?creator=1").json()["posts"] == []
    assert client.delete("/api/creators/1").status_code == 204


def test_cross_site_writes_refused(client):
    headers = {"origin": "https://evil.example"}
    assert client.post("/api/seen", json={"until": 1}, headers=headers).status_code == 403
    assert client.delete("/api/creators/1", headers=headers).status_code == 403
    assert client.store.creator("1")
    assert client.post("/api/seen", json={"until": 1}, headers={"origin": "http://exo.test"}).status_code == 204


def test_state_shows_account_trouble(client):
    client.source.state = "blocked"
    assert client.get("/api/state").json()["status"] == "blocked"
