import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteCensus, type CensusPromotions } from '../scripts/promote-load-census.ts';
import type { LoadProjectCensus } from '../shared/load-project-census.ts';
import type { ReviewedLoadDataset } from '../shared/reviewed-load-projects.ts';

const stamp = '2026-10-01T00:00:00.000Z';
const previous: ReviewedLoadDataset = { schemaVersion: 1, generatedAt: stamp, projects: [], sources: [], reviews: [], limitations: [] };
const promotions: CensusPromotions = { schemaVersion: 1, reviewedAt: stamp, items: [{ entityId: 'site:fixture', eligible: true, identityBasis: 'official_single_site_contract', authority: 'Official utility', docketId: null, stage: null, stageRationale: 'Service contract confirms a single active project; further progress is undisclosed.', limitations: [] }] };
function census(): LoadProjectCensus {
  return { schemaVersion: 1, generatedAt: stamp, inputs: [], evidence: [{ id: 'e1', name: 'Official contract', url: 'https://utility.example.org/contract', sourceFamily: 'utility', retrievedAt: stamp, sha256: 'a'.repeat(64), publishedAt: '2026-09-30', sourceAsOf: '2026-09-30', excerpt: 'The identified site has signed an electricity service contract and remains in development.', limitations: [] }],
    rawRecords: [{ id: 'research:r1', inputCollection: 'research', nativeId: 'r1', name: 'Customer site', region: 'ERCOT', state: 'TX', status: 'contracted', kind: 'customer_request', evidenceIds: ['e1'], entityId: 'site:fixture', payload: { preserved: true } }],
    entities: [{ id: 'site:fixture', name: 'Customer site', region: 'ERCOT', state: 'TX', kind: 'site', customer: 'Customer', utility: 'Official utility', utilityIds: [], location: null, status: 'contracted', asOf: '2026-09-30', connectionBasis: 'confirmed_contract', rawRefIds: ['research:r1'], evidenceIds: ['e1'], capacityFacts: [], aliases: [], relatedSupportRecordIds: [], possibleDuplicateIds: [], parentEntityId: null, scoreProjectId: null, limitations: [], knownGridMw: null, capacityConflict: false, additiveStatus: 'unknown_capacity' }],
    decisions: [], entityAliases: [], attempts: [], survey: { utilities: [], limitations: [] }, limitations: [] };
}
test('explicit confirmed active request enters scoring denominator without inventing MW or score', () => {
  const result = promoteCensus(census(), previous, { projects: [], sources: [] }, promotions);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].eligible, true);
  assert.equal(result.projects[0].id, 'CENSUS::site:fixture');
  assert.equal(result.projects[0].loadMw, null);
  assert.equal(result.reviews[0].stage, null);
  assert.equal(result.reviews[0].sourceEvidence[0].sha256, 'a'.repeat(64));
  assert.deepEqual(promoteCensus(census(), result, result, promotions), result, 'repeated import preserves identity and yields identical output');
});
test('announced, operating, unsupported, and ambiguous candidates cannot silently enter scoring', () => {
  for (const status of ['announced', 'operating', 'unknown'] as const) {
    const data = census(); data.entities[0].status = status; data.entities[0].additiveStatus = 'not_active';
    assert.throws(() => promoteCensus(data, previous, { projects: [], sources: [] }, promotions), /confirmed active request/);
  }
  const unsupported = census(); unsupported.evidence[0].sha256 = null;
  assert.throws(() => promoteCensus(unsupported, previous, { projects: [], sources: [] }, promotions), /No acquired source/);
  const announced = census(); announced.entities[0].connectionBasis = 'announced'; announced.entities[0].additiveStatus = 'not_confirmed_connection';
  assert.throws(() => promoteCensus(announced, previous, { projects: [], sources: [] }, promotions), /confirmed active request/);
  const duplicate = census();
  duplicate.entities.push({ ...structuredClone(duplicate.entities[0]), id: 'site:other', rawRefIds: [], possibleDuplicateIds: ['site:fixture'], additiveStatus: 'possible_duplicate' });
  duplicate.entities[0].possibleDuplicateIds = ['site:other']; duplicate.entities[0].additiveStatus = 'possible_duplicate';
  assert.doesNotThrow(() => promoteCensus(duplicate, previous, { projects: [], sources: [] }, promotions), 'unscored support counterpart must not hide the confirmed named request');
  assert.throws(() => promoteCensus(duplicate, previous, { projects: [], sources: [] }, { ...promotions, items: [...promotions.items, { ...promotions.items[0], entityId: 'site:other' }] }), /Resolve duplicate/);
});
test('without a review decision the census cannot bulk-promote candidates', () => {
  const result = promoteCensus(census(), previous, { projects: [], sources: [] }, { ...promotions, items: [] });
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.reviews, []);
});
test('multiple identity and progress excerpts from one filing survive promotion', () => {
  const data = census();
  data.evidence.push({ ...data.evidence[0], id: 'e2', excerpt: 'The second passage documents the status of the grid studies.' });
  data.entities[0].evidenceIds.push('e2');
  const result = promoteCensus(data, previous, { projects: [], sources: [] }, promotions);
  assert.equal(result.reviews[0].sourceEvidence.length, 1);
  assert.match(result.reviews[0].sourceEvidence[0].excerpt, /single active|identified site/);
  assert.match(result.reviews[0].sourceEvidence[0].excerpt, /grid studies/);
  data.evidence.push({ ...data.evidence[0], id: 'reviewed:derived', excerpt: result.reviews[0].sourceEvidence[0].excerpt });
  data.entities[0].evidenceIds.push('reviewed:derived');
  assert.deepEqual(promoteCensus(data, result, result, promotions), result, 'a rebuilt census does not recursively duplicate its derived review quotes');
});
