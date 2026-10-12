"""Facility discovery must add actual records without deleting failed-source history."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

APP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('facility_collection', APP / 'scripts/collect-large-load-facilities.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def fragment(group, status='planned', extra=False):
    source_id = group + '-official'
    record = {'id': 'LLF-' + group + '-one', 'name': group + ' official facility', 'operator': group,
              'sector': 'data_center', 'region': 'Unknown', 'state': 'VA', 'county': None,
              'city': 'Example', 'lat': None, 'lon': None, 'identityKind': 'facility', 'parentId': None,
              'lifecycle': status, 'asOf': None, 'sourceIds': [source_id], 'capacityFacts': [],
              'events': [], 'gridEvidence': [], 'aliases': [], 'legacyProjectIds': [], 'notes': []}
    facilities = [record]
    if extra:
        facilities.append({**record, 'id': 'LLF-' + group + '-two', 'name': group + ' second facility'})
    return {'schemaVersion': 1, 'id': group, 'generatedAt': '2026-10-01T00:00:00.000Z',
            'sources': [{'id': source_id, 'name': group + ' official index', 'url': 'https://example.org/' + group,
                         'retrievedAt': '2026-10-01T00:00:00.000Z', 'sha256': 'a' * 64,
                         'publishedAt': None, 'excerpt': 'Official facility list', 'sourceAsOf': None}],
            'facilities': facilities, 'limitations': []}


class FacilityCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.args = SimpleNamespace(source='all', fragments=self.root / 'fragments',
                                    output=self.root / 'inventory.json', observations=self.root / 'observations.json',
                                    report=self.root / 'collection.json', state_dir=self.root / 'runs', parser_timeout=20)
        for group in collector.GROUPS:
            collector.write(self.args.fragments / (group + '.json'), fragment(group))
            parser = self.root / 'scripts/facility-sources' / (group + '.py')
            parser.parent.mkdir(parents=True, exist_ok=True)
            parser.write_text('# fixture parser invoked through the mocked subprocess\n')
        collector.write(self.args.output, {'preserved': 'previous valid combined dataset'})
        collector.write(self.args.observations, {'schemaVersion': 1, 'observations': [{'id': 'previous-event'}]})
        self.patch = mock.patch.object(collector, 'APP', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def runner(self, candidates=None, failed=(), partial=(), builder_fails=False):
        candidates = candidates or {}

        def execute(command, *, timeout):
            if command[0] == 'node':
                if builder_fails:
                    return subprocess.CompletedProcess(command, 1, '', 'Invalid shared schema')
                directory = Path(command[command.index('--input-dir') + 1])
                output = Path(command[command.index('--output') + 1])
                collector.write(output, {'fragments': [collector.read(p) for p in sorted(directory.glob('*.json'))]})
                self.assertIn('--previous', command)
                return subprocess.CompletedProcess(command, 0, 'Validated', '')
            group = Path(command[1]).stem
            output = Path(command[command.index('--output') + 1])
            state = Path(command[command.index('--state-dir') + 1])
            if group in failed:
                # Simulate a destructive failed parser: the runner must roll it back.
                collector.write(output, {'schemaVersion': 1, 'facilities': []})
                collector.write(state / 'report.json', {'status': 'failed', 'sources': [{'id': group, 'status': 'failed'}]})
                return subprocess.CompletedProcess(command, 1, '', 'HTTP 403')
            collector.write(output, candidates.get(group, fragment(group)))
            status = 'partial' if group in partial else 'success'
            collector.write(state / 'report.json', {'status': status, 'sources': [{'id': group, 'status': status}]})
            return subprocess.CompletedProcess(command, 0, 'Actual source records parsed', '')
        return execute

    def test_discovery_and_lifecycle_changes_are_observations_not_invented_milestone_dates(self):
        old = fragment('operators')
        new = fragment('operators', status='construction', extra=True)
        events = collector.observed_changes('operators', old, new, '2026-10-12T00:00:00.000Z')
        self.assertEqual([e['kind'] for e in events], ['lifecycle_changed', 'facility_discovered'])
        self.assertEqual(events[0]['previousLifecycle'], 'planned')
        self.assertIsNone(events[0]['sourceAsOf'])
        self.assertNotIn('date', events[0])
        self.assertEqual(new['facilities'][0]['events'], [])

    def test_retrieval_hash_and_source_reference_changes_are_not_progress(self):
        old = fragment('operators')
        old['facilities'][0]['capacityFacts'] = [{'id': 'fact-old', 'value': 40, 'unit': 'MW',
             'measure': 'it_power', 'scope': 'facility', 'asOf': None, 'sourceIds': ['source-old'], 'note': '40 MW IT'}]
        new = copy.deepcopy(old)
        new['sources'][0].update(sha256='b' * 64, retrievedAt='2026-10-02T00:00:00.000Z')
        new['facilities'][0]['sourceIds'] = ['source-new']
        new['facilities'][0]['capacityFacts'][0].update(id='fact-new', sourceIds=['source-new'])
        self.assertEqual(collector.observed_changes('operators', old, new, '2026-10-12T00:00:00.000Z'), [])
        new['facilities'][0]['capacityFacts'][0]['value'] = 80
        self.assertEqual(collector.observed_changes('operators', old, new, '2026-10-12T00:00:00.000Z')[0]['changedFields'], ['capacityFacts'])

    def test_partial_run_adds_new_records_and_preserves_failed_group(self):
        old_industrial = (self.args.fragments / 'industrial.json').read_bytes()
        candidate = fragment('operators', status='construction', extra=True)
        self.assertEqual(collector.collect(self.args, self.runner({'operators': candidate}, failed=('industrial',), partial=('hyperscale',))), 0)
        self.assertEqual((self.args.fragments / 'industrial.json').read_bytes(), old_industrial)
        report = collector.read(self.args.report)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual((report['discoveredCount'], report['lifecycleChangeCount']), (1, 1))
        events = collector.read(self.args.observations)['observations']
        self.assertEqual(events[0], {'id': 'previous-event'})
        self.assertEqual(len(events), 3)
        combined = collector.read(self.args.output)['fragments']
        self.assertEqual(next(f for f in combined if f['id'] == 'industrial'), fragment('industrial'))

    def test_all_failures_keep_inventory_fragments_and_observations_byte_identical(self):
        paths = [self.args.output, self.args.observations, *self.args.fragments.glob('*.json')]
        before = {p: p.read_bytes() for p in paths}
        self.assertEqual(collector.collect(self.args, self.runner(failed=collector.GROUPS)), 1)
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)
        report = collector.read(self.args.report)
        self.assertEqual(report['status'], 'failed')
        self.assertFalse(report['publishedFilesUpdated'])
        self.assertEqual(report['discoveredCount'], 0)
        for group in collector.GROUPS:
            diagnostic = self.args.state_dir / 'runs' / report['runId'] / group / 'normalized-fragment.json'
            self.assertEqual(collector.read(diagnostic), {'schemaVersion': 1, 'facilities': []})

    def test_disappearing_listing_is_rejected_not_deleted_or_retired(self):
        self.args.source = 'operators'
        previous = fragment('operators', extra=True)
        collector.write(self.args.fragments / 'operators.json', previous)
        self.assertEqual(collector.collect(self.args, self.runner()), 1)
        self.assertEqual(collector.read(self.args.fragments / 'operators.json'), previous)
        self.assertIn('dropped 1 previous facilities', collector.read(self.args.report)['sourceGroups'][0]['error'])

    def test_shared_builder_validation_failure_cannot_publish_any_candidate(self):
        paths = [self.args.output, self.args.observations, *self.args.fragments.glob('*.json')]
        before = {p: p.read_bytes() for p in paths}
        self.assertEqual(collector.collect(self.args, self.runner({'operators': fragment('operators', extra=True)}, builder_fails=True)), 1)
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)
        report = collector.read(self.args.report)
        self.assertFalse(report['publishedFilesUpdated'])
        diagnostic = self.args.state_dir / 'runs' / report['runId'] / 'operators' / 'normalized-fragment.json'
        self.assertEqual(collector.read(diagnostic), fragment('operators', extra=True))

    def test_false_acquisition_evidence_and_empty_success_are_rejected(self):
        for alteration in ('hash', 'future', 'empty', 'missing_reference'):
            with self.subTest(alteration=alteration):
                candidate = fragment('operators')
                if alteration == 'hash':
                    candidate['sources'][0]['sha256'] = ''
                elif alteration == 'future':
                    candidate['sources'][0]['retrievedAt'] = '2999-01-01T00:00:00.000Z'
                elif alteration == 'empty':
                    candidate['facilities'] = []
                else:
                    candidate['facilities'][0]['sourceIds'] = ['not-acquired']
                with self.assertRaises(ValueError):
                    collector.validate_fragment(candidate, 'operators')

    def test_publication_io_failure_rolls_back_previously_replaced_files(self):
        first, added, failing = self.root / 'first.json', self.root / 'new.json', self.root / 'failing.json'
        first.write_bytes(b'previous first\n')
        failing.write_bytes(b'previous last\n')
        actual_replace = Path.replace

        def replace(source, destination):
            if destination == failing:
                raise OSError('Simulated file replacement failure')
            return actual_replace(source, destination)

        with mock.patch.object(Path, 'replace', replace), self.assertRaises(OSError):
            collector.publish_checked({first: {'next': 1}, added: {'next': 2}, failing: {'next': 3}})
        self.assertEqual(first.read_bytes(), b'previous first\n')
        self.assertEqual(failing.read_bytes(), b'previous last\n')
        self.assertFalse(added.exists())
        self.assertEqual(list(self.root.glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
