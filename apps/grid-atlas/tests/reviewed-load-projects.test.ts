import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReviewedLoadProjects, loadBootstrapWithReviewed, runReviewedLoadBuilder, type ReviewedBootstrap } from '../scripts/apply-reviewed-load-projects.ts';
import { eligibleSourceForProject, matchingReviewedLoadProject, reviewedLoadProjects, validateReviewedLoadProjects, REVIEWED_LOAD_STAGES, type ReviewedLoadDataset } from '../shared/reviewed-load-projects.ts';
import { STAGE_ESTIMATE_CATALOG } from '../shared/stage-estimate.ts';
import type { Project, Source } from '../shared/types.ts';
import { scoreProject, ratingPoint } from '../shared/scoring.ts';
import { createLocalDatabase } from '../server/local-db.ts';
import { handleApi } from '../server/api.ts';
import { projectStageInferences } from '../shared/project-stage-inference-data.ts';
import { selectLatestStageInferences } from '../shared/project-stage-inference.ts';

const now = new Date('2026-10-12T00:00:00.000Z');
const digest = 'b'.repeat(64);
const source: Source = { id: 'reviewed-official-cases', name: 'PUC reviewed official cases', region: 'West', types: ['load'], url: 'https://puc.example.gov/cases', coverage: 'case', sourceAsOf: '2026-09-01', lastCheckedAt: '2026-09-02', refreshCadence: 'monthly', recordCount: 2, gaps: ['Two identified cases, not a complete utility register'], adapter: null };
function project(id: string, override: Partial<Project> = {}): Project {
  return { id, sourceId: source.id, sourceRecordId: 'docket:' + id, name: 'Single site ' + id, types: ['load'], region: 'West', state: 'ID', status: 'active', generationMw: null, storageMw: null, loadMw: null, capacityStatus: 'unknown', eligible: true, exclusionReason: null, sourceUrl: 'https://puc.example.gov/cases/' + id, sourceAsOf: '2026-09-01', rawStatus: 'Official application pending; detailed stage not disclosed', identityScope: 'source_record', ...override };
}
function dataset(): ReviewedLoadDataset {
  const projects = [project('existing'), project('new', { loadMw: 125, capacityStatus: 'known', rawStatus: 'Signed electricity supply contract' })];
  return { schemaVersion: 1, generatedAt: '2026-10-01T00:00:00.000Z', projects, sources: [structuredClone(source)], reviews: projects.map(p => ({
    projectId: p.id, authority: 'State PUC', docketId: p.sourceRecordId, identityBasis: p.loadMw === null ? 'official_single_site_docket' : 'official_single_site_contract', capacityBasis: p.loadMw === null ? 'unknown' : 'contracted_grid_mw', stage: p.loadMw === null ? null : 'ia_executed', stageRationale: p.loadMw === null ? 'The filing identifies one site but does not establish a five-gate progress stage.' : 'The official contract confirms supply; the chosen model stage is an assumption, not five verified gates.',
    sourceEvidence: [{ url: p.sourceUrl, name: 'Official application/contract filing', retrievedAt: '2026-09-02T00:00:00.000Z', sha256: 'a'.repeat(64), publishedAt: '2026-09-01', sourceAsOf: '2026-09-01', excerpt: 'One identified customer site has an electricity service request. Contract MW is provided only where expressly stated.' }], limitations: ['Selected case; nationwide completeness is unknown'],
  })), limitations: ['Source-record identity only; cross-utility physical matching incomplete'] };
}
function bootstrap(): ReviewedBootstrap {
  const unrelatedSource = { ...source, id: 'unrelated', coverage: 'full_register' as const, recordCount: 1 };
  return { projects: [project('existing', { status: 'reference', eligible: false, exclusionReason: 'Not yet reviewed' }), project('other', { sourceId: unrelatedSource.id, loadMw: 20, capacityStatus: 'known' })], sources: [{ ...source, recordCount: 1 }, unrelatedSource], assessments: [{ id: 'preserve-existing-assessment' }], provenance: { referenceSha256: { 'original.zip': 'c'.repeat(64) }, sourceRefreshes: [{ sourceId: 'unrelated', retrievedAt: '2026-08-01T00:00:00.000Z' }], summary: { records: 2, eligible: 1, gateAssessments: 1 } } };
}

test('reviewed official service cases need no national queue ID, but permit/group/unknown identities cannot become eligible', () => {
  assert.doesNotThrow(() => validateReviewedLoadProjects(dataset(), now));
  for (const identityBasis of ['official_permit_only', 'grouped_case', 'unresolved'] as const) {
    const bad = dataset(); bad.reviews[0].identityBasis = identityBasis;
    assert.throws(() => validateReviewedLoadProjects(bad, now), /permit-only, grouped or unresolved/);
    bad.projects[0] = { ...bad.projects[0], eligible: false, status: 'reference', exclusionReason: 'Site service request not established' };
    assert.doesNotThrow(() => validateReviewedLoadProjects(bad, now));
  }
  for (const override of [{ state: 'AK' }, { status: 'operational' }, { status: 'withdrawn' }] as Partial<Project>[]) {
    const bad = dataset(); Object.assign(bad.projects[0], override);
    assert.throws(() => validateReviewedLoadProjects(bad, now), /eligible active mainland/);
  }
  const operating = dataset(); Object.assign(operating.projects[0], { status: 'operational', eligible: false, exclusionReason: 'Service already energized' });
  assert.doesNotThrow(() => validateReviewedLoadProjects(operating, now));
});

test('review validation rejects false capacity, grouped aggregates, duplicate identities and unsupported chronology', () => {
  assert.deepEqual([...REVIEWED_LOAD_STAGES].sort(), STAGE_ESTIMATE_CATALOG.map(stage => stage.stage).sort());
  const mutations: ((d: ReviewedLoadDataset) => void)[] = [
    d => { d.projects[1].loadMw = -1; },
    d => { d.projects[1].loadMw = NaN; },
    d => { d.projects[0].loadMw = 500; },
    d => { d.reviews[1].capacityBasis = 'unknown'; },
    d => { Object.assign(d.reviews[1], { stage: 'ia_execute' }); },
    d => { d.sources[0].coverage = 'aggregate'; },
    d => { d.projects[1].sourceRecordId = d.projects[0].sourceRecordId; },
    d => { d.reviews[1].projectId = d.reviews[0].projectId; },
    d => { d.reviews.pop(); },
    d => { d.reviews[0].sourceEvidence[0].sha256 = 'not-a-hash'; },
    d => { d.reviews[0].sourceEvidence[0].publishedAt = '2026-09-03'; },
    d => { d.reviews[0].sourceEvidence[0].retrievedAt = '2026-10-11T00:00:00.000Z'; },
    d => { d.reviews[0].sourceEvidence[0].url = 'https://user:secret@puc.example.gov'; },
    d => { d.projects[0].sourceAsOf = '2026-09-03'; },
  ];
  for (const mutate of mutations) { const bad = dataset(); mutate(bad); assert.throws(() => validateReviewedLoadProjects(bad, now), /Reviewed load projects:/); }
  const zero = dataset(); zero.projects[1].loadMw = 0; assert.doesNotThrow(() => validateReviewedLoadProjects(zero, now));
});

test('exact reviewed upserts preserve existing IDs, unrelated records and acquisition hashes and are idempotent', () => {
  const before = bootstrap(), original = structuredClone(before);
  const merged = applyReviewedLoadProjects(before, dataset(), digest, now);
  assert.deepEqual(before, original, 'The merge is pure');
  assert.equal(merged.projects.length, 3); assert.equal(merged.projects.filter(p => p.id === 'existing').length, 1);
  assert.equal(merged.projects.find(p => p.id === 'existing')!.eligible, true);
  assert.deepEqual(merged.projects.find(p => p.id === 'other'), original.projects.find(p => p.id === 'other'));
  assert.deepEqual(merged.assessments, original.assessments);
  assert.deepEqual(merged.provenance.referenceSha256, original.provenance.referenceSha256);
  assert.deepEqual(merged.provenance.sourceRefreshes, original.provenance.sourceRefreshes);
  assert.deepEqual(merged.provenance.summary.eligibleByType, { load: 3 });
  assert.deepEqual(merged.provenance.summary.knownCapacityMw, { generation: 0, storage: 0, load: 145 });
  assert.equal(merged.provenance.summary.capacityUnknownOrPartial, 1);
  assert.equal(merged.provenance.summary.gateAssessments, 1);
  assert.equal(merged.provenance.reviewedLoadImports![0].datasetSha256, digest);
  assert.deepEqual(applyReviewedLoadProjects(merged, dataset(), digest, now), merged);
  const conflict = dataset(); conflict.projects[0].sourceRecordId = 'new-identity';
  assert.throws(() => applyReviewedLoadProjects(before, conflict, digest, now), /cannot be reassigned/);
  const alias = dataset(); alias.projects[0].id = 'alias'; alias.reviews[0].projectId = 'alias';
  assert.throws(() => applyReviewedLoadProjects(before, alias, digest, now), /different project ID/);
  const wrongCount = dataset(); wrongCount.sources[0].recordCount = 999;
  assert.throws(() => applyReviewedLoadProjects(before, wrongCount, digest, now), /recordCount/);
});

test('reviewed builder check never writes and checks exact JSON digest rather than fabricating source retrievals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grid-reviewed-load-'));
  try {
    const registryPath = new URL('../data/source-registry.json', import.meta.url);
    const originalRegistry = readFileSync(registryPath, 'utf8');
    const bootPath = join(directory, 'bootstrap.json'), reviewPath = join(directory, 'reviewed.json');
    writeFileSync(bootPath, JSON.stringify(bootstrap())); writeFileSync(reviewPath, JSON.stringify(dataset()));
    const run = (...args: string[]) => runReviewedLoadBuilder(['--bootstrap', bootPath, '--reviewed', reviewPath, ...args]);
    const original = readFileSync(bootPath, 'utf8');
    const prepared = loadBootstrapWithReviewed(bootPath, reviewPath);
    assert.equal(prepared.projects.length, 3); assert.equal(prepared.projects.find(p => p.id === 'existing')?.eligible, true);
    assert.equal(readFileSync(bootPath, 'utf8'), original, 'Fresh seed preparation overlays reviews without rewriting its bootstrap input');
    assert.throws(() => run('--check'), /Bootstrap differs/); assert.equal(readFileSync(bootPath, 'utf8'), original);
    assert.equal(run().written, bootPath);
    const resultingBytes = readFileSync(bootPath, 'utf8');
    assert.equal(run('--check').checked, true); assert.equal(readFileSync(bootPath, 'utf8'), resultingBytes);
    const digest = createHash('sha256').update(readFileSync(reviewPath)).digest('hex');
    assert.equal(JSON.parse(resultingBytes).provenance.reviewedLoadImports[0].datasetSha256, digest);
    assert.equal(readFileSync(registryPath, 'utf8'), originalRegistry, 'A custom fixture merge/check must not touch the checked-in collector registry');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shipped reviewed cases are exact matches accepted by the API; tampered and unreviewed cases are rejected', async () => {
  assert.equal(runReviewedLoadBuilder(['--check']).checked, true, 'Checked-in bootstrap and source registry must match the reviewed supplement');
  const reviewedCase = reviewedLoadProjects.projects.find(p => p.eligible && reviewedLoadProjects.sources.find(s => s.id === p.sourceId)?.coverage === 'case');
  assert.ok(reviewedCase, 'The shipped expansion must contain a reviewed official case beyond ISO registers');
  const reviewedSource = reviewedLoadProjects.sources.find(s => s.id === reviewedCase.sourceId)!;
  assert.ok(matchingReviewedLoadProject(reviewedCase));
  assert.equal(matchingReviewedLoadProject({ ...reviewedCase, rawStatus: reviewedCase.rawStatus + ' changed' }), null);
  assert.equal(eligibleSourceForProject(reviewedCase, reviewedSource), true);
  assert.equal(eligibleSourceForProject(reviewedCase, { ...reviewedSource, url: 'https://unreviewed.example.org' }), false);
  assert.equal(eligibleSourceForProject(project('unreviewed'), source), false);
  const migration = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  const db = createLocalDatabase(':memory:'); db.exec(migration);
  const call = (p: Project) => handleApi(new Request('http://127.0.0.1/api/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [p], sources: [reviewedSource] }) }), { DB: db, LOCAL_DEV: '1' });
  try {
    assert.equal((await call({ ...reviewedCase, loadMw: reviewedCase.loadMw === null ? 1 : reviewedCase.loadMw + 1, capacityStatus: 'known' })).status, 400);
    const accepted = await call(reviewedCase); assert.equal(accepted.status, 201, await accepted.text());
    const bootstrap = JSON.parse(readFileSync(new URL('../data/bootstrap.json', import.meta.url), 'utf8')) as ReviewedBootstrap;
    const completeProjects = bootstrap.projects.filter(project => project.sourceId === reviewedSource.id);
    const importBody = { sourceId: reviewedSource.id, source: reviewedSource, projects: completeProjects, completeScope: true, retrievedAt: new Date().toISOString(), sourceSha256: 'd'.repeat(64) };
    const requestImport = (body: unknown) => handleApi(new Request('http://127.0.0.1/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { DB: db, LOCAL_DEV: '1' });
    const rejected = await requestImport({ ...importBody, projects: completeProjects.map(p => p.id === reviewedCase.id ? { ...p, rawStatus: p.rawStatus + ' unreviewed revision' } : p) });
    assert.equal(rejected.status, 400);
    const imported = await requestImport(importBody); assert.equal(imported.status, 200, await imported.text());
  } finally { db.close(); }
  const unknownStage = reviewedLoadProjects.projects.find(p => p.eligible && matchingReviewedLoadProject(p)?.stage === null
    && selectLatestStageInferences(projectStageInferences, { projectId: p.id }).length === 0);
  assert.ok(unknownStage, 'Unknown-stage active requests without a separate project-specific qualitative judgement must be retained');
  assert.equal(ratingPoint(scoreProject(unknownStage, [])), null, 'In-progress alone does not mean zero progress or 100 points');
});
