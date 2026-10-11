import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MARKET_REGIONS, type LoadPipelineDataset } from '../shared/market-types.ts';
import { resolveRegionalPipelines } from '../shared/regional-pipeline.ts';

const fixture = (): LoadPipelineDataset => JSON.parse(readFileSync(new URL('../public/data/load-pipeline.json', import.meta.url), 'utf8'));

test('seven explicit selections preserve distinct geographic scope and electrical quantity', () => {
  const data = fixture();
  const resolved = resolveRegionalPipelines(data);
  assert.deepEqual(resolved.map(row => row.region), [...MARKET_REGIONS]);
  assert.deepEqual(resolved.map(row => row.coverage), ['regional_aggregate', 'operator_requests', 'partial_pipeline', 'partial_pipeline', 'register_only', 'partial_pipeline', 'partial_pipeline']);
  assert.equal(resolved.find(row => row.region === 'ISO-NE')?.headline?.capacityMw, 285);
  assert.equal(resolved.find(row => row.region === 'MISO')?.headline?.capacityMw, 26600);
  assert.equal(resolved.find(row => row.region === 'NYISO')?.headline?.capacityMw, 14232.9);
  assert.equal(resolved.find(row => row.region === 'NYISO')?.headline?.projectCount, 53);
  assert.match(resolved.find(row => row.region === 'NYISO')!.explanation, /전국/);
});

test('CEC regional coverage preserves mixed stages, rounding and the separate PG&E disclosure', () => {
  const caiso = resolveRegionalPipelines(fixture()).find(row => row.region === 'CAISO')!;
  assert.equal(caiso.headline?.capacityMw, 23278);
  assert.equal(caiso.headline?.capacityBasis, 'mixed_mw');
  assert.equal(caiso.headline?.sourceAsOf, '2025-12');
  assert.equal(caiso.headline?.publishedAt, '2026-08-12');
  assert.equal(caiso.headline?.checkedAt, '2026-10-11T23:20:32.686Z');
  assert.equal(caiso.headline?.sourceSha256, '3eba089b3020de5c1a7f9775e1f6cc7e7157f5b7247a1f857012dc5d17bafb73');
  assert.deepEqual(caiso.additional.map(row => row.capacityMw), [5086, 9587, 8604, 12710]);
  assert.equal(caiso.additional.slice(0, 3).reduce((sum, row) => sum + row.capacityMw!, 0), 23277);
  assert.match(caiso.headline!.caveats.join(' '), /1 MW/);
  assert.equal(caiso.additional[3].sourceAsOf, '2026-06-30');
  assert.ok(!('totalMw' in caiso));
});

test('a utility or wrong-source quantity cannot become the reviewed regulator regional aggregate', () => {
  for (const mutation of ['utility', 'wrong-region', 'wrong-url', 'wrong-path', 'credentials', 'requested-basis', 'missing-mw', 'nonfinite-mw'] as const) {
    const data = fixture();
    const caiso = data.regionalCoverage!.find(row => row.region === 'CAISO')!;
    const headline = data.aggregates.find(row => row.id === caiso.headlineAggregateId)!;
    if (mutation === 'utility') { caiso.headlineAggregateId = 'disclosure:WEST-PGE-20260630-DC-PIPELINE'; caiso.additionalAggregateIds = []; }
    if (mutation === 'wrong-region') data.regionalCoverage!.find(row => row.region === 'PJM')!.coverage = 'regional_aggregate';
    if (mutation === 'wrong-url') headline.sourceUrl = 'https://www.energy.ca.gov.example.org/source.pdf';
    if (mutation === 'wrong-path') headline.sourceUrl = 'https://www.energy.ca.gov/unreviewed.pdf';
    if (mutation === 'credentials') headline.sourceUrl = headline.sourceUrl.replace('https://', 'https://user@');
    if (mutation === 'requested-basis') headline.capacityBasis = 'requested_grid_mw';
    if (mutation === 'missing-mw') headline.capacityMw = null;
    if (mutation === 'nonfinite-mw') headline.capacityMw = Number.NaN;
    assert.equal(resolveRegionalPipelines(data).find(row => row.region === (mutation === 'wrong-region' ? 'PJM' : 'CAISO'))!.coverage, 'unavailable', mutation);
  }
});

test('overlapping requests, contracts and planning references never become an implicit sum or maximum', () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const result = resolveRegionalPipelines(data);
  const ercot = result.find(row => row.region === 'ERCOT')!;
  const pjm = result.find(row => row.region === 'PJM')!;
  const miso = result.find(row => row.region === 'MISO')!;
  assert.equal(ercot.headline?.capacityMw, 438000);
  assert.equal(ercot.headline?.capacityQualifier, 'greater_than');
  assert.equal(ercot.headline?.sourceAsOf, null);
  assert.equal(ercot.additional.find(row => row.id.includes('CONDITIONAL_BASE'))?.capacityMw, 66400);
  assert.equal(pjm.headline?.capacityMw, 240000);
  assert.equal(pjm.headline?.capacityQualifier, 'greater_than');
  assert.equal(miso.headline?.capacityMw, 26600);
  assert.equal(miso.additional.find(row => row.id.includes('EPR_LOAD_20260817'))?.capacityMw, 32600);
  for (const row of result) {
    assert.strictEqual(row.headline, data.aggregates.find(aggregate => aggregate.id === row.headline?.id));
    assert.ok(!('totalMw' in row));
  }
  assert.equal(JSON.stringify(data), before);
});

test('missing metadata does not infer headlines from available named evidence or large totals', () => {
  const data = fixture();
  delete data.regionalCoverage;
  assert.ok(resolveRegionalPipelines(data).every(row => row.coverage === 'unavailable' && row.headline === null && row.additional.length === 0));
});

test('missing, duplicate and cross-region references fail closed', () => {
  for (const mutation of ['missing', 'wrong-region', 'duplicate-reference', 'duplicate-metadata', 'duplicate-aggregate'] as const) {
    const data = fixture();
    const coverage = data.regionalCoverage!.find(row => row.region === 'PJM')!;
    if (mutation === 'missing') coverage.headlineAggregateId = 'missing:aggregate';
    if (mutation === 'wrong-region') coverage.additionalAggregateIds.push('disclosure:ERCOT_LARGE_LOAD_REQUESTS_20260618');
    if (mutation === 'duplicate-reference') coverage.additionalAggregateIds.push(coverage.headlineAggregateId!);
    if (mutation === 'duplicate-metadata') data.regionalCoverage!.push(coverage);
    if (mutation === 'duplicate-aggregate') data.aggregates.push(data.aggregates.find(row => row.id === coverage.headlineAggregateId)!);
    const row = resolveRegionalPipelines(data).find(row => row.region === 'PJM')!;
    assert.equal(row.coverage, 'unavailable', mutation);
    assert.equal(row.headline, null, mutation);
    assert.deepEqual(row.additional, [], mutation);
  }
});

test('utility and subset quantities cannot promote themselves to operator-wide requests', () => {
  const data = fixture();
  const pjm = data.regionalCoverage!.find(row => row.region === 'PJM')!;
  pjm.coverage = 'operator_requests';
  assert.equal(resolveRegionalPipelines(data).find(row => row.region === 'PJM')!.coverage, 'unavailable');
  const ercot = data.regionalCoverage!.find(row => row.region === 'ERCOT')!;
  ercot.headlineAggregateId = 'disclosure:ERCOT_BATCHZERO_CONDITIONAL_BASE_20260903';
  ercot.additionalAggregateIds = [];
  assert.equal(resolveRegionalPipelines(data).find(row => row.region === 'ERCOT')!.coverage, 'unavailable');
});

test('malformed reviewed operator source URL returns unavailable without throwing', () => {
  const data = fixture();
  data.aggregates.find(row => row.id === 'disclosure:ERCOT_LARGE_LOAD_REQUESTS_20260618')!.sourceUrl = 'not a URL';
  assert.equal(resolveRegionalPipelines(data).find(row => row.region === 'ERCOT')!.coverage, 'unavailable');
});
