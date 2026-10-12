import { calendarDayKst, isCalendarDay } from './time.ts';

export const CENSUS_FAMILIES = ['utility', 'puc', 'transmission', 'customer'] as const;
export type CensusSourceFamily = typeof CENSUS_FAMILIES[number];
export type CensusStatus = 'announced' | 'application' | 'study' | 'contracted' | 'construction' | 'operating' | 'withdrawn' | 'unknown';
export type CensusConnectionBasis = 'confirmed_request' | 'confirmed_contract' | 'announced' | 'inferred' | 'unknown';
export type CensusEntityKind = 'site' | 'campus' | 'source_request' | 'anonymous_service_request' | 'unresolved_named_development';
export type CensusRawKind = 'customer_request' | 'named_development' | 'transmission_support' | 'historical' | 'grouped_case' | 'unclassified';
export interface CensusEvidence {
  id: string; name: string; url: string; sourceFamily: CensusSourceFamily;
  retrievedAt: string | null; sha256: string | null; publishedAt: string | null; sourceAsOf: string | null;
  excerpt: string; limitations: string[];
}
export interface CensusCapacityFact {
  id: string; value: number | null; unit: 'MW' | 'MVA';
  basis: 'requested_grid' | 'contracted_grid' | 'site_power' | 'it_power' | 'generation' | 'unknown';
  scope: 'entity' | 'phase' | 'campus' | 'company' | 'multi_site';
  asOf: string | null; evidenceIds: string[]; note: string;
}
export interface CensusEntity {
  id: string; name: string; region: string; state: string | null; kind: CensusEntityKind;
  customer: string | null; utility: string | null; utilityIds: string[]; location: string | null;
  status: CensusStatus; asOf: string | null; connectionBasis: CensusConnectionBasis;
  rawRefIds: string[]; evidenceIds: string[]; capacityFacts: CensusCapacityFact[]; aliases: string[];
  relatedSupportRecordIds: string[]; possibleDuplicateIds: string[]; parentEntityId: string | null;
  scoreProjectId: string | null; limitations: string[];
  knownGridMw: number | null; capacityConflict: boolean;
  additiveStatus: 'included' | 'possible_duplicate' | 'component_of_parent' | 'not_confirmed_connection' | 'capacity_conflict' | 'unknown_capacity' | 'not_active';
}
export type CensusEntityInput = Pick<CensusEntity, 'id'> & Partial<Omit<CensusEntity, 'id' | 'knownGridMw' | 'capacityConflict' | 'additiveStatus'>>;
export interface CensusRawRecord {
  id: string; inputCollection: 'bootstrap' | 'pipeline' | 'research'; nativeId: string;
  name: string; region: string; state: string | null; status: string; kind: CensusRawKind;
  evidenceIds: string[]; entityId: string | null; payload: Record<string, unknown>;
}
export interface CensusDecision {
  id: string; kind: 'same_entity' | 'possible_duplicate' | 'expansion_of' | 'related_support';
  entityIds: string[]; rawRefIds: string[]; evidenceIds: string[]; reason: string;
  origin?: 'explicit_review' | 'exact_source_record'; sourceFragmentId?: string;
}
export interface CensusAttempt {
  id: string; organization: string; utilityIds: string[]; region: string; sourceFamily: CensusSourceFamily;
  url: string | null; status: 'reviewed' | 'fetch_failed' | 'queued' | 'not_public';
  checkedAt: string | null; evidenceIds: string[]; notes: string[];
}
export interface CensusSurveyUtility {
  id: string; name: string; states: string[]; regions: string[]; geographicScope: string;
  referenceEvidenceIds: string[]; attemptIds: string[];
  familyStatus: Record<CensusSourceFamily, CensusAttempt['status']>;
}
export interface CensusFragment {
  schemaVersion: 1; id: string; generatedAt: string; evidence: CensusEvidence[];
  entities: CensusEntityInput[]; decisions: CensusDecision[]; attempts: CensusAttempt[]; limitations: string[];
}
export interface LoadProjectCensus {
  schemaVersion: 1; generatedAt: string;
  inputs: Array<{ id: string; path: string; sha256: string; records: number }>;
  evidence: CensusEvidence[]; rawRecords: CensusRawRecord[]; entities: CensusEntity[];
  decisions: CensusDecision[]; entityAliases: Array<{ aliasId: string; canonicalId: string; decisionId: string }>;
  attempts: CensusAttempt[]; survey: { utilities: CensusSurveyUtility[]; limitations: string[] }; limitations: string[];
}
export interface CensusFilters {
  region?: string; q?: string; status?: CensusStatus | 'all'; connectionBasis?: CensusConnectionBasis | 'all';
  kind?: CensusEntityKind | 'all'; utilityId?: string; sourceFamily?: CensusSourceFamily | 'all';
}
export interface CensusSummary {
  entityCount: number; rawRecordCount: number; unassignedRawRecordCount: number; supportRecordCount: number;
  knownGridMw: number | null; additiveEntityCount: number; unknownGridMwCount: number;
  capacityConflictCount: number; possibleDuplicateCount: number; expansionCount: number;
  byStatus: Record<string, number>; byConnectionBasis: Record<string, number>; byRegion: Record<string, number>;
  survey: { utilityCount: number; attemptedUtilityCount: number; reviewedUtilityCount: number; queuedUtilityCount: number; attemptCount: number; actualAttemptCount: number; queuedAttemptCount: number; byFamily: Record<CensusSourceFamily, number> };
}

const STATUSES: CensusStatus[] = ['announced', 'application', 'study', 'contracted', 'construction', 'operating', 'withdrawn', 'unknown'];
const BASES: CensusConnectionBasis[] = ['confirmed_request', 'confirmed_contract', 'announced', 'inferred', 'unknown'];
const KINDS: CensusEntityKind[] = ['site', 'campus', 'source_request', 'anonymous_service_request', 'unresolved_named_development'];
const ACTIVE = new Set<CensusStatus>(['application', 'study', 'contracted', 'construction']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const nullableText = (v: unknown) => v === null || text(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) && isCalendarDay(v.slice(0, 10)) && Number.isFinite(Date.parse(v));
const date = (v: unknown): v is string | null => v === null || typeof v === 'string' && (isCalendarDay(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v));
function https(v: unknown): v is string { if (!text(v)) return false; try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname; } catch { return false; } }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Load project census: ${message}`); }
export function censusCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(censusCanonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + censusCanonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** Preserve conflicting and non-grid claims; never add documents to manufacture project MW. */
export function resolveCensusCapacity(entity: Pick<CensusEntity, 'kind' | 'capacityFacts'>): { knownGridMw: number | null; capacityConflict: boolean } {
  const grid = entity.capacityFacts.filter(f => f.value !== null && f.unit === 'MW' && ['requested_grid', 'contracted_grid'].includes(f.basis)
    && (f.scope === 'entity' || f.scope === 'phase' || f.scope === 'campus' && entity.kind === 'campus'));
  const values = new Set(grid.map(f => f.value!));
  return { knownGridMw: values.size === 1 ? [...values][0] : null, capacityConflict: values.size > 1 };
}
export function censusAdditiveStatus(entity: Pick<CensusEntity, 'possibleDuplicateIds' | 'parentEntityId' | 'connectionBasis' | 'status' | 'capacityConflict' | 'knownGridMw'>): CensusEntity['additiveStatus'] {
  if (entity.possibleDuplicateIds.length) return 'possible_duplicate';
  if (entity.parentEntityId) return 'component_of_parent';
  if (!['confirmed_request', 'confirmed_contract'].includes(entity.connectionBasis)) return 'not_confirmed_connection';
  if (!ACTIVE.has(entity.status)) return 'not_active';
  if (entity.capacityConflict) return 'capacity_conflict';
  return entity.knownGridMw === null ? 'unknown_capacity' : 'included';
}

export function validateLoadProjectCensus(input: unknown, now = new Date()): asserts input is LoadProjectCensus {
  check(object(input) && input.schemaVersion === 1 && timestamp(input.generatedAt) && Date.parse(input.generatedAt) <= now.getTime(), 'schema/generatedAt');
  const data = input as unknown as LoadProjectCensus, day = calendarDayKst(data.generatedAt);
  check([data.inputs, data.evidence, data.rawRecords, data.entities, data.decisions, data.entityAliases, data.attempts, data.survey?.utilities].every(Array.isArray) && strings(data.limitations) && strings(data.survey.limitations), 'collections');
  const unique = <T extends { id: string }>(items: T[], label: string) => { const ids = new Set<string>(); for (const item of items) { check(object(item) && text(item.id) && !ids.has(item.id), `${label} unique ID`); ids.add(item.id); } return ids; };
  const evidence = unique(data.evidence, 'evidence'), rawIds = unique(data.rawRecords, 'raw record'), ids = unique(data.entities, 'entity');
  const decisions = unique(data.decisions, 'decision'), attempts = unique(data.attempts, 'attempt'), utilities = unique(data.survey.utilities, 'utility'); unique(data.inputs, 'input');
  const refs = (v: unknown, to: Set<string>) => strings(v) && v.every(id => to.has(id));
  for (const source of data.inputs) check(text(source.path) && /^[a-f0-9]{64}$/.test(source.sha256) && Number.isInteger(source.records) && source.records >= 0, 'input manifest');
  for (const e of data.evidence) {
    check(text(e.name) && https(e.url) && CENSUS_FAMILIES.includes(e.sourceFamily) && text(e.excerpt) && strings(e.limitations), 'evidence source');
    check((e.retrievedAt === null || timestamp(e.retrievedAt) && Date.parse(e.retrievedAt) <= Date.parse(data.generatedAt)) && (e.sha256 === null || /^[a-f0-9]{64}$/.test(e.sha256)) && date(e.publishedAt) && date(e.sourceAsOf), 'evidence provenance');
    const cutoff = e.retrievedAt ? calendarDayKst(e.retrievedAt) : day;
    check((!e.publishedAt || e.publishedAt <= cutoff) && (!e.sourceAsOf || e.sourceAsOf <= cutoff), 'evidence chronology');
  }
  const rawById = new Map(data.rawRecords.map(r => [r.id, r]));
  for (const record of data.rawRecords) check(['bootstrap', 'pipeline', 'research'].includes(record.inputCollection) && text(record.nativeId) && text(record.name) && text(record.region) && nullableText(record.state) && typeof record.status === 'string' && ['customer_request', 'named_development', 'transmission_support', 'historical', 'grouped_case', 'unclassified'].includes(record.kind) && refs(record.evidenceIds, evidence) && (record.entityId === null || ids.has(record.entityId)) && object(record.payload), 'raw record / source preservation');
  for (const e of data.entities) {
    check(text(e.name) && text(e.region) && nullableText(e.state) && KINDS.includes(e.kind) && nullableText(e.customer) && nullableText(e.utility) && refs(e.utilityIds, utilities) && nullableText(e.location), 'entity identity');
    check(STATUSES.includes(e.status) && BASES.includes(e.connectionBasis) && date(e.asOf) && (!e.asOf || e.asOf <= day) && nullableText(e.scoreProjectId), 'entity state');
    check(refs(e.rawRefIds, rawIds) && e.rawRefIds.every(id => rawById.get(id)!.entityId === e.id) && refs(e.evidenceIds, evidence) && e.evidenceIds.length > 0 && strings(e.aliases) && strings(e.limitations), 'entity source ownership');
    check(refs(e.relatedSupportRecordIds, rawIds) && refs(e.possibleDuplicateIds, ids) && !e.possibleDuplicateIds.includes(e.id) && (e.parentEntityId === null || ids.has(e.parentEntityId) && e.parentEntityId !== e.id), 'entity relationships');
    check(Array.isArray(e.capacityFacts), 'capacity facts'); unique(e.capacityFacts, 'capacity fact');
    for (const f of e.capacityFacts) check((f.value === null || typeof f.value === 'number' && Number.isFinite(f.value) && f.value >= 0) && ['MW', 'MVA'].includes(f.unit) && ['requested_grid', 'contracted_grid', 'site_power', 'it_power', 'generation', 'unknown'].includes(f.basis) && ['entity', 'phase', 'campus', 'company', 'multi_site'].includes(f.scope) && date(f.asOf) && (!f.asOf || f.asOf <= day) && refs(f.evidenceIds, evidence) && f.evidenceIds.length > 0 && text(f.note), 'capacity basis/provenance');
    const capacity = resolveCensusCapacity(e);
    check(e.knownGridMw === capacity.knownGridMw && e.capacityConflict === capacity.capacityConflict && e.additiveStatus === censusAdditiveStatus(e), 'derived capacity or additive status');
    for (const other of e.possibleDuplicateIds) check(data.entities.find(v => v.id === other)!.possibleDuplicateIds.includes(e.id), 'possible duplicate symmetry');
    const visited = new Set<string>([e.id]); let parent = e.parentEntityId;
    while (parent) { check(!visited.has(parent), `expansion parent cycle: ${[...visited, parent].join(' -> ')}`); visited.add(parent); parent = data.entities.find(v => v.id === parent)!.parentEntityId; }
  }
  for (const r of data.rawRecords) if (r.entityId) check(data.entities.find(e => e.id === r.entityId)!.rawRefIds.includes(r.id), 'raw record reverse ownership');
  const aliases = new Set<string>();
  for (const a of data.entityAliases) { check(text(a.aliasId) && !ids.has(a.aliasId) && !aliases.has(a.aliasId) && ids.has(a.canonicalId) && decisions.has(a.decisionId), 'canonical alias'); aliases.add(a.aliasId); }
  const allIds = new Set([...ids, ...aliases]);
  for (const d of data.decisions) check(['same_entity', 'possible_duplicate', 'expansion_of', 'related_support'].includes(d.kind) && refs(d.entityIds, allIds) && d.entityIds.length > 0 && refs(d.rawRefIds, rawIds) && refs(d.evidenceIds, evidence) && d.evidenceIds.length > 0 && text(d.reason), 'decision evidence or links');
  for (const a of data.attempts) check(text(a.organization) && refs(a.utilityIds, utilities) && text(a.region) && CENSUS_FAMILIES.includes(a.sourceFamily) && (a.url === null || https(a.url)) && ['reviewed', 'fetch_failed', 'queued', 'not_public'].includes(a.status) && (a.checkedAt === null ? a.status === 'queued' : timestamp(a.checkedAt) && Date.parse(a.checkedAt) <= Date.parse(data.generatedAt)) && refs(a.evidenceIds, evidence) && strings(a.notes) && (a.status !== 'reviewed' || a.evidenceIds.length > 0), 'survey attempt');
  for (const u of data.survey.utilities) {
    check(text(u.name) && strings(u.states) && strings(u.regions) && text(u.geographicScope) && strings(u.referenceEvidenceIds) && refs(u.attemptIds, attempts), 'survey utility denominator');
    const linked = data.attempts.filter(a => a.utilityIds.includes(u.id));
    check(censusCanonicalJson([...u.attemptIds].sort()) === censusCanonicalJson(linked.map(a => a.id).sort()), 'survey attempt/utility linkage');
    for (const family of CENSUS_FAMILIES) {
      const latest = linked.filter(a => a.sourceFamily === family).sort((a, b) => (a.checkedAt ?? '').localeCompare(b.checkedAt ?? '') || a.id.localeCompare(b.id)).at(-1);
      check(u.familyStatus[family] === (latest?.status ?? 'queued'), 'survey status requires an actual linked attempt');
    }
  }
}

export function parseCensusFilters(params: URLSearchParams): CensusFilters {
  const filters: CensusFilters = {};
  for (const key of ['region', 'q', 'utilityId'] as const) { const value = params.get(key); if (value && value !== 'all') { if (value.length > 250) throw new Error('Census filter too long'); filters[key] = value; } }
  for (const [key, choices] of [['status', STATUSES], ['connectionBasis', BASES], ['kind', KINDS], ['sourceFamily', CENSUS_FAMILIES]] as const) {
    const value = params.get(key); if (value) { if (value !== 'all' && !(choices as readonly string[]).includes(value)) throw new Error(`Invalid census ${key}`); Object.assign(filters, { [key]: value }); }
  }
  return filters;
}
export function filterCensusEntities(data: LoadProjectCensus, filters: CensusFilters = {}): CensusEntity[] {
  const q = filters.q?.trim().toLocaleLowerCase(), sources = new Map(data.evidence.map(e => [e.id, e]));
  return data.entities.filter(e => (!filters.region || filters.region === 'all' || e.region === filters.region)
    && (!filters.status || filters.status === 'all' || e.status === filters.status) && (!filters.connectionBasis || filters.connectionBasis === 'all' || e.connectionBasis === filters.connectionBasis)
    && (!filters.kind || filters.kind === 'all' || e.kind === filters.kind) && (!filters.utilityId || e.utilityIds.includes(filters.utilityId))
    && (!filters.sourceFamily || filters.sourceFamily === 'all' || e.evidenceIds.some(id => sources.get(id)?.sourceFamily === filters.sourceFamily))
    && (!q || [e.id, e.name, e.customer ?? '', e.utility ?? '', e.location ?? '', e.state ?? '', ...e.aliases, ...e.rawRefIds].some(v => v.toLocaleLowerCase().includes(q))));
}
export function summarizeCensus(data: LoadProjectCensus, filters: CensusFilters = {}): CensusSummary {
  const entities = filterCensusEntities(data, filters), included = entities.filter(e => e.additiveStatus === 'included');
  const countBy = (key: 'status' | 'connectionBasis' | 'region') => { const counts: Record<string, number> = {}; for (const e of entities) counts[e[key]] = (counts[e[key]] ?? 0) + 1; return counts; };
  const utilities = data.survey.utilities.filter(u => (!filters.region || filters.region === 'all' || u.regions.includes(filters.region)) && (!filters.utilityId || u.id === filters.utilityId));
  const attempts = data.attempts.filter(a => !filters.region || filters.region === 'all' || a.region === filters.region || a.utilityIds.some(id => utilities.some(u => u.id === id)));
  const attemptedIds = new Set(attempts.filter(a => a.status !== 'queued').flatMap(a => a.utilityIds)), reviewedIds = new Set(attempts.filter(a => a.status === 'reviewed').flatMap(a => a.utilityIds));
  return { entityCount: entities.length, rawRecordCount: data.rawRecords.length, unassignedRawRecordCount: data.rawRecords.filter(r => !r.entityId).length,
    supportRecordCount: data.rawRecords.filter(r => r.kind === 'transmission_support' || r.kind === 'historical').length,
    knownGridMw: included.length ? Math.round(included.reduce((sum, e) => sum + e.knownGridMw!, 0) * 1e6) / 1e6 : null, additiveEntityCount: included.length,
    unknownGridMwCount: entities.filter(e => e.knownGridMw === null).length, capacityConflictCount: entities.filter(e => e.capacityConflict).length,
    possibleDuplicateCount: entities.filter(e => e.possibleDuplicateIds.length).length, expansionCount: entities.filter(e => e.parentEntityId).length,
    byStatus: countBy('status'), byConnectionBasis: countBy('connectionBasis'), byRegion: countBy('region'),
    survey: { utilityCount: utilities.length, attemptedUtilityCount: utilities.filter(u => attemptedIds.has(u.id)).length, reviewedUtilityCount: utilities.filter(u => reviewedIds.has(u.id)).length,
      queuedUtilityCount: utilities.filter(u => !attemptedIds.has(u.id)).length, attemptCount: attempts.length,
      actualAttemptCount: attempts.filter(a => a.status !== 'queued').length, queuedAttemptCount: attempts.filter(a => a.status === 'queued').length,
      byFamily: Object.fromEntries(CENSUS_FAMILIES.map(f => [f, attempts.filter(a => a.sourceFamily === f && a.status !== 'queued').length])) as Record<CensusSourceFamily, number> },
  };
}
const csvCell = (value: unknown) => { const s = value === null || value === undefined ? '' : String(value); return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'; };
export function censusCsv(data: LoadProjectCensus, filters: CensusFilters = {}): string {
  const evidence = new Map(data.evidence.map(e => [e.id, e]));
  const rows: unknown[][] = [['canonical_id', 'name', 'region', 'state', 'kind', 'customer', 'utility', 'location', 'status', 'as_of', 'connection_basis', 'known_grid_mw', 'additive_status', 'capacity_conflict', 'capacity_facts', 'raw_record_ids', 'aliases', 'parent_entity_id', 'possible_duplicate_ids', 'related_support_ids', 'score_project_id', 'source_urls', 'source_retrieved_at', 'source_sha256', 'limitations']];
  for (const e of filterCensusEntities(data, filters)) { const sources = e.evidenceIds.map(id => evidence.get(id)!); rows.push([e.id, e.name, e.region, e.state, e.kind, e.customer, e.utility, e.location, e.status, e.asOf, e.connectionBasis, e.knownGridMw, e.additiveStatus, e.capacityConflict,
    JSON.stringify(e.capacityFacts), e.rawRefIds.join('|'), e.aliases.join('|'), e.parentEntityId, e.possibleDuplicateIds.join('|'), e.relatedSupportRecordIds.join('|'), e.scoreProjectId,
    sources.map(s => s.url).join('|'), sources.map(s => s.retrievedAt ?? '').join('|'), sources.map(s => s.sha256 ?? '').join('|'), e.limitations.join(' | ')]); }
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
