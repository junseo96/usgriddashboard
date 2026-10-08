import contextlib
import copy
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('collector', ROOT / 'scripts/collect.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
bootstrap_spec = importlib.util.spec_from_file_location('bootstrap_builder', ROOT / 'scripts/build-bootstrap.py')
b = importlib.util.module_from_spec(bootstrap_spec)
bootstrap_spec.loader.exec_module(b)


def fixture(count=74, duplicate=False, status='1', mw='40', changed_legend=False):
    ns = c.NS['x']
    book = f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Load Projects" sheetId="1" r:id="rId1"/></sheets></workbook>'
    rel = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    sheet = ET.Element('worksheet', xmlns=ns)
    table = ET.SubElement(sheet, 'sheetData')
    values = [c.HEADERS]
    for i in range(count):
        row = [''] * 21
        for key, value in {'Queue Number': str(1 if duplicate else i + 1), 'Project: Project Name': 'Official fixture', 'Peak MW load': mw, 'Record Type Name': 'Load Interconnection', 'Type/Fuel': 'L', 'State': 'New York', 'Project Status #': status}.items():
            row[c.HEADERS.index(key)] = value
        values.append(row)
    legend = ', '.join(k + '=' + v for k, v in c.STATUSES.items())
    values += [['End-Use Key'], ['NOTES:'], ['Project status # Key:' + (legend.replace('Withdrawn', 'Changed') if changed_legend else legend) + ' • Availability of Studies']]
    for row_i, row_values in enumerate(values, 1):
        row = ET.SubElement(table, 'row', r=str(row_i))
        for column, value in enumerate(row_values):
            if value:
                cell = ET.SubElement(row, 'c', r=chr(65 + column) + str(row_i), t='inlineStr')
                ET.SubElement(ET.SubElement(cell, 'is'), 't').text = value
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr('xl/workbook.xml', book)
        archive.writestr('xl/_rels/workbook.xml.rels', rel)
        archive.writestr('xl/worksheets/sheet1.xml', ET.tostring(sheet))
    return output.getvalue()


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.source = next(s for s in json.loads((ROOT / 'data/source-registry.json').read_text()) if s['id'] == c.NYISO)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_complete_workbook_normalizes_without_gate_assumptions(self):
        rows, original = c.parse_nyiso(fixture(), self.source)
        self.assertEqual(len(rows), 74)
        self.assertTrue(all(p['eligible'] and p['sourceAsOf'] is None and p['state'] == 'NY' for p in rows))
        self.assertNotIn('assessments', rows[0])
        self.assertEqual(len(original[0]), 21)

    def test_missing_capacity_is_null_and_still_eligible(self):
        rows, _ = c.parse_nyiso(fixture(mw=''), self.source)
        self.assertIsNone(rows[0]['loadMw'])
        self.assertEqual(rows[0]['capacityStatus'], 'unknown')
        self.assertTrue(rows[0]['eligible'])

    def test_completed_and_withdrawn_rows_retained_outside_denominator(self):
        for status, expected in [('0', 'withdrawn'), ('14', 'operational')]:
            rows, _ = c.parse_nyiso(fixture(status=status), self.source)
            self.assertEqual(len(rows), 74)
            self.assertFalse(rows[0]['eligible'])
            self.assertEqual(rows[0]['status'], expected)

    def test_duplicate_changed_legend_and_truncated_scope_rejected(self):
        for value in [fixture(duplicate=True), fixture(changed_legend=True), fixture(count=1), fixture(status='16'), fixture(mw='NaN')]:
            with self.subTest(), self.assertRaises(ValueError):
                c.parse_nyiso(value, self.source)

    def test_url_rejects_credentials_http_and_api_query(self):
        for url, api in [('https://user:secret@example.com/', False), ('http://example.com', False), ('https://example.com?token=x', True), ('http://127.0.0.1/api', True)]:
            with self.subTest(), self.assertRaises(ValueError):
                c.valid_url(url, api)
        self.assertEqual(c.valid_url('http://127.0.0.1:8787/', True), 'http://127.0.0.1:8787')

    def test_redirect_never_forwards_api_secret(self):
        with self.assertRaises(ValueError):
            c.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://another.example')

    def execute(self, data=None, failed=False, api=False, targets=None, post=None):
        data = data if data is not None else fixture()
        metadata = {'url': self.source['url'], 'finalUrl': self.source['url'], 'retrievedAt': '2026-10-08T03:02:29Z', 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        args = SimpleNamespace(state_dir=self.root, source_id=targets or [c.NYISO], cadence='weekly', api_url='http://127.0.0.1:8787' if api else None)
        with patch.object(c, 'fetch', side_effect=urllib.error.URLError('secret-must-not-log') if failed else None, return_value=(data, metadata)), patch.object(c, 'api_post', side_effect=post, return_value={'id': 'snapshot-test'}) as calls, patch.dict(c.os.environ, {'GRID_ATLAS_ADMIN_TOKEN': 'secret-must-not-log'}), contextlib.redirect_stdout(io.StringIO()):
            result = c.run(args)
        report = json.loads(next((self.root / 'runs').glob('*/report.json')).read_text())
        return result, report, calls

    def test_failure_keeps_previous_state_and_writes_report(self):
        previous = {c.NYISO: {'normalizedSha256': 'known-good'}}
        c.write_atomic(self.root / 'state.json', previous)
        result, report, _ = self.execute(failed=True)
        self.assertEqual(result, 1)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(json.loads((self.root / 'state.json').read_text()), previous)
        self.assertNotIn('secret-must-not-log', json.dumps(report))

    def test_unsupported_source_never_marks_dataset_updated(self):
        result, report, _ = self.execute(data=b'<html>Official index</html>', targets=['isone-selected-forecast'])
        self.assertEqual(result, 1)
        self.assertEqual(report['results'][0]['status'], 'parser_review')
        self.assertFalse((self.root / 'state.json').exists())

    def test_successful_import_then_snapshot_then_run(self):
        result, report, calls = self.execute(api=True)
        self.assertEqual(result, 0)
        self.assertEqual([call.args[1] for call in calls.call_args_list], ['/api/import', '/api/snapshots', '/api/runs'])
        self.assertEqual(report['results'][0]['status'], 'imported')
        self.assertEqual(report['snapshotId'], 'snapshot-test')

    def test_failed_import_has_no_snapshot_and_no_new_state(self):
        def post(origin, path, payload, token):
            if path == '/api/import':
                raise urllib.error.HTTPError(origin, 503, 'failed', {}, None)
            return {}
        result, report, calls = self.execute(api=True, post=post)
        self.assertEqual(result, 1)
        self.assertNotIn('/api/snapshots', [call.args[1] for call in calls.call_args_list])
        self.assertFalse((self.root / 'state.json').exists())
        self.assertTrue(report['apiRunRecorded'])

    def test_lbnl_payload_hashes_workbook_and_retains_index_provenance(self):
        index, workbook = b'<html>official publication</html>', b'validated-workbook-test'
        timestamp = '2026-10-08T03:02:29Z'
        metadata = lambda data: {'retrievedAt': timestamp, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        project = copy.deepcopy(next(p for p in json.loads((ROOT / 'data/bootstrap.json').read_text())['projects'] if p['sourceId'] == 'lbnl-generation-storage-queues'))
        args = SimpleNamespace(state_dir=self.root, source_id=['lbnl-generation-storage-queues'], cadence='weekly', api_url='http://127.0.0.1:8787')
        with patch.object(c, 'fetch', side_effect=[(index, metadata(index)), (workbook, metadata(workbook))]), patch.object(c, 'discover_lbnl_workbook', return_value='https://emp.lbl.gov/official.xlsx'), patch.object(c, 'parse_lbnl', return_value=([project], [{'raw':'original'}])), patch.object(c, 'workbook_source_as_of', return_value='2025-12-31'), patch.object(c, 'api_post', return_value={'id':'snapshot'}) as post, patch.dict(c.os.environ, {'GRID_ATLAS_ADMIN_TOKEN':'test-token'}), contextlib.redirect_stdout(io.StringIO()):
            code = c.run(args)
        self.assertEqual(code, 0)
        imported = post.call_args_list[0].args[2]
        self.assertEqual(imported['sourceSha256'], metadata(workbook)['sha256'])
        self.assertEqual(imported['source']['sourceAsOf'], '2025-12-31')
        self.assertNotIn('workbookUrl', imported['source'])
        report = json.loads(next((self.root / 'runs').glob('*/report.json')).read_text())
        self.assertEqual(report['results'][0]['indexManifest']['sha256'], metadata(index)['sha256'])
        self.assertEqual(len(list((self.root / 'raw').glob('*.bin'))), 2)

    def test_unrecognized_lbnl_index_does_not_replace_state(self):
        previous = {'lbnl-generation-storage-queues': {'normalizedSha256':'existing-good'}}
        c.write_atomic(self.root / 'state.json', previous)
        code, report, _ = self.execute(data=b'<html>no verified workbook link</html>', targets=['lbnl-generation-storage-queues'])
        self.assertEqual(code, 1)
        self.assertEqual(report['results'][0]['status'], 'failed')
        self.assertEqual(json.loads((self.root / 'state.json').read_text()), previous)

    def test_truncated_http_response_retried_then_rejected(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = 'https://example.com/data'
        response.headers = {'Content-Length': '100'}
        response.read.return_value = b'partial'
        opener = unittest.mock.MagicMock()
        opener.open.return_value = response
        with self.assertRaises(http.client.IncompleteRead):
            c.fetch('https://example.com/data', opener=opener)
        self.assertEqual(opener.open.call_count, 2)

    def refresh_fixture(self):
        raw = fixture()
        timestamp = c.now()
        source = copy.deepcopy(self.source)
        projects, _ = c.parse_nyiso(raw, source)
        source.update(lastCheckedAt=timestamp, sourceAsOf=None, recordCount=len(projects))
        digest = hashlib.sha256(raw).hexdigest()
        raw_path = self.root / 'raw' / (digest + '.bin')
        raw_path.parent.mkdir()
        raw_path.write_bytes(raw)
        folder = self.root / 'runs' / 'fixture-run'
        folder.mkdir(parents=True)
        candidate = {'sourceId':c.NYISO, 'source':source, 'projects':projects, 'completeScope':True, 'retrievedAt':timestamp, 'sourceSha256':digest}
        candidate_path = folder / (c.NYISO + '-import.json')
        c.write_atomic(candidate_path, candidate)
        report = {'id':'fixture-run','status':'success','startedAt':timestamp,'finishedAt':timestamp,'results':[{
            'sourceId':c.NYISO,'status':'normalized','projectCount':len(projects),
            'normalizedSha256':hashlib.sha256(c.encode(projects)).hexdigest(), 'rawPath':str(raw_path.relative_to(self.root)),
            'manifest':{'bytes':len(raw),'sha256':digest,'retrievedAt':timestamp,'url':source['url'],'finalUrl':source['url']}}]}
        report_path = folder / 'report.json'
        c.write_atomic(report_path, report)
        base = {'projects':[], 'sources':[copy.deepcopy(self.source)], 'assessments':[], 'provenance':{'summary':{},'referenceSha256':{'original':'preserved'}}}
        return base, report_path, raw_path, candidate_path

    def test_refresh_rejects_altered_raw_and_preserves_original_bootstrap(self):
        base, report, raw, _ = self.refresh_fixture()
        raw.write_bytes(raw.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            b.refresh_from_report(base, report)
        self.assertEqual(base['projects'], [])
        self.assertNotIn('sourceRefreshes', base['provenance'])

    def test_refresh_reparses_source_and_rejects_altered_candidate(self):
        base, report, _, candidate = self.refresh_fixture()
        verified = b.refresh_from_report(base, report)
        self.assertEqual(len(verified['projects']), 74)
        self.assertEqual(verified['provenance']['referenceSha256'], {'original':'preserved'})
        self.assertEqual(verified['provenance']['sourceRefreshes'][0]['candidateSha256'], hashlib.sha256(candidate.read_bytes()).hexdigest())
        payload = json.loads(candidate.read_text())
        payload['projects'][0]['loadMw'] = 99999
        c.write_atomic(candidate, payload)
        with self.assertRaisesRegex(ValueError, 'Candidate checksum/content'):
            b.refresh_from_report(base, report)
        self.assertEqual(base['projects'], [])

    def test_bootstrap_capacity_and_source_date_integrity(self):
        payload = json.loads((ROOT / 'data/bootstrap.json').read_text())
        rows = payload['projects']
        self.assertEqual(len(rows), len({p['id'] for p in rows}))
        self.assertEqual(len(rows), len({(p['sourceId'], p['sourceRecordId']) for p in rows}))
        self.assertTrue(all(p['sourceAsOf'] is None for p in rows if p['sourceId'] == c.NYISO))
        self.assertEqual(sum(p['eligible'] for p in rows), 8513)
        self.assertEqual(sum(p['eligible'] and 'load' in p['types'] for p in rows), 53)
        self.assertEqual(payload['assessments'], [])
        self.assertEqual(len(payload['provenance']['sourceRefreshes']), 2)
        self.assertEqual(sum(p['eligible'] and 'generation' in p['types'] for p in rows), 6134)
        lge = next(p for p in rows if p['id'] == 'LG&E::NR_L_LGE_POE')
        self.assertEqual(lge['sourceId'], 'southeast-lge-case')
        self.assertEqual(lge['sourceAsOf'], '2025-01-16')
        historical = [p for p in rows if p['sourceId'] == 'spp-dpa-history' and p['id'] != 'SPP::DPA-2026-May-2350']
        self.assertTrue(all(p['sourceAsOf'] is None for p in historical))
        self.assertFalse(payload['provenance']['nationalComplete'])


if __name__ == '__main__':
    unittest.main()
