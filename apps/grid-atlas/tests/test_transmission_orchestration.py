"""Adapter failures must not remove retained regions or historical observations."""
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('transmission_orchestration_review', SCRIPTS / 'collect-transmission.py')
agg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agg)


def previous_fragment(region):
    fragment = agg.empty_fragment(region)
    for field in agg.ARRAYS:
        fragment.setdefault(field, [])
    fragment['sources'] = [dict(id='source', title='Official report fixture', publisher='ISO fixture',
                                url='https://example.org/report', sha256='a'*64,
                                retrievedAt='2026-10-02T00:00:00Z')]
    fragment['loadIntervals'] = [dict(region=region, start='2026-10-01T00:00:00Z',
                                    end='2026-10-01T01:00:00Z', mw=100, sourceIds=['source'])]
    fragment['coverage'] = [dict(region=region, metric='load', status='observed',
                                 reason='Verified prior observation', sourceUrls=['https://example.org/report'])]
    return fragment


class TransmissionOrchestrationTests(unittest.TestCase):
    def test_incomplete_or_duplicate_adapter_scope_preserves_entire_previous_group(self):
        bad_regions = [[], ['MISO'], ['MISO', 'MISO'], ['PJM', 'NYISO']]
        for returned_regions in bad_regions:
            with self.subTest(returned_regions=returned_regions), tempfile.TemporaryDirectory() as directory:
                app = Path(directory)
                fragments = app / 'data/transmission-fragments'
                output = app / 'data/transmission-observations.json'
                old = [previous_fragment(region) for region in ['PJM', 'MISO']]
                agg.store_group(fragments, 'midwest', old)
                fresh = [agg.empty_fragment(region) for region in returned_regions]
                adapter = SimpleNamespace(collect=lambda *args, **kwargs: copy.deepcopy(fresh))
                arguments = ['collect-transmission.py', '--start', '2026-10-11', '--end', '2026-10-12',
                             '--groups', 'midwest', '--output', str(output)]
                with (patch.object(agg, 'APP', app), patch.object(agg, 'FRAGMENTS', fragments),
                      patch.object(agg, 'gather_fragments', side_effect=lambda: agg.stored_fragments(fragments)),
                      patch.object(agg.importlib, 'import_module', return_value=adapter),
                      patch.object(sys, 'argv', arguments), redirect_stdout(io.StringIO())):
                    agg.main()

                retained = {row['region']: row for row in agg.load_group(fragments, 'midwest')}
                self.assertEqual(set(retained), {'PJM', 'MISO'})
                for before in old:
                    after = retained[before['region']]
                    for field in agg.ARRAYS + ['sources']:
                        self.assertEqual(after[field], before[field])
                    self.assertEqual(after['coverage'][0]['status'], 'partial')
                    self.assertIn('expected region exactly once', after['coverage'][0]['reason'])
                report = json.loads((app / '.local/transmission/latest-run.json').read_text())
                self.assertEqual(report['status'], 'partial')
                self.assertEqual(report['groups']['midwest']['status'], 'failed')
                published = json.loads(output.read_text())
                load_coverage = {row['region']: row for row in published['coverage'] if row['metric'] == 'load'}
                for region in ['PJM', 'MISO']:
                    self.assertEqual(load_coverage[region]['firstDate'], '2026-10-01')
                    self.assertEqual(load_coverage[region]['observationCount'], 1)

    def test_scope_accepts_all_owned_regions_even_without_observations(self):
        # A source failure is represented explicitly by its empty fragment, never omission.
        for group, regions in agg.OWNER_REGIONS.items():
            with self.subTest(group=group):
                agg.validate_group_scope(group, [agg.empty_fragment(region) for region in reversed(regions)])


if __name__ == '__main__':
    unittest.main()
