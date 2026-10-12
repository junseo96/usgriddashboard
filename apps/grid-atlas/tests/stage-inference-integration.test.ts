import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Assessment, Project, ProjectScore, Summary } from '../shared/types.ts';
import { MODEL_VERSION } from '../shared/types.ts';
import type { ProjectStageInferenceDataset, StageInferenceJudgement } from '../shared/project-stage-inference.ts';
import { applyProjectStatusReviews, type ProjectStatusReviewDataset } from '../shared/project-status-reviews.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sourceUrl = 'https://emp.lbl.gov/queues';
function project(id = 'integration-generation', values: Partial<Project> = {}): Project {
  return { id, sourceId: 'lbnl-generation-storage-queues', sourceRecordId: id, name: id, types: ['generation'],
    region: 'MISO', state: 'IN', status: 'active', generationMw: 500, storageMw: null, loadMw: null,
    capacityStatus: 'known', eligible: true, exclusionReason: null, sourceUrl, sourceAsOf: '2025-12-31',
    rawStatus: 'In Progress (unknown study)', identityScope: 'source_record', ...values };
}
function judgement(p: Project, values: Partial<StageInferenceJudgement> = {}): StageInferenceJudgement {
  return { id: 'review:' + p.id, censusId: null, projectId: p.id, projectSnapshot: structuredClone(p),
    evaluatedAt: '2026-10-01T00:00:00.000Z', asOf: '2026-09-01', status: 'active', statusBasis: 'inferred',
    stage: 'grid_upgrade_planning', confidence: 'medium', bottleneck: 'Named-site grid upgrade planning',
    rationale: 'The exact queue ID and named connection point match the published upgrade plan.',
    assumptions: ['Gate progress is a stage-model assumption, not directly measured completion.'],
    limitations: ['No final operational approval is established.'], identityStatus: 'clear',
    identityRationale: 'Exact source record, location and project snapshot match.', applyToAverage: true,
    sourceEvidence: [{ url: 'https://utility.example.org/filing', name: 'Exact project filing', publisherKind: 'utility',
      retrievedAt: '2026-09-30T00:00:00.000Z', sha256: 'a'.repeat(64), publishedAt: '2026-09-15',
      sourceAsOf: '2026-09-01', excerpt: 'The named project has an approved grid upgrade plan; construction is not reported.' }], ...values };
}
function dataset(judgements: StageInferenceJudgement[]): ProjectStageInferenceDataset {
  return { schemaVersion: 1, generatedAt: judgements.map(j => j.evaluatedAt).sort().at(-1)!, judgements,
    audits: judgements.map(j => ({ id: 'audit:' + j.id, censusId: j.censusId, projectId: j.projectId,
      evaluatedAt: j.evaluatedAt, outcome: 'judged', judgementId: j.id, reason: 'Integration fixture exact-identity review.' })),
    inputs: [], limitations: ['Isolated integration fixture; never written to the production dataset.'] };
}
interface ScoringRequest { project: Project; assessments?: Assessment[]; options?: { asOf?: string; knownAt?: string }; }
interface RuntimeResult { scores: ProjectScore[]; summaries: Summary[]; displayPoints: (number | null)[]; ratings: (number | null)[]; }

/** Exercise the production static-import wiring in isolation, without mutating a shared module or real dataset. */
function runScoring(data: ProjectStageInferenceDataset, requests: ScoringRequest[], groups: number[][] = []): RuntimeResult {
  const temporary = mkdtempSync(join(tmpdir(), 'grid-stage-integration-'));
  try {
    cpSync(join(ROOT, 'shared'), join(temporary, 'shared'), { recursive: true });
    mkdirSync(join(temporary, 'data'));
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
    // These data imports are real dependencies, but this integration test needs no live cases.
    writeFileSync(join(temporary, 'data/reviewed-load-projects.json'), JSON.stringify({ schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z', projects: [], sources: [], reviews: [], limitations: [] }));
    writeFileSync(join(temporary, 'data/project-stage-inferences.json'), JSON.stringify(data));
    writeFileSync(join(temporary, 'data/project-status-reviews.json'), JSON.stringify({ schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z', reviews: [], limitations: [] }));
    writeFileSync(join(temporary, 'scoring-input.json'), JSON.stringify({ requests, groups }));
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { scoreProject, ratingPoint, summarize } from './shared/scoring.ts';
      import { projectStageInferences } from './shared/project-stage-inference-data.ts';
      import { scoreStageInference } from './shared/project-stage-inference.ts';
      const input = JSON.parse(readFileSync('./scoring-input.json', 'utf8'));
      const scores = input.requests.map(r => scoreProject(r.project, r.assessments ?? [], r.options ?? {}));
      writeFileSync('./scoring-output.json', JSON.stringify({ scores, ratings: scores.map(ratingPoint),
        summaries: input.groups.map(group => summarize(group.map(index => scores[index]))),
        displayPoints: projectStageInferences.judgements.map(j => scoreStageInference(j)?.point ?? null) }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    return JSON.parse(readFileSync(join(temporary, 'scoring-output.json'), 'utf8')) as RuntimeResult;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('scoreProject forwards distinct source asOf and knowledge cutoffs to reviewed stage estimates', () => {
  const p = project(), data = dataset([judgement(p)]);
  const output = runScoring(data, [
    { project: p, options: { asOf: '2026-08-31' } },
    { project: p, options: { asOf: '2026-09-01', knownAt: '2026-09-30T23:59:59.999Z' } },
    { project: p, options: { asOf: '2026-09-01', knownAt: '2026-10-01T00:00:00.000Z' } },
    { project: p, options: { asOf: '2026-09-01' } },
  ]);
  assert.deepEqual(output.ratings, [null, null, 65, 65]);
  assert.equal(output.scores[2].stageEstimate?.modelVersion, 'qualitative-stage-v1');
  assert.equal(output.scores[2].stageEstimate?.sourceAsOf, '2026-09-01');
  assert.equal(output.scores[2].point, null, 'An inferred rating does not manufacture five direct assessments.');
});

test('partial or explicitly unknown direct gate evidence suppresses a newer qualitative score', () => {
  const p = project(), data = dataset([judgement(p)]);
  const direct: Assessment = { id: 'direct:technical', projectId: p.id, gate: 'technical', status: 'complete',
    progress: 1, basis: 'official', sourceUrl: 'https://utility.example.org/technical-study',
    effectiveAt: '2026-09-01', publishedAt: '2026-09-01', observedAt: '2026-09-30T00:00:00.000Z',
    recordedAt: '2026-10-02T00:00:00.000Z', rationale: 'Only the technical gate has direct evidence.', modelVersion: MODEL_VERSION };
  const output = runScoring(data, [
    { project: p, assessments: [direct] },
    { project: p, assessments: [{ ...direct, status: 'unknown', progress: null }] },
    { project: p, assessments: [direct], options: { knownAt: '2026-10-01T12:00:00.000Z' } },
  ]);
  assert.deepEqual(output.ratings, [null, null, 65]);
  assert.equal(output.scores[0].stageEstimate, null);
  assert.equal(output.scores[1].stageEstimate, null);
  assert.equal(output.scores[0].upper, 80);
  assert.equal(output.scores[1].upper, 100);
});

test('a later null-stage retraction blocks the older raw-status proxy while preserving earlier knowledge', () => {
  const p = project('retracted-project', { rawStatus: 'Construction' });
  const old = judgement(p), revoked = judgement(p, { id: 'review:retracted', stage: null, status: 'unknown',
    applyToAverage: false, asOf: '2026-09-20', evaluatedAt: '2026-10-02T00:00:00.000Z',
    rationale: 'Later identity review cannot establish the current connection stage.' });
  const output = runScoring(dataset([old, revoked]), [
    { project: p },
    { project: p, options: { knownAt: '2026-10-01T12:00:00.000Z' } },
    { project: p, options: { asOf: '2026-09-10' } },
  ]);
  assert.deepEqual(output.ratings, [null, 65, 65]);
  assert.equal(output.scores[0].stageEstimate, null, 'The old Construction label must not resurrect a 25-point estimate.');
});

test('dated qualitative display scores with unknown current status do not enter the national mean', () => {
  const active = project('confirmed-active'), unknown = project('current-status-unknown', { rawStatus: 'Construction' });
  const data = dataset([judgement(active), judgement(unknown, { stage: 'grid_construction', status: 'unknown', applyToAverage: false })]);
  const output = runScoring(data, [{ project: active }, { project: unknown }], [[0, 1]]);
  assert.deepEqual(output.displayPoints, [65, 40], 'A historical display estimate can remain visible independently.');
  assert.deepEqual(output.ratings, [65, null]);
  assert.equal(output.summaries[0].ratingMean, 65);
  assert.equal(output.summaries[0].ratedCount, 1);
  assert.equal(output.summaries[0].ratingUnknownCount, 1);
  assert.equal(output.summaries[0].pointMean, null);
});

test('the production estimate lookup refuses stale state, capacity, source identity or source-date snapshots', () => {
  const p = project(), data = dataset([judgement(p)]);
  const changed: Partial<Project>[] = [{ sourceRecordId: 'other-queue-id' }, { sourceId: 'other-source' },
    { state: 'OH' }, { generationMw: 600 }, { sourceAsOf: '2026-01-01' }, { sourceUrl: 'https://other.example.org/queue' }];
  const output = runScoring(data, [{ project: p }, ...changed.map(change => ({ project: { ...p, ...change } }))]);
  assert.deepEqual(output.ratings, [65, ...changed.map(() => null)]);
});

function statusDataset(base: Project, target: Project): ProjectStatusReviewDataset {
  const j = judgement(base);
  return { schemaVersion: 1, generatedAt: j.evaluatedAt, limitations: ['Reviewed status fixture'], reviews: [{
    id: 'status:' + base.id, judgementId: j.id, evaluatedAt: j.evaluatedAt, asOf: j.asOf, statusBasis: 'explicit',
    baseProject: structuredClone(base), project: structuredClone(target), identityBasis: 'existing_register_record',
    identityRationale: 'Exact queue ID and unchanged source fields identify the record.',
    statusRationale: 'The current official queue explicitly reports withdrawal.', sourceEvidence: j.sourceEvidence,
    limitations: ['Original queue status/date/capacity fields remain unchanged.'],
  }] };
}

test('an exact reviewed withdrawal removes the record from current ratings and capacity without changing source history', () => {
  const original = project('now-withdrawn'), withdrawn: Project = { ...original, status: 'withdrawn', eligible: false,
    exclusionReason: 'Withdrawn in current official queue.' };
  const reviews = statusDataset(original, withdrawn);
  const applied = applyProjectStatusReviews([original], reviews);
  assert.equal(original.status, 'active', 'The historical base object remains intact.');
  for (const field of ['sourceId', 'sourceRecordId', 'sourceAsOf', 'sourceUrl', 'rawStatus', 'generationMw'] as const) {
    assert.equal(applied[0][field], original[field]);
  }
  assert.deepEqual(applyProjectStatusReviews(applied, reviews), applied, 'Reapplying the overlay is idempotent.');
  const output = runScoring(dataset([judgement(original)]), [{ project: original }, { project: applied[0] }], [[0], [1]]);
  assert.deepEqual(output.ratings, [65, null]);
  assert.equal(output.summaries[0].generationMw, 500);
  assert.equal(output.summaries[1].generationMw, 0);
  assert.equal(output.summaries[1].eligibleCount, 0);
  assert.equal(output.summaries[1].excludedCount, 1);
  assert.equal(output.summaries[1].ratingMean, null);
});

test('status overlays reject stale source identities and cannot promote an unresolved load by changing its state alone', () => {
  const original = project(), target: Project = { ...original, status: 'withdrawn', eligible: false, exclusionReason: 'Withdrawn.' };
  const data = statusDataset(original, target);
  assert.throws(() => applyProjectStatusReviews([{ ...original, sourceRecordId: 'different-queue' }], data), /stale base/);
  const sourceChanged = structuredClone(data); sourceChanged.reviews[0].project.sourceUrl = 'https://different.example.org/queue';
  assert.throws(() => applyProjectStatusReviews([original], sourceChanged), /source identity/);
  const anonymous = project('anonymous-load', { types: ['load'], generationMw: null, loadMw: null,
    capacityStatus: 'unknown', state: null, status: 'reference', eligible: false, exclusionReason: 'Site is unresolved.' });
  const claimed: Project = { ...anonymous, state: 'VA', status: 'active', eligible: true, exclusionReason: null };
  assert.throws(() => applyProjectStatusReviews([anonymous], statusDataset(anonymous, claimed)), /explicit individual request/);
});
