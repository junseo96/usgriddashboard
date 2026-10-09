import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assembleLoadBottleneck } from '../scripts/build-load-bottleneck.ts';
import { rateLoadObservation, validateLoadBottleneckDataset, type LoadBottleneckDataset } from '../shared/load-bottleneck.ts';
import type { HistoricalDataset } from '../shared/history.ts';
import { scoreProject, summarize } from '../shared/scoring.ts';
import type { Project } from '../shared/types.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL('../data/' + name, import.meta.url), 'utf8'));
const data = read('load-bottleneck.json') as LoadBottleneckDataset;
const series = (id: string) => {
  const found = data.series.find(row => row.id === id);
  assert.ok(found, `Missing reviewed source series: ${id}`);
  return found;
};
const close = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-8, `${actual} differs from independently expected ${expected}`);
};

test('published load indices reproduce reviewed source evidence and preserve independent regional scopes', () => {
  validateLoadBottleneckDataset(data);
  const result = assembleLoadBottleneck(read('load-bottleneck-reviewed.json'), read('history-nyiso.json'), read('load-cohort-nyiso.json'), data.generatedAt);
  assert.deepEqual(result, data);
  assert.equal(data.modelVersion, 'load-stage-v1');
  assert.deepEqual(data.regions.map(region => region.region).sort(), ['CAISO', 'ERCOT', 'ISO-NE', 'MISO', 'NYISO', 'PJM', 'SPP', 'Southeast', 'West'].sort());
  assert.ok(data.series.some(row => row.weightBasis === 'project_count'));
  assert.ok(data.series.some(row => row.weightBasis === 'capacity_mw'));
  assert.ok(data.regions.every(region => region.gaps.length > 0));
  assert.ok(!('nationalMean' in result));
});

test('NYISO load-stage indices independently retain prior historical and current project-model means', () => {
  const customer = series('nyiso-load-register');
  const historical = (read('history.json') as HistoricalDataset).series.find(row => row.id === 'nyiso-load-bottleneck-score')!;
  assert.equal(customer.points.length, historical.points.length);
  for (const point of customer.points) {
    const prior = historical.points.find(row => row.date === point.date)!;
    const rating = rateLoadObservation(customer, point);
    assert.ok(prior);
    close(rating.point, prior.value!);
    assert.equal(rating.ratedWeight, prior.ratedCount);
    assert.equal(rating.unknownWeight, prior.unknownCount);
    assert.equal(point.totalWeight, prior.projectCount);
    assert.equal(point.source.sha256, prior.source.sha256);
    assert.equal(point.dateBasis, prior.dateBasis);
    assert.equal(point.sourceAsOf, null, 'capture dates must not become an invented register cutoff');
  }
  const original = summarize((read('bootstrap.json').projects as Project[])
    .filter(project => project.sourceId === 'nyiso-load-register').map(project => scoreProject(project, [])));
  const latest = rateLoadObservation(customer, customer.points.at(-1)!);
  close(latest.point, original.ratingMean!);
  assert.equal(latest.activeWeight, 53); assert.equal(latest.ratedWeight, 52); assert.equal(latest.unknownWeight, 1);
  assert.equal(customer.points.at(-1)!.observedAt, '2026-10-08T03:59:18.332Z');
});

test('NYISO fixed cohort follows the same seven source IDs instead of mistaking changing queue means for project progress', () => {
  const fixed = series('nyiso-load-fixed-cohort');
  assert.equal(fixed.scopeType, 'selected_projects');
  assert.match(fixed.scope + fixed.comparability, /생존/);
  const ids = ['1213', '1484', '1536', '580', '776', '850', '979'].sort();
  const expected = [500 / 7, 480 / 7, 475 / 7, 475 / 7, 305 / 7];
  assert.equal(fixed.points.length, 5);
  fixed.points.forEach((point, index) => {
    assert.deepEqual(point.bins.map(bin => bin.id).sort(), ids);
    assert.ok(point.bins.every(bin => bin.membership === 'active' && bin.weight === 1));
    assert.equal(point.totalWeight, 7);
    close(rateLoadObservation(fixed, point).point, expected[index]);
  });
  assert.notEqual(rateLoadObservation(fixed, fixed.points.at(-1)!).point,
    rateLoadObservation(series('nyiso-load-register'), series('nyiso-load-register').points.at(-1)!).point);
});

test('ERCOT ambiguous and unreconciled vintages stay unscored while current MW excludes only observed consumption', () => {
  const ercot = series('ercot-load-stages');
  assert.equal(ercot.weightBasis, 'capacity_mw'); assert.equal(ercot.population, 'tracked_pool');
  assert.match(ercot.scope, /관측/);
  assert.match(ercot.scope, /전체 운영 계약용량/);
  for (const month of ['2022-04', '2024-06', '2024-07', '2024-09']) {
    const point = ercot.points.find(row => row.date.startsWith(month))!;
    assert.ok(point); assert.equal(point.totalWeight, null); assert.equal(point.completePartition, false);
    const rating = rateLoadObservation(ercot, point);
    assert.equal(rating.point, null); assert.equal(rating.trackedPoint, null);
  }
  assert.ok(ercot.points[0].bins.every(bin => bin.stage === 'unknown'));
  const point = ercot.points.at(-1)!, rating = rateLoadObservation(ercot, point);
  assert.equal(point.date, '2026-06-18'); assert.equal(point.totalWeight, 466500);
  assert.equal(rating.operatingWeight, 5700); assert.equal(rating.activeWeight, 460800);
  close(rating.point, (257600 * 100 + 151100 * 80 + 11800 * 75 + 37100 * 50 + 3200 * 20) / 460800);
  close(rating.trackedPoint, (257600 * 100 + 151100 * 80 + 11800 * 75 + 37100 * 50 + 3200 * 20) / 466500);
  assert.match(ercot.stageMappings.find(mapping => mapping.rawStage === 'No Studies Submitted')!.rationale, /재분류/);
});

test('PJM construction commitments remain contracts, ambiguous customers are excluded, and MISO campus works do not become grid works', () => {
  const pjm = series('pjm-aes-ohio-selected-loads'), older = rateLoadObservation(pjm, pjm.points[0]);
  const latestPoint = pjm.points.at(-1)!, latest = rateLoadObservation(pjm, latestPoint);
  assert.equal(older.point, 80); assert.equal(older.ratedWeight, 4); assert.equal(older.unknownWeight, 4);
  assert.equal(latest.point, 50); assert.equal(latest.ratedWeight, 5); assert.equal(latest.unknownWeight, 4);
  assert.equal(latestPoint.totalWeight, 9);
  assert.ok(latestPoint.bins.filter(bin => bin.rawStage.includes('Construction Commitment')).every(bin => bin.stage === 'agreement'));
  assert.ok(latestPoint.bins.filter(bin => ['Other', 'Memorandum of Understanding (MOU)'].includes(bin.rawStage)).every(bin => bin.stage === 'unknown'));
  const miso = series('miso-dte-selected-load-projects'), latestMiso = miso.points.at(-1)!;
  assert.equal(latestMiso.totalWeight, 2);
  assert.ok(latestMiso.bins.every(bin => bin.stage === 'agreement' && bin.weight === 1));
  assert.equal(rateLoadObservation(miso, latestMiso).point, 50);
  assert.match(miso.comparability, /건물 공사/);
});

test('contract-only utility totals and unverified campus construction never inflate active scored populations', () => {
  for (const id of ['spp-evergy-additional-esa-subset', 'miso-ameren-electric-service-contract-subset']) {
    const contract = series(id); assert.equal(contract.population, 'contract_subset');
    for (const point of contract.points) {
      const rating = rateLoadObservation(contract, point);
      assert.equal(rating.point, null); assert.equal(rating.trackedPoint, null);
      assert.ok(point.bins.every(bin => bin.membership === 'unresolved'));
      assert.equal(rating.activeWeight, null);
    }
  }
  const spp = series('spp-evergy-advanced-development-stages');
  const point = spp.points.at(-1)!;
  assert.equal(point.totalWeight, 5300);
  assert.equal(rateLoadObservation(spp, point).unknownWeight, 1100);
  assert.equal(rateLoadObservation(spp, point).ratedWeight, 4200);
  assert.ok(point.bins.filter(bin => bin.rawStage.includes('Actively Building')).every(bin => bin.stage === 'unknown'));
  assert.equal(rateLoadObservation(series('isone-selected-load-studies'), series('isone-selected-load-studies').points.at(-1)!).point, 85);
});

test('Georgia Power physical and commercial subdivisions cover the same 118 customers without double counting or declaring partial ramp complete', () => {
  const gpc = series('gpc-large-load-stage-pool'), point = gpc.points[0];
  assert.equal(gpc.region, 'Southeast'); assert.equal(gpc.scopeType, 'utility_subset');
  assert.equal(gpc.population, 'tracked_pool'); assert.equal(gpc.weightBasis, 'project_count');
  assert.equal(gpc.points.length, 1); assert.equal(point.sourceAsOf, '2026-06-30');
  assert.equal(point.publishedAt, '2026-08-17'); assert.equal(point.totalWeight, 118);
  assert.deepEqual(point.bins.map(bin => [bin.rawStage, bin.weight]), [
    ['Technical Review', 86], ['Broken ground & ramping', 10], ['Broken ground', 11], ['Pending construction', 11],
  ]);
  assert.equal(point.bins.reduce((sum, bin) => sum + bin.weight!, 0), 118);
  const ramp = point.bins.find(bin => bin.rawStage === 'Broken ground & ramping')!;
  assert.equal(ramp.stage, 'partial_energization'); assert.equal(ramp.membership, 'unresolved');
  assert.ok(point.bins.filter(bin => ['Broken ground', 'Pending construction'].includes(bin.rawStage)).every(bin => bin.stage === 'agreement'));
  const rating = rateLoadObservation(gpc, point);
  assert.equal(rating.point, null); assert.equal(rating.activeWeight, null);
  assert.equal(rating.operatingWeight, 0); assert.equal(rating.unresolvedWeight, 10);
  assert.equal(rating.trackedRatedWeight, 118);
  close(rating.trackedPoint, (86 * 80 + 22 * 50 + 10 * 10) / 118);
  assert.match(gpc.comparability, /실제 가동률/);
});

test('BPA history counts only explicit mainland customer rows and stops at the last real archive instead of carrying values forward', () => {
  const bpa = series('bpa-explicit-mainland-loads');
  assert.equal(bpa.region, 'West'); assert.equal(bpa.scopeType, 'selected_projects'); assert.equal(bpa.weightBasis, 'project_count');
  assert.deepEqual(bpa.points.map(point => point.totalWeight), [26, 24, 24, 20, 20, 16]);
  assert.equal(new Set(bpa.points.map(point => point.source.sha256)).size, 6);
  const mainland = new Set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
  for (const point of bpa.points) {
    assert.equal(point.dateBasis, 'archive_capture'); assert.equal(point.sourceAsOf, null); assert.equal(point.publishedAt, null);
    assert.equal(new URL(point.source.originalUrl!).hostname, 'www.bpa.gov');
    assert.equal(point.bins.length, point.totalWeight);
    assert.equal(new Set(point.bins.map(bin => bin.id)).size, point.totalWeight);
    for (const bin of point.bins) {
      assert.equal(bin.membership, 'active'); assert.equal(bin.weight, 1);
      const state = / · ([A-Z]{2}) · 원문 ID /.exec(bin.notes.join(' '))?.[1];
      assert.ok(state && mainland.has(state), `${bin.id} must retain a disclosed mainland state`);
      assert.ok(!['COMPLETED', 'WITHDRAWN'].includes(bin.rawStage));
      assert.notEqual(bin.stage, 'operating', 'BPA administrative completion is not proof of customer energization');
    }
  }
  const latest = bpa.points.at(-1)!;
  assert.equal(latest.date, '2026-02-21'); assert.equal(latest.archiveCapturedAt, '2026-02-20T23:44:25.000Z');
  close(rateLoadObservation(bpa, latest).point, (11 * 80 + 4 * 75 + 50) / 16);
  assert.match(bpa.comparability, /2026년 2월/);
  assert.match(latest.notes.join(' '), /주 미확인 20건/);
});

test('assembling a fixed cohort rejects invented identities and altered historical source attribution', () => {
  const reviewed = read('load-bottleneck-reviewed.json'), history = read('history-nyiso.json');
  const changed = read('load-cohort-nyiso.json');
  changed.vintages[1].projects[0].linkedQueueId = 'invented-cross-source-identity';
  assert.throws(() => assembleLoadBottleneck(reviewed, history, changed, data.generatedAt), /Fixed cohort/);
  const wrongSource = read('load-cohort-nyiso.json');
  wrongSource.vintages[0].source.sha256 = '0'.repeat(64);
  assert.throws(() => assembleLoadBottleneck(reviewed, history, wrongSource, data.generatedAt), /Fixed cohort/);
});
