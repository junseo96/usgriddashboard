"""Operational semantics, using tiny offline source-format fixtures."""
import csv
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import transmission_west as west


def zipped(rows):
    text = io.StringIO()
    writer = csv.DictWriter(text, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('official.csv', text.getvalue())
    return buffer.getvalue()


class WesternOperationalTests(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 10, 12, 7, tzinfo=timezone.utc)
        self.end = self.start + timedelta(hours=1)

    def test_caiso_signed_mcc_hourly_first_and_ignore_other_components(self):
        rows = []
        for interval in range(12):
            start = self.start + timedelta(minutes=5 * interval)
            for index, node in enumerate(west.ZONES):
                # All 3 hourly averages are zero, despite large 5-minute spreads.
                value = (index - 1) * (100 if interval < 6 else -100)
                common = dict(INTERVALSTARTTIME_GMT=west.iso(start),
                              INTERVALENDTIME_GMT=west.iso(start + timedelta(minutes=5)),
                              NODE=node, MARKET_RUN_ID='RTM')
                rows.append(dict(common, LMP_TYPE='MCC', VALUE=value))
                rows.append(dict(common, LMP_TYPE='LMP', VALUE=9000))
        result = west.parse_caiso_mcc(zipped(rows), 'source', self.start, self.end)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['nodeCount'], 3)
        self.assertEqual(result[0]['value'], 0)
        self.assertEqual(result[0]['population'], 'load_zones')

    def test_caiso_integrated_load_excludes_eim_and_subtotals(self):
        rows = []
        for area, value in [('CA ISO-TAC', 30000), ('PGE-TAC', 12000), ('AVA', 2000)]:
            rows.append(dict(TAC_AREA_NAME=area, MARKET_RUN_ID='ACTUAL',
                             LABEL='Total Actual Hourly Integrated Load',
                             INTERVALSTARTTIME_GMT=west.iso(self.start),
                             INTERVALENDTIME_GMT=west.iso(self.end), MW=value))
        result = west.parse_caiso_load(zipped(rows), 'source', self.start, self.end)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['mw'], 30000)

    def test_local_curtailment_is_mwh_not_system_curtailment_or_max_mw(self):
        text = '<title>Daily Renewable Report - Oct 12, 2026 </title>mitigate local congestion\n'
        for fuel in ('solar', 'wind'):
            for cause in ('econ', 'ss', 'oi'):
                values = [1] * 24
                values[3] = 'NA'
                text += f'curt_hr_tot_{fuel}_{cause}_local_mwh = {json.dumps(values)};\n'
                text += f'curt_hr_tot_{fuel}_{cause}_system_mwh = {json.dumps([999] * 24)};\n'
                text += f'curt_hr_max_{fuel}_{cause}_local_mw = {json.dumps([999] * 24)};\n'
        rows = west.parse_caiso_curtailment(text.encode(), '2026-10-12', 'source')
        self.assertEqual(len(rows), 23)
        self.assertTrue(all(row['mwh'] == 6 for row in rows))
        self.assertFalse(any(row['start'] == '2026-10-12T10:00:00Z' for row in rows))

    def test_ercot_uncapped_bus_minus_synchronized_uncapped_lambda(self):
        expected = datetime(2026, 10, 12, 5, tzinfo=timezone.utc)
        lambda_row = dict(SCEDTimeStamp='10/12/2026 00:00:00', RepeatedHourFlag='N',
                          CappedSystemLambda='5000', UncappedSystemLambda='7000')
        value = west.parse_ercot_lambda(zipped([lambda_row]), expected)
        rows = [dict(SCEDTimestamp='10/12/2026 00:00:00', RepeatedHourFlag='N', ElectricalBus=node,
                     CappedLMP='5000', UncappedLMP=price) for node, price in [('A', 6990), ('B', 7030)]]
        self.assertEqual(west.parse_ercot_bus(zipped(rows), expected, value), {'A': -10, 'B': 30})
        with self.assertRaisesRegex(ValueError, 'timestamp mismatch'):
            west.parse_ercot_bus(zipped(rows), expected + timedelta(seconds=1), value)

    def test_sced_duration_weights_actual_seconds_not_sample_count(self):
        intervals = []
        cursor = self.start
        for _ in range(6):
            for seconds, value in [(240, 0), (360, 10)]:
                end = cursor + timedelta(seconds=seconds)
                intervals.append((cursor, end, {'A': 0, 'B': value}, ['source']))
                cursor = end
        result = west.sced_hourly_spreads(iter(intervals))
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]['p90'], 5.4)
        self.assertAlmostEqual(result[0]['p10'], .6)
        self.assertAlmostEqual(result[0]['value'], 4.8)
        # Missing one SCED interval leaves no complete nodes for this hour.
        self.assertEqual(west.sced_hourly_spreads(iter(intervals[1:])), [])
        # A missing bus stays outside the complete-hour population.
        intervals[1] = (*intervals[1][:2], {'A': 0}, ['source'])
        self.assertEqual(west.sced_hourly_spreads(iter(intervals)), [])

    def test_sced_cross_hour_and_overlap(self):
        start = self.start - timedelta(seconds=20)
        intervals = []
        while start < self.end:
            end = min(start + timedelta(seconds=300), self.end)
            intervals.append((start, end, {'A': -5, 'B': 5}, ['source']))
            start = end
        result = west.sced_hourly_spreads(iter(intervals))
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]['value'], 8)
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            west.sced_hourly_spreads(iter([intervals[0], intervals[0]]))

    def test_ercot_quarter_hour_midnight_is_previous_interval(self):
        start, end = west.bounds('2026-10-12', '2026-10-12', west.TX)
        rows = [dict(DeliveryDate='10/12/2026', TimeEnding='24:00', Demand='40000', DSTFlag='N')]
        result = west.parse_ercot_load(zipped(rows), 'source', start, end)
        self.assertEqual(result[0]['start'], '2026-10-13T04:45:00Z')
        self.assertEqual(result[0]['end'], '2026-10-13T05:00:00Z')
        self.assertEqual(result[0]['mw'] * .25, 10000)

    def test_utilization_is_percent_and_preserves_overloads(self):
        self.assertEqual(west.utilization_percent(40, 40), 100)
        self.assertEqual(west.utilization_percent(70, 40), 175)
        self.assertEqual(west.utilization_percent(0, 40), 0)
        self.assertIsNone(west.utilization_percent(-10, 40))
        self.assertIsNone(west.utilization_percent(10, 0))
        self.assertIsNone(west.utilization_percent(-10, -40))

    def test_ercot_dst_fold_and_nonexistent_hour(self):
        a = west.ercot_stamp('11/01/2026 01:10:00', 'N')
        b = west.ercot_stamp('11/01/2026 01:10:00', 'Y')
        self.assertEqual((b - a).total_seconds(), 3600)
        with self.assertRaisesRegex(ValueError, 'Nonexistent'):
            west.ercot_stamp('03/08/2026 02:10:00', 'N')

    def test_binding_deduplicates_oasis_groups_without_adding_durations(self):
        row = dict(INTERVALSTARTTIME_GMT=west.iso(self.start), INTERVALENDTIME_GMT=west.iso(self.start + timedelta(minutes=5)),
                   MARKET_RUN_ID='RTM', NOMOGRAM_ID='asset', CONSTRAINT_CAUSE='contingency', PRC='-2', GROUP='1')
        result = west.parse_caiso_binding(zipped([row, dict(row, GROUP='2')]), 'source', self.start, self.end)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]['binding'])

    def test_refresh_archives_both_original_and_revised_bytes(self):
        class Response(io.BytesIO):
            url = 'https://www.ercot.com/public-example'
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(west.urllib.request, 'urlopen', side_effect=[Response(b'original'), Response(b'revised')]):
                first, first_meta = west.fetch(Response.url, directory)
                revised, revised_meta = west.fetch(Response.url, directory, refresh=True)
            self.assertNotEqual(first_meta['sha256'], revised_meta['sha256'])
            archive = Path(directory) / 'west/history/by-sha256'
            self.assertEqual((archive / (first_meta['sha256'] + '.raw')).read_bytes(), first)
            self.assertEqual((archive / (revised_meta['sha256'] + '.raw')).read_bytes(), revised)


if __name__ == '__main__':
    unittest.main()
