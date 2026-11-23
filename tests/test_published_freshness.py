import datetime as dt
import io
import json
import unittest
from unittest.mock import patch

from scripts import check_published_freshness as check


class CheckPublishedFreshness(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 11, 23, 22, tzinfo=dt.timezone.utc)

    def test_valid_stale_and_exact_boundary(self):
        for age in [7, 18, 22]:
            stamp = self.now - dt.timedelta(minutes=age)
            self.assertEqual(check.snapshot_age_minutes({"generated_at": stamp.isoformat()}, self.now), age)

    def test_rejects_invalid_future_naive_or_sample(self):
        for snap in [[], {}, {"generated_at": "bad"}, {"generated_at": "2026-11-23T21:59:00"},
                     {"generated_at": "2026-11-23T22:01:00Z"},
                     {"generated_at": "2026-11-23T21:55:00Z", "sample": True}]:
            with self.subTest(snap=snap), self.assertRaises(ValueError):
                check.snapshot_age_minutes(snap, self.now)

    def test_cli_distinguishes_recent_overdue_and_failed(self):
        for age, exit_code in [(17, 0), (18, 0), (19, 1)]:
            generated = (self.now - dt.timedelta(minutes=age)).isoformat()
            data = json.dumps({"generated_at": generated}).encode()
            with patch.object(check.dt, "datetime", wraps=dt.datetime) as clock, \
                 patch.object(check, "urlopen", return_value=io.BytesIO(data)) as get, \
                 patch("sys.argv", ["check", "--max-age-minutes", "18"]), \
                 patch("sys.stdout", new_callable=io.StringIO) as stdout:
                clock.now.return_value = self.now
                self.assertEqual(check.main(), exit_code)
                self.assertIn(f"generated_at={generated}", stdout.getvalue())
                self.assertIn("?v=", get.call_args.args[0].full_url)
        with patch.object(check, "urlopen", side_effect=TimeoutError("timeout")), \
             patch("sys.argv", ["check"]), patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(check.main(), 2)
