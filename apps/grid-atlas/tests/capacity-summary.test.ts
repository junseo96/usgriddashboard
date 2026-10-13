import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { AGGREGATION_VERSION, GATES, MODEL_VERSION, type Assessment, type Project, type Source } from '../shared/types.ts';
import { projectCapacityMw, ratingPoint, scoreProject, summarize } from '../shared/scoring.ts';
import { projectCsv } from '../shared/csv.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { STAGE_ESTIMATE_VERSION } from '../shared/stage-estimate.ts';
import { createLocalDatabase } from '../server/local-db.ts';
import { handleApi } from '../server/api.ts';
import { seedDatabase, readSnapshot } from '../server/database.ts';

const source: Source = { id: 'lbnl-generation-storage-queues', name: 'Capacity fixture', region: 'PJM', types: ['generation', 'storage'], url: 'https://emp.lbl.gov/queues', coverage: 'full_register', sourceAsOf: '2025-12-31', lastCheckedAt: '2026-10-08', refreshCadence: 'annual', recordCount: 2, gaps: [], adapter: 'fixture' };
function project(id: string, values: Partial<Project> = {}): Project {
  return { id, sourceId: source.id, sourceRecordId: id, name: id, types: ['generation'], region: 'PJM', state: 'PA', status: 'active', generationMw: 100, storageMw: null, loadMw: null, capacityStatus: 'known', eligible: true, exclusionReason: null, sourceUrl: source.url, sourceAsOf: source.sourceAsOf, rawStatus: 'Not Started', identityScope: 'source_record', ...values };
}
const round = (n: number) => Math.round(n * 1e10) / 1e10;
const rows = [project('large', { types: ['generation', 'storage'], generationMw: 1000, storageMw: 10 }), project('small', { types: ['generation', 'storage'], generationMw: 100, storageMw: 90, rawStatus: 'Construction' })];
const score = (p: Project) => scoreProject(p, [], { asOf: '2026-10-09', knownAt: '2026-10-09T00:00:00Z' });

test('component-specific weights, composite weights, and within-region means differ correctly', () => {
  const scores = rows.map(score), all = summarize(scores), generation = summarize(scores, { type: 'generation' }), storage = summarize(scores, { type: 'storage' });
  assert.equal(all.aggregationVersion, AGGREGATION_VERSION);
  assert.equal(all.weightingBasis, 'disclosed_component_mw');
  assert.equal(all.ratingMean, 88.125);
  assert.equal(all.projectCountRatingMean, 62.5);
  assert.equal(all.ratedCapacityMw, 1200);
  assert.equal(all.ratingWeightedCount, 2);
  assert.equal(generation.ratingMean, round(102500 / 1100));
  assert.equal(generation.ratedCapacityMw, 1100);
  assert.equal(generation.weightingBasis, 'generation_mw');
  assert.equal(storage.ratingMean, 32.5);
  assert.equal(storage.ratedCapacityMw, 100);
  assert.equal(storage.ratingRegions[0].mean, 32.5);
  assert.equal(storage.ratingRegions[0].ratedCapacityMw, 100);
  assert.equal(all.ratingTypeMeans.storage, storage.ratingMean);
  assert.equal(all.ratingTypeMeans.generation, generation.ratingMean);
  assert.equal(projectCapacityMw(rows[0]), 1010);
  assert.equal(projectCapacityMw(rows[0], 'load'), null);
});

test('missing and disclosed zero MW remain separate from unknown scores; no denominator-only records', () => {
  const records = [...rows, project('missing', { generationMw: null, capacityStatus: 'unknown' }), project('zero', { generationMw: 0 }), project('unrated', { generationMw: 5000, rawStatus: 'unknown' })];
  const summary = summarize(records.map(score));
  assert.equal(summary.ratingMean, 88.125);
  assert.equal(summary.ratedCount, 4);
  assert.equal(summary.ratingWeightedCount, 2);
  assert.equal(summary.ratedCapacityMw, 1200);
  assert.equal(summary.ratingUnscoredCapacityMw, 5000);
  assert.equal(summary.boundsCapacityMw, 6200);
  assert.equal(summary.missingCapacityCount, 1);
  assert.equal(summary.zeroCapacityCount, 1);
  assert.equal(summary.ratedMissingCapacityCount, 1);
  assert.equal(summary.ratedZeroCapacityCount, 1);
  assert.equal(summary.projectCountRatingMean, 81.25);
  const absent = summarize(records.slice(2, 4).map(score));
  assert.equal(absent.ratingMean, null);
  assert.equal(absent.projectCountRatingMean, 100);
  assert.equal(absent.lowerMean, null);
  assert.equal(absent.upperMean, null);
  const partial = summarize([score(project('partial', { types: ['generation', 'storage'], generationMw: 100, storageMw: null, capacityStatus: 'partial' }))]);
  assert.equal(partial.partialCapacityCount, 1);
  assert.equal(partial.ratedCapacityMw, 100);
  assert.equal(partial.ratingTypeMeans.storage, null);
  assert.equal(partial.ratingTypeCapacityMw.storage, 0);
  for (const invalid of [NaN, Infinity, -1]) assert.throws(() => summarize([score(project('invalid', { generationMw: invalid }))]), /Invalid generationMw/);
});

test('API and Pages runtime use the selected component for current and historical summaries', async t => {
  const db = createLocalDatabase(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const env = { DB: db, LOCAL_DEV: '1' };
  const call = (path: string, body?: unknown) => handleApi(new Request('http://127.0.0.1:5176' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T12:00:00Z') });
  try {
    await seedDatabase(db, { projects: rows, sources: [source] });
    t.mock.timers.setTime(Date.parse('2026-10-08T13:00:00Z'));
    const current = await (await call('/api/dashboard')).json();
    const originalSnapshot = structuredClone(await readSnapshot(db, current.snapshot.id));
    const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
    const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
    const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
    const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
    install({ projects: rows, snapshot: current.snapshot, exportedAt: new Date().toISOString(), modelVersion: MODEL_VERSION, ratingMethodVersion: STAGE_ESTIMATE_VERSION, sources: [source], limitations: current.limitations }, { scoreProject, summarize, ratingPoint, projectCsv, calendarDayKst, endOfKstDay, isCalendarDay }, false);
    for (const type of ['all', 'generation', 'storage', 'load']) {
      const path = '/api/dashboard?type=' + type;
      const live = await (await call(path)).json(), offline = await (await window.fetch(path)).json();
      assert.deepEqual(offline.summary, live.summary, type);
      assert.deepEqual(offline.history, live.history, type + ' history');
    }
    // Later source changes affect only the newer observation's capacity and status.
    t.mock.timers.setTime(Date.parse('2026-10-09T13:00:00Z'));
    const updated = [rows[0], { ...rows[1], storageMw: 990, rawStatus: 'IA Executed' }];
    const imported = await call('/api/import', { sourceId: source.id, source, projects: updated, completeScope: true, retrievedAt: new Date().toISOString(), sourceSha256: 'a'.repeat(64) });
    assert.equal(imported.status, 200, await imported.text());
    assert.equal((await call('/api/snapshots', {})).status, 201);
    const storage = await (await call('/api/dashboard?type=storage')).json();
    assert.deepEqual(storage.history.map((p: { summary: { ratingMean: number; ratedCapacityMw: number } }) => [p.summary.ratingMean, p.summary.ratedCapacityMw]), [[32.5, 100], [50.5, 1000]]);
    assert.deepEqual(await readSnapshot(db, current.snapshot.id), originalSnapshot);
  } finally { t.mock.timers.reset(); db.close(); }
});

test('cached previews validate their original count mean then upgrade using archived MW', () => {
  const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
  const start = script.indexOf('function validateObservation('), end = script.indexOf('\n// Shares live API', start);
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);
  const validate = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { summarize, scoreProject, calendarDayKst, STAGE_ESTIMATE_VERSION, stable });
  const legacySummary = {
    recordCount: 2, eligibleCount: 2, scoredCount: 0, unknownCount: 2, excludedCount: 0, estimatedCount: 0,
    pointMean: null, lowerMean: 0, upperMean: 100, generationMw: 1100, storageMw: 100, loadMw: 0,
    capacityUnknownCount: 0, typeCounts: { generation: 2, storage: 2, load: 0 },
    knownCapacityCounts: { generation: 2, storage: 2, load: 0 }, ratingMean: 62.5, ratedCount: 2,
    ratingUnknownCount: 0, ratingEstimatedCount: 2, ratingTypeMeans: { generation: 62.5, storage: 62.5, load: null },
    ratingTypeCounts: { generation: 2, storage: 2, load: 0 },
    ratingRegions: [{ region: 'PJM', mean: 62.5, ratedCount: 2, unknownCount: 0, estimatedCount: 2 }],
  };
  const archive = {
    format: 'grid-atlas-offline-preview-v1', modelVersion: MODEL_VERSION, ratingMethodVersion: STAGE_ESTIMATE_VERSION,
    exportedAt: '2026-10-08T13:00:00Z', snapshot: { capturedAt: '2026-10-08T12:00:00Z', modelVersion: MODEL_VERSION, projectCount: 2, sourceCount: 1 },
    projects: structuredClone(rows), sources: [source], limitations: [], health: {}, runs: { runs: [] },
    verification: { allGatesVerifiedUnknown: true, assessedGateCount: 0, actualApiProjectCount: 2 }, summary: legacySummary,
  };
  const before = structuredClone(archive);
  validate(archive);
  assert.equal(archive.summary.ratingMean, 88.125);
  assert.deepEqual(archive.projects, before.projects);
  assert.deepEqual(archive.snapshot, before.snapshot);
  validate(archive); // Versioned recalculation must reproduce strictly on a second export.
  const corrupted = structuredClone(before); corrupted.summary.ratingMean = 88.125;
  assert.throws(() => validate(corrupted), /does not reproduce/);
});


test('direct-score mean and uncertainty bounds use their own positive-MW denominators', () => {
  const stalled = project('stalled', { generationMw: 1000 }), complete = project('complete', { generationMw: 100 }), partial = project('partial', { generationMw: 900 });
  const evidence = (p: Project, completed: boolean): Assessment[] => GATES.map(gate => ({
    id: `${p.id}:${gate}`, projectId: p.id, gate, status: completed ? 'complete' : 'not_started',
    progress: completed ? 1 : 0, basis: 'official', sourceUrl: p.sourceUrl,
    effectiveAt: '2026-10-08', publishedAt: '2026-10-08', observedAt: '2026-10-08T01:00:00Z',
    recordedAt: '2026-10-08T02:00:00Z', rationale: 'Dated gate evidence fixture.', modelVersion: MODEL_VERSION,
  }));
  const summary = summarize([scoreProject(stalled, evidence(stalled, false)), scoreProject(complete, evidence(complete, true)), scoreProject(partial, evidence(partial, true).slice(0, 1))]);
  assert.equal(summary.pointMean, 90.9090909091);
  assert.equal(summary.ratingMean, summary.pointMean);
  assert.equal(summary.scoredCapacityMw, 1100);
  assert.equal(summary.ratedCapacityMw, 1100);
  assert.equal(summary.boundsCapacityMw, 2000);
  assert.equal(summary.lowerMean, 50);
  assert.equal(summary.upperMean, 86);
  assert.equal(summary.ratingUnscoredCapacityMw, 900);
});
