/** Reviewed source coverage is a research inventory, never a project census. */
import { MARKET_REGIONS } from './market-types.ts';
import { calendarDayKst, isCalendarDay } from './time.ts';

export const COVERAGE_REGIONS = [...MARKET_REGIONS, 'Non-ISO', 'Unassigned'] as const;
export type CoverageRegion = typeof COVERAGE_REGIONS[number];
export const COVERAGE_KINDS = ['project_register', 'stage_distribution', 'requests', 'contracts', 'forecast', 'grid_support', 'qualitative'] as const;
export type CoverageKind = typeof COVERAGE_KINDS[number];
export type CoverageStatus = 'reviewed' | 'not_reviewed';
export type CoverageGeography = 'mainland' | 'nonmainland' | 'mixed' | 'unresolved';
export interface CoverageSource {
  id: string; name: string; url: string; retrievedAt: string; sha256: string;
  sourceAsOf: string | null; publishedAt: string | null; notes: string[];
}
export interface CoverageUtility {
  id: string; name: string; states: string[]; forms: string[]; roles: string[];
  geographicScope: CoverageGeography; mainlandStates: string[]; serviceTypes: string[];
  sourceEvidence: { sourceId: string; locator: string }[];
  regions: CoverageRegion[];
  associations: { kind: 'balancing_authority' | 'iso_membership'; code: string; name: string | null;
    region: CoverageRegion | null; sourceId: string; locator: string }[];
  notes: string[];
}
export interface CoverageRoster {
  id: string; region: CoverageRegion; name: string;
  kind: 'zone' | 'transmission_owner' | 'load_provider' | 'member' | 'forecast_submitter';
  sourceIds: string[]; scope: string; complete: boolean;
  entries: { id: string; name: string; aliases: string[]; notes: string[] }[]; notes: string[];
}
export interface CoverageEvidence {
  id: string; region: CoverageRegion; provider: string; name: string; sourceIds: string[];
  coverageKind: CoverageKind; scope: string;
  metrics: { label: string; value: number | null; unit: 'MW' | 'GW' | 'projects' | 'percent';
    asOf: string | null; qualifier: 'exact' | 'approximate' | 'at_least' | 'greater_than'; notes: string[] }[];
  utilityIds: string[]; rosterEntryIds: string[]; scoreSeriesIds: string[]; gaps: string[];
}
export interface LoadCoverageDataset {
  schemaVersion: 1; generatedAt: string; sources: CoverageSource[];
  universe: { year: number; sourceIds: string[]; scope: string; limitations: string[]; utilities: CoverageUtility[] };
  rosters: CoverageRoster[]; evidence: CoverageEvidence[];
  regions: { region: CoverageRegion; sourceIds: string[]; overview: string; gaps: string[] }[];
  limitations: string[];
}
export interface LoadCoverageFilters {
  region?: CoverageRegion | 'all'; q?: string; kind?: CoverageKind | 'all';
  status?: CoverageStatus | 'all'; geographicScope?: CoverageGeography | 'all';
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length < 30000;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const uniqueTexts = (v: unknown): v is string[] => texts(v) && new Set(v).size === v.length;
const region = (v: unknown): v is CoverageRegion => COVERAGE_REGIONS.includes(v as CoverageRegion);
const MAINLAND = new Set('AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
function ensure(value: unknown, why: string): asserts value { if (!value) throw new TypeError(`Invalid load coverage dataset: ${why}`); }
function instant(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)
    && isCalendarDay(v.slice(0, 10)) && Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60
    && Number(v.slice(17, 19)) < 60 && Number.isFinite(Date.parse(v));
}
function period(v: unknown): v is string {
  return typeof v === 'string' && (isCalendarDay(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v) || /^\d{4}-Q[1-4]$/.test(v) || /^\d{4}$/.test(v));
}
function anchor(v: string): string {
  return /^\d{4}-Q/.test(v) ? `${v.slice(0, 4)}-${String((Number(v[6]) - 1) * 3 + 1).padStart(2, '0')}-01`
    : v.length === 4 ? `${v}-01-01` : v.length === 7 ? `${v}-01` : v;
}
function https(v: unknown): boolean { try { const u = new URL(String(v)); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; } }
function dateAt(v: unknown, latest: string): boolean { return v === null || (period(v) && anchor(v) <= latest); }

export function validateLoadCoverageDataset(input: unknown, now: Date | string = new Date(), knownScoreSeriesIds?: ReadonlySet<string>): asserts input is LoadCoverageDataset {
  ensure(object(input) && input.schemaVersion === 1 && instant(input.generatedAt)
    && Date.parse(input.generatedAt) <= new Date(now).getTime() && texts(input.limitations), 'schema / generated date / limitations');
  ensure(Array.isArray(input.sources) && object(input.universe) && Array.isArray(input.rosters)
    && Array.isArray(input.evidence) && Array.isArray(input.regions), 'collections');
  const sources = new Map<string, CoverageSource>();
  for (const source of input.sources) {
    ensure(object(source) && text(source.id) && !sources.has(source.id) && text(source.name) && https(source.url)
      && instant(source.retrievedAt) && Date.parse(source.retrievedAt) <= Date.parse(input.generatedAt)
      && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256) && texts(source.notes), 'source provenance / unique ID');
    ensure(dateAt(source.sourceAsOf, calendarDayKst(source.retrievedAt)) && dateAt(source.publishedAt, calendarDayKst(source.retrievedAt)), 'source date after retrieval');
    sources.set(source.id, source as unknown as CoverageSource);
  }
  const refs = (ids: unknown, required = true): ids is string[] => uniqueTexts(ids) && (!required || ids.length > 0) && ids.every(id => sources.has(id));
  ensure(Number.isInteger(input.universe.year) && Number(input.universe.year) >= 1900 && Number(input.universe.year) <= Number(calendarDayKst(input.generatedAt).slice(0, 4))
    && refs(input.universe.sourceIds) && text(input.universe.scope) && texts(input.universe.limitations) && Array.isArray(input.universe.utilities), 'universe provenance / year');
  const utilities = new Map<string, CoverageUtility>();
  for (const utility of input.universe.utilities) {
    ensure(object(utility) && text(utility.id) && !utilities.has(utility.id) && text(utility.name)
      && uniqueTexts(utility.states) && utility.states.every(s => /^[A-Z]{2}$/.test(s)) && uniqueTexts(utility.forms)
      && uniqueTexts(utility.roles) && uniqueTexts(utility.serviceTypes) && uniqueTexts(utility.mainlandStates)
      && utility.mainlandStates.every(s => MAINLAND.has(s) && (utility.states as string[]).includes(s))
      && ['mainland', 'nonmainland', 'mixed', 'unresolved'].includes(utility.geographicScope as string)
      && texts(utility.notes) && Array.isArray(utility.associations) && Array.isArray(utility.sourceEvidence)
      && utility.sourceEvidence.length > 0 && uniqueTexts(utility.regions) && utility.regions.length > 0 && utility.regions.every(region), 'utility identity / geography');
    ensure(utility.states.filter(s => MAINLAND.has(s)).length === utility.mainlandStates.length, 'mainland states must match disclosed states');
    ensure(utility.geographicScope !== 'mainland' || (utility.mainlandStates.length > 0 && utility.mainlandStates.length === utility.states.length), 'mainland utility geography');
    ensure(utility.geographicScope !== 'nonmainland' || (utility.mainlandStates.length === 0 && utility.states.length > 0), 'nonmainland utility geography');
    ensure(utility.geographicScope !== 'mixed' || (utility.mainlandStates.length > 0 && utility.mainlandStates.length < utility.states.length), 'mixed utility geography');
    for (const proof of utility.sourceEvidence) ensure(object(proof) && sources.has(String(proof.sourceId)) && text(proof.locator), 'utility source locator');
    const provenRegions = new Set<CoverageRegion>();
    for (const association of utility.associations) {
      ensure(object(association) && ['balancing_authority', 'iso_membership'].includes(association.kind as string)
        && text(association.code) && (association.name === null || text(association.name)) && (association.region === null || region(association.region))
        && association.region !== 'Unassigned' && sources.has(String(association.sourceId)) && text(association.locator), 'utility association provenance');
      ensure(association.region === null || !['NA', 'N/A', 'UNKNOWN', 'UNASSIGNED', 'NONE'].includes(association.code.trim().toUpperCase()), 'unknown association code cannot prove a region');
      if (association.region !== null) provenRegions.add(association.region as CoverageRegion);
    }
    if (provenRegions.size === 0) provenRegions.add('Unassigned');
    ensure(utility.regions.length === provenRegions.size && utility.regions.every(r => provenRegions.has(r as CoverageRegion)), 'utility region requires explicit association; state is not proof');
    utilities.set(utility.id, utility as unknown as CoverageUtility);
  }
  const rosterIds = new Set<string>(), entries = new Map<string, CoverageRegion>();
  for (const roster of input.rosters) {
    ensure(object(roster) && text(roster.id) && !rosterIds.has(roster.id) && region(roster.region) && text(roster.name)
      && ['zone', 'transmission_owner', 'load_provider', 'member', 'forecast_submitter'].includes(roster.kind as string)
      && refs(roster.sourceIds) && text(roster.scope) && typeof roster.complete === 'boolean' && texts(roster.notes) && Array.isArray(roster.entries), 'roster provenance / scope');
    rosterIds.add(roster.id);
    for (const entry of roster.entries) {
      ensure(object(entry) && text(entry.id) && !entries.has(entry.id) && text(entry.name) && uniqueTexts(entry.aliases) && texts(entry.notes), 'roster entry unique ID');
      entries.set(entry.id, roster.region);
    }
  }
  const evidenceIds = new Set<string>();
  for (const evidence of input.evidence) {
    ensure(object(evidence) && text(evidence.id) && !evidenceIds.has(evidence.id) && region(evidence.region) && text(evidence.provider)
      && text(evidence.name) && refs(evidence.sourceIds) && COVERAGE_KINDS.includes(evidence.coverageKind as CoverageKind)
      && text(evidence.scope) && Array.isArray(evidence.metrics) && uniqueTexts(evidence.utilityIds) && uniqueTexts(evidence.rosterEntryIds)
      && uniqueTexts(evidence.scoreSeriesIds) && texts(evidence.gaps), 'evidence provenance / scope');
    evidenceIds.add(evidence.id);
    ensure(!knownScoreSeriesIds || evidence.scoreSeriesIds.every(id => knownScoreSeriesIds.has(id)), 'evidence score series link');
    ensure(evidence.utilityIds.every(id => utilities.has(id) && utilities.get(id)!.regions.includes(evidence.region as CoverageRegion)), 'evidence utility link / region');
    ensure(evidence.rosterEntryIds.every(id => entries.get(id) === evidence.region), 'evidence roster link / region');
    const latestSource = evidence.sourceIds.map(id => calendarDayKst(sources.get(id)!.retrievedAt)).sort().at(-1)!;
    for (const metric of evidence.metrics) {
      ensure(object(metric) && text(metric.label) && (metric.value === null || (typeof metric.value === 'number' && Number.isFinite(metric.value)
        && (metric.value >= 0 || (evidence.coverageKind === 'forecast' && ['MW', 'GW'].includes(metric.unit as string)))))
        && ['MW', 'GW', 'projects', 'percent'].includes(metric.unit as string) && dateAt(metric.asOf, latestSource)
        && ['exact', 'approximate', 'at_least', 'greater_than'].includes(metric.qualifier as string) && texts(metric.notes), 'metric value / unit / date');
      ensure(metric.value === null || metric.unit !== 'projects' || Number.isInteger(metric.value), 'project count cannot be fractional MW');
      ensure(metric.value === null || metric.unit !== 'percent' || Number(metric.value) <= 100, 'percentage above 100');
    }
  }
  const regions = new Set<CoverageRegion>();
  for (const row of input.regions) {
    ensure(object(row) && region(row.region) && !regions.has(row.region) && refs(row.sourceIds, false) && text(row.overview) && texts(row.gaps), 'regional review');
    regions.add(row.region);
  }
  ensure(MARKET_REGIONS.every(r => regions.has(r)), 'all seven ISO/RTO regional reviews required');
  ensure(input.evidence.every(e => regions.has(e.region)) && input.rosters.every(r => regions.has(r.region)), 'evidence / roster region lacks review');
}

export function isLoadCoverageDataset(input: unknown): input is LoadCoverageDataset {
  try { validateLoadCoverageDataset(input); return true; } catch { return false; }
}
export function parseLoadCoverageFilters(params: URLSearchParams): LoadCoverageFilters {
  const result: LoadCoverageFilters = {};
  for (const [key, values] of Object.entries({ region: ['all', ...COVERAGE_REGIONS], kind: ['all', ...COVERAGE_KINDS],
    status: ['all', 'reviewed', 'not_reviewed'], geographicScope: ['all', 'mainland', 'nonmainland', 'mixed', 'unresolved'] })) {
    if (!params.has(key)) continue;
    const value = params.get(key)!;
    if (!values.includes(value) || params.getAll(key).length !== 1) throw new RangeError(`Invalid coverage ${key}`);
    Object.assign(result, { [key]: value });
  }
  if (params.has('q')) {
    const q = params.get('q')!.trim();
    if (q.length > 300 || params.getAll('q').length !== 1) throw new RangeError('Invalid coverage search');
    result.q = q;
  }
  return result;
}
const matchesText = (q: string | undefined, values: string[]) => !q || values.some(v => v.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
export function coverageUtilityStatus(data: LoadCoverageDataset, utility: CoverageUtility | string, regionFilter?: CoverageRegion | 'all'): CoverageStatus {
  const id = typeof utility === 'string' ? utility : utility.id;
  return data.evidence.some(e => e.utilityIds.includes(id) && (!regionFilter || regionFilter === 'all' || e.region === regionFilter)) ? 'reviewed' : 'not_reviewed';
}
export function filterCoverageUtilities(data: LoadCoverageDataset, filters: LoadCoverageFilters = {}): CoverageUtility[] {
  const reviewedIds = new Set(data.evidence.filter(e => (!filters.region || filters.region === 'all' || e.region === filters.region)
    && (!filters.kind || filters.kind === 'all' || e.coverageKind === filters.kind)).flatMap(e => e.utilityIds));
  return data.universe.utilities.filter(u => (!filters.region || filters.region === 'all' || u.regions.includes(filters.region))
    && (!filters.geographicScope || filters.geographicScope === 'all' || u.geographicScope === filters.geographicScope)
    && (!filters.status || filters.status === 'all' || (reviewedIds.has(u.id) ? 'reviewed' : 'not_reviewed') === filters.status)
    && (!filters.kind || filters.kind === 'all' || reviewedIds.has(u.id))
    && matchesText(filters.q, [u.id, u.name, ...u.states, ...u.roles, ...u.serviceTypes, ...u.associations.flatMap(a => [a.code, a.name ?? ''])]));
}
export function filterCoverageEvidence(data: LoadCoverageDataset, filters: LoadCoverageFilters = {}): CoverageEvidence[] {
  const geographicIds = new Set(data.universe.utilities.filter(u => !filters.geographicScope || filters.geographicScope === 'all' || u.geographicScope === filters.geographicScope).map(u => u.id));
  return data.evidence.filter(e => (!filters.region || filters.region === 'all' || e.region === filters.region)
    && (!filters.kind || filters.kind === 'all' || e.coverageKind === filters.kind) && filters.status !== 'not_reviewed'
    && (!filters.geographicScope || filters.geographicScope === 'all' || e.utilityIds.some(id => geographicIds.has(id)))
    && matchesText(filters.q, [e.id, e.name, e.provider, e.scope, ...e.metrics.map(m => m.label), ...e.utilityIds, ...e.rosterEntryIds]));
}
export function summarizeCoverage(data: LoadCoverageDataset, filters: LoadCoverageFilters = {}) {
  const utilities = filterCoverageUtilities(data, filters), evidence = filterCoverageEvidence(data, filters);
  const linkedUtilities = new Set(data.evidence.filter(e => (!filters.region || filters.region === 'all' || e.region === filters.region)
    && (!filters.kind || filters.kind === 'all' || e.coverageKind === filters.kind)).flatMap(e => e.utilityIds));
  const rosters = data.rosters.filter(r => !filters.region || filters.region === 'all' || r.region === filters.region);
  const entries = new Set(rosters.flatMap(r => r.entries.map(e => e.id))), linkedEntries = new Set(evidence.flatMap(e => e.rosterEntryIds));
  const reviewedUtilityCount = utilities.filter(u => linkedUtilities.has(u.id)).length;
  return { utilityCount: utilities.length, reviewedUtilityCount, unreviewedUtilityCount: utilities.length - reviewedUtilityCount,
    evidenceCount: evidence.length, rosterEntryCount: entries.size, reviewedRosterEntryCount: [...entries].filter(id => linkedEntries.has(id)).length,
    sourceCount: new Set([...evidence.flatMap(e => e.sourceIds), ...rosters.flatMap(r => r.sourceIds),
      ...utilities.flatMap(u => [...u.sourceEvidence.map(s => s.sourceId), ...u.associations.map(a => a.sourceId)])]).size };
}

/** Heterogeneous rows retain units and sources; totals across rows are deliberately absent. */
export function loadCoverageCsv(data: LoadCoverageDataset, filters: LoadCoverageFilters = {}): string {
  const headers = ['row_type', 'id', 'region', 'name', 'provider', 'review_status', 'geographic_scope', 'states', 'kind', 'scope',
    'metric_label', 'value', 'unit', 'qualifier', 'metric_as_of', 'utility_ids', 'roster_entry_ids', 'score_series_ids',
    'source_ids', 'source_urls', 'source_as_of', 'source_published_at', 'source_retrieved_at', 'source_sha256', 'source_locators', 'notes'];
  const sourceMap = new Map(data.sources.map(s => [s.id, s]));
  const rows: unknown[][] = [];
  const provenance = (ids: string[]) => { const sources = ids.map(id => sourceMap.get(id)!); return [ids.join('|'), sources.map(s => s.url).join('|'),
    sources.map(s => s.sourceAsOf ?? '').join('|'), sources.map(s => s.publishedAt ?? '').join('|'), sources.map(s => s.retrievedAt).join('|'), sources.map(s => s.sha256).join('|')]; };
  for (const u of filterCoverageUtilities(data, filters)) {
    const proofs = [...u.sourceEvidence, ...u.associations.map(a => ({ sourceId: a.sourceId, locator: a.locator }))];
    const ids = [...new Set(proofs.map(p => p.sourceId))];
    rows.push(['utility', u.id, u.regions.join('|'), u.name, '', coverageUtilityStatus(data, u, filters.region), u.geographicScope, u.states.join('|'),
      u.roles.join('|'), data.universe.scope, '', '', '', '', '', u.id, '', '', ...provenance(ids), proofs.map(p => `${p.sourceId}: ${p.locator}`).join(' | '),
      [...u.notes, 'reviewed means explicit linked research; it is not full project coverage.'].join(' | ')]);
  }
  for (const e of filterCoverageEvidence(data, filters)) {
    const metrics = e.metrics.length ? e.metrics : [null];
    for (const m of metrics) rows.push(['evidence', e.id, e.region, e.name, e.provider, 'reviewed', '', '', e.coverageKind, e.scope,
      m?.label, m?.value, m?.unit, m?.qualifier, m?.asOf, e.utilityIds.join('|'), e.rosterEntryIds.join('|'), e.scoreSeriesIds.join('|'),
      ...provenance(e.sourceIds), '', [...e.gaps, ...(m?.notes ?? [])].join(' | ')]);
  }
  const csv = (value: unknown) => { const raw = value === null || value === undefined ? '' : String(value);
    const safe = typeof value === 'string' && /^[\s]*[=+\-@]|^[\t\r\n]/.test(raw) ? "'" + raw : raw; return '"' + safe.replaceAll('"', '""') + '"'; };
  return '\uFEFF' + [headers.join(','), ...rows.map(row => row.map(csv).join(','))].join('\r\n');
}
