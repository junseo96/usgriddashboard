import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assembleHistoricalData } from '../scripts/build-history.ts';
import { validateHistoricalDataset, type HistoricalDataset } from '../shared/history.ts';
import { scoreProject, summarize } from '../shared/scoring.ts';
import type { Project } from '../shared/types.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL('../data/' + name, import.meta.url), 'utf8'));
const data = read('history.json') as HistoricalDataset;
const series = (id: string) => {
  const value = data.series.find(item => item.id === id);
  assert.ok(value, id);
  return value;
};

test('published history reproduces reviewed vintages and source declarations without DB snapshots', () => {
  validateHistoricalDataset(data);
  const reproduced = assembleHistoricalData(read('history-generation.json'), read('history-nyiso.json'), read('history-load-reviewed.json'), data.generatedAt);
  assert.deepEqual(reproduced, data);
  assert.equal(data.coverageStart, '2020-12-31');
  assert.equal(data.coverageEnd, '2026-10-08');
});

test('annual scores use six different contemporary sources and expose changing assessment coverage', () => {
  const points = series('lbnl-all-all-bottleneck-score').points;
  assert.deepEqual(points.map(point => point.sourceAsOf), [2020, 2021, 2022, 2023, 2024, 2025].map(year => `${year}-12-31`));
  assert.equal(new Set(points.map(point => point.source.sha256)).size, 6);
  assert.deepEqual(points.map(point => point.projectCount), [5598, 7799, 9728, 11196, 10483, 8460]);
  assert.equal(points[0].ratedCount, 2149);
  assert.equal(points[1].ratedCount, 2092);
  assert.ok(points[0].value! > 80);
  assert.ok(points.at(-1)!.value! < 70);
  for (const point of points) {
    assert.equal(point.ratedCount! + point.unknownCount!, point.projectCount);
    assert.equal(point.ratingModelVersion, 'stage-proxy-v1');
  }
});

test('latest historical generation and customer means reconcile independently with the live inventory', () => {
  const projects = read('bootstrap.json').projects as Project[];
  const generation = summarize(projects.filter(p => p.sourceId === 'lbnl-generation-storage-queues').map(p => scoreProject(p, [])));
  const load = summarize(projects.filter(p => p.sourceId === 'nyiso-load-register').map(p => scoreProject(p, [])));
  for (const [id, current] of [['lbnl-all-all-bottleneck-score', generation], ['nyiso-load-bottleneck-score', load]] as const) {
    const last = series(id).points.at(-1)!;
    assert.equal(last.projectCount, current.eligibleCount);
    assert.equal(last.ratedCount, current.ratedCount);
    assert.equal(last.unknownCount, current.ratingUnknownCount);
    assert.ok(Math.abs(last.value! - current.ratingMean!) < 1e-8);
  }
  // A mixed current national mean is not silently relabeled as an old LBNL mean.
  const mixed = summarize(projects.map(p => scoreProject(p, [])));
  assert.notEqual(series('lbnl-all-all-bottleneck-score').points.at(-1)!.value, mixed.ratingMean);
});

test('NYISO archive capture and current observation retain distinct dates and seasonal MW break', () => {
  const count = series('nyiso-load-queue-count').points;
  assert.deepEqual(count.map(point => point.value), [10, 19, 31, 47, 53]);
  assert.ok(count.slice(0, 4).every(point => point.dateBasis === 'archive_capture' && point.source.originalUrl && point.sourceAsOf === null));
  assert.equal(count.at(-1)!.dateBasis, 'observation');
  assert.equal(count.at(-1)!.observedAt, '2026-10-08T03:59:18.332Z');
  assert.ok(count.every(point => point.publishedAt === null));
  const capacity = series('nyiso-load-queue-capacity').points;
  assert.deepEqual(capacity.map(point => point.value), [1846.2, 3182.5, 6805.1, 11756.1, 14232.9]);
  assert.equal(capacity.at(-1)!.breakBefore, true);
  assert.equal(series('nyiso-load-bottleneck-score').points[0].value, 75.5);
});

test('request histories preserve missing months, scope breaks, restatements, and contracts as different metrics', () => {
  const ercot = series('ercot-large-load-tracked-history');
  assert.equal(ercot.points[0].value, 17376);
  assert.equal(ercot.points.at(-1)!.value, 466497);
  assert.equal(ercot.points[0].sourceAsOf, '2022-04');
  assert.equal(ercot.points[0].datePrecision, 'month');
  assert.ok(!ercot.points.some(point => point.date === '2022-05-01'));
  assert.ok(ercot.points.some(point => point.date.startsWith('2024-07') && point.breakBefore));
  assert.ok(ercot.points.every(point => point.ratedCount === null && point.projectCount === null && point.ratingModelVersion === null));
  const original = series('pge-data-center-pipeline-original');
  const restated = series('pge-data-center-pipeline-paid-study');
  assert.ok(original.points.some(point => point.value === 5390));
  assert.ok(restated.points.some(point => point.value === 5090));
  const contracts = series('ppl-pa-signed-data-center-agreements');
  assert.equal(contracts.metric, 'load_contracts');
  assert.equal(contracts.points.length, 10);
  assert.ok(contracts.points.every(point => point.datePrecision === 'quarter'));
  assert.equal(contracts.points.at(-1)!.sourceAsOf, '2026-Q2');
  assert.equal(contracts.points.at(-1)!.value, 31800);
});
