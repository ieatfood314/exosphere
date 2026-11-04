"""Fill a throwaway database from the recorded X response in tests/fixtures, so the
site can be run and looked at without touching X. Usage: seed_dev.py <data dir>"""

import json
import sys
import time
from pathlib import Path

from exosphere import config  # noqa: F401
from exosphere.db import Store
from exosphere.normalize import avatar, post
from twscrape.models import parse_tweets

fixture = Path(__file__).parent.parent / "tests/fixtures/raw_user_tweets_and_replies.json"
data = Path(sys.argv[1])
data.mkdir(parents=True, exist_ok=True)
store = Store(data / "exosphere.db")
tweets = list(parse_tweets(json.loads(fixture.read_text())))
batch = {t.id: t for t in tweets}
# Move the recording up to the present so the time labels and day dividers mean something.
shift = int(time.time()) - 3600 - max(int(t.date.timestamp()) for t in tweets)
for tweet in tweets:
    user = tweet.user
    store.add_creator(str(user.id), user.username, user.displayname, avatar(user.profileImageUrl), False)
    item = post(tweet, batch)
    item["at"] += shift
    store.save_posts(str(user.id), [item], backfill=False)
    store.mark_polled(str(user.id))
print(store.creator_count(), "creators")
