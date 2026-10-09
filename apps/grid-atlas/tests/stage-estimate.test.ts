import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GATES, type Project } from '../shared/types.ts';
import { estimateStage, STAGE_ESTIMATE_CATALOG, STAGE_ESTIMATE_VERSION } from '../shared/stage-estimate.ts';

const project: Project = {
  id: 'test:request', sourceId: 'lbnl-generation-storage-queues', sourceRecordId: 'request',
  name: 'Synthetic test request', types: ['generation'], region: 'PJM', state: 'PA',
  status: 'active', generationMw: 100, storageMw: null, loadMw: null, capacityStatus: 'known',
  eligible: true, exclusionReason: null, sourceUrl: 'https://emp.lbl.gov/queues',
  sourceAsOf: '2025-12-31', rawStatus: 'Not Started', identityScope: 'source_record',
};
const nyiso = (rawStatus: string): Project => ({ ...project, sourceId: 'nyiso-load-register',
  sourceUrl: 'https://www.nyiso.com/documents/20142/1407078/NYISO-Interconnection-Queue.xlsx',
  rawStatus, types: ['load'], generationMw: null, loadMw: 100, sourceAsOf: null });

test('not-started and increasingly advanced stages receive explicit model scores', () => {
  const expected = [['Not Started', 100], ['Feasibility Study', 90], ['System Impact Study', 80],
    ['Facility Study', 70], ['IA Pending', 55], ['IA Executed', 50], ['Construction', 25]] as const;
  for (const [rawStatus, point] of expected) {
    const estimate = estimateStage({ ...project, rawStatus });
    assert.ok(estimate);
    assert.equal(estimate.point, point);
    assert.equal(estimate.modelVersion, STAGE_ESTIMATE_VERSION);
    assert.equal(estimate.sourceUrl, project.sourceUrl);
    assert.equal(estimate.sourceAsOf, '2025-12-31');
  }
});

test('NYISO facilities FS follows impact approval and is not feasibility FES', () => {
  assert.equal(estimateStage(nyiso('Scoping Meeting Pending'))?.point, 100);
  assert.equal(estimateStage(nyiso('SRIS/SIS Pending'))?.point, 85);
  assert.equal(estimateStage(nyiso('SRIS/SIS Approved'))?.point, 75);
  assert.equal(estimateStage(nyiso('FS Pending'))?.stage, 'facilities_pending');
  assert.equal(estimateStage(nyiso('FS Pending'))?.point, 75);
  assert.equal(estimateStage(nyiso('FS in Progress'))?.point, 70);
  assert.equal(estimateStage(nyiso('Accepted Cost Allocation/IA in Progress'))?.point, 55);
  assert.equal(estimateStage(nyiso('Under Construction'))?.point, 25);
  assert.equal(estimateStage(nyiso('Under Construction'))?.sourceAsOf, null);
  assert.equal(estimateStage(nyiso('Rejected Cost Allocation/Next FS Pending')), null);
});

test('generic, negated, fuzzy and unreviewed stages remain unrated instead of 100', () => {
  for (const rawStatus of ['active', 'Suspended', 'In Progress (unknown study)', 'unknown', '',
    'Not IA Executed', 'IA Executed Pending', ' IA Executed', 'ia executed', 'Construction cancelled',
    'constructor', 'toString', '__proto__']) {
    assert.equal(estimateStage({ ...project, rawStatus }), null, rawStatus);
  }
  // A known label from another operator is not an approved crosswalk.
  assert.equal(estimateStage({ ...nyiso('IA Executed') }), null);
  assert.equal(estimateStage({ ...project, rawStatus: 'FS Pending' }), null);
});

test('only eligible active projects from the exact reviewed source can be estimated', () => {
  for (const change of [
    { eligible: false }, { status: 'operational' }, { status: 'withdrawn' }, { status: 'reference' },
    { sourceId: 'lbnl-generation-storage-queues-copy' }, { sourceId: 'pjm-register' },
    { sourceUrl: 'https://example.org/queues' }, { sourceUrl: 'http://emp.lbl.gov/queues' },
    { sourceUrl: 'https://token@emp.lbl.gov/queues' }, { sourceUrl: 'not-a-url' },
  ] satisfies Partial<Project>[]) assert.equal(estimateStage({ ...project, ...change }), null);
});

test('every score has all five explicit quarter-step assumptions and sums correctly', () => {
  for (const definition of STAGE_ESTIMATE_CATALOG) {
    assert.equal(definition.point, GATES.reduce((sum, gate) => sum + 20 * (1 - definition.progress[gate]), 0));
    for (const gate of GATES) assert.ok([0, .25, .5, .75, 1].includes(definition.progress[gate]));
  }
  const before = structuredClone(project);
  const estimate = estimateStage({ ...project, rawStatus: 'Construction' })!;
  assert.deepEqual(estimate.gates.map(gate => gate.gate), GATES);
  assert.equal(estimate.gates.reduce((sum, gate) => sum + gate.points, 0), estimate.point);
  for (const gate of estimate.gates) assert.match(gate.rationale, /모형 가정, 해당 요건의 직접 확인 아님/);
  assert.match(estimate.rationale, /실제 공정률이 아니/);
  assert.deepEqual(project, before);
});

test('actual bootstrap contains many progressed estimates while ambiguous records remain unknown', () => {
  const bootstrap = JSON.parse(readFileSync(new URL('../data/bootstrap.json', import.meta.url), 'utf8')) as { projects: Project[]; assessments: unknown[] };
  const eligible = bootstrap.projects.filter(project => project.eligible);
  const estimates = eligible.map(estimateStage);
  const rated = estimates.filter(estimate => estimate !== null);
  assert.ok(rated.length > eligible.length / 2, 'Reviewed real-source stages cover the majority of the baseline');
  assert.ok(rated.length < eligible.length, 'Ambiguous stages must remain unrated');
  assert.ok(rated.filter(estimate => estimate.point < 100).length > rated.filter(estimate => estimate.point === 100).length);
  assert.equal(estimateStage(bootstrap.projects.find(project => project.id === 'NYISO::0580')!)?.point, 25);
  assert.equal(estimateStage(bootstrap.projects.find(project => project.id === 'NYISO::205')!), null);
  for (const record of eligible.filter(project => ['active', 'In Progress (unknown study)', 'Suspended'].includes(project.rawStatus))) {
    assert.equal(estimateStage(record), null);
  }
});
