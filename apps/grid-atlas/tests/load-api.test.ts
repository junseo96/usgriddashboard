import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLoadApiDataset, loadApiCsv, orderedLoadApiRecords, publicLoadApiUrl, validateLoadApiDataset, type LoadApiDataset } from '../shared/load-api.ts';

const actual = JSON.parse(readFileSync(new URL('../data/load-api-observations.json', import.meta.url), 'utf8')) as LoadApiDataset;
const fixture = (): LoadApiDataset => structuredClone(actual);

test('public API dataset accepts real subtotal differences without treating them as complete stages', () => {
  validateLoadApiDataset(actual);
  const input = fixture();
  const latest = input.records[0];
  latest.totalMw = 466497;
  latest.byStatus = { observed_energized: 5700, under_ercot_review: 151100, no_studies_submitted: 257600, planning_studies_approved: null, approved_to_energize_not_operational: 3200 };
  latest.qualityIssues = [{ code: 'stages_total_mismatch', severity: 'warning', detail: 'Published partial stage sum does not equal the reported total.', reportedSumMw: 417600, expectedMw: 466497 }];
  assert.equal(isLoadApiDataset(input), true);
  assert.equal(latest.region, 'ERCOT');
  assert.equal(latest.scope, 'regional_aggregate');
  assert.equal(latest.verification, 'provider_extraction_unverified');
  assert.equal(latest.totalMw, 466497);
  assert.equal(latest.byStatus?.planning_studies_approved, null);
  assert.ok(latest.qualityIssues.some(issue => issue.code === 'stages_total_mismatch'));
});

test('API validator rejects malformed capacity, calendar dates, receipt provenance and duplicate identities', () => {
  const changes: ((data: LoadApiDataset) => void)[] = [
    data => { data.records[0].totalMw = Number.NaN; },
    data => { data.records[0].totalMw = -1; },
    data => { data.records[0].reportDate = '2026-02-30'; },
    data => { data.records[0].snapshotMonth = '2026-06-02'; },
    data => { data.records[0].receipt.fetchedAt = '2020-01-01T00:00:00Z'; },
    data => { data.records[0].receipt.sha256 = 'not-a-hash'; },
    data => { data.records[0].sourceUrl = 'https://example.org/file?api_key=secret'; },
    data => { data.records.push(structuredClone(data.records[0])); },
    data => { data.collection.lastSuccessAt = null; },
  ];
  for (const change of changes) {
    const data = fixture(); change(data);
    assert.equal(isLoadApiDataset(data), false);
    assert.throws(() => validateLoadApiDataset(data));
  }
});

test('an initial failed collection can have no data, and a later failure preserves prior successful records', () => {
  const previous = fixture();
  previous.collection.status = 'failed';
  previous.collection.error = 'Provider unavailable; previous observations retained.';
  previous.collection.endpointReceipts = [{ url: 'https://data.kardashevlabs.org/ercot/large-load/latest', fetchedAt: previous.collection.completedAt, httpStatus: null, sha256: null, bytes: 0, recordCount: null }];
  assert.equal(isLoadApiDataset(previous), true);
  previous.records = [];
  previous.collection.lastSuccessAt = null;
  assert.equal(isLoadApiDataset(previous), true);
});

test('API export retains multiple report vintages, unknown vs zero capacities, and both acquisition hashes', () => {
  const first = fixture().records[0];
  first.id = 'first'; first.standaloneMw = 0; first.colocatedMw = null;
  const revised = { ...structuredClone(first), id: 'revision', reportDate: '2026-10-01', totalMw: 12 };
  const rows = orderedLoadApiRecords([first, revised]);
  assert.deepEqual(rows.map(row => row.id), ['revision', 'first']);
  const csv = loadApiCsv(rows);
  assert.equal(csv.split('\r\n').length, 3, 'Each vintage stays a distinct row, not a sum.');
  assert.ok(csv.includes('"first","ERCOT","regional_aggregate"'));
  assert.ok(csv.includes(`"${first.totalMw}","","0"`));
  assert.ok(csv.includes(first.payloadSha256));
  assert.ok(csv.includes(first.receipt.sha256));
  assert.ok(csv.includes(first.receipt.fetchedAt));
  assert.ok(csv.includes('provider_extraction_unverified'));
});

test('API export neutralizes spreadsheet formula input and excludes credential fields and credential URLs', () => {
  const record = { ...fixture().records[0], id: ' =HYPERLINK("https://example.org", "open")', token: 'private-api-key', sourceUrl: 'https://example.org/data?token=private-api-key' };
  const csv = loadApiCsv([record]);
  assert.ok(csv.includes('"\' =HYPERLINK('));
  assert.equal(csv.includes('private-api-key'), false);
  assert.equal(publicLoadApiUrl('javascript:alert(1)'), undefined);
  assert.equal(publicLoadApiUrl('https://user:password@example.org/file'), undefined);
  assert.equal(publicLoadApiUrl('https://example.org/file?year=2026'), 'https://example.org/file?year=2026');
});
