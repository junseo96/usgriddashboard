import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'scripts'))
spec = importlib.util.spec_from_file_location('historical_generation', APP / 'scripts/build-historical-generation.py')
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


def row(qid='1', **changes):
    return {'q_id': qid, 'entity': 'PJM', 'q_status': 'active', 'state': 'PA', 'region': 'PJM',
            'type1': 'Solar', 'type2': 'Battery', 'type3': None,
            'mw1': 100, 'mw2': None, 'mw3': None, 'ia_status_clean': 'IA Executed', **changes}


class HistoricalGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact = json.loads((APP / 'data/history-generation.json').read_text())

    def test_unknown_stages_are_not_assigned_maximum_or_zero(self):
        for year in history.RELEASES:
            for stage in ('In Progress', 'In Progress (unknown study)', 'Unknown', 'active', 'Operational', 'Phase 4 Study', 'not under construction'):
                self.assertIsNone(history.stage_point(stage, year))
        self.assertEqual(history.stage_point('Not Started', 2020), 100)

    def test_reviewed_legacy_spelling_aliases_only(self):
        self.assertEqual(history.stage_point('Facilities Study', 2023), 70)
        self.assertEqual(history.stage_point('Feasability Study', 2022), 90)
        self.assertEqual(history.stage_point('IA Draft', 2023), 55)
        self.assertIsNone(history.stage_point('IA Draft', 2025))

    def test_ambiguous_identity_groups_are_all_excluded(self):
        rows = [row('same'), row('same', mw1=200), row('unique')]
        projects, exclusions, raw_count = history.normalize_legacy(rows, 2021)
        self.assertEqual(raw_count, 3)
        self.assertEqual([p['id'] for p in projects], ['PJM::unique'])
        self.assertEqual(exclusions['ambiguousIdentityRows'], 2)

    def test_capacity_zero_null_negative_and_hybrid_denominator(self):
        projects, _, _ = history.normalize_legacy([row('zero', mw1=0), row('negative', mw1=-10)], 2022)
        summaries = history.summaries(projects, 2022)
        total, generation, storage = summaries[:3]
        self.assertEqual(total['eligibleCount'], 2)
        self.assertEqual(generation['eligibleCount'], 2)
        self.assertEqual(storage['eligibleCount'], 2)
        self.assertEqual(total['generationMw'], 0)
        self.assertIsNone(total['storageMw'])
        self.assertEqual(total['capacityUnknownCount'], 2)
        self.assertEqual(total['knownGenerationCapacityCount'], 1)

    def test_resource_scope_and_closed_rows_not_invented(self):
        rows = [row('withdrawn', q_status='withdrawn'), row('canada', state='BC'),
                row('unknown', type1='Unknown'), row('good', type1='Pumped Storage', type2=None, mw2=None)]
        projects, exclusions, raw_count = history.normalize_legacy(rows, 2021)
        self.assertEqual(raw_count, 3)
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]['types'], ['storage'])
        self.assertEqual(exclusions['unclassifiedResourceRows'], 1)
        self.assertEqual(exclusions['outsideOrUnknownMainlandRows'], 1)

    def test_artifact_reconciles_all_annual_distributions(self):
        history.validate_artifact(self.artifact)
        for vintage in self.artifact['vintages']:
            scores = [(history.stage_point(raw, vintage['year']), count) for raw, count in vintage['rawStatusCounts'].items()]
            scored = [(score, count) for score, count in scores if score is not None]
            overall = vintage['summaries'][0]
            self.assertEqual(overall['ratedCount'], sum(count for _, count in scored))
            self.assertAlmostEqual(overall['ratingMean'], sum(score * count for score, count in scored) / overall['ratedCount'])
            self.assertLess(vintage['sourceAsOf'], vintage['publishedAt'])
            self.assertGreater(vintage['source']['retrievedAt'], vintage['publishedAt'])

    def test_pinned_provenance_rejects_changed_release(self):
        changed = copy.deepcopy(self.artifact)
        changed['vintages'][0]['source']['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            history.validate_artifact(changed)

    def test_current_vintage_matches_actual_typescript_model_and_bootstrap(self):
        # Independent application model and bootstrap path protect against a
        # subtly different historical denominator or duplicated Python score.
        script = """
          import fs from 'node:fs';
          import { estimateStage, STAGE_ESTIMATE_VERSION } from './shared/stage-estimate.ts';
          const data = JSON.parse(fs.readFileSync('./data/bootstrap.json','utf8'));
          const projects = data.projects.filter(p => p.sourceId === 'lbnl-generation-storage-queues' && p.eligible);
          const scores = projects.map(p => estimateStage(p)?.point).filter(p => p !== undefined);
          const statuses = Object.fromEntries(['Not Started','Feasibility Study','Cluster Study','System Impact Study','Facility Study','IA Pending','IA Executed','Construction'].map(rawStatus => [rawStatus, estimateStage({...projects[0],rawStatus})?.point]));
          console.log(JSON.stringify({modelVersion:STAGE_ESTIMATE_VERSION,n:projects.length,rated:scores.length,mean:scores.reduce((a,b)=>a+b,0)/scores.length,statuses,generation:projects.reduce((n,p)=>n+(p.generationMw??0),0),storage:projects.reduce((n,p)=>n+(p.storageMw??0),0)}));
        """
        actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=APP, text=True))
        latest = self.artifact['vintages'][-1]['summaries'][0]
        self.assertEqual(actual['modelVersion'], history.MODEL)
        self.assertEqual(actual['statuses'], history.POINTS)
        self.assertEqual(actual['n'], latest['eligibleCount'])
        self.assertEqual(actual['rated'], latest['ratedCount'])
        self.assertAlmostEqual(actual['mean'], latest['ratingMean'])
        self.assertAlmostEqual(actual['generation'], latest['generationMw'], places=5)
        self.assertAlmostEqual(actual['storage'], latest['storageMw'], places=5)


if __name__ == '__main__':
    unittest.main()
