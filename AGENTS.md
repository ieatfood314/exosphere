# exosphere

A quiet feed of chosen X accounts. Python (Starlette, twscrape, SQLite) with a no-build
vanilla JS front end. Runs as the `exosphere` user service on port 4600.

## Layout
- `exosphere/source.py` is the only module that talks to X. `normalize.py` turns tweets into
  the site's JSON, `poller.py` is the background loop, `db.py` is storage, `app.py` the API.
- `exosphere/static/` is the whole front end, served as is.
- Data and burner cookies: `~/.local/share/exosphere/` (`exosphere.db`, `accounts.db`).

## Rules that aren't obvious
- `exosphere/config.py` must load before twscrape: it turns off twscrape's PostHog telemetry.
- Timelines also contain other people's posts (quotes, reply parents). Filter by author.
- "New" is by `fetched_at`, not post time, because polling lags. A creator's first fetch is
  `backfill` and only its last 24 hours count as new.
- Everything from X reaches the DOM as text nodes. Never use `innerHTML` on post data.
- Keep polling slow. One burner, so X's limits and bans are the main risk; the cycle is 30
  minutes. New X accounts may need a phone number before name search
  works, so keep the "Try their @handle" fallback.
- Logging the burner out in the browser its cookies came from kills them in `accounts.db`.
- No engagement counts, no infinite scroll. Older posts need a tap on Earlier.
- The Posts filter is `OWN_POSTS` in `db.py`: posts, quotes and self-replies (threads), no
  replies to others and no reposts. It reads the stored JSON, so old rows need no migration.
  `only=posts` must go on `/api/state` as well as `/api/feed`, or the orbit glows for posts
  the feed is hiding.

## Design
Go-wild design, not the usual ui-taste. Earth hangs overhead; scrolling climbs from 700 km to
10,000 km, the real top of the exosphere, where the feed ends. Airglow green `#7DFFB4` is the
one live color. The limb is painted on a canvas because big blurred box-shadows clip badly.

## Dev
```
uv run pytest
uv run python scripts/seed_dev.py dev-data
EXOSPHERE_DATA=$PWD/dev-data EXOSPHERE_PORT=4601 uv run exosphere serve
```
Seeded data comes from a recording, so dev never touches X. With no account in `dev-data`,
the poller makes no requests.
Parallel sessions all default to port 4601, and a busy port still answers with someone else's
code. Check it's free first, or pick another.

## Deploy
`deploy/exosphere.service` goes in `~/.config/systemd/user/`. After a code change run
`systemctl --user restart exosphere`.
