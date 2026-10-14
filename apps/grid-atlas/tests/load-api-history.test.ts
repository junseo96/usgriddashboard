import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLoadApiHistoricalSeries, LOAD_API_HISTORY_ID } from '../shared/load-api-history.ts';
import type { LoadApiDataset, LoadApiRecord } from '../shared/load-api.ts';
import { historicalCsv, validateHistoricalDataset, type HistoricalDataset } from '../shared/history.ts';
import { buildTimelineSeries, timelineCanJoin } from '../shared/timeline.ts';

const stamp = '2026-10-14T13:00:00.000Z';
function record(id: string, month: string, totalMw: number, overrides: Partial<LoadApiRecord> = {}): LoadApiRecord {
  return {
    id, region: 'ERCOT', scope: 'regional_aggregate', snapshotMonth: `${month}-01`, reportDate: `${month}-20`,
    totalMw, colocatedMw: null, standaloneMw: null, byStatus: null, bySizeBucket: null, byType: null, byZone: null,
    approvedToEnergizeMw: null, planningStudiesApprovedMw: null, trailing12mo: null,
    sourceUrl: `https://www.ercot.com/files/docs/${month}/large-load.pdf`, providerExtractedAt: '2026-08-05T03:43:08.458Z',
    fetchedAt: stamp, receipt: { url: 'https://data.kardashevlabs.org/ercot/large-load/history', fetchedAt: stamp, sha256: 'a'.repeat(64) },
    payloadSha256: 'b'.repeat(64), verification: 'provider_extraction_unverified', qualityIssues: [], ...overrides,
  };
}
function dataset(records: LoadApiRecord[]): LoadApiDataset {
  return { schemaVersion: 1, generatedAt: stamp, provider: 'kardashev', records,
    collection: { startedAt: stamp, completedAt: stamp, status: 'success', lastSuccessAt: stamp,
      addedCount: records.length, error: null, endpointReceipts: [], warnings: [] } };
}
function historical(input: LoadApiDataset): HistoricalDataset {
  return { schemaVersion: 1, generatedAt: stamp, coverageStart: '2020-01-01', coverageEnd: '2026-10-14',
    limitations: [], series: buildLoadApiHistoricalSeries(input) };
}

test('API history selects the newest report and provider revision without destroying earlier vintages', () => {
  const january = record('jan', '2026-01', 100);
  const original = record('original', '2026-02', 200);
  const revision = record('revision', '2026-02', 210, { providerExtractedAt: '2026-08-06T00:00:00Z' });
  const laterReport = record('later-report', '2026-02', 220, { reportDate: '2026-03-02', providerExtractedAt: '2026-07-01T00:00:00Z' });
  const input = dataset([revision, january, laterReport, original]);
  const before = structuredClone(input);
  const series = buildLoadApiHistoricalSeries(input);
  assert.equal(series.length, 1);
  assert.equal(series[0].id, LOAD_API_HISTORY_ID);
  assert.deepEqual(series[0].points.map(p => p.value), [100, 220], 'later source report outranks later API receipt or extraction');
  assert.match(series[0].points[1].notes.join('\n'), /보존된 API 관측 3개/);
  assert.deepEqual(input, before, 'selection never overwrites stored report variants');
  const withinReport = buildLoadApiHistoricalSeries(dataset([original, revision]))[0];
  assert.equal(withinReport.points[0].value, 210, 'provider revision wins within one report');
  assert.deepEqual(buildLoadApiHistoricalSeries(dataset([...input.records].reverse())), series, 'response ordering does not change selection');
});

test('API monthly points preserve missing months, changed report bases and nested restatements without joining them', () => {
  const january = record('jan', '2026-01', 100, { trailing12mo: { '2025-12': 80, '2026-01': 110 } });
  const february = record('feb', '2026-02', 200);
  const april = record('apr', '2026-04', 400);
  const output = historical(dataset([january, february, april]));
  validateHistoricalDataset(output, '2026-10-15T00:00:00Z');
  const points = output.series[0].points;
  assert.deepEqual(points.map(p => p.sourceAsOf), ['2026-01', '2026-02', '2026-04']);
  assert.deepEqual(points.map(p => p.value), [100, 200, 400], 'trailing restatements do not replace report headline totals');
  assert.deepEqual(points.map(p => p.breakBefore), [false, true, true]);
  assert.match(points[0].notes.join('\n'), /110 MW/);
  assert.match(points[2].notes.join('\n'), /중간 월은 보간/);
  const timeline = buildTimelineSeries({ historical: output })[0];
  assert.equal(timelineCanJoin(timeline, timeline.points[0], timeline.points[1]), false);
  assert.equal(timelineCanJoin(timeline, timeline.points[1], timeline.points[2]), false);
});

test('API source provenance hashes the acquired API body and retains the original report separately', () => {
  const row = record('row', '2026-02', 0, {
    qualityIssues: [{ code: 'status_total_differs', severity: 'warning', detail: '단계 부분합과 총량의 차이', reportedSumMw: 10, expectedMw: 0 }],
  });
  const output = historical(dataset([row]));
  validateHistoricalDataset(output, '2026-10-15T00:00:00Z');
  const series = output.series[0], point = series.points[0];
  assert.equal(point.value, 0, 'a published zero remains a real zero');
  assert.equal(point.source.sha256, row.receipt.sha256);
  assert.notEqual(point.source.sha256, row.payloadSha256);
  assert.equal(point.source.url, row.receipt.url);
  assert.equal(point.source.originalUrl, row.sourceUrl);
  assert.equal(point.source.retrievedAt, row.fetchedAt);
  assert.equal(point.datePrecision, 'month');
  assert.equal(point.dateBasis, 'source_as_of');
  assert.equal(point.date, '2026-02-01');
  assert.equal(point.publishedAt, '2026-02-20');
  assert.equal(point.observedAt, undefined, 'a month anchor is not a backdated system observation');
  assert.equal(series.metric, 'load_requests');
  assert.equal(series.unit, 'MW');
  assert.deepEqual(series.projectTypes, ['load']);
  assert.match(series.scope, /데이터센터 외/);
  assert.equal(point.projectCount, null);
  assert.equal(point.ratedCount, null);
  assert.equal(point.ratingModelVersion, null);
  assert.match(point.notes.join('\n'), /API 응답 바이트/);
  assert.match(point.notes.join('\n'), /단계 부분합과 총량의 차이/);
  assert.match(historicalCsv(output), /kardashev-ercot-large-load-total/);
  assert.ok(historicalCsv(output).includes(row.sourceUrl));
});

test('empty API data does not invent history and failed refresh preserves earlier receipts', () => {
  assert.deepEqual(buildLoadApiHistoricalSeries(dataset([])), []);
  const input = dataset([record('saved', '2026-02', 120)]);
  input.collection = { ...input.collection, status: 'failed', error: 'upstream unavailable', addedCount: 0 };
  const saved = buildLoadApiHistoricalSeries(input)[0].points[0];
  assert.equal(saved.value, 120);
  assert.equal(saved.source.retrievedAt, stamp);
  assert.equal(saved.sourceAsOf, '2026-02');
  assert.equal(saved.observedAt, undefined);
});
