"""Settings, all from the environment. Import this before twscrape."""

import os
from pathlib import Path

# twscrape reports usage to PostHog unless told not to.
os.environ["TWS_TELEMETRY"] = "0"

DATA_DIR = Path(os.environ.get("EXOSPHERE_DATA", "~/.local/share/exosphere")).expanduser()
DB_PATH = DATA_DIR / "exosphere.db"
ACCOUNTS_PATH = DATA_DIR / "accounts.db"  # burner session cookies, kept out of the repo

HOST = os.environ.get("EXOSPHERE_HOST", "127.0.0.1")
PORT = int(os.environ.get("EXOSPHERE_PORT", "4600"))

# One burner, so go slowly: every creator once per cycle, spread evenly across it.
CYCLE_MINUTES = int(os.environ.get("EXOSPHERE_CYCLE_MINUTES", "30"))
MIN_GAP_SECONDS = int(os.environ.get("EXOSPHERE_MIN_GAP_SECONDS", "60"))
RATE_LIMIT_BACKOFF_SECONDS = 15 * 60

FIRST_FETCH = 40  # posts pulled when a creator is added
POLL_FETCH = 20  # posts pulled on a normal poll
GAP_FETCH = 100  # posts pulled when a normal poll found nothing we already had

NTFY_URL = os.environ.get("EXOSPHERE_NTFY_URL", "")  # pinged when the burner stops working
