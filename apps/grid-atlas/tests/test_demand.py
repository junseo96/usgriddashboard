"""Demand quality, interval semantics, DST and source-failure regression tests."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from zoneinfo import ZoneInfo

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/collect-demand.py'
spec = importlib.util.spec_from_file_location('grid_demand', SCRIPT)
demand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demand)
UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 8, 12, tzinfo=UTC)


def row(code='NYIS', timestamp='10/08/2026 11:00:00', value=12000, flag=None, reported=True):
    return {'RESPONDENT_ID': code, 'TYPE_ID': 'D', 'TIMESTAMP_': timestamp,
            'VAL': value, 'REPORTED_VAL': value if reported else None,
            'IMPUTED_VAL': None if reported else value, 'FLAG_ID': flag,
            'FLAG_DESCRIPTION': 'Not reported' if flag else None}


def envelope(rows):
    return json.dumps([{'data': rows, 'recordCount': len(rows), 'totalCount': len(rows)}]).encode()


def point(when, mw=100, quality=None):
    return {'observedAt': demand.iso(when), 'mw': mw, 'quality': quality}


class DemandTests(unittest.TestCase):
    def test_reported_only_and_flags_are_preserved(self):
        rows = [row(), row(timestamp='10/08/2026 12:00:00', value=13000, flag='x', reported=False)]
        result = demand.parse_eia(envelope(rows), NOW, demand.EIA_ENDPOINT)['NYISO']
        self.assertEqual(result['latestMw'], 12000)
        self.assertEqual(len(result['series']), 1)
        self.assertIn('추정·대체값 1개', ' '.join(result['warnings']))
        result = demand.parse_eia(envelope([row(flag='a')]), NOW, demand.EIA_ENDPOINT)['NYISO']
        self.assertIn('a:', result['series'][0]['quality'])

    def test_schema_truncation_and_measure_rejected(self):
        data = json.loads(envelope([row()]))
        data[0]['totalCount'] = 2
        with self.assertRaisesRegex(ValueError, 'truncated'):
            demand.parse_eia(json.dumps(data).encode(), NOW, demand.EIA_ENDPOINT)
        bad = row(); bad['TYPE_ID'] = 'DF'
        with self.assertRaisesRegex(ValueError, 'measure'):
            demand.parse_eia(envelope([bad]), NOW, demand.EIA_ENDPOINT)

    def test_bad_numbers_do_not_become_actual_load(self):
        for value in [None, True, -10, float('nan'), float('inf'), '1200']:
            result = demand.parse_eia(envelope([row(value=value)]), NOW, demand.EIA_ENDPOINT)
            self.assertEqual(result, {})

    def test_future_data_is_not_current(self):
        result = demand.parse_eia(envelope([row(), row(timestamp='10/08/2026 13:00:00')]), NOW, demand.EIA_ENDPOINT)['NYISO']
        self.assertEqual(len(result['series']), 1)
        self.assertIn('이후의 관측 1개', ' '.join(result['warnings']))

    def test_conflicting_duplicate_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            demand.parse_eia(envelope([row(), row(value=123)]), NOW, demand.EIA_ENDPOINT)

    def test_hour_ending_midnight_belongs_to_previous_local_day(self):
        midnight = dt.datetime(2026, 10, 8, 4, tzinfo=UTC)
        peaks = demand.daily_peaks([point(midnight, 500)], 'America/New_York', 60, NOW, True)
        self.assertEqual(peaks[0]['date'], '2026-10-07')
        self.assertEqual(peaks[0]['peakAt'], '2026-10-08T04:00:00Z')
        self.assertEqual(peaks[0]['expectedObservations'], 24)
        self.assertFalse(peaks[0]['complete'])

    def test_instantaneous_midnight_belongs_to_same_local_day(self):
        peaks = demand.daily_peaks([point(dt.datetime(2026, 10, 8, 4, tzinfo=UTC))], 'America/New_York', 5, NOW)
        self.assertEqual(peaks[0]['date'], '2026-10-08')
        self.assertEqual(peaks[0]['expectedObservations'], 288)

    def test_dst_spring_and_fall_days_use_23_and_25_hours(self):
        for date, count in [(dt.date(2026, 3, 8), 23), (dt.date(2026, 11, 1), 25)]:
            start = dt.datetime.combine(date, dt.time(), ZoneInfo('America/New_York')).astimezone(UTC)
            series = [point(start + dt.timedelta(hours=index + 1), 100 + index) for index in range(count)]
            peaks = demand.daily_peaks(series, 'America/New_York', 60, start + dt.timedelta(days=2), True)
            self.assertEqual(len(peaks), 1)
            self.assertEqual(peaks[0]['expectedObservations'], count)
            self.assertTrue(peaks[0]['complete'])

    def test_quality_flag_prevents_complete_peak_claim(self):
        start = dt.datetime(2026, 10, 7, 4, tzinfo=UTC)
        series = [point(start + dt.timedelta(hours=index + 1), quality='suspect' if index == 4 else None) for index in range(24)]
        peaks = demand.daily_peaks(series, 'America/New_York', 60, NOW, True)
        self.assertFalse(peaks[0]['complete'])
        self.assertEqual(peaks[0]['observations'], 24)

    def test_failed_collection_preserves_last_good_timestamps_and_value(self):
        success, _ = demand.collect(NOW, lambda _: envelope([row(code=item[0]) for item in demand.REGIONS.values()]), eia_only=True)
        later = NOW + dt.timedelta(days=1)
        def fail(_): raise RuntimeError('source unavailable')
        result, report = demand.collect(later, fail, success)
        self.assertEqual(report['status'], 'failed')
        for before, after in zip(success['regions'], result['regions']):
            for key in ['observedAt', 'retrievedAt', 'latestMw', 'series', 'dailyPeaks']:
                self.assertEqual(before[key], after[key])
            self.assertEqual(after['status'], 'stale')
        self.assertEqual(result['lastAttemptAt'], demand.iso(later))

    def test_total_failure_without_prior_has_null_not_zero(self):
        def fail(_): raise RuntimeError('source unavailable')
        result, report = demand.collect(NOW, fail)
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(all(item['latestMw'] is None and item['status'] == 'unavailable' for item in result['regions']))

    def test_direct_failure_falls_back_to_hourly_with_notice(self):
        def fail(*args, **kwargs): raise ValueError('schema changed')
        result, report = demand.collect(NOW, lambda _: envelope([row(code=item[0]) for item in demand.REGIONS.values()]), direct=fail)
        self.assertEqual(report['status'], 'success')
        self.assertTrue(all(item['intervalMinutes'] == 60 for item in result['regions']))
        self.assertTrue(all('직접 운영기관 피드 갱신 실패' in ' '.join(item['warnings']) for item in result['regions']))

    def test_stale_direct_does_not_hide_newer_hourly_actual(self):
        def direct(region, fetch, now, days):
            if region != 'NYISO': return None
            result = demand.parse_eia(envelope([row(timestamp='10/08/2026 02:00:00')]), NOW, demand.EIA_ENDPOINT)['NYISO']
            result['intervalMinutes'] = 5
            result['sourceName'] = 'Direct test source'
            return result
        result, report = demand.collect(NOW, lambda _: envelope([row(code=item[0]) for item in demand.REGIONS.values()]), direct=direct)
        nyiso = next(item for item in result['regions'] if item['region'] == 'NYISO')
        self.assertEqual(nyiso['intervalMinutes'], 60)
        self.assertEqual(nyiso['observedAt'], '2026-10-08T11:00:00Z')

    def test_prior_hourly_peaks_keep_source_and_cadence_beside_direct_today(self):
        rows = [row(code=item[0]) for item in demand.REGIONS.values()]
        rows += [row(code='ERCO', timestamp='10/07/2026 15:00:00', value=70000)]
        def direct(region, fetch, now, days):
            if region != 'ERCOT': return None
            result = demand.parse_eia(envelope([row(code='ERCO')]), NOW, demand.EIA_ENDPOINT)['ERCOT']
            result.update(intervalMinutes=5, sourceName='ERCOT 5min', sourceUrl='https://www.ercot.com/', _intervalEnding=False)
            return result
        result, _ = demand.collect(NOW, lambda _: envelope(rows), direct=direct)
        ercot = next(item for item in result['regions'] if item['region'] == 'ERCOT')
        self.assertEqual(len(ercot['series']), 1)
        self.assertEqual(len(ercot['dailyPeaks']), 2)
        self.assertEqual([peak['intervalMinutes'] for peak in ercot['dailyPeaks']], [60, 5])
        self.assertIn('EIA', ercot['dailyPeaks'][0]['sourceName'])
        self.assertEqual(ercot['dailyPeaks'][1]['sourceName'], 'ERCOT 5min')

    def test_source_regression_does_not_overwrite_newer_verified_observation(self):
        initial, _ = demand.collect(NOW, lambda _: envelope([row(code=item[0]) for item in demand.REGIONS.values()]))
        result, report = demand.collect(NOW + dt.timedelta(minutes=5), lambda _: envelope([row(code=item[0], timestamp='10/08/2026 10:00:00', value=1) for item in demand.REGIONS.values()]), initial)
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(all(item['latestMw'] == 12000 and item['observedAt'] == '2026-10-08T11:00:00Z' and item['status'] == 'stale' for item in result['regions']))

    def test_cached_dataset_validation_accepts_verified_collection(self):
        value, _ = demand.collect(NOW, lambda _: envelope([row(code=item[0]) for item in demand.REGIONS.values()]))
        self.assertIs(demand.validate_previous(value, NOW), value)

    def test_cached_dataset_rejects_corruption_before_retention(self):
        value, _ = demand.collect(NOW, lambda _: envelope([row(code=item[0]) for item in demand.REGIONS.values()]))
        def mutations():
            item = copy.deepcopy(value); item['regions'].pop(); yield item
            item = copy.deepcopy(value); item['regions'][1] = item['regions'][0]; yield item
            item = copy.deepcopy(value); item['regions'][0]['latestMw'] = -1; yield item
            item = copy.deepcopy(value); item['regions'][0]['series'][0]['mw'] = True; yield item
            item = copy.deepcopy(value); item['regions'][0]['latestMw'] = 500; yield item
            item = copy.deepcopy(value); item['regions'][0]['timezone'] = 'UTC'; yield item
            item = copy.deepcopy(value); item['regions'][0]['series'] *= 2; yield item
            item = copy.deepcopy(value); item['regions'][0]['dailyPeaks'][0]['expectedObservations'] = 23; yield item
            item = copy.deepcopy(value); item['regions'][0]['observedAt'] = '2026-10-08'; yield item
            item = copy.deepcopy(value); item['regions'][0]['sourceUrl'] = 'https://attacker.test'; yield item
            item = copy.deepcopy(value); item['regions'][0]['status'] = 'unavailable'; yield item
            item = copy.deepcopy(value); item['generatedAt'] = '2030-01-01T00:00:00Z'; yield item
        for index, corrupt in enumerate(mutations()):
            with self.subTest(index=index):
                with self.assertRaises(ValueError): demand.validate_previous(corrupt, NOW)

    def test_only_official_tls_source_urls_allowed(self):
        for url in ['http://www.eia.gov/', 'https://attacker.test/', 'https://user:pass@www.eia.gov/', 'https://www.eia.gov:8443/']:
            with self.assertRaises(ValueError): demand.check_url(url)
        demand.check_url('https://www.eia.gov/electricity/930-api/region_data/data')

    def test_atomic_json_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / 'new/grid-demand.json'
            demand.atomic_json(destination, {'verified': True})
            self.assertEqual(json.loads(destination.read_text()), {'verified': True})
            self.assertEqual(len(list(destination.parent.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
