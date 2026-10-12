import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Source } from '../shared/types.ts';
import { applyProjectStatusReviews, matchingProjectStatusReview, validateProjectStatusReviews, type ProjectStatusReview, type ProjectStatusReviewDataset } from '../shared/project-status-reviews.ts';
import { applyProjectStatusReviewsToBootstrap, runProjectStatusReviewBuilder, type StatusReviewedBootstrap } from '../scripts/apply-project-status-reviews.ts';

const base: Project = { id: 'generation:123', sourceId: 'official-register', sourceRecordId: '123', name: 'Project 123', types: ['generation'], region: 'PJM', state: 'PA', status: 'active', generationMw: 200, storageMw: null, loadMw: null, capacityStatus: 'known', eligible: true, exclusionReason: null, sourceUrl: 'https://operator.example.org/queue', sourceAsOf: '2026-01-01', rawStatus: 'Active in original January source', identityScope: 'source_record' };
const source: Source = { id: base.sourceId, name: 'Official queue', region: 'PJM', types: ['generation', 'storage', 'load'], url: base.sourceUrl, coverage: 'full_register', sourceAsOf: base.sourceAsOf, lastCheckedAt: '2026-01-02', refreshCadence: 'monthly', recordCount: 1, gaps: [], adapter: null };
function review(overrides: Partial<ProjectStatusReview> = {}): ProjectStatusReview {
  return { id: 'status:123:withdrawn', judgementId: 'judgement:123:withdrawn', evaluatedAt: '2026-10-01T00:00:00.000Z', asOf: '2026-09-15', statusBasis: 'explicit', baseProject: structuredClone(base), project: { ...base, status: 'withdrawn', eligible: false, exclusionReason: 'Reviewed September withdrawal; original January status is retained separately.' }, identityBasis: 'existing_register_record', identityRationale: 'The official operator filing lists the same queue ID 123.', statusRationale: 'The operator expressly marks this queue record as withdrawn on September 15.', sourceEvidence: [{ url: 'https://operator.example.org/queue-september', name: 'September withdrawal report', publisherKind: 'official', retrievedAt: '2026-09-30T00:00:00.000Z', sha256: 'b'.repeat(64), publishedAt: '2026-09-15', sourceAsOf: '2026-09-15', excerpt: 'Queue project 123 was withdrawn.' }], limitations: ['Withdrawal from this queue does not prove termination of every related development.'], ...overrides };
}
function dataset(reviews = [review()]): ProjectStatusReviewDataset { return { schemaVersion: 1, generatedAt: reviews.map(r => r.evaluatedAt).sort().at(-1) ?? '2026-10-01T00:00:00.000Z', reviews, limitations: [] }; }
function bootstrap(): StatusReviewedBootstrap { return { projects: [structuredClone(base)], sources: [structuredClone(source)], observations: [{ id: 'old-observation', status: 'active' }], provenance: { sourceRefreshes: [{ sourceId: source.id, sourceSha256: 'c'.repeat(64) }], summary: { records: 1, eligible: 1 } } }; }

test('a reviewed withdrawal changes the active denominator while preserving original source dates, statuses, capacities and history', () => {
  const original = bootstrap(), data = dataset(), result = applyProjectStatusReviewsToBootstrap(original, data, 'a'.repeat(64));
  assert.equal(result.projects[0].status, 'withdrawn'); assert.equal(result.projects[0].eligible, false); assert.equal(result.provenance.summary.eligible, 0);
  assert.equal(result.projects[0].rawStatus, base.rawStatus); assert.equal(result.projects[0].sourceAsOf, base.sourceAsOf); assert.equal(result.projects[0].generationMw, 200);
  assert.deepEqual(result.sources, original.sources); assert.deepEqual(result.observations, original.observations); assert.deepEqual(result.provenance.sourceRefreshes, original.provenance.sourceRefreshes);
  assert.deepEqual(original, bootstrap(), 'The base inventory is not mutated'); assert.deepEqual(applyProjectStatusReviewsToBootstrap(result, data, 'a'.repeat(64)), result);
  assert.equal(matchingProjectStatusReview(data, result.projects[0])?.baseProject?.rawStatus, base.rawStatus); assert.equal(matchingProjectStatusReview(data, base), null);
});

test('changed raw records require re-review instead of silently applying an old current-status opinion', () => {
  for (const patch of [{ rawStatus: 'New operator status' }, { sourceAsOf: '2026-09-30' }, { generationMw: 300 }, { sourceRecordId: 'another-site' }] as Partial<Project>[]) assert.throws(() => applyProjectStatusReviews([{ ...base, ...patch }], dataset()), /stale base/);
  assert.throws(() => applyProjectStatusReviews([], dataset()), /missing base/);
  const falseIdentity = review(); falseIdentity.project.name = 'A different named project'; assert.throws(() => validateProjectStatusReviews(dataset([falseIdentity])), /only status\/state/);
  const falseSourceDate = review(); falseSourceDate.project.sourceAsOf = '2026-09-15'; assert.throws(() => validateProjectStatusReviews(dataset([falseSourceDate])), /source identity, dates/);
  assert.throws(() => validateProjectStatusReviews(dataset([review({ baseProject: null })])), /base project is required/);
  const annualReference = review(); annualReference.sourceEvidence[0].sourceAsOf = '2025'; assert.doesNotThrow(() => validateProjectStatusReviews(dataset([annualReference])));
  annualReference.sourceEvidence[0].sourceAsOf = '2027'; assert.throws(() => validateProjectStatusReviews(dataset([annualReference])), /provenance or chronology/);
});

test('new active loads need explicit individual connection identity and preserve an undisclosed grid capacity', () => {
  const old = { ...base, id: 'load:456', types: ['load'] as Project['types'], status: 'reference' as const, eligible: false, state: null, generationMw: null, loadMw: null, capacityStatus: 'unknown' as const, exclusionReason: 'Current customer status unreviewed' };
  const current = { ...old, state: 'VA', status: 'active' as const, eligible: true, exclusionReason: null };
  const inferred = review({ id: 'status:456', baseProject: old, project: current, statusBasis: 'inferred', identityBasis: 'official_service_request', identityRationale: 'The one service request and named site are linked by the official request number.', statusRationale: 'Current grid-planning work for this particular customer supports an active-status inference.' });
  const result = applyProjectStatusReviews([old], dataset([inferred]), [source]); assert.equal(result[0].loadMw, null); assert.equal(result[0].eligible, true); assert.equal(result[0].state, 'VA'); assert.equal(result[0].rawStatus, old.rawStatus);
  assert.throws(() => validateProjectStatusReviews(dataset([{ ...inferred, identityBasis: 'existing_register_record' }])), /explicit individual/);
  assert.throws(() => validateProjectStatusReviews(dataset([{ ...inferred, project: { ...current, state: null } }])), /mainland/);
  const inferredConnection = { ...inferred, identityBasis: 'inferred_single_site_connection' as const, identityRationale: 'The official transmission plan identifies one new customer site and its supply work. The actual customer application is unavailable.' };
  const connectionResult = applyProjectStatusReviews([old], dataset([inferredConnection]), [source]);
  assert.equal(matchingProjectStatusReview(dataset([inferredConnection]), connectionResult[0])?.statusBasis, 'inferred');
  assert.throws(() => validateProjectStatusReviews(dataset([{ ...inferredConnection, statusBasis: 'explicit' }])), /labelled inferred/);
});

test('status history follows an exact review chain and cannot branch or mutate prior review content', () => {
  const first = review(), next = review({ id: 'status:123:reactivated', judgementId: 'judgement:reactivated', evaluatedAt: '2026-10-02T00:00:00.000Z', baseProject: first.project, project: { ...first.project, status: 'active', eligible: true, exclusionReason: null }, statusRationale: 'A newer reviewed operator record confirms reinstatement.' });
  const data = dataset([first, next]); assert.equal(applyProjectStatusReviews([base], data)[0].eligible, true); assert.deepEqual(applyProjectStatusReviews([first.project], data)[0], next.project);
  assert.throws(() => validateProjectStatusReviews(dataset([first, { ...next, baseProject: base }])), /exact base-to-target chain/);
  const initial = applyProjectStatusReviewsToBootstrap(bootstrap(), dataset([first]), 'a'.repeat(64));
  const altered = dataset([{ ...first, statusRationale: 'Changed under the same immutable review ID' }]); assert.throws(() => applyProjectStatusReviewsToBootstrap(initial, altered, 'd'.repeat(64)), /Immutable status review/);
});

test('reviewed status CLI check is read-only, preserves other input files, and detects an unapplied overlay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grid-status-'));
  try {
    const originalPath = join(directory, 'bootstrap.json'), reviewsPath = join(directory, 'reviews.json'); writeFileSync(originalPath, JSON.stringify(bootstrap())); writeFileSync(reviewsPath, JSON.stringify(dataset()));
    const args = ['--bootstrap', originalPath, '--reviews', reviewsPath], before = readFileSync(originalPath, 'utf8'), reviewBytes = readFileSync(reviewsPath, 'utf8');
    assert.throws(() => runProjectStatusReviewBuilder([...args, '--check']), /differs from reviewed/); assert.equal(readFileSync(originalPath, 'utf8'), before);
    runProjectStatusReviewBuilder(args); const applied = readFileSync(originalPath, 'utf8'); runProjectStatusReviewBuilder([...args, '--check']); assert.equal(readFileSync(originalPath, 'utf8'), applied); assert.equal(readFileSync(reviewsPath, 'utf8'), reviewBytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
