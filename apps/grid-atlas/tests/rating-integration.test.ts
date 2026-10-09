import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GATES, MODEL_VERSION, type Assessment, type Project, type Source } from '../shared/types.ts';
import { ratingPoint, scoreProject, summarize } from '../shared/scoring.ts';
import { STAGE_ESTIMATE_VERSION } from '../shared/stage-estimate.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { isDemandDataset } from '../shared/market.ts';
import { createLocalDatabase } from '../server/local-db.ts';
import { handleApi, type ApiEnvironment } from '../server/api.ts';
import { seedDatabase } from '../server/database.ts';

const at = { asOf: '2026-10-08', knownAt: '2026-10-08T13:00:00Z' };
const source: Source = {
  id: 'lbnl-generation-storage-queues', name: 'LBNL fixture', region: 'PJM', types: ['generation', 'storage'],
  url: 'https://emp.lbl.gov/queues', coverage: 'full_register', sourceAsOf: '2025-12-31',
  lastCheckedAt: '2026-10-08', refreshCadence: 'annual', recordCount: 2, gaps: [], adapter: 'fixture',
};
function project(id: string, rawStatus: string, values: Partial<Project> = {}): Project {
  return { id, sourceId: source.id, sourceRecordId: id, name: id, types: ['generation'], region: 'PJM', state: 'PA',
    status: 'active', generationMw: 1, storageMw: null, loadMw: null, capacityStatus: 'known', eligible: true,
    exclusionReason: null, sourceUrl: source.url, sourceAsOf: source.sourceAsOf, rawStatus, identityScope: 'source_record', ...values };
}
function evidence(p: Project, gate: Assessment['gate'], values: Partial<Assessment> = {}): Assessment {
  return { id: `${p.id}-${gate}`, projectId: p.id, gate, status: 'complete', progress: 1, basis: 'official',
    sourceUrl: 'https://emp.lbl.gov/queues', effectiveAt: '2026-10-08', publishedAt: '2026-10-08',
    observedAt: '2026-10-08T11:00:00Z', recordedAt: '2026-10-08T12:00:00Z', rationale: 'Dated gate review fixture',
    modelVersion: MODEL_VERSION, ...values };
}

test('model ratings average equally across projects while preserving evidence counts, hybrid identity, types and regions', () => {
  const hybrid = project('hybrid', 'IA Executed', { types: ['generation', 'storage'], generationMw: 10000, storageMw: 50 });
  const construction = project('construction', 'Construction');
  const load = project('load', 'Under Construction', { sourceId: 'nyiso-load-register', sourceUrl: 'https://www.nyiso.com/documents/20142/1407078/NYISO-Interconnection-Queue.xlsx', types: ['load'], region: 'NYISO', state: 'NY', generationMw: null, loadMw: 200 });
  const unknown = { ...load, id: 'unknown', sourceRecordId: 'unknown', rawStatus: 'Active' };
  const excluded = project('excluded', 'Not Started', { eligible: false, status: 'withdrawn', exclusionReason: 'Withdrawn' });
  const scores = [hybrid, construction, load, unknown, excluded].map(p => scoreProject(p, [], at));
  const summary = summarize([...scores, structuredClone(scores[0])]);
  assert.equal(summary.recordCount, 5);
  assert.equal(summary.eligibleCount, 4);
  assert.equal(summary.ratedCount, 3);
  assert.equal(summary.ratingUnknownCount, 1);
  assert.equal(summary.ratingEstimatedCount, 3);
  assert.equal(summary.ratingMean, 33.3333333333);
  assert.equal(summary.pointMean, null);
  assert.equal(summary.scoredCount, 0);
  assert.equal(summary.unknownCount, 4);
  assert.deepEqual(summary.ratingTypeCounts, { generation: 2, storage: 1, load: 1 });
  assert.deepEqual(summary.ratingTypeMeans, { generation: 37.5, storage: 50, load: 25 });
  assert.deepEqual(summary.ratingRegions, [
    { region: 'NYISO', mean: 25, ratedCount: 1, unknownCount: 1, estimatedCount: 1 },
    { region: 'PJM', mean: 37.5, ratedCount: 2, unknownCount: 0, estimatedCount: 2 },
  ]);
  assert.equal(scores[0].point, null);
  assert.equal(scores[0].lower, 0);
  assert.equal(scores[0].upper, 100);
  assert.ok(scores[0].gates.every(g => g.assessment === null && g.progress === null));
  assert.equal(scores[4].stageEstimate, null);
});

test('complete evidence wins and partial or explicitly revoked evidence suppresses the coarse model', () => {
  const p = project('construction', 'Construction');
  assert.equal(ratingPoint(scoreProject(p, [], at)), 25);
  const complete = scoreProject(p, GATES.map(g => evidence(p, g)), at);
  assert.equal(ratingPoint(complete), 0);
  assert.equal(complete.stageEstimate, null);
  assert.equal(summarize([complete]).ratingEstimatedCount, 0);
  const estimated = scoreProject(p, GATES.map(g => evidence(p, g, { basis: 'estimate' })), at);
  assert.equal(summarize([estimated]).ratingEstimatedCount, 1);
  for (const row of [evidence(p, 'technical'), evidence(p, 'technical', { status: 'unknown', progress: null })]) {
    const score = scoreProject(p, [row], at);
    assert.equal(score.stageEstimate, null);
    assert.equal(ratingPoint(score), null);
  }
  const later = evidence(p, 'technical', { recordedAt: '2026-10-08T14:00:00Z' });
  assert.equal(ratingPoint(scoreProject(p, [later], at)), 25);
  assert.equal(summarize([]).ratingMean, null);
  assert.equal(summarize([scoreProject(project('unknown', 'active'), [], at)]).ratingMean, null);
});

function call(env: ApiEnvironment, path: string, payload?: unknown) {
  return handleApi(new Request('http://127.0.0.1:5176' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), env);
}

test('API filters, detail, CSV and exported runtime agree on stage ratings without manufacturing evidence', async t => {
  const db = createLocalDatabase(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const env = { DB: db, LOCAL_DEV: '1' };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T12:00:00Z') });
  try {
    await seedDatabase(db, { projects: [project('construction', 'Construction'), project('unknown', 'active')], sources: [source] });
    t.mock.timers.setTime(Date.parse(at.knownAt));
    const params = new URLSearchParams(at).toString();
    const dashboard = await (await call(env, '/api/dashboard?' + params)).json();
    assert.equal(dashboard.ratingMethodVersion, STAGE_ESTIMATE_VERSION);
    assert.equal(dashboard.summary.ratingMean, 25);
    assert.equal(dashboard.summary.pointMean, null);
    const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
    const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
    assert.ok(start > 0 && end > start);
    const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
    const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
    install({ projects: dashboard.projects.map((s: { project: Project }) => s.project), snapshot: dashboard.snapshot,
      exportedAt: at.knownAt, modelVersion: MODEL_VERSION, ratingMethodVersion: STAGE_ESTIMATE_VERSION,
      sources: dashboard.sources, limitations: dashboard.limitations },
    { scoreProject, summarize, ratingPoint, calendarDayKst, endOfKstDay, isCalendarDay, isDemandDataset }, false);
    for (const filter of ['status=scored', 'status=unknown', 'q=Construction', 'q=' + encodeURIComponent('공사')]) {
      const path = '/api/dashboard?' + params + '&' + filter;
      const live = await (await call(env, path)).json();
      const offline = await (await window.fetch(path)).json();
      assert.deepEqual(offline.projects, live.projects);
      assert.deepEqual(offline.summary, live.summary);
      assert.equal(live.total, 1);
    }
    const detail = await (await call(env, '/api/projects/construction?' + params)).json();
    assert.equal(detail.score.stageEstimate.point, 25);
    assert.equal(detail.totalAssessments, 0);
    assert.equal(detail.score.point, null);
    assert.equal(detail.score.stageEstimate.modelVersion, STAGE_ESTIMATE_VERSION);
    assert.equal(detail.score.stageEstimate.sourceAsOf, '2025-12-31');
    const csvPath = '/api/export?' + params + '&status=scored';
    const liveCsv = await (await call(env, csvPath)).text();
    assert.equal(await (await window.fetch(csvPath)).text(), liveCsv);
    assert.match(liveCsv, /rating_score,rating_basis,rating_model_version/);
    assert.match(liveCsv, /"25","stage_model","stage-proxy-v1"/);
    assert.doesNotMatch(liveCsv, /"unknown"/);
    const old = await (await window.fetch('/api/dashboard?asOf=2000-01-01')).json();
    assert.equal(old.available, false);
    assert.equal(old.summary.ratingMean, null);
  } finally { t.mock.timers.reset(); db.close(); }
});

test('history re-rates each stored source status without backfilling from the current construction status', async t => {
  const db = createLocalDatabase(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const env = { DB: db, LOCAL_DEV: '1' };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T12:00:00Z') });
  try {
    await seedDatabase(db, { projects: [project('changing', 'Not Started')], sources: [{ ...source, recordCount: 1 }] });
    const originalKnownAt = new Date().toISOString();
    t.mock.timers.setTime(Date.parse(at.knownAt));
    const imported = await call(env, '/api/import', {
      sourceId: source.id, source: { ...source, recordCount: 1 }, projects: [project('changing', 'Construction')],
      completeScope: true, retrievedAt: at.knownAt, sourceSha256: 'a'.repeat(64),
    });
    assert.equal(imported.status, 200, await imported.text());
    assert.equal((await call(env, '/api/snapshots', {})).status, 201);
    const now = await (await call(env, '/api/dashboard')).json();
    assert.equal(now.summary.ratingMean, 25);
    assert.deepEqual(now.history.map((p: { summary: { ratingMean: number } }) => p.summary.ratingMean), [100, 25]);
    const then = await (await call(env, '/api/dashboard?knownAt=' + encodeURIComponent(originalKnownAt))).json();
    assert.equal(then.summary.ratingMean, 100);
    assert.equal(then.projects[0].project.rawStatus, 'Not Started');
    assert.equal((await (await call(env, '/api/dashboard?asOf=2000-01-01')).json()).available, false);
  } finally { t.mock.timers.reset(); db.close(); }
});
