import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MARKET_REGIONS } from '../shared/market-types.ts';
import { coverageUtilityStatus, filterCoverageEvidence, filterCoverageUtilities, isLoadCoverageDataset,
  loadCoverageCsv, parseLoadCoverageFilters, summarizeCoverage, validateLoadCoverageDataset,
  type CoverageRegion, type CoverageUtility, type LoadCoverageDataset } from '../shared/load-coverage.ts';
import { scoreProject, summarize, ratingPoint } from '../shared/scoring.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { isDemandDataset } from '../shared/market.ts';
import { filterHistoricalSeries, historicalCsv, parseHistoricalFilters } from '../shared/history.ts';
import { loadBottleneckCsv, parseLoadBottleneckFilters } from '../shared/load-bottleneck.ts';

function utility(id: string, regions: CoverageRegion[], name = 'Test reporting utility'): CoverageUtility {
  return { id, name, states: ['IL'], forms: ['861'], roles: ['distribution'], geographicScope: 'mainland', mainlandStates: ['IL'],
    serviceTypes: ['bundled'], sourceEvidence: [{ sourceId: 'frame', locator: `Entity ID ${id}` }], regions,
    associations: regions.filter(r => r !== 'Unassigned').map(r => ({ kind: 'balancing_authority', code: r,
      name: null, region: r, sourceId: 'frame', locator: `Reported BA ${r}` })), notes: ['Synthetic test row, not a real company.'] };
}
function fixture(): LoadCoverageDataset {
  const nonmainland = utility('eia861:4', ['Non-ISO']);
  nonmainland.states = ['AK']; nonmainland.mainlandStates = []; nonmainland.geographicScope = 'nonmainland';
  return { schemaVersion: 1, generatedAt: '2026-01-02T01:00:00.000Z',
    sources: ['frame', 'report'].map(id => ({ id, name: `${id} test source`, url: `https://example.org/${id}`, retrievedAt: '2026-01-02T00:00:00.000Z',
      sha256: 'a'.repeat(64), sourceAsOf: '2025', publishedAt: null, notes: ['Synthetic test provenance.'] })),
    universe: { year: 2025, sourceIds: ['frame'], scope: 'Electricity reporters, not a list of customer applications.', limitations: ['Reporting entities can span regions.'],
      utilities: [utility('eia861:1', ['PJM', 'MISO']), utility('eia861:2', ['PJM']), utility('eia861:3', ['Unassigned']), nonmainland] },
    rosters: [{ id: 'pjm-zones', region: 'PJM', name: 'Test zone list', kind: 'zone', sourceIds: ['report'], scope: 'Complete test source list, not projects.', complete: true,
      entries: [{ id: 'pjm:zone-a', name: 'Test zone A', aliases: ['Zone A'], notes: [] }, { id: 'pjm:zone-b', name: 'Test zone B', aliases: [], notes: [] }], notes: [] }],
    evidence: [{ id: 'contracts-a', region: 'PJM', provider: 'Test utility group', name: 'Contracted capacity', sourceIds: ['report'], coverageKind: 'contracts',
      scope: 'Subset with disclosed contracts; active versus operating split is unknown.',
      metrics: [{ label: 'Contracted load', value: 200, unit: 'MW', asOf: '2025-12-31', qualifier: 'at_least', notes: ['Cannot be treated as 200 projects.'] }],
      utilityIds: ['eia861:1'], rosterEntryIds: ['pjm:zone-a'], scoreSeriesIds: [], gaps: ['Individual project stages not disclosed.'] },
    { id: 'forecast-a', region: 'MISO', provider: 'Test planning source', name: 'Planning scenario', sourceIds: ['report'], coverageKind: 'forecast',
      scope: 'Future scenario, not connection requests.', metrics: [{ label: 'Unpublished amount', value: null, unit: 'GW', asOf: null, qualifier: 'exact', notes: [] }],
      utilityIds: ['eia861:1'], rosterEntryIds: [], scoreSeriesIds: [], gaps: ['Application counts unknown.'] }],
    regions: [...MARKET_REGIONS, 'Non-ISO' as const, 'Unassigned' as const].map(region => ({ region, sourceIds: ['report'], overview: 'Explicit test regional review.', gaps: ['No completeness claim.'] })),
    limitations: ['Research links are not national project coverage.'] };
}

test('reporter universe preserves multi-region identity and unknown BA without inferring membership from state', () => {
  const data = fixture(); validateLoadCoverageDataset(data);
  const all = summarizeCoverage(data), pjm = summarizeCoverage(data, { region: 'PJM' }), miso = summarizeCoverage(data, { region: 'MISO' });
  assert.deepEqual([all.utilityCount, all.reviewedUtilityCount, all.unreviewedUtilityCount], [4, 1, 3]);
  assert.equal(pjm.utilityCount, 2); assert.equal(miso.utilityCount, 1);
  assert.equal(filterCoverageUtilities(data, { region: 'Unassigned' })[0].id, 'eia861:3');
  assert.equal(filterCoverageUtilities(data, { geographicScope: 'mainland' }).length, 3);
  assert.equal(pjm.rosterEntryCount, 2); assert.equal(pjm.reviewedRosterEntryCount, 1);
  assert.equal(coverageUtilityStatus(data, 'eia861:1'), 'reviewed');
  assert.equal(coverageUtilityStatus(data, 'eia861:2'), 'not_reviewed');
  assert.equal(coverageUtilityStatus(data, 'eia861:1', 'ERCOT'), 'not_reviewed');
  assert.equal(filterCoverageUtilities(data, { kind: 'project_register' }).length, 0);
  assert.equal(all.evidenceCount, 2); // No score or project coverage percentage is fabricated.
  assert.equal('projectCoverage' in all, false);
});

test('coverage validation rejects inferred regions, missing source proof, duplicates, and cross-region joins', () => {
  const mutations: [string, (d: LoadCoverageDataset) => void][] = [
    ['state-only inferred ISO', d => { d.universe.utilities[2].regions = ['PJM']; }],
    ['unproven extra ISO', d => { d.universe.utilities[0].regions.push('SPP'); }],
    ['NA balancing authority is not proof of Non-ISO', d => { d.universe.utilities[3].associations[0].code = 'NA'; }],
    ['duplicate utility across regions', d => { d.universe.utilities.push(structuredClone(d.universe.utilities[0])); }],
    ['missing source locator', d => { d.universe.utilities[0].associations[0].locator = ''; }],
    ['missing utility source proof', d => { d.universe.utilities[0].sourceEvidence = []; }],
    ['missing source', d => { d.evidence[0].sourceIds = ['not-collected']; }],
    ['missing utility ID', d => { d.evidence[0].utilityIds = ['eia861:999']; }],
    ['cross-region utility', d => { d.evidence[0].utilityIds = ['eia861:4']; }],
    ['cross-region roster', d => { d.evidence[1].rosterEntryIds = ['pjm:zone-a']; }],
    ['duplicate roster entry ID', d => { d.rosters[0].entries.push(structuredClone(d.rosters[0].entries[0])); }],
    ['missing required regional gap', d => { d.regions = d.regions.filter(r => r.region !== 'CAISO'); }],
    ['duplicate source', d => { d.sources.push(structuredClone(d.sources[0])); }],
    ['invalid mainland classification', d => { d.universe.utilities[3].geographicScope = 'mainland'; }],
  ];
  for (const [reason, mutate] of mutations) { const data = fixture(); mutate(data); assert.throws(() => validateLoadCoverageDataset(data), TypeError, reason); }
});

test('provenance chronology and measurement units prevent unpublished or fabricated coverage claims', () => {
  const mutations: ((d: LoadCoverageDataset) => void)[] = [
    d => { d.sources[0].retrievedAt = '2026-01-03T00:00:00.000Z'; },
    d => { d.sources[0].sourceAsOf = '2026-01-03'; },
    d => { d.sources[0].publishedAt = '2026-02'; },
    d => { d.sources[0].sha256 = 'placeholder'; },
    d => { d.sources[0].url = 'https://secret@example.org/'; },
    d => { d.evidence[0].metrics[0].asOf = '2026-01-03'; },
    d => { d.evidence[0].metrics[0].unit = 'projects'; d.evidence[0].metrics[0].value = 1.5; },
    d => { d.evidence[0].metrics[0].unit = 'percent'; d.evidence[0].metrics[0].value = 101; },
    d => { d.evidence[0].metrics[0].value = Number.NaN; },
  ];
  for (const mutate of mutations) { const data = fixture(); mutate(data); assert.equal(isLoadCoverageDataset(data), false); }
  const data = fixture(); data.evidence[0].scoreSeriesIds = ['unreviewed-score'];
  assert.throws(() => validateLoadCoverageDataset(data, new Date(), new Set(['reviewed-score'])), /score series link/);
  data.evidence[0].scoreSeriesIds = ['reviewed-score'];
  validateLoadCoverageDataset(data, new Date(), new Set(['reviewed-score']));
  assert.equal(data.evidence[1].metrics[0].value, null);
});

test('filters distinguish the evidence kind and explicit review status without fuzzy entity joins', () => {
  const data = fixture(); data.universe.utilities[1].name = data.universe.utilities[0].name;
  assert.deepEqual(filterCoverageUtilities(data, { region: 'PJM', status: 'reviewed' }).map(u => u.id), ['eia861:1']);
  assert.deepEqual(filterCoverageUtilities(data, { region: 'PJM', status: 'not_reviewed' }).map(u => u.id), ['eia861:2']);
  assert.deepEqual(filterCoverageEvidence(data, { kind: 'contracts', q: 'test UTILITY' }).map(e => e.id), ['contracts-a']);
  assert.deepEqual(filterCoverageEvidence(data, { status: 'not_reviewed' }), []);
  assert.deepEqual(parseLoadCoverageFilters(new URLSearchParams('region=PJM&kind=contracts&status=reviewed&geographicScope=mainland&q=Test')), {
    region: 'PJM', kind: 'contracts', status: 'reviewed', geographicScope: 'mainland', q: 'Test' });
  for (const query of ['region=US', 'kind=capacity', 'status=complete', 'geographicScope=continental', 'region=PJM&region=MISO']) {
    assert.throws(() => parseLoadCoverageFilters(new URLSearchParams(query)), RangeError);
  }
});

test('forecast load adjustments preserve negative and zero MW without allowing negative application counts or requests', () => {
  const data = fixture();
  data.evidence[1].metrics = [
    { label: 'Peak forecast adjustment', value: -180, unit: 'MW', asOf: '2025', qualifier: 'exact', notes: ['A planning reduction, not negative customer projects.'] },
    { label: 'Unchanged forecast adjustment', value: 0, unit: 'GW', asOf: '2025', qualifier: 'exact', notes: [] },
  ];
  validateLoadCoverageDataset(data);
  assert.match(loadCoverageCsv(data), /"Peak forecast adjustment","-180","MW"/);
  assert.match(loadCoverageCsv(data), /"Unchanged forecast adjustment","0","GW"/);
  for (const unit of ['projects', 'percent'] as const) {
    const invalid = structuredClone(data); invalid.evidence[1].metrics[0].unit = unit;
    assert.throws(() => validateLoadCoverageDataset(invalid), /metric value/);
  }
  for (const kind of ['requests', 'contracts', 'project_register', 'stage_distribution', 'grid_support', 'qualitative'] as const) {
    const invalid = structuredClone(data); invalid.evidence[1].coverageKind = kind;
    assert.throws(() => validateLoadCoverageDataset(invalid), /metric value/);
  }
});

test('CSV keeps source hashes, distinct measurement rows, unknown blanks, and formula-safe text', () => {
  const data = fixture(); data.universe.utilities[0].name = ' =HYPERLINK("unsafe")';
  const csv = loadCoverageCsv(data);
  assert.match(csv, /"' =HYPERLINK\(""unsafe""\)"/);
  assert.match(csv, /"Contracted load","200","MW","at_least","2025-12-31"/);
  assert.match(csv, /"Unpublished amount","","GW","exact",""/);
  assert.match(csv, new RegExp('"' + 'a'.repeat(64) + '"'));
  assert.match(csv, /https:\/\/example.org\/report/);
  assert.match(csv, /Entity ID eia861:1/);
  assert.equal(csv.split('\r\n').length, 7); // Header, four distinct entities, two distinct metric rows.
  assert.equal(loadCoverageCsv(data, { region: 'PJM', kind: 'contracts' }).split('\r\n').length, 3);
  assert.equal(loadCoverageCsv(data, { region: 'PJM', status: 'not_reviewed' }).split('\r\n').length, 2);
});

test('live and static coverage APIs retain reviewed data and missing old assets remain unavailable', async () => {
  const { handleApi } = await import('../server/api.ts');
  const { createLocalDatabase } = await import('../server/local-db.ts');
  const db = createLocalDatabase(':memory:');
  try {
    const get = (path: string) => handleApi(new Request('https://grid.example.org' + path), { DB: db });
    const response = await get('/api/load-coverage'); assert.equal(response.status, 200);
    const loadCoverage = await response.json(); validateLoadCoverageDataset(loadCoverage);
    const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
    const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
    const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
    const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
    const now = new Date().toISOString(), data = { projects: [], snapshot: { capturedAt: now }, exportedAt: now, loadCoverage };
    const helpers = { scoreProject, summarize, ratingPoint, calendarDayKst, endOfKstDay, isCalendarDay, isDemandDataset,
      filterHistoricalSeries, historicalCsv, parseHistoricalFilters, loadBottleneckCsv, parseLoadBottleneckFilters, loadCoverageCsv, parseLoadCoverageFilters };
    install(data, helpers, false);
    for (const path of ['/api/load-coverage', '/api/load-coverage/export', '/api/load-coverage/export?region=PJM&status=not_reviewed']) {
      const live = await get(path), offline = await window.fetch(path);
      assert.equal(live.status, offline.status); assert.equal(await live.text(), await offline.text());
    }
    assert.equal((await get('/api/load-coverage/export?region=US')).status, 400);
    assert.equal((await window.fetch('/api/load-coverage/export?region=US')).status, 400);
    assert.equal((await window.fetch('/api/load-coverage', { method: 'POST' })).status, 401);
    install({ ...data, loadCoverage: undefined }, helpers, false);
    assert.equal((await window.fetch('/api/load-coverage')).status, 503);
    assert.equal((await window.fetch('/api/load-coverage/export')).status, 503);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first<{ n: number }>())?.n, 0);
  } finally { db.close(); }
});
