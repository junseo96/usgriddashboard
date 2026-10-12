/** Only explicit, source-reviewed active requests enter the scoring register. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateLoadProjectCensus, type LoadProjectCensus } from '../shared/load-project-census.ts';
import { validateReviewedLoadProjects, reviewedCanonicalJson, type ReviewedLoadDataset, type ReviewedLoadProject } from '../shared/reviewed-load-projects.ts';
import type { Project, Source } from '../shared/types.ts';

export interface CensusPromotion extends Pick<ReviewedLoadProject, 'identityBasis' | 'authority' | 'docketId' | 'stage' | 'stageRationale' | 'limitations'> {
  entityId: string; eligible: true;
}
export interface CensusPromotions { schemaVersion: 1; reviewedAt: string; items: CensusPromotion[]; }

export function promoteCensus(census: LoadProjectCensus, previous: ReviewedLoadDataset, bootstrap: { projects: Project[]; sources: Source[] }, promotions: CensusPromotions): ReviewedLoadDataset {
  validateLoadProjectCensus(census); validateReviewedLoadProjects(previous);
  if (promotions.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(promotions.reviewedAt) || !Number.isFinite(Date.parse(promotions.reviewedAt)) || Date.parse(promotions.reviewedAt) > Date.now()) throw new Error('Invalid promotion review date');
  if (new Set(promotions.items.map(p => p.entityId)).size !== promotions.items.length) throw new Error('Duplicate census promotion');
  const result = structuredClone(previous);
  result.generatedAt = new Date(Math.max(Date.parse(previous.generatedAt), Date.parse(promotions.reviewedAt))).toISOString();
  const projects = new Map(result.projects.map(p => [p.id, p])), sources = new Map(result.sources.map(s => [s.id, s])), reviews = new Map(result.reviews.map(r => [r.projectId, r]));
  const originals = new Map(bootstrap.projects.map(p => [p.id, p]));
  const touched = new Set<string>();
  const promotedEntityIds = new Set(promotions.items.map(p => census.entityAliases.find(a => a.aliasId === p.entityId)?.canonicalId ?? p.entityId));
  for (const decision of promotions.items) {
    const id = census.entityAliases.find(a => a.aliasId === decision.entityId)?.canonicalId ?? decision.entityId;
    const entity = census.entities.find(e => e.id === id);
    if (!entity || decision.eligible !== true || !['confirmed_request', 'confirmed_contract'].includes(entity.connectionBasis) || !['application', 'study', 'contracted', 'construction'].includes(entity.status)) throw new Error(`Promotion needs a confirmed active request: ${id}`);
    const conflictingDuplicate = entity.possibleDuplicateIds.some(otherId => {
      const other = census.entities.find(e => e.id === otherId)!;
      return promotedEntityIds.has(otherId) || [other.scoreProjectId, ...other.rawRefIds.filter(ref => ref.startsWith('bootstrap:')).map(ref => ref.slice(10))].some(pid => pid && originals.get(pid)?.eligible);
    });
    if (conflictingDuplicate || entity.parentEntityId) throw new Error(`Resolve duplicate/component scope before scoring promotion: ${id}`);
    const acquiredEvidence = entity.evidenceIds.map(eid => census.evidence.find(e => e.id === eid)!).filter(e => e.retrievedAt && e.sha256 && e.excerpt);
    // Rebuilding the census also imports this file's derived review excerpts. Use the
    // original investigation evidence when available to avoid recursive quote growth.
    const originalEvidence = acquiredEvidence.filter(e => !/^(reviewed:|legacy-source:|legacy-pipeline:)/.test(e.id));
    const evidence = originalEvidence.length ? originalEvidence : acquiredEvidence;
    if (!evidence.length) throw new Error(`No acquired source evidence: ${id}`);
    const groupedEvidence = new Map<string, typeof evidence>();
    for (const source of evidence) { const key = `${source.url}|${source.sha256}`; groupedEvidence.set(key, [...(groupedEvidence.get(key) ?? []), source]); }
    const sourceEvidence = [...groupedEvidence.values()].map(group => {
      const e = group[0];
      const agreedDate = (key: 'publishedAt' | 'sourceAsOf') => { const dates = [...new Set(group.map(s => s[key]).filter(v => v !== null))]; return dates.length === 1 ? dates[0]! : null; };
      return { url: e.url, name: e.name, retrievedAt: new Date(Math.max(...group.map(s => Date.parse(s.retrievedAt!)))).toISOString(), sha256: e.sha256!, publishedAt: agreedDate('publishedAt'), sourceAsOf: agreedDate('sourceAsOf'), excerpt: [...new Set(group.map(s => s.excerpt))].join('\n\n') };
    });
    const original = entity.scoreProjectId ? originals.get(entity.scoreProjectId) ?? projects.get(entity.scoreProjectId) : originals.get(`CENSUS::${id}`);
    const projectId = original?.id ?? `CENSUS::${id}`;
    if (touched.has(projectId)) throw new Error(`Two promotions resolve to same scoring project: ${projectId}`);
    touched.add(projectId);
    const sourceId = original?.sourceId ?? `census-official-load-${entity.region.toLowerCase()}`;
    const primary = evidence.find(e => e.sourceFamily === 'utility' || e.sourceFamily === 'puc') ?? evidence[0];
    const knownMw = entity.capacityConflict ? null : entity.knownGridMw;
    const project: Project = {
      id: projectId, sourceId, sourceRecordId: original?.sourceRecordId ?? id, name: entity.name, types: ['load'], region: entity.region, state: entity.state,
      status: 'active', generationMw: null, storageMw: null, loadMw: knownMw, capacityStatus: knownMw === null ? 'unknown' : 'known', eligible: true, exclusionReason: null,
      sourceUrl: primary.url, sourceAsOf: entity.asOf, rawStatus: original?.rawStatus || primary.excerpt.slice(0, 2000), identityScope: 'source_record',
    };
    projects.set(projectId, project);
    const capacityBasis = knownMw === null ? 'unknown' : entity.capacityFacts.some(f => f.value === knownMw && f.basis === 'contracted_grid') ? 'contracted_grid_mw' : 'requested_grid_mw';
    reviews.set(projectId, { projectId, authority: decision.authority, docketId: decision.docketId, identityBasis: decision.identityBasis, capacityBasis, stage: decision.stage, stageRationale: decision.stageRationale,
      sourceEvidence, limitations: [...new Set([...entity.limitations, ...decision.limitations, ...(entity.possibleDuplicateIds.length ? ['익명 송전 참고 기록과 동일 사업일 가능성이 있습니다. 현재 점수 분모에는 확인된 이 고객 신청만 포함하며 참고 기록을 함께 승격하지 않습니다.'] : []), '통합 조사 원장의 검토된 활성 신청입니다. 추정 점수의 다섯 진행률은 공통 모형 가정이며 개별 요건의 직접 확인을 뜻하지 않습니다.'])].sort() });
    if (!sources.has(sourceId)) {
      const originalSource = bootstrap.sources.find(s => s.id === sourceId);
      sources.set(sourceId, originalSource ? structuredClone(originalSource) : { id: sourceId, name: `${entity.region} 공식 공급 신청·계약 교차 조사`, region: entity.region, types: ['load'], url: primary.url, coverage: 'case', sourceAsOf: null, lastCheckedAt: result.generatedAt, refreshCadence: 'monthly', recordCount: null, gaps: ['유틸리티·규제기관·송전계획·고객 공시에서 개별 확인한 범위. 전국·권역 전수가 아니며 현재 단계 미확인은 미산출.'], adapter: null });
    }
    // Same-entity decisions preserve each old row but eliminate duplicate active denominators.
    const otherIds = entity.rawRefIds.filter(ref => ref.startsWith('bootstrap:')).map(ref => ref.slice('bootstrap:'.length)).filter(other => other !== projectId);
    for (const otherId of otherIds) {
      const other = originals.get(otherId);
      if (!other?.eligible || !other.types.includes('load')) continue;
      projects.set(otherId, { ...other, eligible: false, exclusionReason: `통합 원장 ${id}의 동일 사업. 활성 분모는 ${projectId}에서 한 번 집계.` });
      reviews.set(otherId, { ...reviews.get(projectId)!, projectId: otherId, stage: null, capacityBasis: other.loadMw === null ? 'unknown' : reviews.get(otherId)?.capacityBasis ?? 'requested_grid_mw', stageRationale: `동일 사업의 중복 원문 기록입니다. ${projectId}에서 평가합니다.` });
      if (!sources.has(other.sourceId)) sources.set(other.sourceId, structuredClone(bootstrap.sources.find(s => s.id === other.sourceId)!));
    }
  }
  result.projects = [...projects.values()]; result.reviews = [...reviews.values()]; result.sources = [...sources.values()];
  const merged = new Map(bootstrap.projects.map(p => [p.id, p])); for (const p of result.projects) merged.set(p.id, p);
  for (const source of result.sources) source.recordCount = [...merged.values()].filter(p => p.sourceId === source.id).length;
  result.limitations = [...new Set([...result.limitations, '통합 조사 원장 전체와 점수 산정 원장의 분모는 다릅니다. 개별적으로 확인한 활성 신청·공급계약만 검토를 거쳐 점수 산정 원장에 연결합니다.'])];
  validateReviewedLoadProjects(result);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dir = resolve(import.meta.dirname, '../data');
  const census = JSON.parse(readFileSync(resolve(dir, 'load-project-census.json'), 'utf8')) as LoadProjectCensus;
  const file = resolve(dir, 'reviewed-load-projects.json');
  const previous = JSON.parse(readFileSync(file, 'utf8')) as ReviewedLoadDataset;
  const result = promoteCensus(census, previous, JSON.parse(readFileSync(resolve(dir, 'bootstrap.json'), 'utf8')), JSON.parse(readFileSync(resolve(dir, 'load-census-promotions.json'), 'utf8')));
  if (process.argv.includes('--check')) { if (reviewedCanonicalJson(previous) !== reviewedCanonicalJson(result)) throw new Error('Census promotions differ from the reviewed scoring register'); }
  else writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ reviewed: result.projects.length, active: result.projects.filter(p => p.eligible).length, sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') }) + '\n');
}
