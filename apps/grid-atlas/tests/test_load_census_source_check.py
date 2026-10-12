import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('census_source_monitor', ROOT / 'scripts/check-load-census-sources.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def observation(body=b'official document', at='2026-10-12T06:00:00.000Z'):
    return {'retrievedAt': at, 'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body),
            'httpStatus': 200, 'finalUrl': 'https://official.example/document',
            'contentType': 'text/plain', 'etag': None, 'lastModified': None}


def source(url='https://official.example/document'):
    return {'url': url, 'evidenceIds': ['first'], 'sourceFamilies': ['puc'], 'historicalEvidence': [
        {'id': 'first', 'sha256': '0' * 64, 'retrievedAt': '2025-01-01T00:00:00.000Z', 'sourceAsOf': '2024-12-31'}]}


class Response:
    def __init__(self, body=b'official document', status=200, headers=None):
        self.body = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}

    def getheader(self, key):
        return self.headers.get(key)

    def read1(self, size):
        return self.body.read(size)


class Connection:
    sock = None

    def __init__(self, response):
        self.response = response

    def request(self, *args, **kwargs):
        pass

    def getresponse(self):
        return self.response

    def close(self):
        pass


class CensusSourceMonitorTests(unittest.TestCase):
    def check(self, previous=None, body=b'official document', error=None):
        def fetcher(*args, **kwargs):
            if error:
                raise error
            return observation(body)
        return m.check_source(source(), previous, fetcher=fetcher, budget=m.Budget(1000, 10), timeout=2, max_bytes=1000)

    def test_historical_evidence_is_not_a_monitor_comparison_baseline(self):
        result = self.check()
        self.assertEqual(result['status'], 'baseline')
        self.assertIsNone(result['previousObservation'])
        self.assertTrue(result['reviewRequired'])
        self.assertNotIn('sourceAsOf', result['observation'])

    def test_unchanged_check_does_not_clear_an_unreviewed_change(self):
        old = {'observation': observation(), 'reviewRequired': True}
        result = self.check(previous=old)
        self.assertEqual(result['status'], 'unchanged')
        self.assertTrue(result['reviewRequired'])
        changed = self.check(previous={'observation': observation(), 'reviewRequired': False}, body=b'new bytes')
        self.assertEqual(changed['status'], 'changed')
        self.assertTrue(changed['reviewRequired'])

    def test_failed_check_keeps_prior_acquisition_time_and_never_has_new_hash(self):
        old = {'observation': observation(at='2026-10-01T00:00:00.000Z'), 'reviewRequired': True}
        result = self.check(previous=old, error=m.FetchError('http_error', 403))
        self.assertEqual(result['status'], 'fetch_failed')
        self.assertEqual(result['httpStatus'], 403)
        self.assertIsNone(result['observation'])
        self.assertEqual(result['previousObservation'], old['observation'])

    def test_urls_reject_credentials_http_local_ips_and_nonstandard_ports(self):
        unsafe = ['http://official.example/', 'https://user:password@official.example/',
                  'https://127.0.0.1/', 'https://169.254.169.254/latest/', 'https://10.1.1.1/',
                  'https://[::1]/', 'https://224.0.0.1/', 'https://localhost/', 'https://host.local/',
                  'https://official.example:8443/', 'https://official.example/\nHost:x',
                  'https://official.example\\@127.0.0.1/']
        for url in unsafe:
            with self.subTest(url=url), self.assertRaises(m.FetchError):
                m.public_url(url)
        self.assertEqual(m.public_url('https://OFFICIAL.example:443/a?docket=123#page=4'), 'https://official.example/a?docket=123')

    def test_dns_mixed_public_private_results_rejected_before_connection(self):
        answers = [(2, 1, 6, '', ('93.184.216.34', 443)), (2, 1, 6, '', ('10.0.0.1', 443))]
        with patch.object(m.socket, 'getaddrinfo', return_value=answers), self.assertRaises(m.FetchError) as caught:
            m.public_addresses('official.example')
        self.assertEqual(caught.exception.code, 'nonpublic_address')

    def test_connection_pins_address_and_verifies_original_tls_hostname(self):
        context = MagicMock()
        with patch.object(m.ssl, 'create_default_context', return_value=context), patch.object(m.socket, 'create_connection') as connect:
            connection = m.PublicHTTPSConnection('official.example', '93.184.216.34', 2)
            connection.connect()
        connect.assert_called_once_with(('93.184.216.34', 443), 2)
        context.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='official.example')

    def fetch_response(self, response, max_bytes=1000, total_bytes=1000):
        with patch.object(m, 'public_addresses', return_value=['93.184.216.34']), patch.object(m, 'PublicHTTPSConnection', return_value=Connection(response)):
            return m.fetch('https://official.example/document', budget=m.Budget(total_bytes, 10), timeout=2, max_bytes=max_bytes)

    def test_actual_download_bytes_are_hashed_and_truncation_is_not_success(self):
        result = self.fetch_response(Response(b'real downloaded bytes', headers={'Content-Length': '21'}))
        self.assertEqual(result['sha256'], hashlib.sha256(b'real downloaded bytes').hexdigest())
        self.assertEqual(result['bytes'], 21)
        self.assertTrue(result['retrievedAt'].endswith('Z'))
        with self.assertRaises(m.FetchError) as caught:
            self.fetch_response(Response(b'short', headers={'Content-Length': '10'}))
        self.assertEqual(caught.exception.code, 'truncated_response')

    def test_redirect_to_private_url_and_403_are_not_retried(self):
        with self.assertRaises(m.FetchError) as caught:
            self.fetch_response(Response(status=302, headers={'Location': 'https://127.0.0.1/private'}))
        self.assertEqual(caught.exception.code, 'unsafe_url')
        with self.assertRaises(m.FetchError) as caught:
            self.fetch_response(Response(status=403))
        self.assertEqual(caught.exception.http_status, 403)

    def test_stream_and_total_byte_limits_fail_without_a_partial_hash(self):
        for source_limit, total_limit, code in [(5, 1000, 'source_byte_limit'), (1000, 5, 'run_byte_limit')]:
            with self.subTest(), self.assertRaises(m.FetchError) as caught:
                self.fetch_response(Response(b'oversized document'), source_limit, total_limit)
            self.assertEqual(caught.exception.code, code)

    def test_unique_url_manifest_preserves_all_references(self):
        data = {'schemaVersion': 1, 'evidence': [
            {'id': 'a', 'url': 'https://official.example/report#page=1', 'sourceFamily': 'puc'},
            {'id': 'b', 'url': 'https://official.example/report#page=2', 'sourceFamily': 'utility'},
        ]}
        sources = m.source_manifest(data)
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]['evidenceIds'], ['a', 'b'])
        self.assertEqual(sources[0]['sourceFamilies'], ['puc', 'utility'])

    def test_run_is_read_only_reports_deferred_sources_and_rotates_them(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            census = base / 'census.json'
            census.write_text(json.dumps({'schemaVersion': 1, 'generatedAt': '2026-10-12T00:00:00.000Z', 'evidence': [
                {'id': 'a', 'url': 'https://a.example/report', 'sourceFamily': 'puc'},
                {'id': 'b', 'url': 'https://b.example/report', 'sourceFamily': 'utility'},
            ], 'entities': [{'id': 'preserve-me', 'status': 'study', 'score': None}]}))
            original = census.read_bytes()
            args = SimpleNamespace(input=census, state_dir=base / 'state', max_sources=1, workers=1,
                                   timeout=2, max_bytes=1000, max_total_bytes=1000, max_seconds=10)
            fetched = []

            def fetcher(url, **kwargs):
                fetched.append(url)
                return observation()

            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.run(args, fetcher=fetcher), 0)
                self.assertEqual(m.run(args, fetcher=fetcher), 0)
            self.assertEqual(fetched, ['https://a.example/report', 'https://b.example/report'])
            self.assertEqual(census.read_bytes(), original)
            report = json.loads((args.state_dir / 'latest-report.json').read_text())
            self.assertEqual(report['status'], 'partial')
            self.assertEqual(report['counts'], {'baseline': 1, 'skipped_limit': 1})
            prior = json.loads((args.state_dir / 'state.json').read_text())

            def failed(*args, **kwargs):
                raise m.FetchError('http_error', 403)

            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.run(args, fetcher=failed), 1)
            after = json.loads((args.state_dir / 'state.json').read_text())
            self.assertEqual(after['sources']['https://a.example/report']['observation'], prior['sources']['https://a.example/report']['observation'])
            self.assertEqual(census.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
