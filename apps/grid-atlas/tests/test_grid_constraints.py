import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

import openpyxl


PATH = Path(__file__).resolve().parents[1] / 'scripts/build-grid-constraints.py'
SPEC = importlib.util.spec_from_file_location('grid_constraints_builder', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GridConstraintsTests(unittest.TestCase):
    def test_pge_null_is_not_zero_and_capacity_is_not_summed(self):
        groups = [dict(FeederId='A', load_min_kw=0, load_max_kw=2500, load_known_segments=4, segment_count=7),
                  dict(FeederId='B', load_min_kw=None, load_max_kw=None, load_known_segments=0, segment_count=9)]
        rows = MODULE.parse_pge_groups(groups, {'A': 1}, ['official'], '2026-10-13', 'analysis dates mixed')
        self.assertEqual(len(rows), 3)
        by_metric = {row['metricId']: row for row in rows}
        self.assertEqual(by_metric['pge_zero_load_headroom_percent']['value'], 25)
        self.assertEqual(by_metric['pge_zero_load_headroom_percent']['denominator'], 4)
        self.assertEqual(by_metric['pge_load_headroom_max_mw']['value'], 2.5)
        self.assertEqual(by_metric['pge_load_headroom_min_mw']['value'], 0)
        self.assertTrue(all(row['periodKind'] == 'snapshot' for row in rows))

    def test_pge_duplicate_or_invalid_denominator_rejected(self):
        row = dict(FeederId='A', load_min_kw=0, load_max_kw=1, load_known_segments=2, segment_count=3)
        for groups, zeros in [([row, row], {}), ([row], {'A': 3}), ([row | dict(load_known_segments=4)], {})]:
            with self.assertRaises(ValueError):
                MODULE.parse_pge_groups(groups, zeros, ['source'], '2026-10-13', '')

    def test_eia_preserves_ieee_standard_and_excludes_non_contiguous(self):
        workbook = openpyxl.Workbook()
        utility = workbook.active
        utility.title = 'Reliability_States'
        header = ['Data Year', 'Utility Number', 'Utility Name', 'State', 'Ownership'] + ['value']*23
        header[14] = 'Number of Customers'
        utility.append(['IEEE Standard'])
        utility.append(['All Events'])
        utility.append(header)
        # Different Other Standard values must not leak into the IEEE series.
        utility.append([2025, 1, 'Utility A', 'CA', 'Investor Owned', 200, 2, 100, 50, .5, 100, 1, 1, 1, 1000, 25, 'Y', 900, 9, 100, 700, 7, 100, 999])
        utility.append([2025, 2, 'Utility B', 'AK', 'Cooperative', 500, 5, 100, 500, 5, 100, 1, 1, 1, 5000])
        utility.append([2025, 3, 'Utility C', 'CA', 'Cooperative', '.', '.', '.', '.', '.', '.', '.', '.', '.', '.', 25, 'Y', 900, 9, 100, 700, 7, 100, 999])
        utility.append([2025, 4, 'Utility D', 'TX', 'Municipal', 0, 0, 0, 0, 0, 0, 0, 0, 0, 50.25])
        state = workbook.create_sheet('State Totals')
        state.append(['IEEE Standard'])
        state.append(['All Events'])
        state.append(['Data Year', 'State', 'Number of Customers', 'SAIDI (minutes per year)', 'SAIFI', 'CAIDI', 'SAIDI no MED', 'SAIFI no MED'])
        state.append([2025, 'CA', 1000, 200, 2, 100, 50, .5])
        memory = io.BytesIO()
        workbook.save(memory)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('Reliability_2025.xlsx', memory.getvalue())
        rows = MODULE.parse_eia_workbook(archive.getvalue(), 2025, 'eia')
        self.assertEqual(len(rows), 12)
        self.assertEqual({row['state'] for row in rows}, {'CA', 'TX'})
        self.assertNotIn('Utility C', [row['utility'] for row in rows])
        self.assertEqual(next(row['value'] for row in rows if row['utility'] == 'Utility A' and row['metricId'] == 'eia_ieee_saidi_no_med'), 50)
        self.assertEqual(next(row['value'] for row in rows if row['utility'] == 'Utility D' and row['metricId'] == 'eia_ieee_saidi_all'), 0)
        self.assertEqual(next(row['customerCount'] for row in rows if row['utility'] == 'Utility D'), 50.25)
        self.assertTrue(all(row['region'] == 'State-level' for row in rows))

    def test_constraint_hours_and_reliability_are_not_percent_or_congestion(self):
        metrics = {row['id']: row for row in MODULE.METRICS}
        self.assertEqual(metrics['rt_congestion_event_hours']['unit'], '제약·시간')
        self.assertEqual(metrics['eia_ieee_saidi_all']['kind'], 'reliability')
        self.assertEqual(metrics['eia_ieee_saidi_all']['aggregation'], 'none')
        self.assertEqual(metrics['pge_load_headroom_min_mw']['aggregation'], 'none')
        self.assertEqual(metrics['isone_da_congestion_per_mwh_3year']['unit'], 'USD/MWh')


if __name__ == '__main__':
    unittest.main()
