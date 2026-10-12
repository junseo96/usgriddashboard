import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Project, Source } from '../shared/types.ts';
import type { LoadCoverageDataset } from '../shared/load-coverage.ts';
import type { LoadPipelineDataset, PipelineProject } from '../shared/market-types.ts';
import { buildLoadProjectCensus, type CensusBuildInput } from '../scripts/build-load-project-census.ts';
import { censusCsv, filterCensusEntities, parseCensusFilters, summarizeCensus, validateLoadProjectCensus, type CensusEntityInput, type CensusEvidence, type CensusFragment, type LoadProjectCensus } from '../shared/load-project-census.ts';

const source: Source = { id: 'fixture-register', name: 'Official fixture register', region: 'NYISO', types: ['load'], url: 'https://utility.example.org/register', coverage: 'full_register', sourceAsOf: '2026-09-01', lastCheckedAt: '2026-09-02', refreshCadence: 'monthly', recordCount: null, gaps: ['Fixture'], adapter: null };
const evidence: CensusEvidence = { id: 'review:official', name: 'Official campus case and utility service filing', url: 'https://puc.example.org/site-case', sourceFamily: 'puc', retrievedAt: '2026-09-05T00:00:00.000Z', sha256: 'a'.repeat(64), publishedAt: '2026-09-01', sourceAsOf: '2026-09-01', excerpt: 'The documents refer to the same single campus; its utility request is 100 MW.', limitations: ['Fixture only'] };
function project(id: string, override: Partial<Project> = {}): Project { return { id, sourceId: source.id, sourceRecordId: id, name: `Acme ${id}`, types: ['load'], region: 'NYISO', state: 'NY', status: 'active', generationMw: null, storageMw: null, loadMw: 100, capacityStatus: 'known', eligible: true, exclusionReason: null, sourceUrl: source.url, sourceAsOf: '2026-09-01', rawStatus: 'Active service request', identityScope: 'source_record', ...override }; }
function pipelineProject(id: string, override: Partial<PipelineProject> = {}): PipelineProject { return { id, name: `Acme ${id}`, region: 'NYISO', state: 'NY', sector: 'data_center', classification: 'application', status: 'active', capacityMw: 100, capacityBasis: 'requested_grid_mw', sourceName: 'Official application', sourceUrl: 'https://puc.example.org/' + id, sourceAsOf: '2026-09-01', checkedAt: '2026-09-02', evidence: 'The named site filed one 100 MW service request.', caveats: ['Fixture'], linkedProjectId: null, ...override }; }
function input(projects: Project[] = [], pipeline: PipelineProject[] = []): CensusBuildInput {
  const coverage: LoadCoverageDataset = { schemaVersion: 1, generatedAt: '2026-10-01T00:00:00.000Z', sources: [], universe: { year: 2025, sourceIds: [], scope: 'EIA reporter fixture, not projects', limitations: [], utilities: [1, 2, 3].map(id => ({ id: `eia861:${id}`, name: 'Reporting organization ' + id, states: ['NY'], forms: ['861'], roles: [], geographicScope: 'mainland', mainlandStates: ['NY'], serviceTypes: [], sourceEvidence: [], regions: ['NYISO'], associations: [], notes: [] })) }, rosters: [], evidence: [], regions: [], limitations: [] };
  const loadPipeline: LoadPipelineDataset = { schemaVersion: 1, generatedAt: '2026-10-01T00:00:00.000Z', projects: pipeline, aggregates: [], limitations: [] };
  return { bootstrap: { projects, sources: [source] }, pipeline: loadPipeline, coverage, fragments: [] };
}
function fragment(entities: CensusEntityInput[]): CensusFragment { return { schemaVersion: 1, id: 'fixture-review', generatedAt: '2026-10-02T00:00:00.000Z', evidence: [evidence], entities, decisions: [], attempts: [], limitations: ['Partial research fixture'] }; }
function site(id: string, override: Partial<CensusEntityInput> = {}): CensusEntityInput { return { id, name: 'Acme campus', region: 'NYISO', state: 'NY', kind: 'site', customer: 'Acme', utility: 'Utility A', utilityIds: ['eia861:1'], location: '1 River Road', status: 'application', asOf: '2026-09-01', connectionBasis: 'confirmed_request', rawRefIds: [], evidenceIds: [evidence.id], capacityFacts: [{ id: id + ':mw', value: 100, unit: 'MW', basis: 'requested_grid', scope: 'entity', asOf: '2026-09-01', evidenceIds: [evidence.id], note: 'Explicit grid service request for this site.' }], aliases: [], relatedSupportRecordIds: [], possibleDuplicateIds: [], parentEntityId: null, scoreProjectId: null, limitations: [], ...override }; }

test('four documents become one canonical entity only through an explicit evidenced same-site decision', () => {
  const data = input([project('a'), project('b'), project('c')], [pipelineProject('d')]);
  const refs = ['bootstrap:a', 'bootstrap:b', 'bootstrap:c', 'pipeline:d'];
  const f = fragment([site('site:acme', { rawRefIds: refs })]); data.fragments = [f];
  assert.throws(() => buildLoadProjectCensus(data), /explicit same_entity/);
  f.decisions.push({ id: 'decision:acme-campus', kind: 'same_entity', entityIds: ['site:acme', 'request:a', 'request:b', 'request:c', 'development:d'], rawRefIds: refs, evidenceIds: [evidence.id], reason: 'Docket site address and parcel identify one campus across all four filings.' });
  const result = buildLoadProjectCensus(data);
  assert.equal(result.entities.length, 1); assert.equal(result.rawRecords.length, 4); assert.equal(result.entityAliases.length, 4);
  assert.equal(result.entities[0].capacityFacts.length, 5); assert.equal(result.entities[0].knownGridMw, 100, 'Repeated documents do not add request MW');
  assert.equal(summarizeCensus(result).knownGridMw, 100); assert.equal(summarizeCensus(result).additiveEntityCount, 1);
  assert.equal(result.rawRecords.find(r => r.id === 'bootstrap:b')!.payload.sourceRecordId, 'b');
  assert.ok(result.entityAliases.every(a => a.canonicalId === 'site:acme' && a.decisionId === 'decision:acme-campus'));
  assert.deepEqual(buildLoadProjectCensus(data), result, 'Deterministic and nonmutating');
});

test('same company at different locations stays distinct; suspected duplicates retain both records but no additive MW', () => {
  const data = input(); const f = fragment([site('site:north'), site('site:south', { location: '99 South Road' })]); data.fragments = [f];
  const separate = buildLoadProjectCensus(data); assert.equal(separate.entities.length, 2); assert.equal(summarizeCensus(separate).knownGridMw, 200);
  assert.equal(separate.decisions.length, 0, 'Company name equality does not merge physical sites');
  f.decisions.push({ id: 'decision:suspect', kind: 'possible_duplicate', entityIds: ['site:north', 'site:south'], rawRefIds: [], evidenceIds: [evidence.id], reason: 'Both records may describe a relocated proposal; parcel linkage is not verified.' });
  const ambiguous = buildLoadProjectCensus(data); assert.equal(ambiguous.entities.length, 2); assert.equal(summarizeCensus(ambiguous).knownGridMw, null);
  assert.equal(summarizeCensus(ambiguous).possibleDuplicateCount, 2); assert.ok(ambiguous.entities.every(e => e.additiveStatus === 'possible_duplicate'));
});

test('conflicting request/contract MW becomes unknown; IT, site power, generation and MVA stay separate facts', () => {
  const entity = site('site:conflict');
  entity.capacityFacts!.push({ ...entity.capacityFacts![0], id: 'contract', basis: 'contracted_grid', value: 80 }, { ...entity.capacityFacts![0], id: 'it', basis: 'it_power', value: 1000 }, { ...entity.capacityFacts![0], id: 'mva', value: 600, unit: 'MVA' });
  const data = input(); data.fragments = [fragment([entity])];
  const result = buildLoadProjectCensus(data); assert.equal(result.entities[0].knownGridMw, null); assert.equal(result.entities[0].capacityConflict, true); assert.equal(summarizeCensus(result).knownGridMw, null);
  entity.capacityFacts!.splice(1, 1);
  const resolved = buildLoadProjectCensus(data); assert.equal(resolved.entities[0].knownGridMw, 100); assert.equal(resolved.entities[0].capacityFacts.length, 3);
  entity.capacityFacts![0].value = null; const noGrid = buildLoadProjectCensus(data); assert.equal(noGrid.entities[0].knownGridMw, null);
});

test('an expansion remains traceable without adding its MW to its parent campus total', () => {
  const parent = site('campus:parent', { kind: 'campus' }), child = site('site:phase2');
  parent.capacityFacts![0].value = 1000; parent.capacityFacts![0].scope = 'campus'; child.capacityFacts![0].value = 300; child.capacityFacts![0].scope = 'phase';
  const f = fragment([parent, child]); f.decisions.push({ id: 'decision:phase2', kind: 'expansion_of', entityIds: ['site:phase2', 'campus:parent'], rawRefIds: [], evidenceIds: [evidence.id], reason: 'Phase 2 is included in the disclosed campus total.' });
  const data = input(); data.fragments = [f]; const result = buildLoadProjectCensus(data);
  assert.equal(summarizeCensus(result).knownGridMw, 1000); assert.equal(summarizeCensus(result).expansionCount, 1); assert.equal(result.entities.find(e => e.id === 'site:phase2')!.knownGridMw, 300);
});

test('source-record links enrich one entity automatically while transmission and historical orphans stay raw', () => {
  const support = project('support', { sourceId: 'pjm-m3-support', eligible: false, status: 'reference', exclusionReason: 'Transmission support, unidentified customer' });
  const history = project('history', { sourceId: 'spp-dpa-history', eligible: false, status: 'reference', exclusionReason: 'Historical assessment' });
  const data = input([project('a'), support, history], [pipelineProject('a-copy', { linkedProjectId: 'a' }), pipelineProject('support-copy', { linkedProjectId: 'support', classification: 'grid_support' })]);
  data.bootstrap.sources.push({ ...source, id: support.sourceId }, { ...source, id: history.sourceId });
  data.fragments = [fragment([{ id: 'site:renamed', rawRefIds: ['bootstrap:a', 'pipeline:a-copy'], name: 'Reviewed single site', evidenceIds: [evidence.id] }])];
  const result = buildLoadProjectCensus(data); assert.equal(result.entities.length, 1); assert.equal(result.rawRecords.length, 5); assert.equal(summarizeCensus(result).unassignedRawRecordCount, 3);
  assert.ok(result.decisions.some(d => d.origin === 'exact_source_record')); assert.equal(result.entityAliases[0].aliasId, 'request:a');
  assert.ok(result.rawRecords.filter(r => r.kind === 'transmission_support' || r.kind === 'historical').every(r => r.entityId === null));
});

test('publisher classification uses the original artifact identity or regulator hostname, never a company release path', () => {
  const companyUrl = 'https://investors.company.example/news/kentucky-psc-approves-power-contract';
  const data = input([
    project('company-release', { sourceId: 'miso-contracts', sourceUrl: companyUrl }),
    project('regulator-order', { sourceId: 'miso-contracts', sourceUrl: 'https://psc.ky.gov/orders/site-case.pdf' }),
  ]);
  const result = buildLoadProjectCensus(data);
  assert.equal(result.evidence.find(e => e.url === companyUrl)!.sourceFamily, 'customer');
  assert.equal(result.evidence.find(e => e.url.startsWith('https://psc.ky.gov/'))!.sourceFamily, 'puc');

  const sourceUrl = 'https://filings.utility.example/customer-contract.pdf';
  const original = { ...evidence, id: 'original-utility-document', url: sourceUrl, sourceFamily: 'utility' as const };
  const acquired = input([project('utility-document', { sourceId: 'utility-contracts', sourceUrl })]);
  acquired.bootstrap.provenance = { sourceRefreshes: [{ sourceId: 'utility-contracts', sourceUrl, sourceSha256: original.sha256!, retrievedAt: original.retrievedAt! }] };
  acquired.fragments = [{ ...fragment([]), evidence: [original] }];
  const classified = () => buildLoadProjectCensus(acquired).evidence.find(e => e.id.startsWith('legacy-source:'))!.sourceFamily;
  assert.equal(classified(), 'utility', 'An exact original artifact preserves its reviewed publisher type');
  acquired.bootstrap.provenance.sourceRefreshes![0].sourceSha256 = 'b'.repeat(64);
  assert.equal(classified(), 'customer', 'The same URL with a different artifact hash cannot inherit classification');
  acquired.bootstrap.provenance.sourceRefreshes![0].sourceSha256 = original.sha256!;
  acquired.fragments[0].evidence.push({ ...original, id: 'conflicting-original-review', sourceFamily: 'customer' });
  assert.equal(classified(), 'customer', 'Conflicting original classifications fall back instead of picking one');
});

test('survey denominator is EIA reporting organizations, and roster/reference inclusion is never a website visit', () => {
  const data = input([project('a'), project('b')]); const f = fragment([]); data.fragments = [f];
  let result = buildLoadProjectCensus(data); assert.equal(result.survey.utilities.length, 3); assert.equal(summarizeCensus(result).entityCount, 2); assert.equal(summarizeCensus(result).survey.attemptedUtilityCount, 0); assert.equal(summarizeCensus(result).survey.queuedUtilityCount, 3);
  f.attempts.push({ id: 'attempt:one-puc-document', organization: 'Utility A', utilityIds: ['eia861:1'], region: 'NYISO', sourceFamily: 'puc', url: evidence.url, status: 'reviewed', checkedAt: '2026-09-05T00:00:00.000Z', evidenceIds: [evidence.id], notes: ['Reviewed the document, not all customer applications.'] });
  result = buildLoadProjectCensus(data); assert.equal(summarizeCensus(result).survey.reviewedUtilityCount, 1); assert.equal(summarizeCensus(result).survey.utilityCount, 3); assert.equal(result.survey.utilities[0].familyStatus.utility, 'queued'); assert.equal(result.survey.utilities[0].familyStatus.puc, 'reviewed');
  const bad = structuredClone(result); bad.survey.utilities[1].attemptIds.push('missing-attempt'); assert.throws(() => validateLoadProjectCensus(bad), /survey utility/);
  const fabricated = structuredClone(result); fabricated.survey.utilities[1].familyStatus.utility = 'reviewed'; assert.throws(() => validateLoadProjectCensus(fabricated), /actual linked attempt/);
});

test('promoting a canonical entity to the score register and rebuilding adds a source record, not another entity', () => {
  const data = input(); data.fragments = [fragment([site('site:promoted')])];
  const before = buildLoadProjectCensus(data); assert.equal(before.entities.length, 1);
  data.bootstrap.projects.push(project('CENSUS::site:promoted', { sourceRecordId: 'site:promoted' }));
  data.pipeline.projects.push(pipelineProject('promoted-copy', { linkedProjectId: 'CENSUS::site:promoted' }));
  const after = buildLoadProjectCensus(data); assert.equal(after.entities.length, 1); assert.equal(after.entities[0].scoreProjectId, 'CENSUS::site:promoted'); assert.equal(after.entities[0].rawRefIds.length, 3); assert.equal(summarizeCensus(after).knownGridMw, 100);
  assert.ok(after.decisions.some(d => d.id === 'exact-promoted:CENSUS::site:promoted'));
});

test('filters and formula-safe CSV preserve unknown capacity, decisions and original proof', () => {
  const data = input(); const entity = site('site:formula', { name: '=HYPERLINK("https://bad.example")', capacityFacts: [], status: 'announced', connectionBasis: 'announced' }); data.fragments = [fragment([entity])];
  const result = buildLoadProjectCensus(data), filters = parseCensusFilters(new URLSearchParams('region=NYISO&sourceFamily=puc&status=announced&q=HYPERLINK'));
  assert.equal(filterCensusEntities(result, filters).length, 1); assert.equal(filterCensusEntities(result, { connectionBasis: 'confirmed_request' }).length, 0);
  const csv = censusCsv(result, filters); assert.ok(csv.includes('"\'=HYPERLINK')); assert.ok(csv.includes('""')); assert.ok(csv.includes(evidence.sha256!)); assert.ok(csv.includes(evidence.url)); assert.ok(!csv.includes('NaN'));
  assert.throws(() => parseCensusFilters(new URLSearchParams('status=completed')), /Invalid census status/);
  const bad = structuredClone(result); bad.entities[0].knownGridMw = 100; assert.throws(() => validateLoadProjectCensus(bad), /derived capacity/);
});

test('published census preserves every bootstrap/pipeline raw row and all EIA reporters with verifiable input hashes', () => {
  const census = JSON.parse(readFileSync(new URL('../data/load-project-census.json', import.meta.url), 'utf8')) as LoadProjectCensus;
  validateLoadProjectCensus(census);
  const bootstrap = JSON.parse(readFileSync(new URL('../data/bootstrap.json', import.meta.url), 'utf8')) as { projects: Project[] };
  const pipeline = JSON.parse(readFileSync(new URL('../public/data/load-pipeline.json', import.meta.url), 'utf8')) as LoadPipelineDataset;
  const coverage = JSON.parse(readFileSync(new URL('../data/load-coverage.json', import.meta.url), 'utf8')) as LoadCoverageDataset;
  const raw = new Map(census.rawRecords.map(row => [row.id, row]));
  const loads = bootstrap.projects.filter(p => p.types.includes('load'));
  assert.equal(census.rawRecords.filter(r => r.inputCollection === 'bootstrap').length, loads.length);
  assert.equal(census.rawRecords.filter(r => r.inputCollection === 'pipeline').length, pipeline.projects.length);
  for (const project of loads) assert.deepEqual(raw.get('bootstrap:' + project.id)?.payload, project);
  for (const project of pipeline.projects) assert.deepEqual(raw.get('pipeline:' + project.id)?.payload, project);
  assert.deepEqual(census.survey.utilities.map(u => u.id).sort(), coverage.universe.utilities.map(u => u.id).sort());
  for (const manifest of census.inputs) {
    const bytes = readFileSync(new URL('../' + manifest.path, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256, `Changed census input ${manifest.path}; rebuild required`);
  }
  assert.ok(census.rawRecords.some(row => row.kind === 'historical' && row.entityId === null));
  assert.ok(census.rawRecords.some(row => row.kind === 'transmission_support' && row.entityId === null));
  const originals = new Map<string, Set<string>>();
  for (const manifest of census.inputs.filter(item => item.id.startsWith('fragment:'))) {
    const part = JSON.parse(readFileSync(new URL('../' + manifest.path, import.meta.url), 'utf8')) as CensusFragment;
    for (const evidence of part.evidence) if (evidence.sha256) {
      const key = evidence.url + ':' + evidence.sha256;
      const families = originals.get(key) ?? new Set<string>(); families.add(evidence.sourceFamily); originals.set(key, families);
    }
  }
  for (const evidence of census.evidence.filter(e => e.id.startsWith('reviewed:'))) {
    const families = originals.get(evidence.url + ':' + evidence.sha256);
    if (families?.size === 1) assert.equal(evidence.sourceFamily, [...families][0], `Reviewed artifact changed publisher classification: ${evidence.url}`);
  }
  const companyRelease = census.evidence.filter(e => e.url.includes('terawulf.com/') && e.url.includes('kentucky-psc-approves'));
  assert.ok(companyRelease.length > 0); assert.ok(companyRelease.every(e => e.sourceFamily === 'customer'));
});
