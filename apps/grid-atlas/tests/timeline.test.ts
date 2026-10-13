import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { HistoricalDataset } from '../shared/history.ts';
import type { LoadBottleneckDataset } from '../shared/load-bottleneck.ts';
import type { DemandDataset } from '../shared/market-types.ts';
import { buildTimelineSeries, comparableTimelineSeries, filterTimelineSeries, timelineCanJoin, timelineCsv, timelineMetricTransition, type TimelineSeries } from '../shared/timeline.ts';
const history = JSON.parse(readFileSync(new URL('../data/history.json', import.meta.url), 'utf8')) as HistoricalDataset;
const load = JSON.parse(readFileSync(new URL('../data/load-bottleneck.json', import.meta.url), 'utf8')) as LoadBottleneckDataset;
const demand = JSON.parse(readFileSync(new URL('../data/grid-demand.json', import.meta.url), 'utf8')) as DemandDataset;
const all = buildTimelineSeries({ historical: history, load, demand });
const byId = (id: string) => { const row = all.find(s => s.id === id); assert.ok(row, id); return row; };

test('switching project and system metrics removes incompatible preset filters while preserving a real region', () => {
  for (const metric of ['score', 'capacity', 'count'] as const) {
    const filters = timelineMetricTransition(metric, { region: 'PJM', type: 'system', origin: 'system' });
    assert.equal(filters.region, 'PJM');
    assert.equal(filters.type, 'all');
    assert.equal(filters.origin, 'all');
    assert.ok(filterTimelineSeries(all, filters).some(s => s.points.length > 0));
  }
  for (const metric of ['demand', 'peak'] as const) {
    const filters = timelineMetricTransition(metric, { region: '미국 본토', type: 'all', origin: 'historical' });
    assert.equal(filters.region, 'all');
    assert.equal(filters.type, 'system');
    assert.equal(filters.origin, 'all');
    assert.ok(filterTimelineSeries(all, filters).some(s => s.points.length > 0));
    assert.ok(filterTimelineSeries(all, filters).every(s => s.region !== '미국 본토'));
  }
});

test('integrated timeline preserves every historical value, scope and count without creating a national load mean', () => {
  assert.equal(all.filter(s => s.origin === 'historical').length, history.series.length);
  for (const original of history.series) {
    const normalized = byId(`history:${original.id}`);
    assert.equal(normalized.scope, original.scope);
    for (const p of original.points) {
      const actual = normalized.points.find(q => q.id === p.id)!;
      assert.equal(actual.value, p.value);
      assert.equal(actual.unknown, p.weightBasis === 'capacity_mw' ? p.ratingUnscoredCapacityMw : p.unknownCount);
      assert.equal(actual.population, p.weightBasis === 'capacity_mw' ? p.knownCapacityMw : p.projectCount);
      assert.equal(actual.source.sha256, p.source.sha256);
    }
  }
  const national = all.filter(s => s.region === '미국 본토');
  assert.ok(national.length > 0);
  assert.ok(national.every(s => s.originalId.startsWith('lbnl-') && !s.projectTypes.includes('load')));
  assert.ok(all.every(s => !s.id.includes('forecast')));
});

test('NYISO all-project and identical-seven cohorts retain their different denominators', () => {
  const register = byId('load:nyiso-load-register:active');
  const fixed = byId('load:nyiso-load-fixed-cohort:active');
  assert.equal(register.points.at(-1)?.denominator, 14112.9);
  assert.equal(register.points.at(-1)?.population, 14232.9);
  assert.equal(register.points.at(-1)?.unknown, 120);
  assert.ok(fixed.points.every(p => p.denominatorUnit === 'MW' && p.population! > 7 && p.denominator! > 7));
  assert.ok(fixed.points.at(-1)!.value! < 50);
  assert.ok(comparableTimelineSeries(register, fixed));
  assert.equal(fixed.points[0].dateBasis, 'archive_capture');
  assert.ok(fixed.points[0].archiveCapturedAt);
});

test('MW proxy, active project average and tracked reference indices are separate series', () => {
  const active = byId('load:ercot-load-stages:active');
  const tracked = byId('load:ercot-load-stages:tracked');
  const nyiso = byId('load:nyiso-load-register:active');
  assert.equal(active.weightBasis, 'capacity_mw');
  assert.equal(active.points.at(-1)?.denominatorUnit, 'MW');
  assert.notEqual(active.points.at(-1)?.value, tracked.points.at(-1)?.value);
  assert.equal(comparableTimelineSeries(active, nyiso), true);
  assert.ok(active.measure.includes('관측 소비 MW 제외'));
  const gpc = byId('load:gpc-large-load-stage-pool:tracked');
  assert.equal(gpc.points[0].population, null);
  assert.equal(byId('load:gpc-large-load-stage-pool:active').points[0].value, null);
  assert.ok(gpc.measure.includes('참고지수'));
  assert.equal(gpc.points[0].value, null, 'Unknown dated MW cannot be replaced by the old count mean');
  assert.ok(gpc.points[0].notes.some(n => n.includes('건수 평균(보조)')));
});

test('unrated source periods stay null and definition gaps cannot be joined', () => {
  const series = byId('load:ercot-load-stages:active');
  assert.equal(series.points[0].value, null);
  const missing = series.points.findIndex(p => p.value === null);
  assert.equal(timelineCanJoin(series, series.points[missing], series.points[missing + 1]), false);
  const changed = series.points.findIndex((p, index) => index > 0 && p.breakBefore);
  assert.ok(changed > 0);
  assert.equal(timelineCanJoin(series, series.points[changed - 1], series.points[changed]), false);
  const base = series.points.at(-1)!;
  assert.equal(timelineCanJoin(series, { ...base, date: '2026-01-01', timestamp: Date.parse('2026-01-01'), precision: 'month', breakBefore: false },
    { ...base, date: '2026-03-01', timestamp: Date.parse('2026-03-01'), precision: 'month', breakBefore: false }), false);
});

test('demand uses KST dates, peaks retain market-local dates and incomplete-day denominators', () => {
  const source = structuredClone(demand);
  source.regions = [source.regions.find(r => r.region === 'PJM')!];
  source.regions[0].series = [{ observedAt: '2026-10-08T16:00:00Z', mw: 101, quality: null }];
  source.regions[0].dailyPeaks = [{ date: '2026-10-08', peakAt: '2026-10-08T16:00:00Z', peakMw: 101, observations: 17, expectedObservations: 24, complete: false }];
  const rows = buildTimelineSeries({ demand: source });
  assert.equal(rows.find(r => r.metric === 'demand')!.points[0].date, '2026-10-09');
  const peak = rows.find(r => r.metric === 'peak')!.points[0];
  assert.equal(peak.date, '2026-10-08');
  assert.equal(peak.complete, false);
  assert.equal(peak.denominator, 17);
  assert.equal(peak.population, 24);
  assert.equal(peak.unknown, 7);
  assert.equal(filterTimelineSeries(rows, { start: '2026-10-09', end: '2026-10-09' }).find(r => r.metric === 'peak')!.points.length, 0);
  assert.equal(filterTimelineSeries(rows, { type: 'load' }).length, 0);
  assert.equal(filterTimelineSeries(rows, { type: 'system' }).length, 2);
});

test('intraday observation gaps remain disconnected and period filters never carry a last-known value forward', () => {
  const series = byId('demand:CAISO');
  const base = series.points[0];
  assert.equal(timelineCanJoin(series, base, { ...base, timestamp: base.timestamp + series.intervalMinutes! * 60_000 }), true);
  assert.equal(timelineCanJoin(series, base, { ...base, timestamp: base.timestamp + series.intervalMinutes! * 60_000 * 3 }), false);
  const futureWindow = filterTimelineSeries(all, { metric: 'score', start: '2099-01-01', end: '2099-01-02' });
  assert.ok(futureWindow.every(row => row.points.length === 0));
  assert.throws(() => filterTimelineSeries(all, { start: '2026-10-09', end: '2026-10-01' }), RangeError);
});

test('CSV exports selected series independently with unknown blanks and full provenance', () => {
  const series: TimelineSeries = structuredClone(byId('load:nyiso-load-register:active'));
  series.name = '=UNTRUSTED()';
  series.points = [{ ...series.points[0], value: null, denominator: null, unknown: null, qualifier: 'greater_than' }];
  const csv = timelineCsv([series]);
  assert.ok(csv.includes('"\'=UNTRUSTED()"'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('source_sha256'));
  assert.ok(lines[1].includes(series.points[0].source.sha256!));
  assert.ok(lines[1].includes('"greater_than",""'));
  assert.ok(!lines[1].includes('"greater_than","0"'));
});
