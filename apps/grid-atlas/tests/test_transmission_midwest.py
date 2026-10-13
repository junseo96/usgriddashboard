import csv
from datetime import date
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import transmission_midwest as midwest


class Sheet:
    def __init__(self, rows):
        self.rows = rows
        self.nrows = len(rows)

    def row_values(self, i):
        return self.rows[i]

    def cell_value(self, i, j):
        return self.rows[i][j]


class Book:
    datemode = 0

    def __init__(self, rows):
        self.sheet = Sheet(rows)

    def sheet_by_index(self, _):
        return self.sheet


def lmp_blob(rows, day='10/05/2026'):
    stream = io.StringIO()
    stream.write('Realtime Market LMPs\n' + day + '\n\n,,,All Hours-Ending are Eastern Standard Time (EST)\n')
    writer = csv.writer(stream)
    writer.writerow(['Node', 'Type', 'Value'] + [f'HE {h}' for h in range(1, 25)])
    writer.writerows(rows)
    return stream.getvalue().encode()


def binding_book(rows):
    headers = ['Constraint ID', 'Constraint Name', 'Contingency Description', 'Hour of  Occurrence', 'Constraint Description', 'Preliminary Shadow Price']
    return Book([['Binding Constraints Report - Real-Time Market'], ['Market Date: 10/05/2026'], ['Publish Date: 10/06/2026'], headers, *rows])


def load_book(rows):
    return Book([['FORECASTED AND'], ['ACTUAL LOAD REPORT'], [], [], ['Market Day', 'HourEnding', 'MISO MTLF (MWh)', 'MISO ActualLoad (MWh)'], *rows])


class MidwestTransmissionTests(unittest.TestCase):
    def test_signed_mcc_same_hour_and_only_loadzone_population(self):
        rows = [['A', 'Loadzone', 'MCC', *([-10] * 24)], ['B', 'Loadzone', 'MCC', *([10] * 24)],
                ['Generator', 'Gennode', 'MCC', *([1000] * 24)], ['A', 'Loadzone', 'LMP', *([9999] * 24)]]
        result = midwest.parse_miso_lmp(lmp_blob(rows), '2026-10-05', 'fixture')
        self.assertEqual(len(result), 24)
        self.assertEqual(result[0]['value'], 16)
        self.assertEqual(result[0]['p10'], -8)
        self.assertEqual(result[0]['p90'], 8)
        self.assertEqual(result[0]['nodeCount'], 2)
        self.assertEqual(result[0]['start'], '2026-10-05T05:00:00Z')
        self.assertEqual(result[-1]['end'], '2026-10-06T05:00:00Z')
        summer = midwest.parse_miso_lmp(lmp_blob(rows, '07/15/2026'), '2026-07-15', 'fixture')
        self.assertEqual(summer[0]['start'], '2026-07-15T05:00:00Z', 'Summer still fixed EST, not EDT')

    def test_csv_padded_metadata_is_a_valid_official_legacy_layout(self):
        rows = [['A', 'Loadzone', 'MCC', *([0] * 24)], ['B', 'Loadzone', 'MCC', *([10] * 24)]]
        blob = lmp_blob(rows).replace(b'Realtime Market LMPs\n', b'Realtime Market LMPs,,,,\n').replace(b'10/05/2026\n', b'10/05/2026,,,,\n')
        self.assertEqual(len(midwest.parse_miso_lmp(blob, '2026-10-05', 'fixture')), 24)

    def test_lmp_missing_hour_not_zero_and_schema_date_conflicts_reject(self):
        rows = [['A', 'Loadzone', 'MCC', *([0] * 24)], ['B', 'Loadzone', 'MCC', '', *([10] * 23)]]
        self.assertEqual(len(midwest.parse_miso_lmp(lmp_blob(rows), '2026-10-05', 'fixture')), 23)
        with self.assertRaisesRegex(ValueError, 'date mismatch'):
            midwest.parse_miso_lmp(lmp_blob(rows), '2026-10-06', 'fixture')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            midwest.parse_miso_lmp(lmp_blob(rows + [rows[0]]), '2026-10-05', 'fixture')
        with self.assertRaisesRegex(ValueError, 'time basis'):
            midwest.parse_miso_lmp(lmp_blob(rows).replace(b'Eastern Standard Time (EST)', b'Eastern Time'), '2026-10-05', 'fixture')

    def test_constraint_end_labels_preserved_and_reserves_excluded(self):
        rows = [[1, 'Line_A', 'N-1_B', '00:00', '', -85], [1, 'Line_A', 'N-1_B', '00:00', '', -85],
                [2, 'Reserve', '', '00:05', 'Contingency Reserve Loss', -1000], [1, 'Line_A', 'N-1_B', '23:55', '', -20]]
        with patch.object(midwest.xlrd, 'open_workbook', return_value=binding_book(rows)):
            result, windows, reserves = midwest.parse_miso_binding(b'fixture', '2026-10-05', 'source')
        self.assertEqual(len(result), 2)
        self.assertEqual(reserves, 1)
        self.assertTrue(result[0]['binding'], 'Negative shadow price still represents binding')
        self.assertEqual(result[0]['start'], '2026-10-05T04:55:00Z')
        self.assertEqual(result[0]['end'], '2026-10-05T05:00:00Z')
        self.assertEqual(windows[0]['start'], result[0]['start'])
        self.assertEqual(windows[0]['end'], '2026-10-06T04:55:00Z')
        self.assertFalse(any('flowMw' in row or 'limitMw' in row for row in result))

    def test_complete_empty_event_report_has_window_but_no_fabricated_event(self):
        with patch.object(midwest.xlrd, 'open_workbook', return_value=binding_book([])):
            rows, windows, _ = midwest.parse_miso_binding(b'fixture', '2026-10-05', 'source')
        self.assertEqual(rows, [])
        self.assertEqual(len(windows), 1)
        with patch.object(midwest.xlrd, 'open_workbook', return_value=binding_book([[1, 'Line_A', '', '00:03', '', 2]])):
            with self.assertRaisesRegex(ValueError, 'Malformed'):
                midwest.parse_miso_binding(b'fixture', '2026-10-05', 'source')

    def test_actual_hourly_mwh_becomes_same_numeric_mw_forecasts_never_substitute(self):
        # 46300 is 2026-10-05 in the report's Excel1900 calendar.
        rows = [[46300, 1, 9999, 60000], [46300, 2, 9999, ''], [46301, 1, 9999, 70000]]
        with patch.object(midwest.xlrd, 'open_workbook', return_value=load_book(rows)):
            result = midwest.parse_miso_load(b'fixture', '2026-10-05', 'source')
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['mw'], 60000)
        self.assertEqual(result[0]['start'], '2026-10-05T05:00:00Z')
        with patch.object(midwest.xlrd, 'open_workbook', return_value=load_book([[46300, 1, 9999, '']])):
            with self.assertRaisesRegex(ValueError, 'No actual load'):
                midwest.parse_miso_load(b'fixture', '2026-10-05', 'source')

    def test_load_duplicate_hour_is_not_double_counted(self):
        with patch.object(midwest.xlrd, 'open_workbook', return_value=load_book([[46300, 1, 9, 100], [46300, 1, 9, 100]])):
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                midwest.parse_miso_load(b'fixture', '2026-10-05', 'source')

    def test_pjm_auth_block_is_explicit_and_no_observations_are_manufactured(self):
        def fetch(url, *_):
            if url == midwest.PJM_PAGE:
                blob = b'This page is no longer available rt_hrl_lmps'
                return blob, dict(url=url, retrievedAt='2026-10-13T00:00:00Z', sha256=hashlib.sha256(blob).hexdigest())
            raise urllib.error.HTTPError(url, 401, 'Unauthorized', None, None)
        with patch.object(midwest, '_fetch', side_effect=fetch):
            fragment = midwest._pjm('/tmp/unused', False)
        self.assertTrue(all(row['status'] == 'auth_required' for row in fragment['coverage'][:3]))
        for field in ('priceIntervals', 'constraintIntervals', 'loadIntervals', 'utilizationIntervals', 'curtailmentIntervals'):
            self.assertEqual(fragment[field], [])

    def test_cache_integrity_preserves_actual_acquisition_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'midwest' / 'history'
            root.mkdir(parents=True)
            url = midwest.BASE + '20261005_rt_lmp_final.csv'
            blob = b'original bytes'
            path = root / '20261005_rt_lmp_final.csv'
            path.write_bytes(blob)
            meta = dict(url=url, retrievedAt='2026-10-12T00:00:00Z', sha256=hashlib.sha256(blob).hexdigest())
            path.with_suffix('.csv.meta.json').write_text(json.dumps(meta))
            self.assertEqual(midwest._fetch(url, tmp), (blob, meta))
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
                midwest._fetch(url, tmp)


if __name__ == '__main__':
    unittest.main()
