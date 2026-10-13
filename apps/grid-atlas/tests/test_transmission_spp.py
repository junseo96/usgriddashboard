import csv
from datetime import date, datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('transmission_spp', SCRIPTS / 'transmission_spp.py')
spp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spp)


class SppTransmissionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.day = date(2026, 10, 7)

    def tearDown(self):
        self.directory.cleanup()

    def write(self, name, fields, rows):
        path = self.root / name
        with path.open('w', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(fields)
            writer.writerows(rows)
        return path

    def prices(self, missing=False, conflict=False):
        rows = []
        start = datetime(2026, 10, 7, 5, tzinfo=timezone.utc)
        for i in range(12):
            stamp = (start + timedelta(minutes=5 * (i+1))).strftime('%m/%d/%Y %H:%M:%S')
            rows.extend([[stamp, 'A', -10, 'SPP'], [stamp, 'B', 10, 'SPP'], [stamp, 'A', -9 if conflict and i == 0 else -10, 'SPP'], [stamp, 'WEST', 1000, 'SWPW']])
            if not missing or i != 11:
                rows.append([stamp, 'C', 0, 'SPP'])
        return self.write('prices.csv', ['GMT Interval', 'PNODE Name', 'MCC', 'BAA'], rows)

    def test_hourly_prices_collapse_settlement_aliases_and_separate_west(self):
        rows = spp.parse_prices(self.prices(), self.day, 'source')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['nodeCount'], 3)
        self.assertEqual(rows[0]['p10'], -8)
        self.assertEqual(rows[0]['p90'], 8)
        self.assertEqual(rows[0]['value'], 16)
        self.assertEqual(rows[0]['start'], '2026-10-07T05:00:00Z')

    def test_missing_node_interval_is_not_zero_and_duplicate_conflict_rejected(self):
        rows = spp.parse_prices(self.prices(missing=True), self.day, 'source')
        self.assertEqual(rows[0]['nodeCount'], 2)
        self.assertEqual(rows[0]['candidateNodeCount'], 3)
        with self.assertRaisesRegex(ValueError, 'Conflicting node'):
            spp.parse_prices(self.prices(conflict=True), self.day, 'source')

    def test_constraint_binding_union_excludes_activated_and_west(self):
        path = self.write('constraints.csv', ['GMTIntervalEnd', 'Constraint Name', 'NERCID', 'State', 'Interconnect', 'Contingent Facility'], [
            ['10/07/2026 05:05:00', 'A', '1', 'BINDING', 'E', 'N-1'],
            ['10/07/2026 05:10:00', 'A', '1', 'BREACHED', 'E', 'N-1'],
            ['10/07/2026 05:10:00', 'A', '1', 'BREACHED', 'E', 'N-1'],
            ['10/07/2026 05:15:00', 'B', '2', 'ACTIVATED', 'E', 'N-1'],
            ['10/07/2026 05:20:00', 'W', '3', 'BINDING', 'W', 'N-1'],
            ['10/07/2026 05:30:00', 'A', '1', 'BINDING', 'E', 'N-1'],
        ])
        events, windows = spp.parse_constraints(path, self.day, 'source')
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]['start'], '2026-10-07T05:00:00Z')
        self.assertEqual(events[0]['end'], '2026-10-07T05:10:00Z')
        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[0]['end'], '2026-10-07T05:20:00Z')
        self.assertEqual(windows[1]['start'], '2026-10-07T05:25:00Z')

    def test_actual_load_sums_cf_nc_but_not_duplicates_or_west_and_skips_incomplete_hours(self):
        path = self.write('load.csv', ['Market Hour', 'Balancing Area Name', 'Control Zone Name', 'Forecast Area Type', 'Load MW'], [
            ['10/07/2026 06:00:00', 'SPP', 'ZONE', 'CF', 100],
            ['10/07/2026 06:00:00', 'SPP', 'ZONE', 'CF', 100],
            ['10/07/2026 06:00:00', 'SPP', 'ZONE', 'NC', 20],
            ['10/07/2026 06:00:00', 'SWPW', 'WEST', 'CF', 1000],
            ['10/07/2026 07:00:00', 'SPP', 'ZONE', 'CF', 100],
            ['10/07/2026 07:00:00', 'SPP', 'ZONE', 'NC', ''],
        ])
        rows = spp.parse_load(path, self.day, 'source')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['mw'], 120)
        self.assertEqual(rows[0]['start'], '2026-10-07T05:00:00Z')
        self.assertEqual(rows[0]['end'], '2026-10-07T06:00:00Z')

    def test_wrong_day_and_unknown_state_fail_instead_of_creating_false_coverage(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            spp.parse_prices(self.prices(), date(2026, 10, 6), 'source')
        path = self.write('bad-constraints.csv', ['GMTIntervalEnd', 'Constraint Name', 'NERCID', 'State', 'Interconnect', 'Contingent Facility'], [['10/07/2026 05:05:00', 'A', '1', 'NEW_STATE', 'E', 'C']])
        with self.assertRaisesRegex(ValueError, 'Unrecognized'):
            spp.parse_constraints(path, self.day, 'source')

    def test_market_day_utc_bounds_preserve_dst_day_length(self):
        start, end = spp.day_bounds(date(2026, 11, 1))
        self.assertEqual((end-start).total_seconds(), 25*3600)
        start, end = spp.day_bounds(date(2026, 3, 8))
        self.assertEqual((end-start).total_seconds(), 23*3600)

    def test_interval_file_fallback_requires_every_node_interval_and_keeps_per_file_sources(self):
        def acquire(stem, url, title, day, cache_dir, refresh):
            local_end = datetime.strptime(stem.removeprefix('lmp-interval-'), '%Y%m%d%H%M').replace(tzinfo=spp.CENTRAL)
            end = local_end.astimezone(timezone.utc)
            # One actually missing file must remove the whole corresponding hour.
            if end.hour == 6 and end.minute == 5:
                raise urllib.error.URLError('source unavailable')
            path = self.write(stem + '.csv', ['GMTIntervalEnd', 'Pnode', 'MCC', 'BAA'], [
                [end.strftime('%m/%d/%Y %H:%M:%S'), 'A', -10, 'SPP'],
                [end.strftime('%m/%d/%Y %H:%M:%S'), 'B', 10, 'SPP'],
            ])
            return path, {'id': stem}
        with patch.object(spp, 'fetch_url', side_effect=acquire):
            sources, prices, events, windows, errors = spp.latest_day_intervals('lmp', self.day, self.root)
        self.assertEqual(len(sources), 287)
        self.assertEqual(len(prices), 23)
        self.assertEqual(len(errors), 1)
        self.assertTrue(all(p['value'] == 16 for p in prices))
        self.assertTrue(all(len(p['sourceIds']) == 12 for p in prices))
        self.assertNotIn('2026-10-07T06:00:00Z', [p['start'] for p in prices])
        self.assertEqual(events, [])
        self.assertEqual(windows, [])

    def test_previous_interval_day_is_retained_when_the_latest_requested_day_moves_forward(self):
        (self.root / 'lmp-interval-202610120005.csv').write_text('previous actual interval cache')
        called = []
        def interval_data(kind, day, cache_dir, refresh):
            called.append((kind, day.isoformat()))
            if kind != 'lmp':
                return [], [], [], [], ['unavailable']
            start, _ = spp.day_bounds(day)
            source = {'id': 'spp-lmp-interval-' + day.strftime('%Y%m%d'), 'url': 'https://portal.spp.org/actual-file'}
            return [source], [{'start': spp.iso(start), 'end': spp.iso(start + timedelta(hours=1))}], [], [], []
        with patch.object(spp, 'fetch', side_effect=OSError('daily archive not published')), patch.object(spp, 'latest_day_intervals', side_effect=interval_data):
            result = spp.collect('2026-10-12', '2026-10-13', self.root)[0]
        self.assertIn(('lmp', '2026-10-12'), called)
        self.assertIn(('lmp', '2026-10-13'), called)
        self.assertEqual(len(result['priceIntervals']), 2)


if __name__ == '__main__':
    unittest.main()
