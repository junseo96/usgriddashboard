/** Facility development inventory. Inclusion never implies a verified ISO service request.
 * Historical queries reconstruct available status/facts using today's reviewed physical identity;
 * they do not recreate the historical count of source rows before later deduplication decisions.
 */
import type { Gate } from './types.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from './time.ts';

export const FACILITY_MODEL_VERSION = 'facility-development-v1';
export const FACILITY_SECTORS = ['data_center', 'semiconductor', 'battery', 'vehicle', 'steel', 'aluminum', 'hydrogen', 'manufacturing', 'other_industrial'] as const;
export type FacilitySector = typeof FACILITY_SECTORS[number];
export type FacilityLifecycle = 'planned' | 'construction' | 'operating' | 'paused' | 'cancelled' | 'unknown';
export type FacilityCapacityMeasure = 'requested_grid' | 'contracted_grid' | 'facility_power' | 'it_power' | 'onsite_generation' | 'unknown';
export interface FacilitySource { id: string; name: string; url: string; retrievedAt: string; sha256: string; publishedAt: string | null; sourceAsOf: string | null; excerpt: string; }
export interface FacilityCapacityFact { id: string; value: number | null; unit: 'MW' | 'MVA'; measure: FacilityCapacityMeasure; scope: 'facility' | 'campus' | 'phase'; asOf: string | null; sourceIds: string[]; note: string; }
export interface FacilityEvent { id: string; date: string; status: FacilityLifecycle; sourceIds: string[]; note: string; }
export interface FacilityGridEvidence { id: string; kind: 'application' | 'study' | 'contract' | 'energized' | 'permit' | 'unknown'; date: string | null; sourceIds: string[]; note: string; }
export interface FacilityObservationIdentity { name: string; operator: string | null; sector: FacilitySector; region: string; regionBasis?: 'reported' | 'geographic_estimate' | 'unknown'; state: string | null; city: string | null; county: string | null; lat: number | null; lon: number | null; identityKind: 'campus' | 'facility' | 'phase'; aliases: string[]; legacyProjectIds: string[]; }
export interface FacilityObservation { id: string; originId?: string; evidenceOnly?: boolean; identity?: FacilityObservationIdentity; observedAt: string; lifecycle: FacilityLifecycle; asOf: string | null; sourceIds: string[]; capacityFacts: FacilityCapacityFact[]; gridEvidence: FacilityGridEvidence[]; }
export interface LargeLoadFacility {
  id: string; name: string; operator: string | null; sector: FacilitySector; region: string; regionBasis?: 'reported' | 'geographic_estimate' | 'unknown'; state: string | null; county: string | null; city: string | null;
  lat: number | null; lon: number | null; identityKind: 'campus' | 'facility' | 'phase'; parentId: string | null;
  lifecycle: FacilityLifecycle; asOf: string | null; sourceIds: string[]; capacityFacts: FacilityCapacityFact[]; events: FacilityEvent[]; gridEvidence: FacilityGridEvidence[];
  aliases: string[]; legacyProjectIds: string[]; notes: string[]; possibleDuplicateIds?: string[]; observations?: FacilityObservation[];
}
export interface FacilityJurisdiction {
  id: string; name: string; states: string[]; regions: string[]; sectors: FacilitySector[]; effectiveFrom: string | null; effectiveTo: string | null;
  sourceIds: string[]; procedures: Array<{ gate: Gate; requirement: string }>; limitations: string[];
}
export interface FacilityJurisdictionDataset { schemaVersion: 1; generatedAt: string; sources: FacilitySource[]; rules: FacilityJurisdiction[]; limitations: string[]; }
export interface FacilityDecision { id: string; kind: 'same_entity' | 'possible_duplicate' | 'part_of'; facilityIds: string[]; sourceIds: string[]; reason: string; }
export interface FacilityFragment { schemaVersion: 1; id: string; generatedAt: string; sources: FacilitySource[]; facilities: LargeLoadFacility[]; enrichmentOnlyFacilityIds?: string[]; limitations: string[]; }
export interface FacilityDataset {
  schemaVersion: 1; generatedAt: string; sources: FacilitySource[]; facilities: LargeLoadFacility[]; jurisdictions: FacilityJurisdiction[];
  decisions: FacilityDecision[]; inputs: Array<{ id: string; path: string; sha256: string }>; limitations: string[];
}
export interface FacilityFilters { q?: string; region?: string; state?: string; sector?: FacilitySector | 'all'; lifecycle?: FacilityLifecycle | 'all'; scoreBasis?: FacilityScore['basis'] | 'all'; asOf?: string; knownAt?: string; includeUnknownPrior?: boolean; }
export interface FacilityScore {
  point: number | null; range: [number, number] | null; gates: Array<{ gate: Gate; label: string; points: number; progress: number; assumption: string }>;
  confidence: 'high' | 'medium' | 'low' | null; basis: 'lifecycle' | 'grid_evidence' | 'jurisdiction_prior' | 'conservative_prior' | 'unassessed'; modelId: string | null;
  rationale: string; assumptions: string[]; sourceIds: string[]; jurisdictionIds: string[]; lifecycle: FacilityLifecycle; asOf: string | null; evaluatedAt: string;
  eligibleForAverage: boolean; exclusionReason: string | null;
}
export interface FacilitySummary {
  identityScope: 'current_reviewed_identity';
  facilityCount: number; developmentCount: number; operatingCount: number; pausedCount: number; cancelledCount: number; unknownCount: number;
  scoredCount: number; averageCount: number; mean: number | null; meanRange: [number, number] | null; priorCount: number; lifecycleCount: number; gridEvidenceCount: number; unassessedCount: number;
  linkedProjectCount: number; possibleDuplicateCount: number; phaseCount: number;
  byLifecycle: Record<string, number>; byRegion: Record<string, number>; bySector: Record<string, number>;
  capacityByMeasure: Record<FacilityCapacityMeasure, { mw: number | null; knownCount: number; conflictCount: number }>;
}
export interface FacilityHistoryPoint { date: string; lifecycle: FacilityLifecycle; score: FacilityScore; sourceIds: string[]; knownAt: string; }

const GATES: Gate[] = ['technical', 'commercial', 'permitting', 'construction', 'energization'];
const LABELS = ['기술 검토', '계약·비용', '부지·인허가', '설비·계통 보강', '통전·운영'];
const LIFECYCLES: FacilityLifecycle[] = ['planned', 'construction', 'operating', 'paused', 'cancelled', 'unknown'];
const MEASURES: FacilityCapacityMeasure[] = ['requested_grid', 'contracted_grid', 'facility_power', 'it_power', 'onsite_generation', 'unknown'];
const REGIONS = ['PJM', 'ERCOT', 'MISO', 'CAISO', 'NYISO', 'ISO-NE', 'SPP', 'Southeast', 'West', 'Unknown'];
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x);
const texts = (x: unknown): x is string[] => Array.isArray(x) && x.every(text) && new Set(x).size === x.length;
const nullableText = (x: unknown) => x === null || text(x);
const instant = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(x) && isCalendarDay(x.slice(0, 10)) && Number.isFinite(Date.parse(x));
const day = (x: unknown): x is string | null => x === null || typeof x === 'string' && isCalendarDay(x);
const sourceDay = (x: unknown): x is string | null => day(x) || typeof x === 'string' && (/^\d{4}$/.test(x) || /^\d{4}-(0[1-9]|1[0-2])$/.test(x));
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Large load facilities: ' + reason); }
export function facilityCanonicalJson(x: unknown): string { if (Array.isArray(x)) return '[' + x.map(facilityCanonicalJson).join(',') + ']'; if (object(x)) return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + facilityCanonicalJson(x[k])).join(',') + '}'; return JSON.stringify(x); }
function https(value: unknown): boolean { try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname; } catch { return false; } }
const SOURCE_INDEX = new WeakMap<Pick<FacilityDataset, 'sources'>, Map<string, FacilitySource>>();
function sourceMap(data: Pick<FacilityDataset, 'sources'>): Map<string, FacilitySource> { let result = SOURCE_INDEX.get(data); if (!result) { result = new Map(data.sources.map(s => [s.id, s])); SOURCE_INDEX.set(data, result); } return result; }
function validateSources(sources: FacilitySource[], generatedAt: string): Map<string, FacilitySource> {
  check(Array.isArray(sources), 'sources required'); const result = new Map<string, FacilitySource>();
  for (const s of sources) {
    check(object(s) && text(s.id) && !result.has(s.id) && text(s.name) && https(s.url) && /^[a-f0-9]{64}$/.test(s.sha256) && text(s.excerpt), 'source identity, secure URL, SHA or excerpt');
    check(instant(s.retrievedAt) && Date.parse(s.retrievedAt) <= Date.parse(generatedAt) && sourceDay(s.publishedAt) && sourceDay(s.sourceAsOf), 'source dates');
    check([s.publishedAt, s.sourceAsOf].every(d => d === null || d <= calendarDayKst(s.retrievedAt)), 'source date after retrieval'); result.set(s.id, s);
  } return result;
}
function refs(ids: string[], sources: Map<string, FacilitySource>, label: string): void { check(texts(ids) && ids.length > 0 && ids.every(id => sources.has(id)), 'missing source reference: ' + label); }
function validateFacilities(facilities: LargeLoadFacility[], sources: Map<string, FacilitySource>, generatedAt: string, complete: boolean): void {
  check(Array.isArray(facilities), 'facilities required'); const ids = new Set<string>(); const cutoff = calendarDayKst(generatedAt);
  for (const f of facilities) {
    check(object(f) && text(f.id) && !ids.has(f.id) && text(f.name), 'duplicate/missing facility identity'); ids.add(f.id);
    check(nullableText(f.operator) && FACILITY_SECTORS.includes(f.sector) && REGIONS.includes(f.region) && (f.state === null || STATES.has(f.state)) && nullableText(f.county) && nullableText(f.city), 'facility geography or sector: ' + f.id);
    check(f.regionBasis === undefined || ['reported', 'geographic_estimate', 'unknown'].includes(f.regionBasis), 'region basis');
    check((f.lat === null || Number.isFinite(f.lat) && f.lat >= -90 && f.lat <= 90) && (f.lon === null || Number.isFinite(f.lon) && f.lon >= -180 && f.lon <= 180) && (f.lat === null) === (f.lon === null), 'coordinates must be a valid pair');
    check(['campus', 'facility', 'phase'].includes(f.identityKind) && nullableText(f.parentId) && f.parentId !== f.id && LIFECYCLES.includes(f.lifecycle) && day(f.asOf) && (!f.asOf || f.asOf <= cutoff), 'facility identity/status dates');
    check(texts(f.aliases) && texts(f.legacyProjectIds) && texts(f.notes) && (f.possibleDuplicateIds === undefined || texts(f.possibleDuplicateIds) && !f.possibleDuplicateIds.includes(f.id)), 'facility aliases/notes: ' + f.id); refs(f.sourceIds, sources, f.id);
    const validateFacts = (facts: FacilityCapacityFact[]) => { const factIds = new Set<string>(); check(Array.isArray(facts), 'capacity facts'); for (const c of facts) {
      check(text(c.id) && !factIds.has(c.id) && (c.value === null || Number.isFinite(c.value) && c.value >= 0) && ['MW', 'MVA'].includes(c.unit) && MEASURES.includes(c.measure) && ['facility', 'campus', 'phase'].includes(c.scope) && day(c.asOf) && (!c.asOf || c.asOf <= cutoff) && text(c.note), 'capacity fact: ' + f.id); refs(c.sourceIds, sources, c.id); factIds.add(c.id);
      check(c.asOf === null || c.sourceIds.some(id => c.asOf! <= calendarDayKst(sources.get(id)!.retrievedAt)), 'capacity fact after supporting source acquisition');
    } };
    const validateGrid = (items: FacilityGridEvidence[]) => { const itemIds = new Set<string>(); check(Array.isArray(items), 'grid evidence'); for (const e of items) {
      check(text(e.id) && !itemIds.has(e.id) && ['application', 'study', 'contract', 'energized', 'permit', 'unknown'].includes(e.kind) && day(e.date) && (!e.date || e.date <= cutoff) && text(e.note), 'grid evidence: ' + f.id); refs(e.sourceIds, sources, e.id); itemIds.add(e.id);
      check(e.date === null || e.sourceIds.some(id => e.date! <= calendarDayKst(sources.get(id)!.retrievedAt)), 'grid fact after supporting source acquisition');
    } };
    validateFacts(f.capacityFacts); validateGrid(f.gridEvidence);
    check(Array.isArray(f.events), 'events'); const eventIds = new Set<string>(); for (const e of f.events) {
      check(text(e.id) && !eventIds.has(e.id) && isCalendarDay(e.date) && e.date <= cutoff && LIFECYCLES.includes(e.status) && text(e.note), 'actual milestone event/date: ' + f.id); refs(e.sourceIds, sources, e.id); eventIds.add(e.id);
      check(e.sourceIds.some(id => e.date <= calendarDayKst(sources.get(id)!.retrievedAt)), 'future target cannot be a milestone event');
    }
    const observationIds = new Set<string>(); for (const o of f.observations ?? []) {
      check(text(o.id) && !observationIds.has(o.id) && instant(o.observedAt) && Date.parse(o.observedAt) <= Date.parse(generatedAt) && LIFECYCLES.includes(o.lifecycle) && day(o.asOf) && (!o.asOf || o.asOf <= calendarDayKst(o.observedAt)), 'facility observation');
      check(o.evidenceOnly === undefined || typeof o.evidenceOnly === 'boolean', 'observation evidence-only classification');
      if (o.identity) check(text(o.identity.name) && nullableText(o.identity.operator) && FACILITY_SECTORS.includes(o.identity.sector) && REGIONS.includes(o.identity.region) && (o.identity.state === null || STATES.has(o.identity.state)) && nullableText(o.identity.city) && nullableText(o.identity.county) && ['campus', 'facility', 'phase'].includes(o.identity.identityKind) && texts(o.identity.aliases) && texts(o.identity.legacyProjectIds), 'observation identity');
      refs(o.sourceIds, sources, o.id); check(o.sourceIds.every(id => Date.parse(sources.get(id)!.retrievedAt) <= Date.parse(o.observedAt)), 'observation before source acquisition'); validateFacts(o.capacityFacts); validateGrid(o.gridEvidence); observationIds.add(o.id);
    }
  }
  if (complete) for (const f of facilities) {
    check(f.parentId === null || ids.has(f.parentId), 'missing parent: ' + f.id); check((f.possibleDuplicateIds ?? []).every(id => ids.has(id)), 'missing possible duplicate');
    const seen = new Set([f.id]); let p = f.parentId; while (p) { check(!seen.has(p), 'parent cycle'); seen.add(p); p = facilities.find(x => x.id === p)!.parentId; }
  }
}
function validateRules(rules: FacilityJurisdiction[], sources: Map<string, FacilitySource>): void {
  check(Array.isArray(rules), 'jurisdiction rules'); const ids = new Set<string>(); for (const r of rules) {
    check(text(r.id) && !ids.has(r.id) && text(r.name) && texts(r.states) && r.states.every(s => STATES.has(s)) && texts(r.regions) && r.regions.every(s => REGIONS.includes(s) && s !== 'Unknown') && (r.states.length || r.regions.length) && texts(r.sectors) && r.sectors.every(s => FACILITY_SECTORS.includes(s)), 'jurisdiction scope');
    check(day(r.effectiveFrom) && day(r.effectiveTo) && (!r.effectiveFrom || !r.effectiveTo || r.effectiveFrom <= r.effectiveTo) && texts(r.limitations), 'jurisdiction effective dates'); refs(r.sourceIds, sources, r.id);
    check(Array.isArray(r.procedures) && r.procedures.length > 0 && new Set(r.procedures.map(p => p.gate)).size === r.procedures.length && r.procedures.every(p => GATES.includes(p.gate) && text(p.requirement)), 'jurisdiction procedures'); ids.add(r.id);
  }
}
export function validateFacilityFragment(input: unknown, now = new Date()): asserts input is FacilityFragment {
  check(object(input) && input.schemaVersion === 1 && text(input.id) && instant(input.generatedAt) && Date.parse(input.generatedAt) <= now.getTime() && texts(input.limitations), 'fragment header'); const f = input as unknown as FacilityFragment;
  validateFacilities(f.facilities, validateSources(f.sources, f.generatedAt), f.generatedAt, false);
  check(f.enrichmentOnlyFacilityIds === undefined || texts(f.enrichmentOnlyFacilityIds) && f.enrichmentOnlyFacilityIds.every(id => f.facilities.some(row => row.id === id)), 'enrichment IDs must reference this fragment');
}
export function validateFacilityJurisdictions(input: unknown, now = new Date()): asserts input is FacilityJurisdictionDataset {
  check(object(input) && input.schemaVersion === 1 && instant(input.generatedAt) && Date.parse(input.generatedAt) <= now.getTime() && texts(input.limitations), 'jurisdiction dataset header'); const d = input as unknown as FacilityJurisdictionDataset; validateRules(d.rules, validateSources(d.sources, d.generatedAt));
}
export function validateLargeLoadFacilities(input: unknown, now = new Date()): asserts input is FacilityDataset {
  check(object(input) && input.schemaVersion === 1 && instant(input.generatedAt) && Date.parse(input.generatedAt) <= now.getTime() && texts(input.limitations), 'dataset header'); const d = input as unknown as FacilityDataset;
  const sources = validateSources(d.sources, d.generatedAt); validateFacilities(d.facilities, sources, d.generatedAt, true); validateRules(d.jurisdictions, sources);
  check(Array.isArray(d.inputs) && new Set(d.inputs.map(x => x.id)).size === d.inputs.length && d.inputs.every(x => text(x.id) && text(x.path) && /^[a-f0-9]{64}$/.test(x.sha256)), 'input manifest');
  check(Array.isArray(d.decisions), 'identity decisions'); const decisionIds = new Set<string>(); for (const x of d.decisions) { check(text(x.id) && !decisionIds.has(x.id) && ['same_entity', 'possible_duplicate', 'part_of'].includes(x.kind) && texts(x.facilityIds) && x.facilityIds.length >= 2 && texts(x.sourceIds) && x.sourceIds.length > 0 && x.sourceIds.every(id => sources.has(id)) && text(x.reason), 'identity decision requires actual source evidence'); decisionIds.add(x.id); }
}

function queryCutoff(query: FacilityFilters): string | null {
  if (query.asOf !== undefined && !isCalendarDay(query.asOf)) throw new Error('Invalid facility asOf day');
  if (query.knownAt === undefined) return null;
  if (isCalendarDay(query.knownAt)) return endOfKstDay(query.knownAt);
  if (!instant(query.knownAt)) throw new Error('Invalid facility knownAt'); return query.knownAt;
}
function visibleSources(ids: string[], sources: Map<string, FacilitySource>, cutoff: string | null): boolean { return ids.some(id => { const s = sources.get(id); return s && (!cutoff || Date.parse(s.retrievedAt) <= Date.parse(cutoff)); }); }
/** A dated milestone and the time its source was acquired are independent cutoffs. */
function selectedFacility(data: FacilityDataset, facility: LargeLoadFacility, query: FacilityFilters): LargeLoadFacility {
  const cutoff = queryCutoff(query), sources = sourceMap(data);
  const observations = new Map<string, FacilityObservation>();
  const knownObservations = [...facility.observations ?? []].filter(o => !cutoff || Date.parse(o.observedAt) <= Date.parse(cutoff)).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  for (const o of knownObservations) observations.set(o.originId ?? o.id.split(':observation:')[0], o);
  const snapshots = [...observations.values()], observed = snapshots.filter(o => !o.evidenceOnly).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || (a.asOf ?? '').localeCompare(b.asOf ?? '') || a.id.localeCompare(b.id)).at(-1);
  // Enrichment may carry a copied primary snapshot. Its exact fact IDs remain owned
  // by the primary origin, including later corrections/removals. Distinct reviewed
  // fact IDs supplement it; no historical observations or raw assertions are deleted.
  const primaryCapacityIds = new Set(knownObservations.filter(o => !o.evidenceOnly).flatMap(o => o.capacityFacts).filter(c => !query.asOf || c.asOf !== null && c.asOf <= query.asOf).map(c => c.id));
  const primaryGridIds = new Set(knownObservations.filter(o => !o.evidenceOnly).flatMap(o => o.gridEvidence).filter(e => !query.asOf || e.date !== null && e.date <= query.asOf).map(e => e.id));
  const capacities = (o: FacilityObservation) => o.capacityFacts.filter(c => !o.evidenceOnly || !primaryCapacityIds.has(c.id));
  const gridFacts = (o: FacilityObservation) => o.gridEvidence.filter(e => !o.evidenceOnly || !primaryGridIds.has(e.id));
  let result = observed ? { ...facility, ...(cutoff ? observed.identity : {}), lifecycle: observed.lifecycle, asOf: observed.asOf, sourceIds: observed.sourceIds,
    capacityFacts: snapshots.flatMap(capacities), gridEvidence: snapshots.flatMap(gridFacts) } : { ...facility };
  if (cutoff && !observed && (facility.observations?.length || facility.sourceIds.some(id => Date.parse(sources.get(id)!.retrievedAt) > Date.parse(cutoff)))) result = { ...result, lifecycle: 'unknown', asOf: null, sourceIds: [], capacityFacts: [], gridEvidence: [] };
  const knownIds = (ids: string[]) => ids.filter(id => visibleSources([id], sources, cutoff));
  result.events = facility.events.filter(e => (!query.asOf || e.date <= query.asOf) && visibleSources(e.sourceIds, sources, cutoff)).map(e => ({ ...e, sourceIds: knownIds(e.sourceIds) }));
  if (query.asOf) {
    const event = [...result.events].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).at(-1);
    result = { ...result, lifecycle: event?.status ?? 'unknown', asOf: event?.date ?? null, sourceIds: event?.sourceIds ?? [] };
    if (knownObservations.length) {
      const capacity = new Map<string, FacilityCapacityFact>(), grid = new Map<string, FacilityGridEvidence>();
      for (const o of knownObservations) {
        const origin = o.originId ?? o.id.split(':observation:')[0];
        for (const c of capacities(o)) if (c.asOf && c.asOf <= query.asOf) { const key = origin + ':' + c.id, previous = capacity.get(key); if (!previous?.asOf || previous.asOf <= c.asOf) capacity.set(key, c); }
        for (const e of gridFacts(o)) if (e.date && e.date <= query.asOf) { const key = origin + ':' + e.id, previous = grid.get(key); if (!previous?.date || previous.date <= e.date) grid.set(key, e); }
      }
      result.capacityFacts = [...capacity.values()]; result.gridEvidence = [...grid.values()];
    }
  }
  result.sourceIds = knownIds(result.sourceIds);
  result.gridEvidence = result.gridEvidence.filter(e => visibleSources(e.sourceIds, sources, cutoff) && (!query.asOf || e.date !== null && e.date <= query.asOf)).map(e => ({ ...e, sourceIds: knownIds(e.sourceIds) }));
  result.capacityFacts = result.capacityFacts.filter(c => visibleSources(c.sourceIds, sources, cutoff) && (!query.asOf || c.asOf !== null && c.asOf <= query.asOf)).map(c => ({ ...c, sourceIds: knownIds(c.sourceIds) }));
  return result;
}
export function filterFacilities(data: FacilityDataset, filters: FacilityFilters = {}): LargeLoadFacility[] {
  const q = filters.q?.trim().toLocaleLowerCase(); queryCutoff(filters);
  return data.facilities.map(f => selectedFacility(data, f, filters)).filter(f => (!filters.region || filters.region === 'all' || f.region === filters.region) && (!filters.state || filters.state === 'all' || f.state === filters.state)
    && (!filters.sector || filters.sector === 'all' || f.sector === filters.sector) && (!filters.lifecycle || filters.lifecycle === 'all' || selectedFacility(data, f, filters).lifecycle === filters.lifecycle)
    && (!filters.scoreBasis || filters.scoreBasis === 'all' || scoreFacility(data, f, filters).basis === filters.scoreBasis)
    && (filters.knownAt === undefined || visibleSources(f.sourceIds, sourceMap(data), queryCutoff(filters)) || f.events.length > 0)
    && (!q || [f.id, f.name, f.operator, f.city, f.county, f.state, ...f.aliases, ...f.legacyProjectIds].join(' ').toLocaleLowerCase().includes(q)));
}
export function scoreFacility(data: FacilityDataset, original: LargeLoadFacility, query: FacilityFilters = {}): FacilityScore {
  const f = selectedFacility(data, original, query), sources = sourceMap(data), cutoff = queryCutoff(query);
  const applicable = data.jurisdictions.filter(r => (!r.states.length || r.states.includes(f.state ?? '')) && (!r.regions.length || r.regions.includes(f.region)) && (!r.sectors.length || r.sectors.includes(f.sector))
    && visibleSources(r.sourceIds, sources, cutoff) && (!query.asOf || r.effectiveFrom !== null) && (!r.effectiveFrom || r.effectiveFrom <= (query.asOf ?? calendarDayKst(data.generatedAt))) && (!r.effectiveTo || (query.asOf ?? calendarDayKst(data.generatedAt)) <= r.effectiveTo));
  let points: number[] | null = null, range: [number, number] | null = null, basis: FacilityScore['basis'] = 'unassessed', modelId: string | null = null, confidence: FacilityScore['confidence'] = null;
  const assumptions = ['다섯 요건의 점수는 시설 개발 근거에 대한 모형 가정이며 ISO 접속 신청·완료를 확인한 직접 평가가 아닙니다.'];
  if (query.asOf || query.knownAt) assumptions.push('현재 검토된 시설 식별·중복 연결 기준으로 과거 근거를 재평가합니다. 당시 원장의 합병 전 행 수·식별 분모를 복원한 결과가 아닙니다.');
  if (applicable.length) assumptions.push('규정은 주·권역·업종이 일치하는 지역 기반 조건부 참고입니다. 실제 공급자·서비스 유형과 규제 관할을 확정한 것은 아닙니다.', ...applicable.flatMap(r => r.limitations));
  if (f.regionBasis === 'geographic_estimate') assumptions.push('권역은 지리적 분류이며 실제 전력회사·ISO 접속 소속을 확인한 것은 아닙니다. 권역 규정 적용도 조건부 시나리오입니다.');
  let rationale = '시설의 단계 근거와 적용 가능한 규정이 부족해 미산출입니다.';
  if (f.lifecycle === 'planned') { points = [15, 15, 20, 20, 20]; range = [60, 100]; basis = 'lifecycle'; confidence = 'low'; modelId = 'planned'; rationale = '발표·개발계획에 따른 초기 개발 시나리오입니다. 실제 접수·계약·허가의 진척은 별도 근거가 있어야 합니다.'; }
  if (f.lifecycle === 'construction') { points = [10, 10, 0, 15, 20]; range = [15, 90]; basis = 'lifecycle'; confidence = 'medium'; modelId = 'site_construction'; rationale = '부지·건물 공사 근거를 반영합니다. 계통 보강 공사나 공급 계약 완료를 증명하지 않습니다.'; assumptions.push('부지·인허가 0점도 건물 공사 단계 모형의 가정이며 모든 허가가 확인됐다는 의미가 아닙니다.'); }
  if (f.lifecycle === 'operating') { points = [0, 0, 0, 0, 0]; range = [0, 0]; basis = 'lifecycle'; confidence = 'medium'; modelId = 'operating'; rationale = '이 시설 범위의 운영 확인에 따른 완료 모형입니다. ISO 신청서나 각 허가의 직접 확인과 구분합니다.'; }
  const allowPrior = visibleSources(original.sourceIds, sources, cutoff) && (!query.asOf || f.events.length > 0);
  if (f.lifecycle === 'unknown' && applicable.length && allowPrior) { points = [18, 18, 18, 18, 18]; range = [0, 100]; basis = 'jurisdiction_prior'; confidence = 'low'; modelId = 'jurisdiction_conservative'; rationale = '관할 절차를 참고한 보수적 90점 시나리오입니다. 규정의 존재는 이 시설의 개별 진척을 증명하지 않습니다.'; assumptions.push('각 18점은 확인된 진행률이 아닌 시나리오 가정입니다. 가능한 범위 0~100은 확인된 미진행 100점과 다릅니다.'); }
  if (f.lifecycle === 'unknown' && !applicable.length && allowPrior) { points = [18, 18, 18, 18, 18]; range = [0, 100]; basis = 'conservative_prior'; confidence = 'low'; modelId = 'common_conservative'; rationale = '관할 규정이 연결되지 않은 공통 다섯 절차의 잠정 90점 시나리오입니다. 개별 진척이나 해당 주·ISO 규정을 확인했다는 의미가 아닙니다.'; assumptions.push('각 18점은 미공개 단계의 보수적 가정이며 확인된 미진행 100점이 아닙니다. 가능한 범위는 0~100입니다.'); }
  const grid = f.gridEvidence.filter(e => e.kind !== 'unknown');
  if (grid.length && !['paused', 'cancelled', 'operating'].includes(f.lifecycle)) {
    points ??= [20, 20, 20, 20, 20]; range ??= [20, 100]; basis = 'grid_evidence'; confidence = 'medium'; modelId = 'project_grid_evidence';
    // Only the gate supported by the individual fact changes. A permit does not establish a supply contract.
    if (grid.some(e => e.kind === 'application')) points[0] = Math.min(points[0], 18);
    if (grid.some(e => e.kind === 'study')) points[0] = Math.min(points[0], 10);
    if (grid.some(e => e.kind === 'contract')) points[1] = 0;
    if (grid.some(e => e.kind === 'permit')) points[2] = 0;
    if (grid.some(e => e.kind === 'energized')) { points[4] = 0; assumptions.push('명시된 통전 근거는 통전 요건만 반영합니다. 일부 단계의 통전으로 전체 캠퍼스를 운영 완료로 바꾸지 않습니다.'); }
    rationale = '시설별 신청·검토·계약·허가·통전 근거가 해당 요건만 보완합니다. 다른 요건은 개발 단계 모형의 가정으로 남습니다.';
  }
  const point = points ? Math.round(points.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  if (point !== null && range) range = [Math.min(range[0], point), Math.max(range[1], point)];
  let exclusionReason: string | null = null;
  if (original.parentId) exclusionReason = '상위 시설과 중복되는 단계·부분 범위';
  else if (original.possibleDuplicateIds?.length) exclusionReason = '동일 시설 가능성이 미해결';
  else if (f.state === null || f.state === 'AK' || f.state === 'HI') exclusionReason = '본토 48주/DC의 위치가 확인되지 않은 시설';
  else if (['operating', 'paused', 'cancelled'].includes(f.lifecycle)) exclusionReason = '현재 개발중인 시설의 평균에서 운영·중단·취소 제외';
  else if (f.lifecycle === 'unknown' && !(query.includeUnknownPrior && point !== null)) exclusionReason = '현재 개발 상태 미확인; 잠정 점수는 별도 집계';
  else if (point === null) exclusionReason = '점수 근거 부족';
  return { point, range, gates: points ? GATES.map((gate, i) => ({ gate, label: LABELS[i], points: points![i], progress: 1 - points![i] / 20, assumption: '20 × (1 − 모형 진행률); 개별 직접 확인과 구분' })) : [],
    confidence, basis, modelId, rationale, assumptions, sourceIds: [...new Set([...f.sourceIds, ...grid.flatMap(e => e.sourceIds)])], jurisdictionIds: applicable.map(r => r.id), lifecycle: f.lifecycle, asOf: f.asOf, evaluatedAt: data.generatedAt,
    eligibleForAverage: point !== null && exclusionReason === null, exclusionReason };
}
export function facilityHistory(data: FacilityDataset, facility: LargeLoadFacility, query: FacilityFilters = {}): FacilityHistoryPoint[] {
  const sources = sourceMap(data), cutoff = queryCutoff(query), dates = [...new Set(facility.events.filter(e => (!query.asOf || e.date <= query.asOf) && visibleSources(e.sourceIds, sources, cutoff)).map(e => e.date))].sort();
  return dates.map(date => { const events = facility.events.filter(e => e.date === date && visibleSources(e.sourceIds, sources, cutoff)); const score = scoreFacility(data, facility, { ...query, asOf: date });
    const sourceIds = [...new Set([...events.flatMap(e => e.sourceIds), ...score.sourceIds, ...score.jurisdictionIds.flatMap(id => data.jurisdictions.find(r => r.id === id)!.sourceIds)])].filter(id => visibleSources([id], sources, cutoff));
    return { date, lifecycle: score.lifecycle, score, sourceIds, knownAt: sourceIds.map(id => sources.get(id)!.retrievedAt).sort().at(-1)! }; });
}
export function summarizeFacilities(data: FacilityDataset, filters: FacilityFilters = {}): FacilitySummary {
  const facilities = filterFacilities(data, filters), scored = facilities.map(f => ({ f, score: scoreFacility(data, f, filters) }));
  const average = scored.filter(s => s.score.eligibleForAverage), count = (life: FacilityLifecycle) => scored.filter(s => s.score.lifecycle === life).length;
  const capacityByMeasure = Object.fromEntries(MEASURES.map(m => [m, { mw: null, knownCount: 0, conflictCount: 0 }])) as FacilitySummary['capacityByMeasure'];
  const byLifecycle: Record<string, number> = {}, byRegion: Record<string, number> = {}, bySector: Record<string, number> = {};
  for (const { f, score } of scored) {
    byLifecycle[score.lifecycle] = (byLifecycle[score.lifecycle] ?? 0) + 1; byRegion[f.region] = (byRegion[f.region] ?? 0) + 1; bySector[f.sector] = (bySector[f.sector] ?? 0) + 1;
    if (f.parentId || f.possibleDuplicateIds?.length) continue;
    const selected = selectedFacility(data, f, filters);
    for (const measure of MEASURES) {
      const values = new Set(selected.capacityFacts.filter(c => c.measure === measure && c.unit === 'MW' && c.value !== null && (c.scope === f.identityKind || c.scope === 'facility' && f.identityKind !== 'phase')).map(c => c.value!));
      if (values.size > 1) capacityByMeasure[measure].conflictCount++;
      else if (values.size === 1) { const item = capacityByMeasure[measure]; item.mw = (item.mw ?? 0) + [...values][0]; item.knownCount++; }
    }
  }
  return { identityScope: 'current_reviewed_identity', facilityCount: facilities.length, developmentCount: count('planned') + count('construction'), operatingCount: count('operating'), pausedCount: count('paused'), cancelledCount: count('cancelled'), unknownCount: count('unknown'),
    scoredCount: scored.filter(s => s.score.point !== null).length, averageCount: average.length, mean: average.length ? average.reduce((a, s) => a + s.score.point!, 0) / average.length : null,
    meanRange: average.length ? [average.reduce((a, s) => a + s.score.range![0], 0) / average.length, average.reduce((a, s) => a + s.score.range![1], 0) / average.length] : null,
    priorCount: scored.filter(s => ['jurisdiction_prior', 'conservative_prior'].includes(s.score.basis)).length, lifecycleCount: scored.filter(s => s.score.basis === 'lifecycle').length, gridEvidenceCount: scored.filter(s => s.score.basis === 'grid_evidence').length, unassessedCount: scored.filter(s => s.score.point === null).length,
    linkedProjectCount: new Set(facilities.flatMap(f => f.legacyProjectIds)).size, possibleDuplicateCount: facilities.filter(f => f.possibleDuplicateIds?.length).length, phaseCount: facilities.filter(f => f.parentId).length,
    byLifecycle, byRegion, bySector, capacityByMeasure };
}
const csvCell = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
export function facilitiesCsv(data: FacilityDataset, filters: FacilityFilters = {}): string {
  const header = ['facility_id', 'identity_scope', 'name', 'operator', 'sector', 'region', 'region_basis', 'state', 'lifecycle', 'source_as_of', 'point', 'range', 'basis', 'confidence', 'development_average', 'exclusion', 'parent_id', 'possible_duplicates', 'legacy_project_ids', 'capacity_facts', 'source_evidence', 'model_assumptions', 'evaluated_at'];
  const sources = sourceMap(data), rows = filterFacilities(data, filters).map(f => { const s = scoreFacility(data, f, filters); return [f.id, 'current_reviewed_identity', f.name, f.operator, f.sector, f.region, f.regionBasis ?? 'unknown', f.state, s.lifecycle, s.asOf, s.point, s.range?.join('–'), s.basis, s.confidence, s.eligibleForAverage, s.exclusionReason, f.parentId, (f.possibleDuplicateIds ?? []).join('|'), f.legacyProjectIds.join('|'), JSON.stringify(selectedFacility(data, f, filters).capacityFacts), JSON.stringify([...new Set([...s.sourceIds, ...s.jurisdictionIds.flatMap(id => data.jurisdictions.find(r => r.id === id)!.sourceIds)])].map(id => sources.get(id))), JSON.stringify(s.assumptions), s.evaluatedAt]; });
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
