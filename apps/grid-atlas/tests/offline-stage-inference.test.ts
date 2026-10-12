import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Project } from '../shared/types.ts';
import { MODEL_VERSION } from '../shared/types.ts';
import { scoreProject, summarize, ratingPoint } from '../shared/scoring.ts';
import { projectCsv } from '../shared/csv.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { estimateProjectStageInference, type ProjectStageInferenceDataset, type StageInferenceJudgement } from '../shared/project-stage-inference.ts';

const project: Project = { id: 'offline-temporal-fixture', sourceId: 'fixture-register', sourceRecordId: 'site-123', name: 'Offline site', types: ['load'], region: 'PJM', state: 'VA', status: 'active', generationMw: null, storageMw: null, loadMw: 100, capacityStatus: 'known', eligible: true, exclusionReason: null, sourceUrl: 'https://utility.example.org/queue', sourceAsOf: '2026-09-01', rawStatus: 'Active; no disclosed study stage', identityScope: 'source_record' };
const judgement: StageInferenceJudgement = { id: 'judgement:offline-reviewed-later', censusId: 'site:offline', projectId: project.id, projectSnapshot: project,
  evaluatedAt: '2026-10-01T00:00:00.000Z', asOf: '2026-09-30', status: 'active', statusBasis: 'inferred', stage: 'grid_upgrade_planning', confidence: 'medium', bottleneck: 'Grid upgrade planning', rationale: 'The reviewed utility filing identifies this request and grid upgrade plan.', assumptions: ['Five-gate values are a stage model, not measured progress.'], limitations: ['Current construction remains unverified.'], identityStatus: 'clear', identityRationale: 'Exact site request ID.', applyToAverage: true,
  sourceEvidence: [{ url: 'https://utility.example.org/plan', name: 'Site upgrade plan', publisherKind: 'utility', retrievedAt: '2026-09-30T12:00:00.000Z', sha256: 'a'.repeat(64), publishedAt: '2026-09-30', sourceAsOf: '2026-09-30', excerpt: 'This site request requires the planned substation upgrade.' }] };
const inferences: ProjectStageInferenceDataset = { schemaVersion: 1, generatedAt: judgement.evaluatedAt, judgements: [judgement],
  audits: [{ id: 'audit:offline', censusId: judgement.censusId, projectId: project.id, evaluatedAt: judgement.evaluatedAt, outcome: 'judged', judgementId: judgement.id, reason: 'Reviewed the exact request and status evidence.' }], inputs: [], limitations: [] };
function runtime() {
  const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
  const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
  const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
  const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
  let calculations = 0;
  // The exported runtime takes its real scoring helpers as dependencies. Keep
  // evidence scoring unchanged while supplying an isolated reviewed dataset.
  const score = (p: Project, assessments = [], options = {}) => {
    calculations++;
    return { ...scoreProject(p, assessments, options), stageEstimate: estimateProjectStageInference(inferences, p, options) };
  };
  const capturedAt = '2026-09-29T00:00:00.000Z', exportedAt = '2026-10-02T00:00:00.000Z';
  install({ projects: [project], sources: [], snapshot: { id: 'before-review', capturedAt }, exportedAt, modelVersion: MODEL_VERSION,
    ratingMethodVersion: 'stage-proxy-v1', limitations: [], runs: { runs: [], truncated: false }, health: { schedule: {} } },
  { summarize, scoreProject: score, ratingPoint, projectCsv, calendarDayKst, endOfKstDay, isCalendarDay }, false);
  return { get: (path: string) => window.fetch(path), calculations: () => calculations, score, capturedAt, exportedAt };
}

test('offline dashboard, detail and CSV honor knowledge cutoffs between inventory capture and a later judgement', async () => {
  const app = runtime(), asOf = '2026-10-02';
  for (const [knownAt, expected] of [['2026-09-30T23:59:59.999Z', null], [judgement.evaluatedAt, 65]] as const) {
    const params = new URLSearchParams({ asOf, knownAt });
    const response = await app.get('/api/dashboard?' + params); assert.equal(response.status, 200);
    const dashboard = await response.json(); assert.equal(dashboard.available, true); assert.equal(dashboard.summary.ratingMean, expected);
    assert.equal(dashboard.history[0].summary.ratingMean, null, 'Snapshot history cannot know a review written after the snapshot');
    const detail = await (await app.get('/api/projects/' + project.id + '?' + params)).json(); assert.equal(detail.score.stageEstimate?.point ?? null, expected);
    const csv = await (await app.get('/api/export?' + params)).text();
    assert.equal(csv, projectCsv([app.score(project, [], { asOf, knownAt })], { snapshotCapturedAt: app.capturedAt, asOf, knownAt, modelVersion: MODEL_VERSION }).replace(/^\uFEFF/, ''));
    assert.equal(csv.includes(judgement.id), expected !== null, 'CSV must not attach a later judgement to an earlier knownAt label');
  }
  const beforeEffective = await (await app.get('/api/dashboard?asOf=2026-09-29&knownAt=2026-10-02T00:00:00.000Z')).json();
  assert.equal(beforeEffective.summary.ratingMean, null, 'asOf is independent of the knowledge cutoff');
});

test('offline temporal score cache shares equivalent current requests and evicts older queries after twelve entries', async () => {
  const app = runtime();
  const detail = (knownAt: string) => app.get('/api/projects/' + project.id + '?' + new URLSearchParams({ asOf: '2026-10-02', knownAt }));
  await detail('2026-10-02T01:00:00.000Z'); const afterFirst = app.calculations();
  for (let i = 2; i < 20; i++) await detail(`2026-10-02T${String(i).padStart(2, '0')}:00:00.000Z`);
  assert.equal(app.calculations(), afterFirst, 'Later current requests clamp to the export knowledge horizon');
  for (let i = 0; i < 13; i++) await detail(`2026-09-30T00:${String(i).padStart(2, '0')}:00.000Z`);
  const afterThirteen = app.calculations(); assert.equal(afterThirteen, afterFirst + 13);
  await detail('2026-09-30T00:12:00.000Z'); assert.equal(app.calculations(), afterThirteen, 'Recent query remains cached');
  await detail('2026-09-30T00:00:00.000Z'); assert.equal(app.calculations(), afterThirteen + 1, 'Oldest historical query was evicted');
});
