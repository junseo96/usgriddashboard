import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { STAGE_ESTIMATE_CATALOG } from '../shared/stage-estimate-catalog.ts';
import { PROJECT_STAGE_INFERENCE_CATALOG, estimateProjectStageInference, latestStageInference, matchingProjectStageInference,
  projectStageInferencesCsv, scoreStageInference, selectLatestStageInferences, stageInferenceCoverage, validateProjectStageInferences,
  type ProjectStageInferenceDataset, type ProjectStageInferenceFragment, type StageInferenceAudit, type StageInferenceJudgement } from '../shared/project-stage-inference.ts';
import { buildProjectStageInferences, runProjectStageInferenceBuilder } from '../scripts/build-project-stage-inferences.ts';

const project: Project = { id: 'fixture-load', sourceId: 'fixture-register', sourceRecordId: 'docket-123-site-a', name: 'Site A', types: ['load'], region: 'PJM', state: 'VA', status: 'active', generationMw: null, storageMw: null, loadMw: 500, capacityStatus: 'known', eligible: true, exclusionReason: null, sourceUrl: 'https://utility.example.org/request', sourceAsOf: '2026-09-01', rawStatus: 'Active request, specific study stage not disclosed', identityScope: 'source_record' };
function judgement(overrides: Partial<StageInferenceJudgement> = {}): StageInferenceJudgement {
  return { id: 'judgement:site-a:2026-10-01', censusId: 'site:a', projectId: project.id, projectSnapshot: structuredClone(project), evaluatedAt: '2026-10-01T00:00:00.000Z', asOf: '2026-09-01', status: 'active', statusBasis: 'inferred', stage: 'grid_upgrade_planning', confidence: 'medium', bottleneck: 'Substation design and delivery schedule remain the likely constraints.', rationale: 'The named utility filing identifies this site and describes planned substation upgrades, but does not confirm construction.', assumptions: ['The five gate progress values are model assumptions, not verified completion percentages.'], limitations: ['No itemized gate evidence is public.'], identityStatus: 'clear', identityRationale: 'The utility docket number and site address match the current project exactly.', applyToAverage: true,
    sourceEvidence: [{ url: 'https://utility.example.org/filing', name: 'Site A utility filing', publisherKind: 'utility', retrievedAt: '2026-09-30T00:00:00.000Z', sha256: 'a'.repeat(64), publishedAt: '2026-09-15', sourceAsOf: '2026-09-01', excerpt: 'The site is under active development. A new substation is planned; construction has not yet begun.' }], ...overrides };
}
function audit(j: StageInferenceJudgement): StageInferenceAudit { return { id: 'audit:' + j.id, censusId: j.censusId, projectId: j.projectId, evaluatedAt: j.evaluatedAt, outcome: 'judged', judgementId: j.id, reason: 'Reviewed site identity, current status, sources, and model assumptions.' }; }
function fragment(judgements: StageInferenceJudgement[]): ProjectStageInferenceFragment { return { schemaVersion: 1, id: 'fixture', generatedAt: judgements.map(j => j.evaluatedAt).sort().at(-1) ?? '2026-10-01T00:00:00.000Z', judgements, audits: judgements.map(audit), limitations: ['Research fixture'] }; }
function dataset(judgements: StageInferenceJudgement[]): ProjectStageInferenceDataset { return buildProjectStageInferences({ fragments: [fragment(judgements)] }); }

test('reviewed qualitative models retain explicit five-gate assumptions and cannot override catalog points', () => {
  const expected = { technical_scoping: 90, connection_design: 75, grid_upgrade_planning: 65, permitting_development: 80, site_construction_grid_unverified: 55, grid_construction: 40, grid_support_complete: 35, energization_preparation: 15 };
  for (const [stage, point] of Object.entries(expected)) {
    const data = dataset([judgement({ stage })]), estimate = estimateProjectStageInference(data, project)!;
    assert.equal(estimate.point, point); assert.equal(estimate.gates.reduce((sum, g) => sum + g.points, 0), point);
    assert.equal(estimate.gates.length, 5); assert.ok(estimate.gates.every(g => /모형 가정/.test(g.rationale)));
    assert.equal(estimate.sourceEvidence[0].sha256, 'a'.repeat(64)); assert.equal(estimate.modelVersion, 'qualitative-stage-v1');
  }
  for (const stage of STAGE_ESTIMATE_CATALOG) assert.deepEqual(PROJECT_STAGE_INFERENCE_CATALOG.find(s => s.stage === stage.stage), stage);
  assert.throws(() => dataset([judgement({ stage: 'caller-chosen-37' })]), /predefined stage/);
  const tampered = judgement(); Object.assign(tampered, { point: 37 }); assert.throws(() => dataset([tampered]), /arbitrary model points/);
  const unknown = dataset([judgement({ stage: null, applyToAverage: false })]); assert.equal(scoreStageInference(unknown.judgements[0]), null, 'Missing stage never becomes 100');
});

test('unknown current status can retain a dated display score but cannot enter the active national mean', () => {
  const historical = judgement({ status: 'unknown', applyToAverage: false, identityStatus: 'unresolved', confidence: 'low', projectSnapshot: null });
  const data = dataset([historical]); assert.equal(scoreStageInference(data.judgements[0])?.point, 65); assert.equal(estimateProjectStageInference(data, project), null);
  for (const patch of [{ status: 'unknown' }, { status: 'operating' }, { status: 'withdrawn' }, { identityStatus: 'possible_duplicate' }, { identityStatus: 'unresolved' }, { projectSnapshot: null }, { asOf: null }] as Partial<StageInferenceJudgement>[]) assert.throws(() => dataset([judgement(patch)]), /average requires/);
  const missingProject = judgement({ projectId: null, projectSnapshot: null, applyToAverage: false }); assert.doesNotThrow(() => dataset([missingProject]));
  const representative = dataset([judgement({ identityStatus: 'representative', identityRationale: 'The previously eligible named request is the sole retained representative of an unresolved duplicate group; anonymous counterparts stay outside the mean.' })]);
  assert.equal(estimateProjectStageInference(representative, project)?.identityStatus, 'representative', 'Reviewed single representatives remain visibly distinct from fully resolved identities');
});

test('matching requires the entire current project snapshot, and a canonical replacement does not rate both records', () => {
  const data = dataset([judgement()]); assert.equal(estimateProjectStageInference(data, project)?.point, 65);
  for (const patch of [{ name: 'Another site' }, { loadMw: 600 }, { sourceAsOf: '2026-09-02' }, { rawStatus: 'Withdrawn after review' }, { eligible: false }, { sourceRecordId: 'different-docket' }] as Partial<Project>[]) assert.equal(estimateProjectStageInference(data, { ...project, ...patch }), null);
  const replacement = { ...project, id: 'replacement-core-record' };
  const next = judgement({ id: 'next-canonical-record', projectId: replacement.id, projectSnapshot: replacement, evaluatedAt: '2026-10-02T00:00:00.000Z' });
  const updated = dataset([judgement(), next]); assert.equal(estimateProjectStageInference(updated, project), null); assert.equal(estimateProjectStageInference(updated, replacement)?.point, 65);
  const generation = { ...project, id: 'generation-fixture', types: ['generation'] as Project['types'], loadMw: null, generationMw: 150 };
  assert.equal(estimateProjectStageInference(dataset([judgement({ censusId: null, projectId: generation.id, projectSnapshot: generation })]), generation)?.point, 65);
});

test('latest unknown judgement revokes an old estimate while asOf and knownAt preserve distinct historical answers', () => {
  const old = judgement(), next = judgement({ id: 'judgement:revoked', evaluatedAt: '2026-10-02T00:00:00.000Z', asOf: '2026-09-30', stage: null, status: 'unknown', applyToAverage: false, rationale: 'The latest evidence does not establish a current connection stage.' });
  const data = dataset([old, next]); assert.equal(latestStageInference(data, 'site:a')?.id, next.id); assert.equal(estimateProjectStageInference(data, project), null);
  assert.equal(estimateProjectStageInference(data, project, { knownAt: '2026-10-01T23:59:59.999Z' })?.point, 65);
  assert.equal(selectLatestStageInferences(data, { asOf: '2026-09-10', knownAt: '2026-09-30' }).length, 0, 'No retroactive assertion that the judgement was known before evaluation');
  assert.equal(selectLatestStageInferences(data, { asOf: '2026-09-10' })[0].id, old.id, 'Current retrospective review retains its actual later evaluation time');
  assert.equal(matchingProjectStageInference(data, project)?.stage, null);
  assert.throws(() => selectLatestStageInferences(data, { asOf: '2026-02-30' }), /Invalid inference asOf/);
});

test('an undated latest average exclusion suppresses old stage fallback only from its actual KST evaluation day', () => {
  const old = judgement({ stage: 'ia_executed' });
  const undated = judgement({ id: 'judgement:undated-current-exclusion', evaluatedAt: '2026-10-01T16:00:00.000Z', asOf: null, status: 'unknown', stage: 'site_construction_grid_unverified', applyToAverage: false, rationale: 'Site works are reported without a source date; current active connection status cannot be established.' });
  const data = dataset([old, undated]);
  assert.equal(matchingProjectStageInference(data, project, { asOf: '2026-10-02' })?.id, undated.id, 'Current source-stage fallback must see the reviewed exclusion even without a source date');
  assert.equal(estimateProjectStageInference(data, project, { asOf: '2026-10-02' }), null);
  assert.equal(matchingProjectStageInference(data, project, { asOf: '2026-10-01' })?.id, old.id, '16:00 UTC is the next KST day; earlier days keep their prior review');
  assert.equal(estimateProjectStageInference(data, project, { asOf: '2026-10-01' })?.point, 50);
  assert.equal(matchingProjectStageInference(data, project, { asOf: '2026-10-02', knownAt: '2026-10-01T15:59:59.999Z' })?.id, old.id, 'Knowledge cutoff independently blocks a later evaluation');
  assert.equal(scoreStageInference(undated)?.sourceAsOf, null, 'Selection does not manufacture an original source date');
  assert.equal(latestStageInference(data, 'site:a', { asOf: '2026-10-02' })?.asOf, null);
});

test('national-register lookups index an immutable review dataset once per historical query', () => {
  const data = dataset([judgement()]); let traversals = 0;
  data.judgements = new Proxy(data.judgements, { get(target, property, receiver) { if (property === Symbol.iterator) traversals++; return Reflect.get(target, property, receiver); } });
  for (let i = 0; i < 13000; i++) matchingProjectStageInference(data, { ...project, id: 'unmatched:' + i });
  assert.equal(traversals, 1, '13,000 project lookups must not rescan the review history');
  matchingProjectStageInference(data, project, { knownAt: '2026-09-30' }); assert.equal(traversals, 2, 'A different temporal query gets its own index');
  assert.equal(estimateProjectStageInference(data, project)?.point, 65); assert.equal(traversals, 2);
});

test('judgement provenance requires acquired evidence and consistent timestamps without fabricated regulator authority', () => {
  const base = judgement(); base.sourceEvidence[0].publisherKind = 'media'; assert.doesNotThrow(() => dataset([base]), 'Reviewed news is allowed and remains explicitly media');
  const futureAcquisition = judgement(); futureAcquisition.sourceEvidence[0].retrievedAt = '2026-10-02T00:00:00.000Z'; assert.throws(() => dataset([futureAcquisition]), /acquisition chronology/);
  const futurePublication = judgement(); futurePublication.sourceEvidence[0].publishedAt = '2026-10-03'; assert.throws(() => dataset([futurePublication]), /acquisition chronology/);
  const noHash = judgement(); noHash.sourceEvidence[0].sha256 = ''; assert.throws(() => dataset([noHash]), /source provenance/);
  const noQuotes = judgement(); noQuotes.sourceEvidence[0].excerpt = ''; assert.throws(() => dataset([noQuotes]), /source provenance/);
  const mismatched = judgement({ projectId: 'wrong-id' }); assert.throws(() => dataset([mismatched]), /snapshot\/project ID mismatch/);
  const yearOnly = judgement(); yearOnly.sourceEvidence[0].sourceAsOf = '2025';
  assert.equal(dataset([yearOnly]).judgements[0].sourceEvidence[0].sourceAsOf, '2025', 'Annual location/reference artifacts retain their stated precision');
  yearOnly.sourceEvidence[0].sourceAsOf = '2027'; assert.throws(() => dataset([yearOnly]), /acquisition chronology/);
});

test('append preserves older opinions and review audits, rejecting changed IDs or unaudited judgements', () => {
  const old = judgement(), first = dataset([old]), next = judgement({ id: 'later-review', evaluatedAt: '2026-10-02T00:00:00.000Z', stage: 'grid_construction' });
  const added = buildProjectStageInferences({ previous: first, fragments: [fragment([next])] });
  assert.equal(added.judgements.length, 2); assert.deepEqual(added.judgements[0], old); assert.equal(estimateProjectStageInference(added, project)?.point, 40);
  assert.deepEqual(buildProjectStageInferences({ previous: added, fragments: [fragment([next])] }), added);
  assert.throws(() => buildProjectStageInferences({ previous: first, fragments: [fragment([{ ...old, rationale: 'Changed opinion under the same ID' }])] }), /Immutable judgement/);
  const absent = fragment([old]); absent.audits = []; assert.throws(() => buildProjectStageInferences({ fragments: [absent] }), /every judgement needs/);
  const ambiguous = dataset([old]); ambiguous.judgements.push({ ...old, id: 'second-current-opinion' }); ambiguous.audits.push(audit(ambiguous.judgements[1])); assert.throws(() => validateProjectStageInferences(ambiguous), /ambiguous concurrent/);
});

test('coverage distinguishes reviewed no-judgement cases and unreviewed projects instead of assigning a default score', () => {
  const part = fragment([judgement()]); part.audits.push({ id: 'audit:unscorable-site', censusId: 'site:b', projectId: null, evaluatedAt: part.generatedAt, outcome: 'no_judgement', judgementId: null, reason: 'No document identifies a single site or a current connection milestone.' });
  part.audits.push({ id: 'audit:queued-site', censusId: 'site:c', projectId: null, evaluatedAt: part.generatedAt, outcome: 'not_reviewed', judgementId: null, reason: 'This source record is queued; no project-specific review was performed in this round.' });
  const data = buildProjectStageInferences({ fragments: [part] }), coverage = stageInferenceCoverage(data, ['site:a', 'site:b', 'site:c', 'site:d']);
  assert.equal(coverage.reviewedCount, 2); assert.equal(coverage.judgedCount, 1); assert.equal(coverage.noJudgementCount, 1); assert.equal(coverage.notReviewedCount, 1); assert.deepEqual(coverage.unreviewedCensusIds, ['site:c', 'site:d']); assert.equal(latestStageInference(data, 'site:b'), null); assert.equal(latestStageInference(data, 'site:c'), null);
  const csv = projectStageInferencesCsv(dataset([judgement({ bottleneck: '=IMPORTDATA("bad")', stage: null, applyToAverage: false })]));
  assert.ok(csv.includes('"\'=IMPORTDATA')); assert.ok(csv.includes('""')); assert.ok(csv.includes('a'.repeat(64))); assert.ok(csv.includes('2026-10-01T00:00:00.000Z'));
});

test('builder check mode is read-only and refuses changed immutable fragment contents', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'grid-inference-'));
  try {
    const output = join(temporary, 'dataset.json'), path = join(temporary, 'fragment.json'), part = fragment([judgement()]); writeFileSync(path, JSON.stringify(part));
    const args = ['--output', output, '--fragment', path]; runProjectStageInferenceBuilder(args); const before = readFileSync(output, 'utf8');
    runProjectStageInferenceBuilder([...args, '--check']); assert.equal(readFileSync(output, 'utf8'), before);
    part.judgements[0].confidence = 'low'; writeFileSync(path, JSON.stringify(part)); assert.throws(() => runProjectStageInferenceBuilder([...args, '--check']), /Immutable judgement/); assert.equal(readFileSync(output, 'utf8'), before);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
