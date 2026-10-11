import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coverageUtilityStatus, filterCoverageUtilities, summarizeCoverage, validateLoadCoverageDataset,
  type LoadCoverageDataset } from '../shared/load-coverage.ts';

const data: LoadCoverageDataset = JSON.parse(readFileSync(new URL('../data/load-coverage.json', import.meta.url), 'utf8'));
const byEvidence = new Map(data.evidence.map(row => [row.id, row]));
const byUtility = new Map(data.universe.utilities.map(row => [row.id, row]));

test('published EIA reporting census conserves mainland, mixed, nonmainland and unresolved identities', () => {
  validateLoadCoverageDataset(data);
  assert.equal(data.universe.year, 2025);
  assert.equal(byUtility.size, 3421);
  assert.equal(data.universe.utilities.length, 3421);
  assert.deepEqual(['mainland', 'mixed', 'nonmainland', 'unresolved'].map(scope => data.universe.utilities.filter(u => u.geographicScope === scope).length), [3315, 22, 80, 4]);
  assert.equal(data.universe.utilities.filter(u => u.mainlandStates.length > 0).length, 3337);
  assert.match(data.universe.scope, /보고기관/);
  assert.ok(data.universe.utilities.some(u => u.roles.includes('retail_marketing')));
  assert.ok(data.universe.utilities.some(u => u.roles.includes('transmission') && !u.roles.includes('distribution')));
  const generating = byUtility.get('eia861:343')!;
  assert.equal(generating.name, 'AEP Generating Company');
  assert.deepEqual(generating.states, ['OH']);
  assert.deepEqual(generating.regions, ['Unassigned']); // Ohio location is not proof of PJM membership.
  assert.equal(filterCoverageUtilities(data, { region: 'Unassigned' }).length, 132);
  assert.deepEqual(byUtility.get('eia861:659')!.associations.map(a => a.kind), ['iso_membership']); // Transmission-only reporter: not mislabeled BA service.
});

test('explicit legal-entity links neither spread parent-group evidence nor reviewed status across regions', () => {
  const links: { links: { evidenceId: string; utilities: { id: string; expectedName: string }[] }[] } = JSON.parse(readFileSync(new URL('../data/load-coverage-links.json', import.meta.url), 'utf8'));
  for (const row of links.links) {
    assert.deepEqual(byEvidence.get(row.evidenceId)!.utilityIds, row.utilities.map(u => u.id));
    for (const utility of row.utilities) assert.equal(byUtility.get(utility.id)!.name, utility.expectedName);
  }
  assert.deepEqual(byEvidence.get('pjm-aep-coverage-20260929')!.utilityIds, ['eia861:733', 'eia861:9324', 'eia861:14006', 'eia861:22053']);
  assert.deepEqual(byEvidence.get('pjm-dominion-coverage-20260929')!.utilityIds, ['eia861:19876']);
  assert.deepEqual(byEvidence.get('stage-coverage-spp-evergy-advanced-development-stages')!.utilityIds, []);
  assert.deepEqual(byEvidence.get('miso-v3-support-northern-states-power-company')!.utilityIds, []);
  assert.deepEqual(byUtility.get('eia861:12341')!.regions, ['MISO', 'PJM']);
  assert.equal(coverageUtilityStatus(data, 'eia861:12341', 'MISO'), 'reviewed');
  assert.equal(coverageUtilityStatus(data, 'eia861:12341', 'PJM'), 'not_reviewed');
  assert.equal(coverageUtilityStatus(data, 'eia861:807', 'SPP'), 'not_reviewed');
  assert.equal(summarizeCoverage(data).reviewedUtilityCount, 63);
});

test('CAISO CEC regional requests preserve the published rounding discrepancy and mixed eligibility', () => {
  const cec = byEvidence.get('cec-caiso-datacenter-request-pool')!;
  assert.equal(cec.coverageKind, 'requests');
  assert.deepEqual(cec.metrics.map(m => [m.value, m.unit, m.asOf]), [
    [23278, 'MW', '2025-12'], [5086, 'MW', '2025-12'], [9587, 'MW', '2025-12'], [8604, 'MW', '2025-12'],
  ]);
  assert.equal(cec.metrics.slice(1).reduce((sum, m) => sum + m.value!, 0), 23277);
  assert.deepEqual(cec.scoreSeriesIds, []); // Inquiries, studies and operating contracts cannot become an active-project score.
  assert.deepEqual(cec.utilityIds, []); // Respondent roster is not an attribution of the entire pool to every company.
  for (const id of ['sce-datacenter-tracking-202507-evidence', 'sdge-cpuc-public-register-202509', 'svp-caiso-large-load-coordination']) {
    assert.ok(byEvidence.has(id)); // Actual expansion beyond PG&E, not relabeling its series as region-wide.
  }
});

test('PJM covers every published forecast area and LAS submitter without turning forecasts into observed history', () => {
  const areas = data.rosters.find(r => r.id === 'pjm-official-forecast-areas')!;
  const submitters = data.rosters.find(r => r.id === 'pjm-las-20260929-submitters')!;
  assert.equal(areas.complete, true); assert.equal(areas.entries.length, 22);
  assert.equal(submitters.complete, true); assert.equal(submitters.entries.length, 12);
  for (const entry of areas.entries) {
    const forecast = data.evidence.find(e => e.id.endsWith('-official-forecast-2026') && e.rosterEntryIds.includes(entry.id))!;
    assert.ok(forecast); assert.equal(forecast.coverageKind, 'forecast'); assert.equal(forecast.metrics.length, 42);
    assert.ok(forecast.metrics.every(m => m.unit === 'MW' && m.asOf === null));
    assert.deepEqual(forecast.scoreSeriesIds, []);
  }
  for (const entry of submitters.entries) assert.ok(data.evidence.some(e => e.rosterEntryIds.includes(entry.id)));
  const ekpc = byEvidence.get('pjm-area-ekpc-official-forecast-2026')!;
  assert.equal(ekpc.metrics[0].value, -10); assert.ok(ekpc.metrics.some(m => m.value === -8));
  assert.ok(data.evidence.some(e => e.coverageKind === 'forecast' && e.metrics.some(m => m.value === 0)));
  const dominion = byEvidence.get('pjm-dominion-coverage-20260929')!;
  assert.deepEqual(dominion.metrics.slice(0, 3).map(m => m.value), [32473, 9356, 11997]);
  assert.deepEqual(dominion.scoreSeriesIds, []); // ELOA/CLOA/ESA contain operating and pre-service pools.
  const aep = byEvidence.get('pjm-aep-coverage-20260929')!;
  assert.deepEqual(aep.metrics.slice(0, 2).map(m => m.value), [24596, 22095]); // Existing+planned versus incremental are not additive.
  assert.deepEqual(aep.scoreSeriesIds, []);
});

test('MISO expansion retains transmission support scope and operator publication gaps remain unknown', () => {
  const census = byEvidence.get('miso-v3-mtep-load-support-census')!;
  assert.equal(census.coverageKind, 'grid_support');
  assert.equal(census.metrics[0].value, 161); assert.equal(census.metrics[0].unit, 'projects');
  assert.match(census.metrics[0].label, /송전사업/);
  assert.deepEqual(census.scoreSeriesIds, []);
  const submitters = data.rosters.find(r => r.id === 'miso-v3-mtep-submitters')!;
  assert.equal(submitters.entries.length, 49);
  assert.equal(data.evidence.filter(e => e.id.startsWith('miso-v3-support-')).length, 30);
  assert.ok(byEvidence.get('miso-v3-support-entergy-arkansas-llc-eato')!.utilityIds.includes('eia861:814'));
  assert.ok(byEvidence.get('miso-v3-support-ameren-illinois')!.utilityIds.includes('eia861:56697'));
  assert.equal(byEvidence.get('ercot-operator-llis-stage-coverage')!.metrics.find(m => m.unit === 'projects')!.value, null);
  assert.equal(byEvidence.get('spp-hill-nonpublic-queue')!.metrics[0].value, null);
  assert.deepEqual(byEvidence.get('spp-hill-nonpublic-queue')!.scoreSeriesIds, []);
});
