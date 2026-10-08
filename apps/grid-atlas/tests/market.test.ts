import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareMarkets, isDemandDataset } from '../shared/market.ts';
import type { Project } from '../shared/types.ts';

const fixture: Project = {
  id: 'test-hybrid', sourceId: 'test-register', sourceRecordId: 'h1', name: 'Synthetic hybrid',
  types: ['generation', 'storage'], region: 'PJM', state: 'PA', status: 'active',
  generationMw: 100, storageMw: 40, loadMw: null, capacityStatus: 'known', eligible: true,
  exclusionReason: null, sourceUrl: 'https://example.org/register', sourceAsOf: '2025-12-31',
  rawStatus: 'active', identityScope: 'source_record',
};
test('market comparison separates hybrid output, excludes support records and preserves missing scope', () => {
  const report = compareMarkets([fixture,
    { ...fixture, id: 'support', sourceRecordId: 's1', types: ['load'], generationMw: null, storageMw: null, loadMw: 999,
      eligible: false, status: 'reference', exclusionReason: 'Transmission support is not an individual active request' },
  ], '2026-10-08T00:00:00Z');
  const pjm = report.regions.find(r => r.region === 'PJM')!;
  assert.equal(pjm.generationMw, 100);
  assert.equal(pjm.storageMw, 40);
  assert.equal(pjm.generationCount, 1);
  assert.equal(pjm.storageCount, 1);
  assert.equal(pjm.loadMw, null);
  assert.equal(pjm.loadCount, 0);
  assert.equal(report.regions.find(r => r.region === 'ERCOT')!.generationMw, null);
  assert.deepEqual(pjm.sourceAsOf, ['2025-12-31']);
});
test('all-unknown capacity remains null while a disclosed zero remains zero', () => {
  const missing = { ...fixture, types: ['load'] as Project['types'], generationMw: null, storageMw: null,
    loadMw: null, capacityStatus: 'unknown' as const };
  const first = compareMarkets([missing], null).regions.find(r => r.region === 'PJM')!;
  assert.equal(first.loadCount, 1);
  assert.equal(first.loadMw, null);
  assert.equal(first.capacityUnknownCount, 1);
  const disclosed = compareMarkets([{ ...missing, loadMw: 0, capacityStatus: 'known' }], null).regions.find(r => r.region === 'PJM')!;
  assert.equal(disclosed.loadMw, 0);
});
test('published demand schema validates actual observations and rejects malformed refreshes', () => {
  const d = JSON.parse(readFileSync(new URL('../data/grid-demand.json', import.meta.url), 'utf8'));
  assert.equal(isDemandDataset(d), true);
  assert.equal(isDemandDataset({ ...d, regions: [...d.regions, d.regions[0]] }), false);
  const malformed = structuredClone(d); malformed.regions[0].latestMw = '999999';
  assert.equal(isDemandDataset(malformed), false);
  const incomplete = structuredClone(d); incomplete.regions[0].dailyPeaks[0].expectedObservations = 0;
  assert.equal(isDemandDataset(incomplete), false);
  const unsafe = structuredClone(d); unsafe.regions[0].sourceUrl = 'https://user:password@example.org/';
  assert.equal(isDemandDataset(unsafe), false);
  const mismatched = structuredClone(d); mismatched.regions[0].latestMw += 1;
  assert.equal(isDemandDataset(mismatched), false);
  const unordered = structuredClone(d); unordered.regions[0].series.reverse();
  assert.equal(isDemandDataset(unordered), false);
  const falseComplete = structuredClone(d);
  falseComplete.regions[0].dailyPeaks[0].complete = true;
  falseComplete.regions[0].dailyPeaks[0].observations = 1;
  assert.equal(isDemandDataset(falseComplete), false);
  const impossibleDay = structuredClone(d); impossibleDay.regions[0].dailyPeaks[0].date = '2026-02-30';
  assert.equal(isDemandDataset(impossibleDay), false);
});
