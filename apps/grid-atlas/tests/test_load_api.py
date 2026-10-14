"""API collection invariants: immutable vintages, source semantics and failure safety."""
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import load_api as api

FETCHED = '2026-10-14T15:00:00.000000Z'


def row(month='2026-06-01', total=466497.0, report='2026-06-19'):
    return {
        'snapshot_month': month, 'report_date': report, 'total_mw': total,
        'colocated_mw': 69708.0, 'standalone_mw': 396789.0,
        'by_status': {'observed_energized': 5700, 'under_ercot_review': 151100,
                      'no_studies_submitted': 257600, 'planning_studies_approved': None,
                      'approved_to_energize_not_operational': 3200},
        'by_size_bucket': {'75_250mw': {'mw': 18686, 'count': 115},
                           '250_500mw': {'mw': 50198, 'count': 144},
                           '500_1000mw': {'mw': 114851, 'count': 175},
                           '1000mw_plus': {'mw': 305149, 'count': 207}},
        'by_type': {'data_center': {'mw': 420812.0, 'pct': 90.2}},
        'by_zone': {'other': 60927, 'lz_west': 82247, 'lz_north': 56788},
        'approved_to_energize_mw': 8926.0, 'planning_studies_approved_mw': 37085.0,
        'trailing_12mo': {'2026-05': 471415, '2026-06': total},
        'source_url': 'https://www.ercot.com/files/docs/2026/06/18/June-19-LLWG-Report.pptx',
        'extracted_at': '2026-08-05T03:43:08.458981Z',
    }


def receipt(name='history', fetched=FETCHED):
    return {'url': api.ENDPOINTS[name], 'fetchedAt': fetched, 'httpStatus': 200,
            'sha256': 'a' * 64, 'bytes': 100, 'recordCount': 1}


def mock_fetcher(history, latest=None, failure=None):
    latest = latest or history[-1]
    def fetch(url, path, receipts):
        endpoint = url.rsplit('/', 1)[-1]
        result = copy.deepcopy(history if endpoint == 'history' else latest)
        metadata = receipt(endpoint, api.now())
        if failure and endpoint == failure:
            metadata.update(httpStatus=503, sha256=None, bytes=0, recordCount=None)
            receipts.append(metadata)
            raise api.CollectionError('public API HTTP 503')
        body = json.dumps(result).encode()
        metadata.update(sha256=api.sha(body), bytes=len(body), recordCount=len(result) if isinstance(result, list) else 1)
        receipts.append(metadata)
        path.mkdir(parents=True, exist_ok=True)
        (path / (metadata['sha256'] + '.json')).write_bytes(body)
        return result, metadata
    return fetch


class NormalizeTests(unittest.TestCase):
    def test_real_scope_disagreements_are_preserved_not_scored(self):
        normalized = api.normalize(row(), receipt())
        issues = {item['code']: item for item in normalized['qualityIssues']}
        self.assertEqual(normalized['totalMw'], 466497)
        self.assertEqual(issues['stages_total_mismatch']['reportedSumMw'], 417600)
        self.assertEqual(issues['size_total_mismatch']['reportedSumMw'], 488884)
        self.assertEqual(issues['zone_scope_unverified']['reportedSumMw'], 199962)
        self.assertIn('stages_incomplete', issues)
        self.assertEqual(normalized['byStatus']['planning_studies_approved'], None)
        self.assertEqual(normalized['scope'], 'regional_aggregate')
        self.assertEqual(normalized['verification'], 'provider_extraction_unverified')
        self.assertNotIn('score', normalized)
        self.assertNotIn('projectCount', normalized)
        self.assertEqual(normalized['receipt']['sha256'], 'a' * 64)
        self.assertNotEqual(normalized['payloadSha256'], normalized['receipt']['sha256'])

    def test_nullable_fields_do_not_become_zero_or_invent_counts(self):
        raw = row()
        for key in ('by_status', 'by_type', 'by_zone', 'trailing_12mo', 'approved_to_energize_mw', 'planning_studies_approved_mw', 'extracted_at'):
            raw[key] = None
        raw['by_size_bucket'] = {'1000_plus': 271857, 'unknown': None}
        normalized = api.normalize(raw, receipt())
        self.assertIsNone(normalized['byStatus'])
        self.assertIsNone(normalized['approvedToEnergizeMw'])
        self.assertIsNone(normalized['providerExtractedAt'])
        self.assertEqual(normalized['bySizeBucket']['1000_plus'], {'mw': 271857, 'count': None})
        self.assertEqual(normalized['bySizeBucket']['unknown'], {'mw': None, 'count': None})
        raw['total_mw'] = 0
        self.assertEqual(api.normalize(raw, receipt())['totalMw'], 0)

    def test_invalid_dates_capacities_units_and_unknown_fields_rejected(self):
        cases = [
            ('snapshot_month', '2026-06-12'), ('report_date', '2026-02-30'),
            ('snapshot_month', '2027-01-01'), ('report_date', '2027-01-01'),
            ('total_mw', None), ('total_mw', -1), ('total_mw', float('nan')),
            ('total_mw', float('inf')), ('total_mw', True), ('total_mw', '466497'),
            ('by_zone', {'bad': -1}), ('by_type', {'data_center': {'mw': 1, 'pct': 110}}),
            ('by_size_bucket', {'large': {'mw': 1, 'count': 1.5}}),
            ('trailing_12mo', {'2026-13': 2}), ('trailing_12mo', {'2026-07': 2}),
            ('extracted_at', '2026-08-05T03:00:00'), ('extracted_at', '2027-08-05T03:00:00Z'),
            ('total_gw', 466.497),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                raw = row()
                raw[key] = value
                with self.assertRaises(api.CollectionError):
                    api.normalize(raw, receipt())

    def test_original_source_url_rejects_credentials_queries_or_other_hosts(self):
        for url in ['http://www.ercot.com/files/docs/file.pdf', 'https://ercot.com@evil.test/file.pdf',
                    'https://user:secret@www.ercot.com/files/docs/file.pdf',
                    'https://www.ercot.com/files/docs/file.pdf?token=secret',
                    'https://www.ercot.com.evil.test/files/docs/file.pdf',
                    'https://www.ercot.com:invalid/files/docs/file.pdf',
                    'https://www.ercot.com/files/docs/file.pdf#secret',
                    'https://www.ercot.com/other/file.pdf',
                    'https://www.ercot.com\\@evil.test/files/docs/file.pdf']:
            with self.subTest(url=url):
                raw = row()
                raw['source_url'] = url
                with self.assertRaises(api.CollectionError):
                    api.normalize(raw, receipt())

    def test_duplicate_json_and_nonfinite_rejected(self):
        for body in [b'{"total_mw":1,"total_mw":2}', b'{"total_mw":NaN}', b'<html>bad gateway</html>']:
            with self.assertRaises(api.CollectionError):
                api.strict_json(body)


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'data.json'
        self.state = Path(self.tmp.name) / 'state'

    def collect(self, history=None, latest=None, failure=None):
        return api.collect(self.path, self.state, fetcher=mock_fetcher(history or [row()], latest, failure))

    def test_idempotence_preserves_actual_first_fetch_and_raw_receipt(self):
        with patch.object(api, 'now', return_value=FETCHED):
            code, initial = self.collect()
        with patch.object(api, 'now', return_value='2026-10-15T15:00:00.000000Z'):
            second_code, repeated = self.collect()
        self.assertEqual((code, second_code), (0, 0))
        self.assertEqual(initial['collection']['addedCount'], 1)
        self.assertEqual(repeated['collection']['addedCount'], 0)
        self.assertEqual(initial['records'], repeated['records'])
        self.assertEqual(repeated['records'][0]['fetchedAt'], FETCHED)
        self.assertNotEqual(initial['collection']['completedAt'], repeated['collection']['completedAt'])
        self.assertEqual(len(list((self.state / 'runs').glob('*/raw/*.json'))), 4)
        self.assertEqual(api.validate_dataset(repeated), repeated)

    def test_changed_payload_appends_revision_same_source_month_report(self):
        _, initial = self.collect()
        revised = row(total=466498)
        _, updated = self.collect([revised])
        self.assertEqual(len(updated['records']), 2)
        self.assertIn(initial['records'][0], updated['records'])
        self.assertEqual({record['totalMw'] for record in updated['records']}, {466497, 466498})
        self.assertEqual(updated['collection']['addedCount'], 1)
        self.assertTrue(updated['collection']['warnings'])

    def test_disappearance_retains_old_month_without_fake_retirement(self):
        early = row('2026-05-01', 438595, '2026-05-20')
        early['trailing_12mo'] = {'2026-05': 438595}
        early['source_url'] = 'https://www.ercot.com/files/docs/2026/05/20/May-21-LLWG-Report.pptx'
        _, before = self.collect([early, row()])
        _, after = self.collect([row()])
        self.assertEqual(before['records'], after['records'])
        self.assertEqual(after['collection']['addedCount'], 0)
        self.assertTrue(any('preserved' in warning for warning in after['collection']['warnings']))

    def test_late_historical_vintage_preserves_report_and_acquisition_dates(self):
        self.collect()
        late = row('2022-08-01', 35142, '2022-08-22')
        late['source_url'] = 'https://www.ercot.com/files/docs/2022/08/22/LLI.pdf'
        late['trailing_12mo'] = {'2022-08': 35142}
        _, dataset = self.collect([late, row()])
        stored = next(item for item in dataset['records'] if item['snapshotMonth'] == '2022-08-01')
        self.assertEqual(stored['reportDate'], '2022-08-22')
        self.assertTrue(stored['fetchedAt'].startswith('2026-'))
        self.assertEqual(stored['providerExtractedAt'], '2026-08-05T03:43:08.458981Z')

    def test_endpoint_failure_keeps_records_and_last_success_but_marks_failed(self):
        _, initial = self.collect()
        code, failed = self.collect(failure='latest')
        self.assertEqual(code, 1)
        self.assertEqual(failed['records'], initial['records'])
        self.assertEqual(failed['collection']['lastSuccessAt'], initial['collection']['lastSuccessAt'])
        self.assertEqual(failed['collection']['addedCount'], 0)
        self.assertEqual(failed['collection']['status'], 'failed')
        self.assertEqual(failed['collection']['endpointReceipts'][-1]['httpStatus'], 503)
        report = json.loads((self.state / 'last-run.json').read_text())
        self.assertEqual(report['status'], 'failed')
        api.validate_dataset(failed)

    def test_failed_first_run_contains_no_fake_observation(self):
        code, failed = self.collect(failure='history')
        self.assertEqual(code, 1)
        self.assertEqual(failed['records'], [])
        self.assertIsNone(failed['collection']['lastSuccessAt'])
        self.assertEqual(failed['collection']['status'], 'failed')

    def test_malformed_history_or_cross_endpoint_disagreement_is_atomic(self):
        _, initial = self.collect()
        for history, latest in [([row(), {'bad': 'row'}], row()), ([row()], row(total=500000))]:
            with self.subTest(history=history):
                code, failed = self.collect(history, latest)
                self.assertEqual(code, 1)
                self.assertEqual(failed['records'], initial['records'])
                self.assertEqual(failed['collection']['addedCount'], 0)

    def test_latest_regression_rejects_even_if_history_disappears(self):
        _, initial = self.collect()
        old = row('2026-05-01', 438595, '2026-05-20')
        old['trailing_12mo'] = None
        for history in ([old, row()], [old]):
            with self.subTest(history=history):
                code, failed = self.collect(history, old)
                self.assertEqual(code, 1)
                self.assertIn('regressed', failed['collection']['error'])
                self.assertEqual(failed['records'], initial['records'])

    def test_same_month_distinct_report_vintages_are_kept(self):
        old_vintage = row(report='2026-06-18')
        old_vintage['source_url'] = 'https://www.ercot.com/files/docs/2026/06/18/earlier.pdf'
        code, dataset = self.collect([old_vintage, row()])
        self.assertEqual(code, 0)
        self.assertEqual(len(dataset['records']), 2)
        self.assertEqual(len({item['snapshotMonth'] for item in dataset['records']}), 1)

    def test_latest_same_month_older_report_is_rejected(self):
        _, initial = self.collect()
        old_vintage = row(report='2026-06-18')
        old_vintage['source_url'] = 'https://www.ercot.com/files/docs/2026/06/18/earlier.pdf'
        for history in ([old_vintage, row()], [old_vintage]):
            with self.subTest(history=history):
                code, dataset = self.collect(history, old_vintage)
                self.assertEqual(code, 1)
                self.assertIn('report date regressed', dataset['collection']['error'])
                self.assertEqual(dataset['records'], initial['records'])

    def test_lock_prevents_overlapping_collectors_from_losing_revisions(self):
        _, initial = self.collect()
        with api.collection_lock(self.state):
            with self.assertRaisesRegex(api.CollectionError, 'another load API collection'):
                self.collect()
        self.assertEqual(json.loads(self.path.read_text()), initial)

    def test_check_detects_tampered_value_or_scope_and_never_repairs_it(self):
        _, dataset = self.collect()
        before = self.path.read_bytes()
        for key, value in [('totalMw', 1), ('scope', 'project_register'), ('fetchedAt', '2020-01-01T00:00:00Z')]:
            modified = copy.deepcopy(dataset)
            modified['records'][0][key] = value
            with self.assertRaises(api.CollectionError):
                api.validate_dataset(modified)
        self.assertEqual(before, self.path.read_bytes())

    def test_unexpected_failure_exit_two_preserves_records(self):
        _, initial = self.collect()
        def broken(*_args):
            raise RuntimeError('private exception details')
        code, dataset = api.collect(self.path, self.state, fetcher=broken)
        self.assertEqual(code, 2)
        self.assertEqual(dataset['records'], initial['records'])
        self.assertNotIn('private', dataset['collection']['error'])


class Response(io.BytesIO):
    status = 200
    def __init__(self, body, length=None):
        super().__init__(body)
        self.headers = {'Content-Length': str(len(body) if length is None else length)}


class FetchTests(unittest.TestCase):
    def test_retry_transient_error_records_attempts_and_saves_actual_bytes(self):
        class Opener:
            calls = 0
            def open(self, request, timeout):
                self.calls += 1
                if self.calls == 1:
                    raise urllib.error.HTTPError(request.full_url, 503, 'unavailable', {}, None)
                return Response(b'[]')
        with tempfile.TemporaryDirectory() as folder:
            receipts = []
            payload, current = api.fetch_endpoint(api.ENDPOINTS['history'], Path(folder), receipts, opener=Opener(), sleep=lambda _: None)
            self.assertEqual(payload, [])
            self.assertEqual([item['httpStatus'] for item in receipts], [503, 200])
            self.assertEqual(current['sha256'], api.sha(b'[]'))
            self.assertEqual((Path(folder) / (current['sha256'] + '.json')).read_bytes(), b'[]')

    def test_payload_limit_truncation_and_invalid_json_fail(self):
        for body, length in [(b'[]', api.MAX_BYTES + 1), (b'[]', 5), (b'<html>Error</html>', None)]:
            with self.subTest(body=body, length=length), tempfile.TemporaryDirectory() as folder:
                class Opener:
                    def open(self, _request, timeout):
                        return Response(body, length)
                with self.assertRaises(api.CollectionError):
                    api.fetch_endpoint(api.ENDPOINTS['history'], Path(folder), [], opener=Opener())

    def test_redirect_is_not_followed_to_unreviewed_host(self):
        handler = api.NoRedirect()
        with self.assertRaises(api.CollectionError):
            handler.redirect_request(None, None, 302, '', {}, 'https://other.test')


if __name__ == '__main__':
    unittest.main()
