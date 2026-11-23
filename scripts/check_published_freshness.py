#!/usr/bin/env python3
"""Check the public GitHub Pages snapshot independently of Actions."""

import argparse
import datetime as dt
import json
import sys
import time
from urllib.request import Request, urlopen

PUBLISHED = "https://marcbommarito.github.io/weather/data/latest.json"


def snapshot_age_minutes(payload, now):
    if not isinstance(payload, dict) or payload.get("sample"):
        raise ValueError("not a live weather snapshot")
    stamp = payload.get("generated_at")
    if not isinstance(stamp, str):
        raise ValueError("snapshot timestamp is missing")
    generated = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if generated.tzinfo is None or generated > now:
        raise ValueError("snapshot timestamp has no timezone or is in the future")
    return (now - generated).total_seconds() / 60


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-age-minutes", type=int, default=18)
    args = parser.parse_args()
    if args.max_age_minutes < 0:
        parser.error("--max-age-minutes must be nonnegative")
    try:
        request = Request(f"{PUBLISHED}?v={time.time_ns()}", headers={"Cache-Control": "no-cache"})
        with urlopen(request, timeout=8) as response:
            payload = json.load(response)
        now = dt.datetime.now(dt.timezone.utc)
        age = snapshot_age_minutes(payload, now)
        fresh = age <= args.max_age_minutes
        print(f"checked_at={now.isoformat()} generated_at={payload['generated_at']} "
              f"age_minutes={age:.2f} result={'fresh' if fresh else 'overdue'}")
        return 0 if fresh else 1
    except (OSError, ValueError) as error:
        print(f"Unable to verify public snapshot freshness: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
