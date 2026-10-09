import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { LOAD_STAGE_CATALOG, LOAD_STAGE_MODEL_VERSION, filterLoadBottleneckSeries, isLoadBottleneckDataset,
  loadBottleneckCsv, parseLoadBottleneckFilters, rateLoadObservation, validateLoadBottleneckDataset,
  type LoadBottleneckBin, type LoadBottleneckDataset, type LoadBottleneckSeries, type LoadStage } from '../shared/load-bottleneck.ts';
import { MARKET_REGIONS } from '../shared/market-types.ts';
import { handleApi } from '../server/api.ts';
import { createLocalDatabase } from '../server/local-db.ts';
import { scoreProject, summarize, ratingPoint } from '../shared/scoring.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { isDemandDataset } from '../shared/market.ts';
import { filterHistoricalSeries, historicalCsv, parseHistoricalFilters } from '../shared/history.ts';

const source = { name: 'Official fixture table', url: 'https://example.org/table', retrievedAt: '2026-01-02T00:00:00Z', sha256: 'a'.repeat(64) };
function bin(stage: LoadStage, weight: number | null, membership: LoadBottleneckBin['membership'] = 'active'): LoadBottleneckBin {
  return { id: stage, rawStage: `Source ${stage}`, stage, weight, membership, notes: ['Synthetic test evidence only.'] };
}
function fixture(): LoadBottleneckDataset {
  const series: LoadBottleneckSeries = { id: 'fixture', name: 'One source population', region: 'ERCOT', scopeType: 'operator_aggregate',
    population: 'tracked_pool', weightBasis: 'capacity_mw', scope: 'One source scope, not national data.', comparability: 'Observed operating MW is not full contracted MW.',
    stageMappings: LOAD_STAGE_CATALOG.map(stage => ({ rawStage: `Source ${stage.stage}`, stage: stage.stage, rationale: 'Reviewed exact source category mapped to an explicit model assumption.' })),
    points: [{ id: 'fixture-2025', date: '2025-12-31', datePrecision: 'day', dateBasis: 'source_as_of', sourceAsOf: '2025-12-31',
      publishedAt: null, source, completePartition: true, totalWeight: 180, notes: ['Exclusive stage bins in the fixture source.'],
      bins: [bin('application', 10), bin('construction', 30), bin('unknown', 20), bin('operating', 100, 'operating'), bin('withdrawn', 20, 'withdrawn')] }] };
  return { schemaVersion: 1, modelVersion: LOAD_STAGE_MODEL_VERSION, generatedAt: '2026-01-02T01:00:00Z', limitations: ['Fixtures only.'],
    series: [series], regions: MARKET_REGIONS.map(region => ({ region, headlineSeriesId: region === 'ERCOT' ? series.id : null,
      gaps: ['No claim of nationwide completeness.'] })) };
}
const rated = (data: LoadBottleneckDataset) => rateLoadObservation(data.series[0], data.series[0].points[0]);

test('load stage model preserves explicit five-gate assumptions including existing NYISO levels', () => {
  const expected = { application: 100, feasibility: 90, preliminary_engineering: 90, technical_pending: 85, technical_study: 80,
    technical_approved: 75, design: 70, agreement_pending: 55, agreement: 50, construction: 25, energization_approved: 20, partial_energization: 10, operating: 0 };
  for (const [id, point] of Object.entries(expected)) {
    const definition = LOAD_STAGE_CATALOG.find(row => row.stage === id)!;
    assert.equal(definition.point, point);
    assert.equal(definition.gates.length, 5);
    assert.equal(definition.gates.reduce((sum, gate) => sum + 20 * (1 - gate.progress), 0), point);
    assert.ok(definition.rationale.length > 20);
  }
  assert.equal(LOAD_STAGE_CATALOG.find(row => row.stage === 'unknown')!.point, null);
});

test('MW stage proxy excludes operating and withdrawn weights and leaves unknown stages unrated', () => {
  const data = fixture(); validateLoadBottleneckDataset(data);
  const value = rated(data);
  assert.equal(value.point, 43.75);
  assert.equal(value.activeWeight, 60);
  assert.equal(value.ratedWeight, 40);
  assert.equal(value.unknownWeight, 20);
  assert.equal(value.coverage, 40 / 60);
  assert.equal(value.operatingWeight, 100);
  assert.equal(value.withdrawnWeight, 20);
  assert.equal(value.trackedPoint, 12.5, 'tracked index explicitly includes observed operating weight at zero');
  assert.equal(value.trackedRatedWeight, 140);
});

test('project-count and capacity-weighted indices stay separate without a regional or national combined mean', () => {
  const data = fixture();
  const countSeries = structuredClone(data.series[0]);
  countSeries.id = 'project-count'; countSeries.weightBasis = 'project_count'; countSeries.population = 'active_queue';
  countSeries.points[0].id = 'count-2025'; countSeries.points[0].totalWeight = 2;
  countSeries.points[0].bins = [bin('application', 1), bin('construction', 1)];
  data.series.push(countSeries); validateLoadBottleneckDataset(data);
  assert.equal(rateLoadObservation(countSeries, countSeries.points[0]).point, 62.5);
  assert.equal(rateLoadObservation(countSeries, countSeries.points[0]).trackedPoint, null);
  assert.equal(rated(data).point, 43.75);
  assert.deepEqual(filterLoadBottleneckSeries(data, { seriesId: 'project-count' }).map(row => row.id), ['project-count']);
  assert.ok(!('nationalMean' in data));
});

test('unresolved operating membership suppresses active average but can retain a labelled tracked bucket index', () => {
  const data = fixture(), point = data.series[0].points[0];
  point.bins = [bin('application', 10), bin('energization_approved', 20, 'unresolved')]; point.totalWeight = 30;
  validateLoadBottleneckDataset(data);
  const value = rated(data);
  assert.equal(value.point, null); assert.equal(value.activeWeight, null); assert.equal(value.coverage, null);
  assert.equal(value.trackedPoint, (1000 + 400) / 30); assert.equal(value.unresolvedWeight, 20);
  assert.ok(value.reasons.some(reason => reason.includes('가동 포함')));
});

test('partially energized customer bins receive only a tracked model index, not active or fully completed status', () => {
  const data = fixture(), point = data.series[0].points[0];
  data.series[0].weightBasis = 'project_count';
  point.bins = [bin('technical_study', 86), bin('agreement', 22), bin('partial_energization', 10, 'unresolved')];
  point.totalWeight = 118;
  validateLoadBottleneckDataset(data);
  const value = rated(data);
  assert.equal(value.point, null); assert.equal(value.activeWeight, null);
  assert.equal(value.trackedPoint, (86 * 80 + 22 * 50 + 10 * 10) / 118);
  assert.equal(value.operatingWeight, 0); assert.equal(value.unresolvedWeight, 10);
  assert.equal(value.trackedRatedWeight, 118, 'commercial and physical subdivisions must not duplicate the same 32 customers');
  point.bins[2].membership = 'active'; assert.equal(isLoadBottleneckDataset(data), false);
  point.bins[2].membership = 'operating'; assert.equal(isLoadBottleneckDataset(data), false);
});

test('contract maturity alone cannot become a five-gate bottleneck score', () => {
  const data = fixture(); data.series[0].population = 'contract_subset';
  data.series[0].points[0].bins = [bin('agreement', 100)]; data.series[0].points[0].totalWeight = 100;
  validateLoadBottleneckDataset(data);
  assert.equal(rated(data).point, null); assert.equal(rated(data).trackedPoint, null);
  assert.ok(rated(data).reasons.some(reason => reason.includes('계약 부분집합')));
});

test('unmeasured weights and incomplete partitions are not zero-filled or presented as complete weighted means', () => {
  const data = fixture(); data.series[0].points[0].bins[1].weight = null;
  validateLoadBottleneckDataset(data);
  const value = rated(data);
  assert.equal(value.point, null); assert.equal(value.trackedPoint, null);
  assert.equal(value.unknownWeight, null); assert.equal(value.activeWeight, null);
  const partial = fixture(); partial.series[0].points[0].completePartition = false;
  assert.equal(rated(partial).point, null); assert.equal(rated(partial).trackedPoint, null);
  const noTotal = fixture(); noTotal.series[0].points[0].totalWeight = null;
  assert.equal(rated(noTotal).point, null);
});

test('a disclosed empty queue has zero weight and no fabricated zero or 100 point mean', () => {
  const data = fixture(), point = data.series[0].points[0];
  point.bins = []; point.totalWeight = 0;
  validateLoadBottleneckDataset(data);
  const value = rated(data);
  assert.equal(value.activeWeight, 0); assert.equal(value.totalWeight, 0);
  assert.equal(value.point, null); assert.equal(value.coverage, null); assert.equal(value.trackedPoint, null);
});

test('validation rejects overlapping totals, fractional project counts and unsupported source mappings', () => {
  for (const mutate of [
    (d: LoadBottleneckDataset) => { d.series[0].points[0].totalWeight = 179; },
    (d: LoadBottleneckDataset) => { d.series[0].points[0].totalWeight = 181; },
    (d: LoadBottleneckDataset) => { d.series[0].points[0].bins.push({ ...d.series[0].points[0].bins[0] }); },
    (d: LoadBottleneckDataset) => { d.series[0].points[0].bins[0].rawStage = 'Unreviewed substring construction'; },
    (d: LoadBottleneckDataset) => { d.series[0].points[0].bins[0].stage = 'construction'; },
    (d: LoadBottleneckDataset) => { d.series[0].points[0].bins[3].membership = 'active'; },
    (d: LoadBottleneckDataset) => { d.series[0].weightBasis = 'project_count'; d.series[0].points[0].bins[0].weight = 9.5; },
    (d: LoadBottleneckDataset) => { d.series[0].points[0].bins[0].weight = -1; },
  ]) { const data = fixture(); mutate(data); assert.equal(isLoadBottleneckDataset(data), false); }
});

test('regional gaps remain explicit and a utility subset cannot be assigned to a different region headline', () => {
  const missing = fixture(); missing.regions.pop(); assert.equal(isLoadBottleneckDataset(missing), false);
  const cross = fixture(); cross.regions[0].headlineSeriesId = 'fixture'; assert.equal(isLoadBottleneckDataset(cross), false);
  const unknown = fixture(); unknown.regions[1].headlineSeriesId = 'nonexistent'; assert.equal(isLoadBottleneckDataset(unknown), false);
  const nonIso = fixture();
  nonIso.regions.push({ region: 'West', headlineSeriesId: null, gaps: ['Outside ISO/RTO coverage; no reviewed customer denominator.'] });
  nonIso.regions.push({ region: 'Southeast', headlineSeriesId: null, gaps: ['Customer stages not disclosed.'] });
  assert.ok(isLoadBottleneckDataset(nonIso));
  assert.equal(filterLoadBottleneckSeries(nonIso, parseLoadBottleneckFilters(new URLSearchParams('region=West'))).length, 0);
  nonIso.regions = nonIso.regions.filter(region => region.region !== 'CAISO');
  assert.equal(isLoadBottleneckDataset(nonIso), false, 'additional areas cannot replace a required ISO/RTO');
});

test('source cutoff precision, archive acquisition and future dates are checked independently', () => {
  const data = fixture(), point = data.series[0].points[0];
  point.sourceAsOf = '2025-Q4'; point.datePrecision = 'quarter'; point.date = '2025-10-01';
  validateLoadBottleneckDataset(data);
  point.date = '2025-12-31'; assert.equal(isLoadBottleneckDataset(data), false);
  const archive = fixture(), old = archive.series[0].points[0];
  old.dateBasis = 'archive_capture'; old.sourceAsOf = null; old.archiveCapturedAt = '2025-12-30T18:00:00Z';
  old.source = { ...source, originalUrl: source.url, url: 'https://web.archive.org/web/20251230180000id_/https://example.org/table' };
  assert.ok(isLoadBottleneckDataset(archive));
  old.source.retrievedAt = '2099-01-01T00:00:00Z'; assert.equal(isLoadBottleneckDataset(archive), false);
});

test('CSV retains quantity basis, excluded weights, exact source mapping and unknown blanks', () => {
  const data = fixture(); data.series[0].name = '=FORMULA()';
  const csv = loadBottleneckCsv(data);
  assert.match(csv, /"'=FORMULA\(\)"/);
  assert.match(csv, /"capacity_mw"/);
  assert.match(csv, /active_point,tracked_pool_point,active_weight,rated_weight,unknown_weight,operating_weight/);
  assert.match(csv, /"43.75","12.5","60","40","20","100","20"/);
  assert.match(csv, /"Source unknown","unknown","active","20",""/);
  assert.equal(loadBottleneckCsv(data, { start: '2026-01-01' }).split('\r\n').length, 1);
  assert.throws(() => parseLoadBottleneckFilters(new URLSearchParams('region=US')), RangeError);
  assert.throws(() => parseLoadBottleneckFilters(new URLSearchParams('start=2026-01-01&end=2025-01-01')), RangeError);
});

test('live and exported load bottleneck APIs match without changing or requiring project database tables', async () => {
  const db = createLocalDatabase(':memory:');
  try {
    const get = (path: string) => handleApi(new Request('https://grid.example.org' + path), { DB: db });
    const response = await get('/api/load-bottleneck'); assert.equal(response.status, 200);
    const loadBottleneck = await response.json(); validateLoadBottleneckDataset(loadBottleneck);
    const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
    const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
    const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
    const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
    const now = new Date().toISOString(), data = { projects: [], snapshot: { capturedAt: now }, exportedAt: now, loadBottleneck };
    const helpers = { scoreProject, summarize, ratingPoint, calendarDayKst, endOfKstDay, isCalendarDay, isDemandDataset,
      filterHistoricalSeries, historicalCsv, parseHistoricalFilters, loadBottleneckCsv, parseLoadBottleneckFilters };
    install(data, helpers, false);
    for (const path of ['/api/load-bottleneck', '/api/load-bottleneck/export', '/api/load-bottleneck/export?region=ERCOT']) {
      const live = await get(path), offline = await window.fetch(path);
      assert.equal(live.status, offline.status); assert.equal(await live.text(), await offline.text());
    }
    assert.equal((await get('/api/load-bottleneck/export?region=US')).status, 400);
    assert.equal((await window.fetch('/api/load-bottleneck/export?region=US')).status, 400);
    assert.equal((await window.fetch('/api/load-bottleneck', { method: 'POST' })).status, 401);
    install({ ...data, loadBottleneck: undefined }, helpers, false);
    assert.equal((await window.fetch('/api/load-bottleneck')).status, 503);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first<{ n: number }>())?.n, 0);
  } finally { db.close(); }
});
