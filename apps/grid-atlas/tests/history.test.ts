import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { filterHistoricalSeries, historicalCsv, isHistoricalDataset, parseHistoricalFilters, validateHistoricalDataset,
  type HistoricalDataset, type HistoricalPoint } from '../shared/history.ts';
import { handleApi } from '../server/api.ts';
import { createLocalDatabase } from '../server/local-db.ts';
import { scoreProject, summarize, ratingPoint } from '../shared/scoring.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { isDemandDataset } from '../shared/market.ts';

function point(id: string, date: string, value: number | null, fields: Partial<HistoricalPoint> = {}): HistoricalPoint {
  return { id, date, datePrecision: 'day', dateBasis: 'source_as_of', sourceAsOf: date, publishedAt: null,
    value, qualifier: 'exact', projectCount: null, ratedCount: null, unknownCount: null,
    source: { name: 'Official historical test fixture', url: 'https://example.org/history', retrievedAt: '2026-01-02T00:00:00Z', sha256: 'a'.repeat(64) },
    notes: ['Test evidence only'], ratingModelVersion: null, ...fields };
}
function fixture(): HistoricalDataset {
  return { schemaVersion: 1, generatedAt: '2026-01-02T01:00:00Z', coverageStart: '2020-01-01', coverageEnd: '2025-12-31',
    limitations: ['Separate source populations; missing observations remain missing.'], series: [
      { id: 'requests', name: 'Disclosed requests', region: 'ERCOT', projectTypes: ['load'], metric: 'load_requests', unit: 'MW',
        scope: 'Gross requested load', description: 'Separate from contracted demand.', comparability: 'Consistent request population only.',
        points: [point('requests-2024', '2024-12-31', 0), point('requests-2020', '2020-12-31', 1000), point('requests-2022', '2022-12-31', null)] },
      { id: 'score', name: 'Annual archived generation score', region: 'US', projectTypes: ['generation'], metric: 'bottleneck_score', unit: 'score',
        scope: 'Active applications in each archived year', description: 'Current model applied to retained historical statuses.', comparability: 'Changing active populations.',
        points: [point('score-2024', '2024-12-31', 70, { projectCount: 10, ratedCount: 8, unknownCount: 2, ratingModelVersion: 'stage-proxy-v1' })] },
    ] };
}

test('history preserves missing values, true zero, independent definitions, and source provenance', () => {
  const data = fixture();
  validateHistoricalDataset(data);
  const series = filterHistoricalSeries(data);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0].points.map(p => p.value), [1000, null, 0]);
  assert.deepEqual(series.map(s => s.unit), ['MW', 'score']);
  assert.equal(series[0].points[0].source.sha256, 'a'.repeat(64));
  assert.equal(data.series[0].points[0].id, 'requests-2024', 'filtering must not mutate source order');
  assert.equal(series[0].points.length, 3, 'missing years must not be interpolated');
});

test('history requires consistent metric, units, scope and type', () => {
  for (const mutate of [
    (d: HistoricalDataset) => { d.series[0].unit = 'score'; },
    (d: HistoricalDataset) => { d.series[0].projectTypes = ['generation']; },
    (d: HistoricalDataset) => { d.series[0].comparability = ''; },
    (d: HistoricalDataset) => { d.series[0].points[0].ratingModelVersion = 'stage-proxy-v1'; },
  ]) { const data = fixture(); mutate(data); assert.equal(isHistoricalDataset(data), false); }
});

test('signed load contracts remain a separate MW metric from gross connection requests', () => {
  const data = fixture();
  data.series.push({ ...data.series[0], id: 'contracts', metric: 'load_contracts',
    name: 'Signed customer agreements', scope: 'Signed data-center agreements at one utility',
    points: [point('contracts-2024', '2024-12-31', 500)] });
  validateHistoricalDataset(data);
  assert.deepEqual(filterHistoricalSeries(data, { metric: 'load_requests' }).map(s => s.id), ['requests']);
  assert.deepEqual(filterHistoricalSeries(data, parseHistoricalFilters(new URLSearchParams('metric=load_contracts'))).map(s => s.id), ['contracts']);
  assert.match(historicalCsv(data, { metric: 'load_contracts' }), /"load_contracts","MW"/);
  data.series[2].projectTypes = ['generation'];
  assert.equal(isHistoricalDataset(data), false);
});

test('history rejects impossible values, fabricated denominators and unversioned scores', () => {
  for (const fields of [
    { value: -1 }, { value: 101 }, { ratingModelVersion: null }, { ratedCount: 0 },
    { ratedCount: 11 }, { unknownCount: 1 }, { projectCount: null }, { value: null, ratedCount: 8 },
  ]) {
    const data = fixture(); Object.assign(data.series[1].points[0], fields);
    assert.equal(isHistoricalDataset(data), false, JSON.stringify(fields));
  }
  const missing = fixture();
  Object.assign(missing.series[1].points[0], { value: null, ratedCount: 0, unknownCount: 10 });
  assert.ok(isHistoricalDataset(missing));
});

test('history rejects future, duplicate and malformed evidence dates', () => {
  for (const mutate of [
    (d: HistoricalDataset) => { d.generatedAt = '2099-01-01T00:00:00Z'; },
    (d: HistoricalDataset) => { d.series[0].points[0].sourceAsOf = '2024-02-30'; },
    (d: HistoricalDataset) => { d.series[0].points[0].source.retrievedAt = '2027-01-01T00:00:00Z'; },
    (d: HistoricalDataset) => { d.series[0].points.push({ ...d.series[0].points[0], id: 'other' }); },
    (d: HistoricalDataset) => { d.series[0].points[0].id = d.series[1].points[0].id; },
    (d: HistoricalDataset) => { d.series[0].points[0].source.url = 'http://example.org/unsafe'; },
    (d: HistoricalDataset) => { d.series[0].points[0].source.sha256 = 'unknown'; },
  ]) { const data = fixture(); mutate(data); assert.equal(isHistoricalDataset(data), false); }
});

test('month/year precision uses explicit period start anchors without inventing event dates', () => {
  const data = fixture();
  Object.assign(data.series[0].points[0], { date: '2024-01-01', sourceAsOf: '2024', datePrecision: 'year' });
  Object.assign(data.series[0].points[1], { date: '2020-12-01', sourceAsOf: null, publishedAt: '2020-12', datePrecision: 'month', dateBasis: 'publication' });
  assert.ok(isHistoricalDataset(data));
  data.series[0].points[0].date = '2024-12-31';
  assert.equal(isHistoricalDataset(data), false);
});

test('quarter precision preserves the disclosed quarter and filters by its explicit axis anchor', () => {
  const data = fixture();
  Object.assign(data.series[0].points[0], { date: '2024-07-01', sourceAsOf: '2024-Q3', datePrecision: 'quarter' });
  validateHistoricalDataset(data);
  const selected = filterHistoricalSeries(data, { seriesId: 'requests', start: '2024-07-01', end: '2024-09-30' });
  assert.equal(selected[0].points.length, 1);
  assert.equal(selected[0].points[0].sourceAsOf, '2024-Q3');
  assert.match(historicalCsv(data), /"2024-07-01","quarter","source_as_of","2024-Q3"/);
  for (const invalid of [{ sourceAsOf: '2024-Q5' }, { date: '2024-09-30' }, { datePrecision: 'month' }, { sourceAsOf: '2099-Q1' }]) {
    const candidate = structuredClone(data);
    Object.assign(candidate.series[0].points[0], invalid);
    assert.equal(isHistoricalDataset(candidate), false, JSON.stringify(invalid));
  }
});

test('archive capture retains its actual timestamp and original URL without inventing source cutoff', () => {
  const data = fixture();
  const archived = data.series[0].points[0];
  Object.assign(archived, { date: '2024-09-17', dateBasis: 'archive_capture', archiveCapturedAt: '2024-09-16T18:00:00Z', sourceAsOf: null, publishedAt: null });
  archived.source.url = 'https://web.archive.org/web/20240916180000id_/https://example.org/register.xlsx';
  archived.source.originalUrl = 'https://example.org/register.xlsx';
  assert.ok(isHistoricalDataset(data));
  delete archived.source.originalUrl;
  assert.equal(isHistoricalDataset(data), false);
});

test('actual source observation and definition breaks survive independently of publication dates', () => {
  const data = fixture();
  Object.assign(data.series[0].points[0], { date: '2025-12-31', dateBasis: 'observation',
    observedAt: '2025-12-30T18:00:00Z', sourceAsOf: null, publishedAt: null, breakBefore: true });
  assert.ok(isHistoricalDataset(data));
  assert.equal(filterHistoricalSeries(data)[0].points.at(-1)?.breakBefore, true);
  data.series[0].points[0].observedAt = '2026-01-03T00:00:00Z';
  assert.equal(isHistoricalDataset(data), false);
});

test('history filters select exact disclosed dates without joining populations or extrapolating', () => {
  const data = fixture();
  const filtered = filterHistoricalSeries(data, { region: 'ERCOT', type: 'load', start: '2021-01-01', end: '2024-12-31' });
  assert.deepEqual(filtered.map(s => s.id), ['requests']);
  assert.deepEqual(filtered[0].points.map(p => p.value), [null, 0]);
  assert.equal(filterHistoricalSeries(data, { metric: 'bottleneck_score' })[0].id, 'score');
  assert.equal(filterHistoricalSeries(data, { seriesId: 'requests', start: '2025-01-01' })[0].points.length, 0);
  assert.throws(() => parseHistoricalFilters(new URLSearchParams('start=2025-01-01&end=2020-01-01')), RangeError);
  assert.throws(() => parseHistoricalFilters(new URLSearchParams('metric=contracted_load')), RangeError);
  assert.throws(() => parseHistoricalFilters(new URLSearchParams('start=2024-02-30')), RangeError);
});

test('history CSV retains qualifications, date precision, denominators and blanks, and neutralizes formula cells', () => {
  const data = fixture(); data.series[0].name = '=FORMULA()'; data.series[0].points[1].qualifier = 'greater_than';
  const csv = historicalCsv(data, { seriesId: 'requests' });
  assert.match(csv, /date_precision,date_basis,source_as_of,published_at,archive_captured_at,observed_at,break_before,value,qualifier/);
  assert.match(csv, /"'=FORMULA\(\)"/);
  assert.match(csv, /"1000","greater_than"/);
  assert.match(csv, /"2022-12-31","","","","false","","exact"/);
  assert.match(csv, /"2024-12-31","","","","false","0","exact"/);
  assert.doesNotMatch(csv, /score-2024/);
  assert.match(historicalCsv(data), /"10","8","2","stage-proxy-v1"/);
});

test('live and exported historical routes agree and work before the project database is initialized', async () => {
  const db = createLocalDatabase(':memory:');
  try {
    const get = (path: string) => handleApi(new Request('https://grid.example.org' + path), { DB: db });
    const response = await get('/api/historical');
    assert.equal(response.status, 200);
    const historical = await response.json();
    validateHistoricalDataset(historical);
    const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
    const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
    assert.ok(start > 0 && end > start);
    const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
    const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
    const now = new Date().toISOString();
    const data = { projects: [], snapshot: { capturedAt: now }, exportedAt: now, historical };
    const helpers = { scoreProject, summarize, ratingPoint, calendarDayKst, endOfKstDay, isCalendarDay, isDemandDataset,
      filterHistoricalSeries, historicalCsv, parseHistoricalFilters };
    install(data, helpers, false);
    for (const path of ['/api/historical', '/api/historical?type=load', '/api/historical?metric=bottleneck_score&start=2020-01-01',
      '/api/historical/export', '/api/historical/export?type=generation']) {
      const live = await get(path), offline = await window.fetch(path);
      assert.equal(offline.status, live.status);
      assert.equal(await offline.text(), await live.text());
    }
    assert.equal((await get('/api/historical?start=2025-01-01&end=2020-01-01')).status, 400);
    assert.equal((await window.fetch('/api/historical?start=2025-01-01&end=2020-01-01')).status, 400);
    assert.equal((await window.fetch('/api/historical', { method: 'POST' })).status, 401);
    install({ ...data, historical: undefined }, helpers, false);
    assert.equal((await window.fetch('/api/historical')).status, 503, 'legacy exports must not manufacture historical points');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first<{ n: number }>())?.n, 0);
  } finally { db.close(); }
});
