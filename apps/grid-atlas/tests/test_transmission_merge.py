"""Rolling refresh replaces observed intervals without erasing uncovered history."""
import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('transmission_merge_review', SCRIPTS / 'collect-transmission.py')
agg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agg)


def fragment(region, revision):
    result = agg.empty_fragment(region)
    result['sources'] = [dict(id='report', title='Official interval fixture', publisher=region,
                              url='https://example.org/report', sha256=revision*64,
                              retrievedAt='2026-10-13T00:00:00Z')]
    return result


def interval(region, start, end, **fields):
    return dict(region=region, start=start, end=end, sourceIds=['report'], **fields)


def utilization(start, end, value, **fields):
    return interval('ERCOT', start, end, assetId='WESTEX', contingency='BASE CASE',
                    flowMw=value, limitMw=100, value=value,
                    directionalBasis='Matched SCED flow and limit', **fields)


class TransmissionMergeTests(unittest.TestCase):
    def test_clipped_sced_refresh_preserves_prior_seconds_provenance_and_is_idempotent(self):
        old, fresh = fragment('ERCOT', 'a'), fragment('ERCOT', 'b')
        begin, boundary, end = '2026-10-11T04:55:17Z', '2026-10-11T05:00:00Z', '2026-10-11T05:00:18Z'
        old['utilizationIntervals'] = [utilization(begin, end, 50)]
        fresh['utilizationIntervals'] = [utilization(boundary, end, 100)]
        unrelated = dict(old['utilizationIntervals'][0], assetId='OTHER')
        other_contingency = dict(old['utilizationIntervals'][0], contingency='OTHER OUTAGE')
        old['utilizationIntervals'].extend([unrelated, other_contingency])
        merged = agg.merge_fragment(old, fresh)
        agg.validate_sources([merged])
        rows = sorted((row for row in merged['utilizationIntervals'] if row['assetId']=='WESTEX' and row['contingency']=='BASE CASE'), key=lambda row: row['start'])
        self.assertEqual([(row['start'], row['end']) for row in rows], [(begin, boundary), (boundary, end)])
        self.assertEqual([row['sourceIds'] for row in rows], [['report@'+'a'*16], ['report@'+'b'*16]])
        self.assertEqual([row['flowMw'] for row in rows], [50, 100])
        daily = agg.other_aggregates([merged])[0]
        target = next(row for row in daily if row['assetId']=='WESTEX' and row['contingency']=='BASE CASE')
        self.assertAlmostEqual(target['observedHours'], 301/3600)
        self.assertAlmostEqual(target['value'], (283*50+18*100)/301)
        self.assertEqual(len(daily), 3)
        self.assertEqual(agg.merge_fragment(merged, fresh), merged)

    def test_partial_overlap_curtailment_energy_is_not_prorated_into_invented_subintervals(self):
        old, fresh = fragment('CAISO', 'a'), fragment('CAISO', 'b')
        def row(start, end, **fields):
            return interval('CAISO', '2026-10-11T'+start+'Z', '2026-10-11T'+end+'Z', **fields)
        old['curtailmentIntervals'] = [row('00:00:00', '02:00:00', mwh=20, reason='Local transmission')]
        fresh['curtailmentIntervals'] = [row('00:30:00', '00:45:00', mwh=5, reason='Local transmission'),
                                          row('01:00:00', '01:30:00', mwh=6, reason='Local transmission')]
        merged = agg.merge_fragment(old, fresh)
        retained_energy = [row['mwh'] for row in merged['curtailmentIntervals'] if row['sourceIds']==['report@'+'a'*16]]
        self.assertEqual(retained_energy, [20])
        with self.assertRaisesRegex(ValueError, 'Overlapping curtailment energy intervals'):
            agg.other_aggregates([merged])

    def test_complete_constraint_window_clears_only_covered_portion_of_old_event(self):
        old, fresh = fragment('MISO', 'a'), fragment('MISO', 'b')
        begin, left, right, end = ['2026-10-11T'+value+'Z' for value in ['00:00:00', '00:15:00', '00:45:00', '01:00:00']]
        old['constraintWindows'] = [interval('MISO', begin, end)]
        old['constraintIntervals'] = [interval('MISO', begin, end, assetId='LINE', contingency='', binding=True)]
        fresh['constraintWindows'] = [interval('MISO', left, right)]
        merged = agg.merge_fragment(old, fresh)
        self.assertEqual([(row['start'],row['end']) for row in merged['constraintIntervals']], [(begin,left),(right,end)])
        assets, coverage = agg.constraint_aggregates([merged])
        self.assertEqual((assets[0]['bindingMinutes'], coverage[0]['observedMinutes'], coverage[0]['value']), (30, 60, 50))
        self.assertEqual(set(coverage[0]['sourceIds']), {'report@'+'a'*16, 'report@'+'b'*16})

    def test_new_overlaps_still_fail_instead_of_silently_changing_evidence(self):
        old, fresh = fragment('ERCOT', 'a'), fragment('ERCOT', 'b')
        fresh['utilizationIntervals'] = [utilization('2026-10-11T00:00:00Z', '2026-10-11T00:05:00Z', 50),
                                         utilization('2026-10-11T00:04:00Z', '2026-10-11T00:06:00Z', 60)]
        with self.assertRaisesRegex(ValueError, 'Overlapping utilization intervals'):
            agg.other_aggregates([agg.merge_fragment(old, fresh)])


if __name__ == '__main__':
    unittest.main()
