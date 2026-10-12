/** Deterministic, source-preserving customer census. No database/network writes. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Project, Source } from '../shared/types.ts';
import type { LoadPipelineDataset, PipelineProject } from '../shared/market-types.ts';
import type { LoadCoverageDataset } from '../shared/load-coverage.ts';
import { matchingReviewedLoadProject } from '../shared/reviewed-load-projects.ts';
import { CENSUS_FAMILIES, censusAdditiveStatus, censusCanonicalJson, resolveCensusCapacity, summarizeCensus, validateLoadProjectCensus,
  type CensusCapacityFact, type CensusDecision, type CensusEntity, type CensusEntityInput, type CensusEvidence, type CensusFragment,
  type CensusRawKind, type CensusRawRecord, type CensusSourceFamily, type CensusStatus, type LoadProjectCensus } from '../shared/load-project-census.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
const isInstant = (v: unknown): v is string => typeof v === 'string' && /T.*Z$/.test(v) && Number.isFinite(Date.parse(v));
interface CensusBootstrap { projects: Project[]; sources: Source[]; provenance?: { sourceRefreshes?: Array<{ sourceId: string; sourceUrl: string; retrievedAt: string; sourceSha256: string }>; reviewedLoadImports?: Array<{ generatedAt: string }> }; }
export interface CensusBuildInput { bootstrap: CensusBootstrap; pipeline: LoadPipelineDataset; coverage: LoadCoverageDataset; fragments?: CensusFragment[]; manifests?: LoadProjectCensus['inputs']; generatedAt?: string; }
const REQUEST_SOURCES = new Set(['nyiso-load-register', 'california-pge-industrial-register', 'california-sdge-register', 'gpc-main-register', 'pjm-aes-contract-table', 'isone-selected-forecast']);
const SUPPORT_SOURCES = new Set(['pjm-m3-support', 'bpa-ll-register', 'miso-mtep-approved', 'miso-mtep-evaluation', 'spp-dpns-reports']);
function family(sourceId: string, url: string): CensusSourceFamily {
  if (/nyiso|miso-mtep|pjm-m3|bpa-|spp-|isone-/.test(sourceId)) return 'transmission';
  if (/california-pge|california-sdge|pjm-aes|gpc-main|gpc-removed/.test(sourceId)) return 'utility';
  // A company's release can mention a regulator in its path; that does not
  // change the publisher. Contract-related source IDs do not identify an issuer.
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* source validation reports malformed URLs */ }
  if (/(^|\.)(puc|psc|cpuc|dcpsc|floridapsc|wvpsc|iurc|scc|ferc)(\.|$)/.test(hostname)) return 'puc';
  return 'customer';
}
function rawKind(project: Project, source: Source | undefined): CensusRawKind {
  const review = matchingReviewedLoadProject(project);
  if (project.eligible || REQUEST_SOURCES.has(project.sourceId)) return 'customer_request';
  if (project.sourceId === 'spp-dpa-history' || project.sourceId === 'gpc-removed-screen') return 'historical';
  if (SUPPORT_SOURCES.has(project.sourceId)) return 'transmission_support';
  if (review?.identityBasis === 'grouped_case' || review?.identityBasis === 'unresolved') return 'grouped_case';
  if (review) return review.identityBasis === 'official_permit_only' ? 'named_development' : 'customer_request';
  if (source?.coverage === 'case') return 'grouped_case';
  return 'unclassified';
}
function status(project: Project): CensusStatus {
  if (project.status === 'operational') return 'operating';
  if (project.status === 'withdrawn') return 'withdrawn';
  const review = matchingReviewedLoadProject(project);
  if (project.status === 'active') {
    if (review?.stage === 'construction' || project.rawStatus === 'Under Construction') return 'construction';
    if (review?.stage === 'ia_executed') return 'contracted';
    if (review?.stage && !['not_started', 'scoping_pending'].includes(review.stage) || /^SRIS\/SIS|^FS /.test(project.rawStatus)) return 'study';
    return 'application';
  }
  return 'unknown';
}
function pipelineStatus(p: PipelineProject): CensusStatus {
  if (p.status === 'operating' || p.status === 'withdrawn' || p.status === 'construction') return p.status;
  if (p.status === 'active') return p.classification === 'contract' ? 'contracted' : 'application';
  return p.status === 'planned' ? 'announced' : 'unknown';
}
function emptyEntity(id: string, name: string, region: string): CensusEntity {
  return { id, name, region, state: null, kind: 'unresolved_named_development', customer: null, utility: null, utilityIds: [], location: null,
    status: 'unknown', asOf: null, connectionBasis: 'unknown', rawRefIds: [], evidenceIds: [], capacityFacts: [], aliases: [], relatedSupportRecordIds: [], possibleDuplicateIds: [], parentEntityId: null, scoreProjectId: null, limitations: [], knownGridMw: null, capacityConflict: false, additiveStatus: 'unknown_capacity' };
}

export function buildLoadProjectCensus(input: CensusBuildInput): LoadProjectCensus {
  const { bootstrap, pipeline, coverage } = input;
  const fragments = [...(input.fragments ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(fragments.map(f => f.id)).size !== fragments.length) throw new Error('Duplicate census fragment ID');
  // Reviewed records are derived from these original artifacts. Preserve the
  // reviewed publisher classification only for an exact URL + source hash,
  // and do not choose arbitrarily when original reviews disagree.
  const originalFamilies = new Map<string, Set<CensusSourceFamily>>();
  for (const fragment of fragments) for (const source of fragment.evidence) if (source.sha256) {
    const key = source.url + ':' + source.sha256;
    const families = originalFamilies.get(key) ?? new Set<CensusSourceFamily>();
    families.add(source.sourceFamily); originalFamilies.set(key, families);
  }
  function sourceFamily(sourceId: string, url: string, sha256: string | null): CensusSourceFamily {
    const original = sha256 ? originalFamilies.get(url + ':' + sha256) : undefined;
    return original?.size === 1 ? [...original][0] : family(sourceId, url);
  }
  const times = [pipeline.generatedAt, coverage.generatedAt, ...(bootstrap.provenance?.reviewedLoadImports ?? []).map(v => v.generatedAt), ...fragments.map(f => f.generatedAt)].filter(isInstant).map(t => new Date(t).toISOString());
  const generatedAt = input.generatedAt ?? times.sort().at(-1);
  if (!generatedAt) throw new Error('Census needs an actual source/review generation timestamp');
  const evidence = new Map<string, CensusEvidence>(), raws = new Map<string, CensusRawRecord>(), entities = new Map<string, CensusEntity>();
  const decisions: CensusDecision[] = [], aliases = new Map<string, { canonicalId: string; decisionId: string }>();
  const sourceMap = new Map(bootstrap.sources.map(s => [s.id, s]));
  function addEvidence(value: CensusEvidence): string {
    const old = evidence.get(value.id);
    if (old && censusCanonicalJson(old) !== censusCanonicalJson(value)) throw new Error(`Conflicting evidence ID: ${value.id}`);
    evidence.set(value.id, structuredClone(value)); return value.id;
  }
  function addRaw(value: CensusRawRecord): void { if (raws.has(value.id)) throw new Error(`Duplicate raw record: ${value.id}`); raws.set(value.id, value); }
  function resolveId(id: string): string { const visited = new Set<string>(); while (aliases.has(id)) { if (visited.has(id)) throw new Error('Canonical alias cycle'); visited.add(id); id = aliases.get(id)!.canonicalId; } return id; }
  function merge(targetId: string, oldId: string, decisionId: string): void {
    targetId = resolveId(targetId); oldId = resolveId(oldId); if (targetId === oldId) return;
    const target = entities.get(targetId), old = entities.get(oldId);
    if (!target || !old) throw new Error(`Unknown merge entity: ${targetId} / ${oldId}`);
    for (const key of ['rawRefIds', 'evidenceIds', 'utilityIds', 'relatedSupportRecordIds', 'possibleDuplicateIds', 'limitations'] as const) target[key] = union(target[key], old[key]);
    target.aliases = union(target.aliases, [old.name, ...old.aliases].filter(name => name !== target.name));
    for (const fact of old.capacityFacts) { const prior = target.capacityFacts.find(f => f.id === fact.id); if (prior && censusCanonicalJson(prior) !== censusCanonicalJson(fact)) throw new Error(`Conflicting capacity fact ${fact.id}`); if (!prior) target.capacityFacts.push(fact); }
    target.scoreProjectId ??= old.scoreProjectId;
    for (const id of old.rawRefIds) raws.get(id)!.entityId = targetId;
    aliases.set(oldId, { canonicalId: targetId, decisionId }); entities.delete(oldId);
  }
  function projectEvidence(p: Project): string[] {
    const source = sourceMap.get(p.sourceId), review = matchingReviewedLoadProject(p);
    if (review) return review.sourceEvidence.map(e => addEvidence({ ...e, id: 'reviewed:' + hash(e.url + ':' + e.sha256 + ':' + e.excerpt).slice(0, 24), sourceFamily: sourceFamily(p.sourceId, e.url, e.sha256), limitations: [] }));
    const acquisition = [...(bootstrap.provenance?.sourceRefreshes ?? [])].reverse().find(s => s.sourceId === p.sourceId && s.sourceUrl === p.sourceUrl);
    const id = 'legacy-source:' + hash(p.sourceId + ':' + p.sourceUrl + ':' + p.sourceAsOf).slice(0, 24);
    return [addEvidence({ id, name: source?.name ?? p.sourceId, url: p.sourceUrl, sourceFamily: sourceFamily(p.sourceId, p.sourceUrl, acquisition?.sourceSha256 ?? null),
      retrievedAt: acquisition?.retrievedAt ?? (isInstant(source?.lastCheckedAt) ? source!.lastCheckedAt : null), sha256: acquisition?.sourceSha256 ?? null,
      publishedAt: null, sourceAsOf: p.sourceAsOf, excerpt: 'Imported source record; original row fields are preserved in rawRecords.payload.',
      limitations: ['기존 원장 자료이며 이번 빌드가 새 원문 취득을 뜻하지 않습니다.', ...(!acquisition ? ['원문 SHA-256 미확보. 입력 JSON 해시는 원문 해시와 구분합니다.'] : []), ...(source?.lastCheckedAt && !isInstant(source.lastCheckedAt) ? [`기존 확인일 ${source.lastCheckedAt}; 정확한 취득 시각은 미상입니다.`] : [])] })];
  }
  const promoted: Project[] = [];
  for (const p of [...bootstrap.projects].filter(p => p.types.includes('load')).sort((a, b) => a.id.localeCompare(b.id))) {
    const rawId = 'bootstrap:' + p.id, source = sourceMap.get(p.sourceId), kind = rawKind(p, source), evidenceIds = projectEvidence(p);
    addRaw({ id: rawId, inputCollection: 'bootstrap', nativeId: p.id, name: p.name || p.sourceRecordId, region: p.region, state: p.state, status: p.status, kind, evidenceIds, entityId: null, payload: structuredClone(p) as unknown as Record<string, unknown> });
    if (p.id.startsWith('CENSUS::') && p.sourceRecordId === p.id.slice('CENSUS::'.length)) { promoted.push(p); continue; }
    if (kind !== 'customer_request' && kind !== 'named_development') continue;
    const e = emptyEntity('request:' + p.id, p.name || p.sourceRecordId, p.region), review = matchingReviewedLoadProject(p);
    Object.assign(e, { state: p.state, kind: /anonymous|비공개|service request/i.test(p.name) ? 'anonymous_service_request' : 'source_request', status: status(p), asOf: p.sourceAsOf,
      connectionBasis: p.eligible || p.sourceId === 'nyiso-load-register' || p.sourceId === 'california-pge-industrial-register' ? review?.capacityBasis === 'contracted_grid_mw' ? 'confirmed_contract' : 'confirmed_request' : 'unknown',
      rawRefIds: [rawId], evidenceIds, scoreProjectId: p.id, limitations: ['원문 신청 레코드 기준이며 다른 기관의 동일한 물리 사업과 연결이 완료되지 않았습니다.', ...(review?.limitations ?? [])] });
    const basis = review?.capacityBasis === 'contracted_grid_mw' ? 'contracted_grid' : p.eligible || p.sourceId === 'nyiso-load-register' ? 'requested_grid' : 'unknown';
    if (p.loadMw !== null) e.capacityFacts.push({ id: 'capacity:' + rawId, value: p.loadMw, unit: 'MW', basis, scope: 'entity', asOf: p.sourceAsOf, evidenceIds, note: '기존 원장의 MW 성분. 확인된 계통 요청/계약 기준만 비교 합계에 사용합니다.' });
    entities.set(e.id, e); raws.get(rawId)!.entityId = e.id;
  }
  for (const p of [...pipeline.projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const rawId = 'pipeline:' + p.id, linkedRawId = p.linkedProjectId ? 'bootstrap:' + p.linkedProjectId : null;
    const linked = linkedRawId ? raws.get(linkedRawId) : undefined;
    const kind: CensusRawKind = p.classification === 'grid_support' ? 'transmission_support' : p.classification === 'historical' ? 'historical' : p.classification === 'announced' ? 'named_development' : linked?.kind ?? 'customer_request';
    let evidenceIds = linked?.evidenceIds ?? [];
    if (!evidenceIds.length) evidenceIds = [addEvidence({ id: 'legacy-pipeline:' + hash(p.sourceUrl + ':' + p.sourceAsOf + ':' + p.sourceName).slice(0, 24), name: p.sourceName, url: p.sourceUrl, sourceFamily: family('', p.sourceUrl), retrievedAt: isInstant(p.checkedAt) ? p.checkedAt : null,
      sha256: null, publishedAt: null, sourceAsOf: p.sourceAsOf, excerpt: 'Existing researched pipeline record; the original explanation and caveats remain in rawRecords.payload.', limitations: ['기존 조사 링크이며 원문 해시·정확한 취득시각이 없으면 미상으로 유지합니다.'] })];
    addRaw({ id: rawId, inputCollection: 'pipeline', nativeId: p.id, name: p.name, region: p.region, state: p.state, status: p.status, kind, evidenceIds, entityId: null, payload: structuredClone(p) as unknown as Record<string, unknown> });
    if (linked?.nativeId.startsWith('CENSUS::')) continue;
    let e = linked?.entityId ? entities.get(linked.entityId) : undefined;
    if (!e && !linked && (kind === 'customer_request' || kind === 'named_development')) {
      e = emptyEntity('development:' + p.id, p.name, p.region);
      Object.assign(e, { state: p.state, status: pipelineStatus(p), asOf: p.sourceAsOf, kind: 'unresolved_named_development',
        connectionBasis: p.classification === 'application' ? 'confirmed_request' : p.classification === 'contract' ? 'confirmed_contract' : 'announced', limitations: [...p.caveats, '실명 조사 기록의 단일 부지·다른 원장과의 관계는 추가 확인이 필요합니다.'] });
      entities.set(e.id, e);
    }
    if (!e) continue;
    e.rawRefIds = union(e.rawRefIds, [rawId]); e.evidenceIds = union(e.evidenceIds, evidenceIds); e.aliases = union(e.aliases, p.name === e.name ? [] : [p.name]); raws.get(rawId)!.entityId = e.id;
    if (p.capacityMw !== null) {
      const basis = ({ requested_grid_mw: 'requested_grid', contracted_grid_mw: 'contracted_grid', site_power_mw: 'site_power', it_mw: 'it_power', generation_mw: 'generation', mixed_mw: 'unknown', unknown: 'unknown' } as const)[p.capacityBasis];
      e.capacityFacts.push({ id: 'capacity:' + rawId, value: p.capacityMw, unit: 'MW', basis, scope: 'entity', asOf: p.sourceAsOf, evidenceIds, note: `기존 조사 자료의 ${p.capacityBasis}; 다른 문서의 MW와 합산하지 않습니다.` });
    }
    if (linked) decisions.push({ id: 'exact-link:' + p.id, kind: 'same_entity', entityIds: [e.id], rawRefIds: [linkedRawId!, rawId], evidenceIds: e.evidenceIds, reason: 'pipeline.linkedProjectId exactly matches the preserved bootstrap project ID; same source record, not a fuzzy physical-site merge.', origin: 'exact_source_record' });
  }
  for (const fragment of fragments) {
    if (fragment.schemaVersion !== 1 || !isInstant(fragment.generatedAt)) throw new Error(`Invalid census fragment: ${fragment.id}`);
    for (const e of fragment.evidence) addEvidence(e);
  }
  for (const fragment of fragments) for (const patch of fragment.entities) {
    if (!patch.id) throw new Error(`Missing research entity ID in ${fragment.id}`);
    const rawRefIds = patch.rawRefIds ?? [];
    for (const id of rawRefIds) if (!raws.has(id)) throw new Error(`Unknown exact raw reference ${id} in ${fragment.id}`);
    const owners = [...new Set(rawRefIds.map(id => raws.get(id)!.entityId).filter((id): id is string => !!id).map(resolveId))];
    const targetId = resolveId(patch.id), oldTarget = entities.get(targetId), otherOwners = owners.filter(id => id !== targetId);
    const explicit = fragment.decisions.find(d => d.kind === 'same_entity' && d.entityIds[0] === patch.id && otherOwners.every(owner => d.entityIds.includes(owner) || d.rawRefIds.some(raw => raws.get(raw)?.entityId === owner)));
    if ((owners.length > 1 || oldTarget && otherOwners.length) && !explicit) throw new Error(`Multiple source records require an explicit same_entity review: ${patch.id}`);
    let e = oldTarget;
    if (!e) {
      const base = owners.length === 1 ? entities.get(owners[0]) : null;
      const rawBase = rawRefIds.map(id => raws.get(id)!).find(raw => patch.id === 'request:' + raw.nativeId);
      if (!base && ((!patch.name && !rawBase?.name) || (!patch.region && !rawBase?.region))) throw new Error(`New census entity needs name and region: ${patch.id}`);
      e = base ? { ...structuredClone(base), id: patch.id, rawRefIds: [] } : emptyEntity(patch.id, patch.name ?? rawBase!.name, patch.region ?? rawBase!.region);
      if (!base && rawBase) Object.assign(e, { state: rawBase.state, evidenceIds: rawBase.evidenceIds, scoreProjectId: rawBase.inputCollection === 'bootstrap' ? rawBase.nativeId : null });
      entities.set(e.id, e);
    }
    const lists = new Set(['rawRefIds', 'evidenceIds', 'utilityIds', 'aliases', 'relatedSupportRecordIds', 'possibleDuplicateIds', 'limitations']);
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || value === undefined) continue;
      if (lists.has(key)) Object.assign(e, { [key]: union((e as unknown as Record<string, string[]>)[key], value as string[]) });
      else if (key === 'capacityFacts') { for (const f of value as CensusCapacityFact[]) { const old = e.capacityFacts.find(v => v.id === f.id); if (old && censusCanonicalJson(old) !== censusCanonicalJson(f)) throw new Error(`Conflicting capacity fact ${f.id}`); if (!old) e.capacityFacts.push(structuredClone(f)); } }
      else Object.assign(e, { [key]: value });
    }
    const decisionId = explicit?.id ?? `exact-research:${fragment.id}:${patch.id}`;
    for (const owner of otherOwners) merge(e.id, owner, decisionId);
    if (otherOwners.length && !explicit) decisions.push({ id: decisionId, kind: 'same_entity', entityIds: [e.id, ...otherOwners], rawRefIds, evidenceIds: e.evidenceIds,
      reason: 'Research entity explicitly references the same preserved source record; canonical ID replacement/enrichment is reversible through entityAliases.', origin: 'exact_source_record', sourceFragmentId: fragment.id });
    for (const id of rawRefIds) raws.get(id)!.entityId = e.id;
    if (!e.rawRefIds.length) {
      const id = `research:${fragment.id}:${patch.id}`;
      addRaw({ id, inputCollection: 'research', nativeId: patch.id, name: e.name, region: e.region, state: e.state, status: e.status, kind: ['confirmed_request', 'confirmed_contract'].includes(e.connectionBasis) ? 'customer_request' : 'named_development', evidenceIds: e.evidenceIds, entityId: e.id, payload: structuredClone(patch) as unknown as Record<string, unknown> });
      e.rawRefIds.push(id);
    }
  }
  for (const fragment of fragments) for (const original of fragment.decisions) {
    const d = { ...structuredClone(original), origin: 'explicit_review' as const, sourceFragmentId: fragment.id };
    if (!d.evidenceIds.length || !d.reason.trim()) throw new Error(`Decision requires evidence and reason: ${d.id}`);
    decisions.push(d);
    const targetId = resolveId(d.entityIds[0]), target = entities.get(targetId);
    if (!target) throw new Error(`Unknown decision target ${d.entityIds[0]}`);
    if (d.kind === 'same_entity') {
      const candidates = union(d.entityIds.slice(1), d.rawRefIds.map(id => raws.get(id)?.entityId ?? '').filter(Boolean));
      for (const id of candidates) if (resolveId(id) !== targetId) merge(targetId, id, d.id);
      for (const id of d.rawRefIds) { const raw = raws.get(id); if (!raw) throw new Error(`Unknown decision raw record ${id}`); raw.entityId = targetId; target.rawRefIds = union(target.rawRefIds, [id]); }
    } else if (d.kind === 'possible_duplicate') {
      const resolved = [...new Set(d.entityIds.map(resolveId))];
      for (const id of resolved) { const e = entities.get(id); if (!e) throw new Error(`Unknown possible duplicate ${id}`); e.possibleDuplicateIds = union(e.possibleDuplicateIds, resolved.filter(other => other !== id)); }
    } else if (d.kind === 'expansion_of') {
      if (d.entityIds.length !== 2) throw new Error(`Expansion decision must list child then parent: ${d.id}`);
      target.parentEntityId = resolveId(d.entityIds[1]);
    } else target.relatedSupportRecordIds = union(target.relatedSupportRecordIds, d.rawRefIds);
  }
  // Verified-score promotion stores the canonical ID verbatim, so rebuilding cannot duplicate it.
  for (const p of promoted) {
    const id = resolveId(p.sourceRecordId), e = entities.get(id);
    if (!e) throw new Error(`Promoted core record has no census entity: ${p.id}`);
    const rawId = 'bootstrap:' + p.id, linked = pipeline.projects.filter(row => row.linkedProjectId === p.id).map(row => 'pipeline:' + row.id);
    e.rawRefIds = union(e.rawRefIds, [rawId, ...linked]); e.evidenceIds = union(e.evidenceIds, raws.get(rawId)!.evidenceIds); e.scoreProjectId = p.id;
    for (const raw of [rawId, ...linked]) raws.get(raw)!.entityId = id;
    decisions.push({ id: 'exact-promoted:' + p.id, kind: 'same_entity', entityIds: [id], rawRefIds: [rawId, ...linked], evidenceIds: e.evidenceIds,
      reason: 'Core CENSUS::<canonical ID> and sourceRecordId exactly preserve the canonical entity identity; score linkage adds no entity.', origin: 'exact_source_record' });
  }
  for (const e of entities.values()) {
    e.parentEntityId = e.parentEntityId ? resolveId(e.parentEntityId) : null;
    e.possibleDuplicateIds = [...new Set(e.possibleDuplicateIds.map(resolveId))].filter(id => id !== e.id).sort();
    for (const other of e.possibleDuplicateIds) { const target = entities.get(other); if (!target) throw new Error(`Unknown duplicate entity ${other}`); target.possibleDuplicateIds = union(target.possibleDuplicateIds, [e.id]); }
  }
  for (const e of entities.values()) { Object.assign(e, resolveCensusCapacity(e)); e.additiveStatus = censusAdditiveStatus(e); e.capacityFacts.sort((a, b) => a.id.localeCompare(b.id)); }
  const attempts = fragments.flatMap(f => f.attempts).map(value => structuredClone(value)).sort((a, b) => a.id.localeCompare(b.id));
  const utilities = coverage.universe.utilities.map(u => {
    const related = attempts.filter(a => a.utilityIds.includes(u.id));
    return { id: u.id, name: u.name, states: u.states, regions: u.regions, geographicScope: u.geographicScope,
      referenceEvidenceIds: coverage.evidence.filter(e => e.utilityIds.includes(u.id)).map(e => e.id).sort(), attemptIds: related.map(a => a.id),
      familyStatus: Object.fromEntries(CENSUS_FAMILIES.map(f => [f, [...related.filter(a => a.sourceFamily === f)].sort((a, b) => (a.checkedAt ?? '').localeCompare(b.checkedAt ?? '') || a.id.localeCompare(b.id)).at(-1)?.status ?? 'queued'])) as Record<CensusSourceFamily, 'reviewed' | 'fetch_failed' | 'queued' | 'not_public'> };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const result: LoadProjectCensus = { schemaVersion: 1, generatedAt, inputs: [...(input.manifests ?? [])].sort((a, b) => a.id.localeCompare(b.id)), evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)), rawRecords: [...raws.values()].sort((a, b) => a.id.localeCompare(b.id)), entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)), decisions: decisions.sort((a, b) => a.id.localeCompare(b.id)),
    entityAliases: [...aliases].map(([aliasId, v]) => ({ aliasId, canonicalId: resolveId(v.canonicalId), decisionId: v.decisionId })).sort((a, b) => a.aliasId.localeCompare(b.aliasId)), attempts, survey: { utilities,
      limitations: ['EIA 신고기관 명부는 프로젝트 수·물리적 송배전회사 수와 다릅니다.', '명부 포함과 기존 출처 연결은 웹사이트 방문이나 수용가 원장 전수 조사를 뜻하지 않습니다. 실제 조사 기록이 없는 기관·자료군은 대기 중입니다.'] },
    limitations: union(['공식 신청·계약, 실명 개발 발표, 추론 후보와 상태 미확인을 구분한 조사 원장입니다. 전국 전수 확보나 모든 물리 사업의 식별 완료를 보장하지 않습니다.', '기존 송전 지원·과거 DPA·묶음 사례를 고객 프로젝트로 자동 전환하지 않고 원문 기록에 별도로 보존합니다.', '유사한 회사명만으로 합치지 않습니다. 의심 중복과 확장 하위 사업은 용량 합산에서 제외합니다.', '자료 추가·재분류에 따른 분모 변화를 실제 프로젝트 진척의 시계열 변화로 해석하지 않습니다.'], fragments.flatMap(f => f.limitations)) };
  validateLoadProjectCensus(result);
  return result;
}

export function runCensusBuilder(args: string[]): LoadProjectCensus {
  let output = resolve(ROOT, 'data/load-project-census.json'), checkOnly = false;
  const fragments: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') { checkOnly = true; continue; }
    if (!['--fragment', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/build-load-project-census.ts [--fragment FILE ...] [--output FILE] [--check]');
    if (args[i] === '--fragment') fragments.push(resolve(args[++i])); else output = resolve(args[++i]);
  }
  const directory = resolve(ROOT, 'data/load-project-census-fragments');
  if (!fragments.length && existsSync(directory)) fragments.push(...readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => resolve(directory, name)));
  const manifests: LoadProjectCensus['inputs'] = [];
  const read = <T>(id: string, path: string, count: (value: T) => number): T => { const bytes = readFileSync(path), value = JSON.parse(bytes.toString('utf8')) as T; manifests.push({ id, path: relative(ROOT, path), sha256: hash(bytes), records: count(value) }); return value; };
  const bootstrap = read<CensusBootstrap>('bootstrap', resolve(ROOT, 'data/bootstrap.json'), value => value.projects.filter(p => p.types.includes('load')).length);
  const pipeline = read<LoadPipelineDataset>('pipeline', resolve(ROOT, 'public/data/load-pipeline.json'), value => value.projects.length);
  const coverage = read<LoadCoverageDataset>('coverage', resolve(ROOT, 'data/load-coverage.json'), value => value.universe.utilities.length);
  const parts = fragments.map((path, index) => read<CensusFragment>('fragment:' + index, path, value => value.entities.length));
  const result = buildLoadProjectCensus({ bootstrap, pipeline, coverage, fragments: parts, manifests });
  if (checkOnly) { if (censusCanonicalJson(JSON.parse(readFileSync(output, 'utf8'))) !== censusCanonicalJson(result)) throw new Error('Census output differs from reproducible inputs'); }
  else { const temporary = output + `.tmp-${process.pid}`; try { writeFileSync(temporary, JSON.stringify(result) + '\n'); renameSync(temporary, output); } finally { try { unlinkSync(temporary); } catch { /* renamed */ } } }
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const data = runCensusBuilder(process.argv.slice(2)); process.stdout.write(JSON.stringify(summarizeCensus(data)) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
