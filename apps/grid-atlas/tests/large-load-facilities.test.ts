import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLargeLoadFacilities } from '../scripts/build-large-load-facilities.ts';
import { facilityCanonicalJson, facilityAggregateHistory, facilityCapacityWeight, facilitiesCsv, facilityHistory, filterFacilities, scoreFacility, summarizeFacilities, validateFacilityFragment, validateLargeLoadFacilities,
  type FacilityDataset, type FacilityFragment, type FacilityJurisdictionDataset, type FacilitySource, type LargeLoadFacility } from '../shared/large-load-facilities.ts';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const source = (id = 'official', patch: Partial<FacilitySource> = {}): FacilitySource => ({ id, name: '공식 시설 자료', url: 'https://example.gov/facilities', retrievedAt: '2026-10-12T06:00:00.000Z', sha256: 'a'.repeat(64), publishedAt: null, sourceAsOf: null, excerpt: '실명 시설의 개발 단계와 부지 범위를 확인.', ...patch });
const facility = (id = 'LLF-site-a', patch: Partial<LargeLoadFacility> = {}): LargeLoadFacility => ({ id, name: 'Example data center', operator: 'Example Inc.', sector: 'data_center', region: 'PJM', state: 'VA', city: 'Ashburn', county: null, lat: null, lon: null, identityKind: 'facility', parentId: null, lifecycle: 'planned', asOf: null, sourceIds: ['official'], capacityFacts: [], events: [], gridEvidence: [], aliases: [], legacyProjectIds: [], notes: [], ...patch });
const fragment = (facilities: LargeLoadFacility[], sources = [source()]): FacilityFragment => ({ schemaVersion: 1, id: 'test', generatedAt: '2026-10-12T07:00:00.000Z', sources, facilities, limitations: [] });
const regulations = (): FacilityJurisdictionDataset => ({ schemaVersion: 1, generatedAt: '2026-10-12T07:00:00.000Z', sources: [source('rule')], rules: [{ id: 'VA-PJM', name: 'Virginia large load service process', states: ['VA'], regions: ['PJM'], sectors: ['data_center'], effectiveFrom: '2025-01-01', effectiveTo: null, sourceIds: ['rule'], procedures: [{ gate: 'technical', requirement: 'Site-specific grid study' }], limitations: ['Applies only if this facility seeks the described service.'] }], limitations: [] });
const dataset = (facilities: LargeLoadFacility[], jurisdiction = false): FacilityDataset => buildLargeLoadFacilities({ fragments: [fragment(facilities)], jurisdictions: jurisdiction ? regulations() : null, now: NOW });

test('development inventory includes announced facilities without turning them into ISO requests', () => {
  const d = dataset([facility(), facility('live', { lifecycle: 'operating' }), facility('halt', { lifecycle: 'paused' }), facility('gone', { lifecycle: 'cancelled' })]);
  assert.equal(d.facilities[0].legacyProjectIds.length, 0);
  assert.deepEqual(d.facilities.map(f => f.gridEvidence), [[], [], [], []]);
  const summary = summarizeFacilities(d);
  assert.equal(summary.facilityCount, 4); assert.equal(summary.developmentCount, 1); assert.equal(summary.countAverageCount, 1); assert.equal(summary.countMean, 90);
  assert.equal(scoreFacility(d, d.facilities.find(f => f.id === 'live')!).point, 0);
  assert.equal(summary.operatingCount, 1); assert.equal(summary.pausedCount, 1); assert.equal(summary.cancelledCount, 1);
});
test('unknown phase has an explicitly uncertain jurisdiction scenario, optional denominator, no regulatory proof of progress', () => {
  const d = dataset([facility('unknown', { lifecycle: 'unknown' }), facility('wrong-state', { lifecycle: 'unknown', state: 'PA' })], true);
  const score = scoreFacility(d, d.facilities.find(f => f.id === 'unknown')!);
  assert.equal(score.point, 90); assert.deepEqual(score.range, [0, 100]); assert.equal(score.basis, 'jurisdiction_prior'); assert.equal(score.confidence, 'low'); assert.equal(score.eligibleForAverage, false);
  assert.equal(summarizeFacilities(d).countMean, null); assert.equal(summarizeFacilities(d, { includeUnknownPrior: true }).countMean, 90);
  const unlinked = scoreFacility(d, d.facilities.find(f => f.id === 'wrong-state')!); assert.equal(unlinked.point, 90); assert.equal(unlinked.basis, 'conservative_prior'); assert.deepEqual(unlinked.jurisdictionIds, []);
});
test('individual contract and permit affect only their gates; partial campus energization is not full operation', () => {
  const gridEvidence: LargeLoadFacility['gridEvidence'] = ['contract', 'permit', 'energized'].map(kind => ({ id: kind, kind: kind as 'contract' | 'permit' | 'energized', date: null, sourceIds: ['official'], note: 'Specific facility evidence; energized scope is one initial phase.' }));
  const d = dataset([facility('campus', { identityKind: 'campus', gridEvidence })]); const score = scoreFacility(d, d.facilities[0]);
  assert.equal(score.basis, 'grid_evidence'); assert.equal(score.lifecycle, 'planned'); assert.deepEqual(score.gates.map(g => g.points), [15, 0, 0, 20, 0]); assert.equal(score.point, 35);
  assert.equal(score.eligibleForAverage, true); assert.ok(score.assumptions.some(s => s.includes('전체 캠퍼스')));
});
test('unknown capacity stays null, MW measures remain separate, contradictory claims and child phases are not additive', () => {
  const capacity = (id: string, value: number, measure: 'it_power' | 'requested_grid', unit: 'MW' | 'MVA' = 'MW') => ({ id, value, unit, measure, scope: 'facility' as const, asOf: null, sourceIds: ['official'], note: 'Reported measure; no conversion.' });
  const d = dataset([facility('a', { capacityFacts: [capacity('grid', 100, 'requested_grid'), capacity('duplicate-document', 100, 'requested_grid'), capacity('it', 70, 'it_power'), capacity('mva', 200, 'requested_grid', 'MVA')] }),
    facility('b', { capacityFacts: [capacity('grid1', 100, 'requested_grid'), capacity('grid2', 150, 'requested_grid')] }), facility('phase', { identityKind: 'phase', parentId: 'a', capacityFacts: [capacity('part', 100, 'requested_grid')] }), facility('unknown')]);
  const s = summarizeFacilities(d); assert.equal(s.capacityByMeasure.requested_grid.mw, 100); assert.equal(s.capacityByMeasure.requested_grid.knownCount, 1); assert.equal(s.capacityByMeasure.requested_grid.conflictCount, 1); assert.equal(s.capacityByMeasure.it_power.mw, 70);
  assert.equal(s.capacityByMeasure.contracted_grid.mw, null); assert.equal(s.countAverageCount, 3);
});
test('four documents require an explicit same-site decision and preserve source evidence without four averages', () => {
  const facilities = ['a', 'b', 'c', 'd'].map(id => facility(id));
  const built = buildLargeLoadFacilities({ fragments: [fragment(facilities)], decisions: [{ id: 'same-site', kind: 'same_entity', facilityIds: ['a', 'b', 'c', 'd'], sourceIds: ['official'], reason: 'Exact address and cadastral parcel matched in four primary documents.' }], now: NOW });
  assert.equal(built.facilities.length, 1); assert.equal(summarizeFacilities(built).countAverageCount, 1); assert.ok(built.facilities[0].aliases.includes('d')); assert.equal(built.decisions.length, 1);
  assert.equal(buildLargeLoadFacilities({ previous: built, fragments: [fragment(facilities)], decisions: [{ id: 'same-site', kind: 'same_entity', facilityIds: ['a', 'b', 'c', 'd'], sourceIds: ['official'], reason: 'Exact address and cadastral parcel matched in four primary documents.' }], now: NOW }).facilities.length, 1);
  assert.throws(() => buildLargeLoadFacilities({ fragments: [fragment(facilities)], decisions: [{ id: 'bad', kind: 'same_entity', facilityIds: ['a', 'b'], sourceIds: ['nonexistent'], reason: 'Claim without a real evidence link.' }], now: NOW }), /Missing source/);
  assert.throws(() => buildLargeLoadFacilities({ fragments: [fragment(facilities)], decisions: [{ id: 'bad', kind: 'same_entity', facilityIds: ['a', 'b'], sourceIds: [], reason: 'Claim without any evidence.' }], now: NOW }), /actual source/);
});
test('unlinked municipal building phases remain visible without inflating either project average', () => {
  const d = dataset([facility('campus'), ...Array.from({ length: 10 }, (_, i) => facility(`permit-building-${i}`, {
    identityKind: 'phase', parentId: null, lifecycle: 'construction',
  }))]);
  const summary = summarizeFacilities(d);
  assert.equal(summary.facilityCount, 11);
  assert.equal(summary.phaseCount, 10);
  assert.equal(summary.countAverageCount, 1);
  assert.equal(summary.countMean, 90);
  assert.equal(summary.averageMw, 0);
  assert.equal(summary.mean, null);
  const building = d.facilities.find(f => f.id === 'permit-building-0')!;
  assert.equal(scoreFacility(d, building).point, 55);
  assert.equal(scoreFacility(d, building).eligibleForAverage, false);
  assert.match(scoreFacility(d, building).exclusionReason!, /개별 단계/);
});
test('same operator and city do not merge different sites; ambiguous links exclude both from means and MW', () => {
  const d = dataset([facility('one'), facility('two')]); assert.equal(d.facilities.length, 2);
  const uncertain = buildLargeLoadFacilities({ fragments: [fragment([facility('one'), facility('two')])], decisions: [{ id: 'suspect', kind: 'possible_duplicate', facilityIds: ['one', 'two'], sourceIds: ['official'], reason: 'Address incomplete; physical identity not established.' }], now: NOW });
  assert.equal(summarizeFacilities(uncertain).facilityCount, 2); assert.equal(summarizeFacilities(uncertain).countAverageCount, 0);
});
test('an exact reviewed campus relationship survives a fresh operator page with no parent metadata', () => {
  const parent = facility('campus', { identityKind: 'campus' });
  const reviewed = { ...fragment([parent, facility('building', { parentId: 'campus' })]), id: 'legacy-sites' };
  const latestOperator = { ...fragment([facility('building')]), id: 'operators' };
  const d = buildLargeLoadFacilities({ fragments: [reviewed, latestOperator], now: NOW });
  assert.equal(d.facilities.find(f => f.id === 'building')!.parentId, 'campus');
  assert.equal(summarizeFacilities(d).countAverageCount, 1);
  const conflicting = { ...fragment([facility('other-parent'), facility('building', { parentId: 'other-parent' })]), id: 'conflict' };
  assert.throws(() => buildLargeLoadFacilities({ fragments: [reviewed, conflicting], now: NOW }), /Conflicting parent/);
});
test('later derived enrichment and its preserved unmarked history cannot override the primary lifecycle or identity', () => {
  const primary = { ...fragment([facility('site', { lifecycle: 'construction' })]), id: 'operators', generatedAt: '2026-10-12T07:00:00.000Z' };
  const derived = { ...fragment([facility('site', { name: 'Old copied name', lifecycle: 'operating', gridEvidence: [{ id: 'contract', kind: 'contract' as const, date: null, sourceIds: ['official'], note: 'Older reviewed contract remains useful.' }] })]), id: 'reviewed-links', generatedAt: '2026-10-12T08:00:00.000Z' };
  const mistakenOld = buildLargeLoadFacilities({ fragments: [primary, derived], now: NOW }); assert.equal(mistakenOld.facilities[0].lifecycle, 'operating');
  const classified = { ...derived, enrichmentOnlyFacilityIds: ['site'] };
  const fixed = buildLargeLoadFacilities({ fragments: [primary, classified], previous: mistakenOld, now: NOW });
  assert.equal(fixed.facilities[0].lifecycle, 'construction'); assert.equal(fixed.facilities[0].name, 'Example data center');
  assert.equal(scoreFacility(fixed, fixed.facilities[0]).lifecycle, 'construction'); assert.equal(scoreFacility(fixed, fixed.facilities[0]).basis, 'grid_evidence');
  assert.ok(fixed.facilities[0].observations!.filter(o => o.originId === 'reviewed-links:site').every(o => o.evidenceOnly));
  assert.equal(facilityCanonicalJson(buildLargeLoadFacilities({ fragments: [primary, classified], previous: fixed, now: NOW })), facilityCanonicalJson(fixed));
});
test('fresh primary collection updates status while genuinely new legacy facilities remain primary', () => {
  const older = { ...fragment([facility('site', { lifecycle: 'planned' })]), id: 'operators' };
  const old = buildLargeLoadFacilities({ fragments: [older], now: NOW });
  const fresh = { ...fragment([facility('site', { lifecycle: 'operating' })]), id: 'operators', generatedAt: '2026-10-12T08:00:00.000Z' };
  const legacy = { ...fragment([facility('site', { lifecycle: 'planned' }), facility('new-legacy', { lifecycle: 'construction' })]), id: 'legacy-sites', generatedAt: '2026-10-12T09:00:00.000Z', enrichmentOnlyFacilityIds: ['site'] };
  const current = buildLargeLoadFacilities({ previous: old, fragments: [fresh, legacy], now: NOW });
  assert.equal(current.facilities.find(f => f.id === 'site')!.lifecycle, 'operating'); assert.equal(current.facilities.find(f => f.id === 'new-legacy')!.lifecycle, 'construction');
  assert.equal(summarizeFacilities(current).developmentCount, 1); assert.equal(summarizeFacilities(current).operatingCount, 1);
});
test('dated partial-site enrichment cannot replace the primary facility historical lifecycle', () => {
  const d = dataset([facility('site', { lifecycle: 'operating', events: [
    { id: 'primary-open', date: '2025-01-01', status: 'operating', sourceIds: ['official'], note: 'Matched facility began operating.' },
    { id: 'partial-research', date: '2026-01-01', status: 'construction', sourceIds: ['official'], note: 'Research describes a different campus subset.', evidenceOnly: true },
  ] })]);
  const f = d.facilities[0];
  assert.equal(f.events.length, 2);
  assert.equal(scoreFacility(d, f, { asOf: '2026-02-01' }).lifecycle, 'operating');
  assert.deepEqual(facilityHistory(d, f).map(p => p.date), ['2025-01-01']);
  const referenceOnly = dataset([facility('reference', { events: [{ id: 'partial-only', date: '2025-01-01', status: 'operating', sourceIds: ['official'], note: 'Unmatched partial operation only.', evidenceOnly: true }] })]);
  assert.equal(scoreFacility(referenceOnly, referenceOnly.facilities[0], { asOf: '2026-01-01' }).point, null);
});
test('copied enrichment capacity cannot create a false conflict after the primary value changes', () => {
  const oldFact = { id: 'primary-power', value: 100, unit: 'MW' as const, measure: 'facility_power' as const, scope: 'facility' as const, asOf: '2020-01-01', sourceIds: ['official'], note: 'Original reported capacity.' };
  const oldPrimary = { ...fragment([facility('site', { capacityFacts: [oldFact] })]), id: 'operators', generatedAt: '2026-10-12T07:00:00.000Z' };
  const copied = { ...fragment([facility('site', { capacityFacts: [oldFact, { ...oldFact, id: 'reviewed-it', value: 80, measure: 'it_power' as const }] })]), id: 'legacy-sites', enrichmentOnlyFacilityIds: ['site'], generatedAt: '2026-10-12T08:00:00.000Z' };
  const old = buildLargeLoadFacilities({ fragments: [oldPrimary, copied], now: NOW });
  const fresh = { ...oldPrimary, generatedAt: '2026-10-12T09:00:00.000Z', facilities: [facility('site', { capacityFacts: [{ ...oldFact, value: 200, asOf: '2025-01-01' }] })] };
  const d = buildLargeLoadFacilities({ previous: old, fragments: [fresh, copied], now: NOW });
  const summary = summarizeFacilities(d); assert.equal(summary.capacityByMeasure.facility_power.mw, 200); assert.equal(summary.capacityByMeasure.facility_power.conflictCount, 0); assert.equal(summary.capacityByMeasure.it_power.mw, 80);
  assert.equal(summarizeFacilities(d, { asOf: '2021-01-01' }).capacityByMeasure.facility_power.mw, 100);
  assert.equal(summarizeFacilities(d, { asOf: '2025-06-01' }).capacityByMeasure.facility_power.mw, 200);
  assert.ok(d.facilities[0].observations!.some(o => o.evidenceOnly && o.capacityFacts.some(c => c.id === 'primary-power' && c.value === 100)));
});
test('a primary correction to unknown suppresses the copied energized fact but retains a distinct reviewed contract', () => {
  const energized = { id: 'primary-grid', kind: 'energized' as const, date: '2025-01-01', sourceIds: ['official'], note: 'Previously interpreted as energized.' };
  const initial = { ...fragment([facility('site', { gridEvidence: [energized] })]), id: 'operators' };
  const enrichment = { ...fragment([facility('site', { gridEvidence: [energized, { ...energized, id: 'reviewed-contract', kind: 'contract' as const, note: 'Separate signed supply contract.' }] })]), id: 'legacy-sites', enrichmentOnlyFacilityIds: ['site'], generatedAt: '2026-10-12T08:00:00.000Z' };
  const old = buildLargeLoadFacilities({ fragments: [initial, enrichment], now: NOW });
  const correction = { ...initial, generatedAt: '2026-10-12T09:00:00.000Z', facilities: [facility('site', { gridEvidence: [{ ...energized, kind: 'unknown' as const, note: 'Site commissioning did not prove grid energization.' }] })] };
  const d = buildLargeLoadFacilities({ previous: old, fragments: [correction, enrichment], now: NOW });
  const score = scoreFacility(d, d.facilities[0]); assert.equal(score.gates.find(g => g.gate === 'energization')!.points, 20); assert.equal(score.gates.find(g => g.gate === 'commercial')!.points, 0);
  const historical = filterFacilities(d, { asOf: '2025-06-01' })[0]; assert.equal(historical.gridEvidence.find(e => e.id === 'primary-grid')!.kind, 'unknown');
  assert.ok(d.facilities[0].observations!.some(o => o.evidenceOnly && o.gridEvidence.some(e => e.kind === 'energized')));
});
test('historical reevaluation explicitly uses current reviewed identity, not pre-deduplication row counts', () => {
  const d = buildLargeLoadFacilities({ fragments: [fragment([facility('a'), facility('b')])], decisions: [{ id: 'dedup', kind: 'same_entity', facilityIds: ['a', 'b'], sourceIds: ['official'], reason: 'Same physical property established by source addresses.' }], now: NOW });
  const summary = summarizeFacilities(d, { knownAt: '2026-10-12' }); assert.equal(summary.identityScope, 'current_reviewed_identity'); assert.equal(summary.facilityCount, 1);
  assert.ok(scoreFacility(d, d.facilities[0], { knownAt: '2026-10-12' }).assumptions.some(s => s.includes('합병 전 행 수')));
  assert.ok(facilitiesCsv(d).includes('current_reviewed_identity'));
});
test('historical points require dated events and are separately constrained by source-known time', () => {
  const f = facility('history', { lifecycle: 'operating', events: [{ id: 'plan', date: '2020-06-01', status: 'planned', sourceIds: ['official'], note: 'Actual announcement dated in source.' }, { id: 'open', date: '2024-06-01', status: 'operating', sourceIds: ['official'], note: 'Actual opening.' }] });
  const d = dataset([f, facility('undated', { lifecycle: 'operating' })]);
  assert.deepEqual(facilityHistory(d, d.facilities[0]).map(p => [p.date, p.score.point]), [['2020-06-01', 90], ['2024-06-01', 0]]);
  assert.deepEqual(facilityHistory(d, d.facilities[0], { knownAt: '2026-10-11' }), []);
  assert.equal(scoreFacility(d, d.facilities[0], { knownAt: '2026-10-11', includeUnknownPrior: true }).point, null);
  assert.equal(summarizeFacilities(d, { knownAt: '2026-10-11', includeUnknownPrior: true }).facilityCount, 0);
  assert.equal(scoreFacility(d, d.facilities[0], { asOf: '2019-01-01' }).point, null);
  assert.equal(scoreFacility(d, d.facilities.find(f => f.id === 'undated')!, { asOf: '2024-01-01' }).point, null);
});
test('unknown current state with individual grid evidence joins only the explicitly selected provisional denominator', () => {
  const d = dataset([facility('contract', { lifecycle: 'unknown', gridEvidence: [{ id: 'supply', kind: 'contract', date: null, sourceIds: ['official'], note: 'Signed supply contract; present operation status not disclosed.' }] })]);
  assert.equal(scoreFacility(d, d.facilities[0]).basis, 'grid_evidence'); assert.equal(summarizeFacilities(d).countAverageCount, 0);
  assert.equal(summarizeFacilities(d, { includeUnknownPrior: true }).countAverageCount, 1);
  assert.equal(filterFacilities(d, { scoreBasis: 'grid_evidence' }).length, 1); assert.equal(filterFacilities(d, { scoreBasis: 'lifecycle' }).length, 0);
});
test('a later status refresh preserves the earlier observation and never retroactively replaces it', () => {
  const old = buildLargeLoadFacilities({ fragments: [{ ...fragment([facility()]), generatedAt: '2026-10-01T07:00:00.000Z', sources: [source('official', { retrievedAt: '2026-10-01T06:00:00.000Z' })] }], now: NOW });
  const current = buildLargeLoadFacilities({ previous: old, fragments: [fragment([facility('LLF-site-a', { lifecycle: 'operating' })], [source('official', { sha256: 'b'.repeat(64) })])], now: NOW });
  assert.equal(current.sources.length, 2); assert.equal(current.facilities[0].observations!.length, 2);
  assert.equal(scoreFacility(current, current.facilities[0], { knownAt: '2026-10-05' }).point, 90); assert.equal(scoreFacility(current, current.facilities[0]).point, 0);
  const repeated = buildLargeLoadFacilities({ previous: current, fragments: [fragment([facility('LLF-site-a', { lifecycle: 'operating' })], [source('official', { sha256: 'b'.repeat(64) })])], now: NOW });
  assert.equal(facilityCanonicalJson(repeated), facilityCanonicalJson(current));
});
test('historical knownAt restores observed capacity and grid facts even when later normalization cites the same old document', () => {
  const oldFragment = { ...fragment([facility('facts', { capacityFacts: [{ id: 'mw', value: 100, unit: 'MW', measure: 'requested_grid', scope: 'facility', asOf: null, sourceIds: ['official'], note: 'Initial requested load.' }], events: [{ id: 'start', date: '2020-01-01', status: 'planned', sourceIds: ['official'], note: 'Actual dated announcement.' }] })]), generatedAt: '2026-10-01T07:00:00.000Z', sources: [source('official', { retrievedAt: '2026-10-01T06:00:00.000Z' })] } satisfies FacilityFragment;
  const old = buildLargeLoadFacilities({ fragments: [oldFragment], now: NOW });
  const revised = structuredClone(oldFragment); revised.generatedAt = '2026-10-12T07:00:00.000Z'; revised.facilities[0].capacityFacts[0].value = 200;
  revised.facilities[0].gridEvidence.push({ id: 'signed', kind: 'contract', date: null, sourceIds: ['official'], note: 'Later review establishes the contract.' });
  const current = buildLargeLoadFacilities({ previous: old, fragments: [revised], now: NOW });
  assert.equal(summarizeFacilities(current, { knownAt: '2026-10-05' }).capacityByMeasure.requested_grid.mw, 100);
  assert.equal(summarizeFacilities(current).capacityByMeasure.requested_grid.mw, 200);
  assert.equal(scoreFacility(current, current.facilities[0], { knownAt: '2026-10-05' }).basis, 'lifecycle');
  assert.equal(scoreFacility(current, current.facilities[0]).basis, 'grid_evidence');
  const refresh = structuredClone(revised); refresh.sources[0].retrievedAt = '2026-10-12T06:00:00.000Z';
  const fetched = buildLargeLoadFacilities({ previous: current, fragments: [refresh], now: NOW });
  assert.equal(fetched.facilities[0].events.length, 1); assert.equal(fetched.facilities[0].events[0].sourceIds.length, 2);
});
test('historical geography uses the observed identity and dated old capacity survives later updates', () => {
  const oldFragment = fragment([facility('moving', { capacityFacts: [{ id: 'power', value: 50, unit: 'MW', measure: 'facility_power', scope: 'facility', asOf: '2020-01-01', sourceIds: ['official'], note: 'Original building capacity.' }] })], [source('official', { retrievedAt: '2026-10-01T06:00:00.000Z' })]); oldFragment.generatedAt = '2026-10-01T07:00:00.000Z';
  const old = buildLargeLoadFacilities({ fragments: [oldFragment], now: NOW });
  const revised = structuredClone(oldFragment); revised.generatedAt = '2026-10-12T07:00:00.000Z'; revised.facilities[0].state = 'TX'; revised.facilities[0].region = 'ERCOT'; revised.facilities[0].name = 'Corrected Texas facility';
  revised.facilities[0].capacityFacts[0].value = 100; revised.facilities[0].capacityFacts[0].asOf = '2025-01-01';
  const current = buildLargeLoadFacilities({ previous: old, fragments: [revised], now: NOW });
  assert.equal(filterFacilities(current, { knownAt: '2026-10-05', state: 'VA' }).length, 1); assert.equal(filterFacilities(current, { knownAt: '2026-10-05', state: 'TX' }).length, 0);
  assert.equal(filterFacilities(current, { knownAt: '2026-10-05' })[0].name, 'Example data center');
  assert.equal(summarizeFacilities(current, { asOf: '2021-01-01' }).capacityByMeasure.facility_power.mw, 50);
  assert.equal(summarizeFacilities(current, { asOf: '2025-06-01' }).capacityByMeasure.facility_power.mw, 100);
});
test('history source-known time includes later-acquired gate evidence; dated grid claims cannot precede their artifact', () => {
  const sources = [source('old', { retrievedAt: '2026-10-01T06:00:00.000Z' }), source('new')];
  const f = facility('history', { sourceIds: ['old', 'new'], events: [{ id: 'start', date: '2020-01-01', status: 'planned', sourceIds: ['old'], note: 'Dated announcement.' }], gridEvidence: [{ id: 'contract', kind: 'contract', date: '2019-12-01', sourceIds: ['new'], note: 'Historical contract discovered later.' }] });
  const d = buildLargeLoadFacilities({ fragments: [fragment([f], sources)], now: NOW });
  assert.equal(facilityHistory(d, d.facilities[0])[0].knownAt, '2026-10-12T06:00:00.000Z');
  const invalid = fragment([facility('future-grid', { gridEvidence: [{ id: 'future', kind: 'energized', date: '2026-10-10', sourceIds: ['official'], note: 'Impossible proof before occurrence.' }] })], [source('official', { retrievedAt: '2026-10-01T06:00:00.000Z' })]);
  assert.throws(() => validateFacilityFragment(invalid, NOW), /grid fact after/);
});
test('first build and repeat are byte-equivalent despite unsorted arrays and staged manifests', () => {
  const f = fragment([facility('stable', { notes: ['z note', 'a note'], aliases: ['z', 'a'], legacyProjectIds: ['Z', 'A'], events: [{ id: 'z', date: '2021-01-01', status: 'planned', sourceIds: ['official'], note: 'Actual event.' }, { id: 'a', date: '2022-01-01', status: 'construction', sourceIds: ['official'], note: 'Actual work.' }] })]);
  const first = buildLargeLoadFacilities({ fragments: [f], now: NOW }); const repeated = buildLargeLoadFacilities({ fragments: [f], previous: first, now: NOW }); assert.equal(facilityCanonicalJson(first), facilityCanonicalJson(repeated));
});
test('source dates, future targets, broken evidence, duplicate IDs and parent cycles fail validation', () => {
  assert.throws(() => validateFacilityFragment(fragment([facility(), facility()]), NOW), /identity/);
  assert.throws(() => validateFacilityFragment(fragment([facility({} as string, { sourceIds: ['absent'] })]), NOW), /identity|reference/);
  assert.throws(() => validateFacilityFragment(fragment([facility({} as string)]), NOW), /identity/);
  assert.throws(() => validateFacilityFragment(fragment([facility()], [source('official', { publishedAt: '2027-01-01' })]), NOW), /date after/);
  assert.throws(() => dataset([facility('target', { events: [{ id: 'future', date: '2028-01-01', status: 'operating', sourceIds: ['official'], note: 'Target completion, not an event.' }] })]), /milestone/);
  assert.throws(() => dataset([facility('a', { parentId: 'b' }), facility('b', { parentId: 'a' })]), /cycle/);
  const bad = dataset([facility()]); bad.facilities[0].capacityFacts = [{ id: 'negative', value: -1, unit: 'MW', measure: 'it_power', scope: 'facility', asOf: null, sourceIds: [bad.sources[0].id], note: 'Invalid.' }]; assert.throws(() => validateLargeLoadFacilities(bad, NOW), /capacity/);
});
test('unknown mainland location retains a score but cannot enter the mainland development mean', () => {
  const d = dataset([facility('where', { state: null, region: 'Unknown' })]); assert.equal(scoreFacility(d, d.facilities[0]).point, 90); assert.equal(summarizeFacilities(d).countAverageCount, 0);
});
test('CSV keeps provenance and measure semantics, escapes formulas, and matches search filters', () => {
  const d = dataset([facility('formula', { name: '=HYPERLINK("https://evil.example")' }), facility('other', { state: 'OH' })]);
  assert.equal(filterFacilities(d, { state: 'VA' }).length, 1); const csv = facilitiesCsv(d, { state: 'VA' });
  assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('source_evidence')); assert.ok(csv.includes('a'.repeat(64))); assert.ok(!csv.includes('"other"')); assert.ok(csv.includes('lifecycle'));
});

const mw = (id: string, value: number | null, patch: Partial<LargeLoadFacility['capacityFacts'][number]> = {}): LargeLoadFacility['capacityFacts'][number] => ({ id, value, unit: 'MW', measure: 'requested_grid', scope: 'facility', asOf: null, sourceIds: ['official'], note: 'Same-scope requested capacity.', ...patch });
test('capacity weighted facility score uses score × MW, keeps count mean auxiliary, and never substitutes another capacity meaning', () => {
  const d = dataset([facility('large', { capacityFacts: [mw('request', 1000), mw('it', 50, { measure: 'it_power' })] }), facility('small', { lifecycle: 'construction', capacityFacts: [mw('request', 100), mw('contract', 900, { measure: 'contracted_grid' })] }), facility('missing', { capacityFacts: [mw('contract', 10000, { measure: 'contracted_grid' })] })]);
  const s = summarizeFacilities(d);
  assert.equal(s.mean, (90 * 1000 + 55 * 100) / 1100); assert.equal(s.averageMw, 1100); assert.equal(s.averageCount, 2);
  assert.equal(s.countMean, (90 + 55 + 90) / 3); assert.equal(s.countAverageCount, 3); assert.equal(s.excludedCapacityCount, 1);
  assert.deepEqual(s.meanRange, [(60 * 1000 + 15 * 100) / 1100, (100 * 1000 + 90 * 100) / 1100]);
  const contract = summarizeFacilities(d, { capacityBasis: 'contracted_grid' }); assert.equal(contract.averageMw, 10900); assert.equal(contract.mean, (55 * 900 + 90 * 10000) / 10900);
  const absent = summarizeFacilities(d, { capacityBasis: 'facility_power' }); assert.equal(absent.mean, null); assert.equal(absent.averageMw, 0); assert.equal(absent.countAverageCount, 3);
  const csv = facilitiesCsv(d); assert.ok(csv.includes('capacity_basis')); assert.ok(csv.includes('average_denominator_mw')); assert.ok(csv.includes('capacity_source_ids'));
  assert.ok(facilitiesCsv(d, { q: 'large' }).includes('"1000"'));
});
test('capacity weight excludes conflicting values, partial campus MW, zero, MVA and unresolved overlaps without max or summation', () => {
  const d = dataset([facility('conflict', { capacityFacts: [mw('one', 100), mw('two', 500)] }), facility('campus', { identityKind: 'campus', capacityFacts: [mw('phase', 100)] }), facility('zero', { capacityFacts: [mw('zero', 0)] }), facility('mva', { capacityFacts: [mw('mva', 100, { unit: 'MVA' })] }), facility('good', { capacityFacts: [mw('one', 100), mw('duplicate', 100)] }), facility('part', { parentId: 'good', capacityFacts: [mw('one', 100)] }), facility('unresolved', { possibleDuplicateIds: ['good'], capacityFacts: [mw('one', 200)] })]);
  const s = summarizeFacilities(d); assert.equal(s.averageCount, 1); assert.equal(s.averageMw, 100); assert.equal(s.mean, 90);
  for (const id of ['conflict', 'campus', 'zero', 'mva', 'part', 'unresolved']) { const w = facilityCapacityWeight(d, d.facilities.find(f => f.id === id)!); assert.equal(w.eligibleForAverage, false); assert.ok(w.exclusionReason); }
  assert.equal(facilityCapacityWeight(d, d.facilities.find(f => f.id === 'campus')!).mw, null);
});
test('unknown prior selection controls the same positive-MW denominator, and zero-score operating facilities never dilute development', () => {
  const d = dataset([facility('unknown', { lifecycle: 'unknown', capacityFacts: [mw('request', 200)] }), facility('live', { lifecycle: 'operating', capacityFacts: [mw('request', 10000)] })]);
  assert.equal(summarizeFacilities(d).mean, null); assert.equal(summarizeFacilities(d).averageMw, 0);
  const included = summarizeFacilities(d, { includeUnknownPrior: true }); assert.equal(included.mean, 90); assert.equal(included.averageMw, 200); assert.equal(included.averageCount, 1);
});
test('zero MW is a disclosed value and conflicts with a positive same-scope claim instead of silently losing its source', () => {
  const d = dataset([facility('zero-positive', { capacityFacts: [mw('zero', 0), mw('positive', 100)] }), facility('zero-only', { capacityFacts: [mw('zero', 0)] }), facility('missing')]);
  const conflict = facilityCapacityWeight(d, d.facilities.find(f => f.id === 'zero-positive')!);
  assert.equal(conflict.mw, null); assert.equal(conflict.eligibleForAverage, false); assert.match(conflict.capacityExclusionReason!, /상충/); assert.deepEqual(conflict.factIds.sort(), ['positive', 'zero']);
  assert.match(facilityCapacityWeight(d, d.facilities.find(f => f.id === 'zero-only')!).capacityExclusionReason!, /공개 용량 0 MW/);
  assert.match(facilityCapacityWeight(d, d.facilities.find(f => f.id === 'missing')!).capacityExclusionReason!, /미공개/);
});
test('event history recomputes with dated capacity changes and leaves absent past MW missing', () => {
  const oldFragment = fragment([facility('history', { capacityFacts: [mw('request', 100, { asOf: '2022-01-01' })], events: [{ id: 'plan', date: '2020-01-01', status: 'planned', sourceIds: ['official'], note: 'Actual announcement.' }, { id: 'build', date: '2024-01-01', status: 'construction', sourceIds: ['official'], note: 'Actual construction start.' }] })]);
  oldFragment.generatedAt = '2026-10-01T07:00:00.000Z'; oldFragment.sources[0].retrievedAt = '2026-10-01T06:00:00.000Z';
  const old = buildLargeLoadFacilities({ fragments: [oldFragment], now: NOW });
  const revised = structuredClone(oldFragment); revised.generatedAt = '2026-10-12T07:00:00.000Z'; revised.facilities[0].capacityFacts = [mw('request', 500, { asOf: '2025-01-01' })];
  const d = buildLargeLoadFacilities({ previous: old, fragments: [revised], now: NOW });
  const before = summarizeFacilities(d, { asOf: '2021-01-01' }); assert.equal(before.mean, null); assert.equal(before.countMean, 90); assert.equal(before.averageMw, 0);
  assert.equal(summarizeFacilities(d, { asOf: '2023-01-01' }).averageMw, 100); assert.equal(summarizeFacilities(d, { asOf: '2025-01-01' }).averageMw, 500);
  const events = facilityHistory(d, d.facilities[0]); assert.equal(events[0].weight.mw, null); assert.equal(events[1].weight.mw, 100);
  const series = facilityAggregateHistory(d); assert.deepEqual(series.map(p => [p.date, p.summary.averageMw, p.summary.mean]), [['2020-01-01', 0, null], ['2022-01-01', 100, 90], ['2024-01-01', 100, 55], ['2025-01-01', 500, 55]]);
  const observations = facilityAggregateHistory(d, {}, 'observations'); assert.deepEqual(observations.map(p => p.summary.averageMw), [100, 500]);
  assert.equal(facilityAggregateHistory(d, { knownAt: '2026-10-05' }, 'observations').length, 1);
});
