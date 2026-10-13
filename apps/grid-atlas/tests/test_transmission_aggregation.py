"""Independent interval/denominator/provenance regressions for operational data."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('transmission_aggregation_review', SCRIPTS / 'collect-transmission.py')
agg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agg)


def interval(start, end, **extra):
    return dict(start=start, end=end, sourceIds=['source'], **extra)


def full_day(region, spread, mw, *, market='RT', population='load_zones'):
    start = datetime(2026, 10, 1, tzinfo=timezone.utc)
    fragment = agg.empty_fragment(region)
    for i in range(24):
        left, right = agg.iso(start+timedelta(hours=i)), agg.iso(start+timedelta(hours=i+1))
        fragment['priceIntervals'].append(interval(left, right, region=region, market=market, population=population,
                                                   populationLabel=population, resolutionMinutes=60, quantileMethod='linear-type7',
                                                   nodeCount=10, candidateNodeCount=10, p10=-3, p90=spread-3, value=spread))
        fragment['loadIntervals'].append(interval(left, right, region=region, mw=mw))
    return fragment


class TransmissionAggregationTests(unittest.TestCase):
    def test_national_uses_same_complete_utc_day_market_population_and_matched_mwh(self):
        a, b = full_day('MISO', 10, 100), full_day('NYISO', 30, 900)
        physical = full_day('CAISO', 100, 100000, population='physical_nodes')
        da = full_day('ISO-NE', 100, 100000, market='DA')
        rows = [a, b, physical, da]
        _, _, national = agg.price_aggregates(rows, agg.hourly_load(rows))
        self.assertEqual(len(national), 1)
        self.assertEqual(national[0]['regions'], ['MISO', 'NYISO'])
        self.assertEqual(national[0]['loadMwh'], 24000)
        self.assertEqual(national[0]['value'], 28)
        self.assertFalse(national[0]['nationalComplete'])
        b['loadIntervals'].pop()
        self.assertEqual(agg.price_aggregates(rows, agg.hourly_load(rows))[2], [])

    def test_subhourly_direct_load_wins_only_with_full_hour_otherwise_falls_back(self):
        fragment = agg.empty_fragment('MISO')
        begin, half, end = '2026-10-01T00:00:00Z', '2026-10-01T00:30:00Z', '2026-10-01T01:00:00Z'
        fragment['loadIntervals'] = [interval(begin, end, region='MISO', mw=100, priority=1),
                                     interval(begin, half, region='MISO', mw=200, priority=2)]
        self.assertEqual(agg.hourly_load([fragment])[('MISO', begin)]['mwh'], 100)
        fragment['loadIntervals'].append(interval(half, end, region='MISO', mw=400, priority=2))
        self.assertEqual(agg.hourly_load([fragment])[('MISO', begin)]['mwh'], 300)

    def test_binding_union_clips_to_verified_window_and_preserves_both_evidence_sides(self):
        fragment = agg.empty_fragment('MISO')
        fragment['constraintWindows'] = [dict(region='MISO', start='2026-10-01T00:00:00Z', end='2026-10-01T01:00:00Z', sourceIds=['complete-report'])]
        fragment['constraintIntervals'] = [dict(region='MISO', assetId='line-A', contingency='', binding=True, start='2026-09-30T23:55:00Z', end='2026-10-01T00:10:00Z', sourceIds=['event-A']),
                                           dict(region='MISO', assetId='line-B', contingency='', binding=True, start='2026-10-01T00:05:00Z', end='2026-10-01T00:15:00Z', sourceIds=['event-B'])]
        assets, days = agg.constraint_aggregates([fragment])
        self.assertEqual(len(days), 1)
        self.assertEqual((days[0]['observedMinutes'], days[0]['anyBindingMinutes'], days[0]['value']), (60, 15, 25))
        self.assertEqual({row['bindingMinutes'] for row in assets}, {10})
        self.assertTrue({'complete-report', 'event-A', 'event-B'} <= set(days[0]['sourceIds']))
        fragment['constraintWindows'] = []
        self.assertEqual(agg.constraint_aggregates([fragment]), ([], []))

    def test_unspecified_contingency_is_supported_for_binding_and_utilization(self):
        fragment = agg.empty_fragment('NYISO')
        base = interval('2026-10-01T00:00:00Z', '2026-10-01T00:05:00Z', region='NYISO')
        fragment['constraintWindows'] = [base]
        fragment['constraintIntervals'] = [dict(base, assetId='line', contingency=None, binding=True)]
        assets, days = agg.constraint_aggregates([fragment])
        self.assertEqual(assets[0]['contingency'], '')
        self.assertEqual(days[0]['value'], 100)
        fragment['utilizationIntervals'] = [dict(base, assetId='interface', contingency=None, flowMw=50, limitMw=100, value=50, directionalBasis='matched positive-direction limit')]
        self.assertEqual(agg.other_aggregates([fragment])[0][0]['contingency'], '')

    def test_changed_source_bytes_cannot_relabel_retained_observation(self):
        old, fresh = agg.empty_fragment('PJM'), agg.empty_fragment('PJM')
        source = dict(id='report', url='https://example.gov/report', sha256='a'*64, retrievedAt='2026-10-02T00:00:00Z')
        old['sources'] = [source]
        old['loadIntervals'] = [dict(region='PJM', start='2026-10-01T00:00:00Z', end='2026-10-01T01:00:00Z', mw=100, sourceIds=['report'])]
        fresh['sources'] = [dict(source, sha256='b'*64, retrievedAt='2026-10-03T00:00:00Z')]
        fresh['loadIntervals'] = [dict(region='PJM', start='2026-10-01T01:00:00Z', end='2026-10-01T02:00:00Z', mw=200, sourceIds=['report'])]
        try:
            merged = agg.merge_fragment(old, fresh)
        except ValueError:
            return  # Fail closed is also acceptable; collector preserves the old fragment.
        sources = {row['id']: row for row in merged['sources']}
        retained = next(row for row in merged['loadIntervals'] if row['mw'] == 100)
        self.assertIn('a'*64, [sources[ref]['sha256'] for ref in retained['sourceIds']])

    def test_overlapping_curtailment_energy_is_not_silently_summed(self):
        fragment = agg.empty_fragment('CAISO')
        fragment['curtailmentIntervals'] = [interval('2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', region='CAISO', reason='Local transmission', mwh=10),
                                           interval('2026-10-01T00:30:00Z', '2026-10-01T01:30:00Z', region='CAISO', reason='Local transmission', mwh=10)]
        with self.assertRaises(ValueError):
            agg.other_aggregates([fragment])

    def test_instantaneous_utilization_preserves_sample_mean_without_fake_observation_hours(self):
        fragment = agg.empty_fragment('NYISO')
        common = dict(region='NYISO', assetId='interface', contingency=None, limitMw=100,
                      directionalBasis='matched directional limit', intervalNature='instantaneous',
                      sourceUnit='MWH (as published; ratio only)')
        fragment['utilizationIntervals'] = [
            interval('2026-10-01T00:00:00Z', '2026-10-01T00:00:01Z', **common, flowMw=25, value=25),
            interval('2026-10-01T00:50:00Z', '2026-10-01T00:50:01Z', **common, flowMw=-75, value=75),
        ]
        result = agg.other_aggregates([fragment])[0]
        self.assertEqual(len(result), 1)
        row = result[0]
        self.assertEqual((row['value'], row['maximum'], row['sampleCount']), (50, 75, 2))
        self.assertEqual(row['observedHours'], 0)
        self.assertEqual(row['aggregationBasis'], 'instantaneous_samples')
        self.assertEqual(row['sourceUnit'], common['sourceUnit'])

    def test_utilization_rejects_fraction_presented_as_percent(self):
        fragment = agg.empty_fragment('ERCOT')
        row = interval('2026-10-01T00:00:00Z', '2026-10-01T00:05:00Z', region='ERCOT',
                       assetId='line', contingency='outage', flowMw=100, limitMw=100,
                       directionalBasis='same SCED constraint pair', value=1)
        fragment['utilizationIntervals'] = [row]
        with self.assertRaisesRegex(ValueError, '100 percent'):
            agg.other_aggregates([fragment])
        row['value'] = 100
        observed = agg.other_aggregates([fragment])[0][0]
        self.assertEqual(observed['value'], 100)
        self.assertAlmostEqual(observed['observedHours'], 5 / 60)
        self.assertEqual(observed['aggregationBasis'], 'dispatch_duration')


if __name__ == '__main__':
    unittest.main()
