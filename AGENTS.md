# exosphere

A quiet feed of chosen X accounts. Python (Starlette, twscrape, SQLite) with a no-build
vanilla JS front end. Runs as the `exosphere` user service on port 4600.

## Layout
- `exosphere/source.py` is the only module that talks to X. `normalize.py` turns tweets into
  the site's JSON, `poller.py` is the background loop, `db.py` is storage, `app.py` the API.
- `exosphere/offline.py` lists what the Android app saves for reading offline.
- `exosphere/static/` is the whole front end, served as is.
- `android/` is a WebView shell around the live site: Java, no Gradle, no dependencies.
- Data and burner cookies: `~/.local/share/exosphere/` (`exosphere.db`, `accounts.db`).

## This repo is public
Keep real names, hostnames, tailnet names, email addresses and anything about who the burner
is out of files and commit messages. Notes about one particular install go somewhere private.

## Rules that aren't obvious
- `exosphere/config.py` must load before twscrape: it turns off twscrape's PostHog telemetry.
- Timelines also contain other people's posts (quotes, reply parents). Filter by author.
- A bare word in the add box is a name, never a handle: @tibo isn't the Tibo you meant. Only
  `@handle` or a profile URL follows straight away; everything else asks you to pick.
- Names you can hold are buttons, not links, and their avatars have `pointer-events: none`.
  Firefox for Android shows its own menu on any link or image, so keep `href` off them.
- "New" is by `fetched_at`, not post time, because polling lags. A creator's first fetch is
  `backfill`, and only what they posted since the last check counts as new, at most 24 hours.
- A check is recorded when the page is hidden or closed after showing the feed, not on load,
  so the feed holds still while it's read. It's written to `localStorage` first and cleared
  once sent, so a check made offline reaches the server later. Unread posts move to Earlier at that point. Back
  within 5 minutes the page stays as it was, or 30 if scrolled down mid-read; after that it
  reloads to what's new.
- Everything from X reaches the DOM as text nodes. Never use `innerHTML` on post data.
- Keep polling slow. One burner, so X's limits and bans are the main risk; the cycle is 30
  minutes. New X accounts may need a phone number before name search
  works, so keep the "Try their @handle" fallback.
- Logging the burner out in the browser its cookies came from kills them in `accounts.db`.
- No engagement counts, no infinite scroll. Older posts need a tap on Earlier.
- New is only what's unchecked. All and person pages are history, seen or not, and reading
  them doesn't record a check. The All/Posts filter's first button is "Everything" so it
  doesn't read as the All page.
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

## Android
The app loads the site from your server, so site changes need no new APK. Only changes under
`android/` do. It builds in seconds, so nas needs nothing heavier:
```
ANDROID_HOME=<sdk> JAVA_HOME=<jdk17> android/build.sh
```
`android/test.sh` tests the offline code. To publish, bump `android/version` (`<name> <code>`, higher code every time), push, then run
`android/release.sh`. Obtainium reads GitHub releases, and the tag has to match the version name.
- The server address is asked for on first launch, never built in, because the APK is public.
- The release key is `~/.config/exosphere/android.jks`. Lose it and installed apps can't update.
- No JS bridge. The connect screen talks to the app by navigating to `exosphere://connect`, so
  the live site gets no native access.
- The app keeps the system bars as black strips. Under the status bar, posts would run through
  the clock, as the site has no sticky header.
- `build.sh` copies `style.css` and the fonts into the APK for the connect screen, so classes
  it uses (`.top`, `.mark`, `.ask`, `.note`, `#hero`) need to keep working there.
- Offline: `Offline.java` puts the site's pages network first, then the saved copy, marked
  with an `x-exosphere-saved` header so the site can say so. `SyncJob` fills the copy hourly on
  unmetered networks, and soon after you leave the app, from the list at `/api/offline`.
- A saved page is found by its URL, so `offline.py` has to ask for exactly what `app.js` asks
  for. Change a request in one and change the other. Query order and `%3A` don't matter.
- Offline, New can end mid-page, so Earlier there walks the saved pages (`savedEarlier`).
- Only the site's GETs have copies. Follows and unfollows need the server.
- Mind mobile data. The app's network is Tailscale's VPN, so "unmetered" can't be trusted alone:
  `SyncJob.onWifi` looks for real unmetered Wi-Fi underneath, before and during a sync, and a
  file stops downloading partway once it's gone. `Offline` bypasses the WebView cache, so it
  revalidates saved pages by etag; the server gzips.
- `Shelf` and `Syncer` are plain Java so `android/test.sh` can run them off the phone. Keep
  `android.*` out of them.
- HTTPS only, except `localhost` and `10.0.2.2` for a dev server. The emulator reaches
  `http://10.0.2.2:4601`. Test against that, as the live site would move your real read position.

## Deploy
`deploy/exosphere.service` goes in `~/.config/systemd/user/`. After a code change run
`systemctl --user restart exosphere`.
