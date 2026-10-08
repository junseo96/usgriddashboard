"""Safety and semantics of the official direct actual-load feeds."""
import importlib.util
import json
from datetime import date, datetime, timezone
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("demand_direct", Path(__file__).resolve().parents[1] / "scripts/demand_direct.py")
direct = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(direct)

HEADER = "Time,Day ahead forecast,Hour ahead forecast,Current demand,Demand response\n"
NOW = datetime(2026, 10, 8, 9, tzinfo=timezone.utc)


def csv_bytes(*lines):
    return (HEADER + "\n".join(lines)).encode()


def ercot_row(timestamp="2026-10-08 03:40:00-0500", demand=47730, forecast=0):
    return {"timestamp": timestamp,
            "epoch": int(datetime.fromisoformat(timestamp).timestamp() * 1000),
            "forecast": forecast, "demand": demand, "capacity": 69857}


def ercot_bytes(*rows):
    return json.dumps({"data": list(rows), "forecast": [{"forecastedDemand": 999999}]}).encode()


class CaisoActualTests(unittest.TestCase):
    def test_only_actuals_not_forecast_blank_or_response(self):
        points, warnings = direct.parse_caiso(csv_bytes(
            "00:00,80000,90000,29904,500", "00:05,81000,92000,30290,",
            "00:10,82000,93000,,"), date(2026, 10, 8), NOW)
        self.assertEqual([point["mw"] for point in points], [29904, 30290])
        self.assertEqual(points[0]["observedAt"], "2026-10-08T07:00:00Z")
        self.assertEqual(warnings, [])

    def test_final_midnight_boundary_not_same_day_observation(self):
        points, _ = direct.parse_caiso(csv_bytes(
            "00:00,1,2,31000,", "23:55,1,2,30000,", "00:00,1,2,29000,"),
            date(2026, 10, 7), NOW)
        self.assertEqual(len(points), 2)
        self.assertEqual(points[-1]["observedAt"], "2026-10-08T06:55:00Z")

    def test_dst_ambiguous_or_nonexistent_not_assigned_guessed_offset(self):
        for day, line in [(date(2026, 11, 1), "01:00,1,2,28000,"),
                          (date(2026, 3, 8), "02:00,1,2,28000,")]:
            points, warnings = direct.parse_caiso(csv_bytes(line), day,
                datetime(2026, 12, 1, tzinfo=timezone.utc))
            self.assertEqual(points, [])
            self.assertIn("DST", warnings[0])

    def test_winter_offset_is_not_fixed_summer_offset(self):
        points, _ = direct.parse_caiso(csv_bytes("00:00,1,2,28000,"), date(2026, 1, 8), NOW)
        self.assertEqual(points[0]["observedAt"], "2026-01-08T08:00:00Z")

    def test_future_actual_nonfinite_or_bad_cadence_rejected(self):
        for line in ("03:00,1,2,30000,", "00:00,1,2,NaN,", "00:03,1,2,30000,"):
            with self.assertRaises(direct.DirectDemandError):
                direct.parse_caiso(csv_bytes(line), date(2026, 10, 8), NOW)

    def test_changed_schema_and_conflicting_duplicates_rejected(self):
        with self.assertRaises(direct.DirectDemandError):
            direct.parse_caiso(b"Time,Demand\n00:00,30000", date(2026, 10, 8), NOW)
        with self.assertRaises(direct.DirectDemandError):
            direct.parse_caiso(csv_bytes("00:05,1,2,30000,", "00:05,1,2,31000,"), date(2026, 10, 8), NOW)


class ErcotActualTests(unittest.TestCase):
    def test_excludes_forecast_capacity_and_future_forecasts(self):
        points = direct.parse_ercot(ercot_bytes(ercot_row(),
            ercot_row("2026-10-08 15:00:00-0500", 99000, 1)), NOW)
        self.assertEqual(points, [{"observedAt": "2026-10-08T08:40:00Z", "mw": 47730,
                                    "quality": None}])

    def test_explicit_dst_offsets_preserve_both_repeated_wall_clock_hours(self):
        points = direct.parse_ercot(ercot_bytes(
            ercot_row("2026-11-01 01:00:00-0500", 31000),
            ercot_row("2026-11-01 01:00:00-0600", 32000)),
            datetime(2026, 11, 1, 10, tzinfo=timezone.utc))
        self.assertEqual([p["observedAt"] for p in points], ["2026-11-01T06:00:00Z", "2026-11-01T07:00:00Z"])

    def test_unknown_actual_marker_or_epoch_mismatch_rejected(self):
        mismatched = ercot_row()
        mismatched["epoch"] += 1000
        for row in (ercot_row(forecast=None), ercot_row(forecast=False), mismatched):
            with self.assertRaises(direct.DirectDemandError):
                direct.parse_ercot(ercot_bytes(row), NOW)

    def test_future_actual_and_invalid_timezone_rejected(self):
        for timestamp in ("2026-10-08 05:00:00-0500", "2026-10-08 03:40:00-0600"):
            with self.assertRaises(direct.DirectDemandError):
                direct.parse_ercot(ercot_bytes(ercot_row(timestamp)), NOW)

    def test_forecast_only_is_unavailable(self):
        with self.assertRaises(direct.DirectDemandError):
            direct.parse_ercot(ercot_bytes(ercot_row(forecast=1)), NOW)


class DirectCollectionTests(unittest.TestCase):
    def test_daily_failures_preserve_only_actual_successful_days(self):
        calls = []
        def fetch(url):
            calls.append(url)
            if "20261008" in url:
                return csv_bytes("01:35,1,2,27537,")
            raise OSError("test-only unrelated response body should not leak")
        region = direct.collect_direct("CAISO", fetch, NOW, days=3)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all("/outlook/history/" in url for url in calls))
        self.assertEqual(region["latestMw"], 27537)
        self.assertEqual(region["status"], "available")
        self.assertEqual(len(region["series"]), 1)
        self.assertEqual(region["dailyPeaks"], [])
        self.assertFalse(region["_intervalEnding"])
        self.assertNotIn("unrelated response", str(region))

    def test_ercot_one_fetch_current_day_metadata_and_stale_data(self):
        calls = []
        def fetch(url):
            calls.append(url)
            return ercot_bytes(ercot_row())
        region = direct.collect_direct("ERCOT", fetch, NOW.replace(hour=15))
        self.assertEqual(calls, [direct.ERCOT_URL])
        self.assertEqual(region["status"], "stale")
        self.assertEqual(region["intervalMinutes"], 5)
        self.assertIn("충전", " ".join(region["warnings"]))

    def test_unsupported_does_not_fetch_and_days_are_bounded(self):
        def fail(url):
            raise AssertionError("must not fetch")
        self.assertIsNone(direct.collect_direct("NYISO", fail, NOW))
        with self.assertRaises(direct.DirectDemandError):
            direct.collect_direct("CAISO", fail, NOW, days=8)


if __name__ == "__main__":
    unittest.main()
