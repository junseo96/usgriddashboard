/** Reviewed qualitative judgements. Five-gate values are model assumptions, not assessments. */
import type { Gate, Project } from './types.ts';
import { STAGE_ESTIMATE_CATALOG, type StageEstimateDefinition } from './stage-estimate-catalog.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from './time.ts';

export const PROJECT_STAGE_INFERENCE_VERSION = 'qualitative-stage-v1' as const;
const GATES: readonly Gate[] = ['technical', 'commercial', 'permitting', 'construction', 'energization'];
const GATE_LABELS: Record<Gate, string> = { technical: '기술 검토', commercial: '계약·비용', permitting: '인허가', construction: '공사·망보강', energization: '통전' };
function model(stage: string, label: string, values: readonly number[], rationale: string): StageEstimateDefinition {
  return { stage, label, progress: Object.fromEntries(GATES.map((gate, i) => [gate, values[i]])) as Record<Gate, number>, point: values.reduce((sum, v) => sum + 20 * (1 - v), 0), rationale };
}
export const PROJECT_STAGE_INFERENCE_CATALOG: readonly StageEstimateDefinition[] = [
  ...STAGE_ESTIMATE_CATALOG,
  model('technical_scoping', '기술 범위·초기 협의 추정', [.25, .25, 0, 0, 0], '초기 기술 범위 협의의 모형 위치입니다. 실제 계통영향 연구 착수나 계약 체결을 확인했다는 뜻이 아닙니다.'),
  model('connection_design', '접속 설계 추정', [.75, .25, .25, 0, 0], '접속 설계·경로 검토를 진행 단계로 해석한 가정입니다. 설계 완료·허가 취득이나 계약 체결의 직접 증명이 아닙니다.'),
  model('grid_upgrade_planning', '망보강 계획 추정', [.75, .5, .5, 0, 0], '송전·배전 보강 계획과 비용·인허가 준비의 모형 위치이며 공사 착수를 뜻하지 않습니다.'),
  model('permitting_development', '인허가·개발 준비 추정', [.25, .25, .5, 0, 0], '부지 개발·인허가 근거를 반영한 가정입니다. 부지 허가는 계통 연구·접속 계약의 완료를 입증하지 않습니다.'),
  model('site_construction_grid_unverified', '부지 공사·계통 미확인 추정', [.5, .5, 1, .25, 0], '부지·건물 공사와 계통 공사를 구분합니다. 계통 보강 공정은 미확인이고 인허가 100% 등 다섯 진행률은 공통 모형 가정입니다.'),
  model('grid_construction', '전력 인프라 공사 추정', [.75, .75, .75, .75, 0], '해당 사업의 전력 인프라 공사 근거를 반영하되 계약·허가 전부 완료나 실제 공정률 75%를 확인했다는 뜻이 아닙니다.'),
  model('grid_support_complete', '관련 망보강 완공·수용가 운영 미확인', [.75, .75, .5, 1, .25], '관련 계통 보강설비의 완공을 반영한 모형 위치입니다. 수용가 자체의 통전·운영, 모든 공급계약 또는 부지 인허가의 완료를 입증하지 않습니다.'),
  model('energization_preparation', '통전 준비 추정', [1, 1, 1, 1, .25], '통전 준비 단계의 모형 위치입니다. 운영 승인·실제 통전 완료나 앞선 요건 전부의 직접 확인을 뜻하지 않습니다.'),
];
const BY_STAGE = new Map(PROJECT_STAGE_INFERENCE_CATALOG.map(stage => [stage.stage, stage]));

export interface StageInferenceEvidence {
  url: string; name: string; publisherKind: 'official' | 'utility' | 'customer' | 'media';
  retrievedAt: string; sha256: string; publishedAt: string | null; sourceAsOf: string | null; excerpt: string;
}
export interface StageInferenceJudgement {
  id: string; censusId: string | null; projectId: string | null; projectSnapshot: Project | null;
  evaluatedAt: string; asOf: string | null; status: 'active' | 'operating' | 'withdrawn' | 'unknown';
  statusBasis: 'explicit' | 'inferred'; stage: string | null; confidence: 'high' | 'medium' | 'low';
  bottleneck: string; rationale: string; assumptions: string[]; limitations: string[];
  identityStatus: 'clear' | 'representative' | 'possible_duplicate' | 'unresolved'; identityRationale: string;
  applyToAverage: boolean; sourceEvidence: StageInferenceEvidence[];
}
export interface StageInferenceAudit {
  id: string; censusId: string | null; projectId: string | null; evaluatedAt: string;
  outcome: 'judged' | 'no_judgement' | 'not_reviewed'; judgementId: string | null; reason: string;
}
export interface ProjectStageInferenceFragment {
  schemaVersion: 1; id: string; generatedAt: string; judgements: StageInferenceJudgement[];
  audits: StageInferenceAudit[]; limitations: string[];
}
export interface ProjectStageInferenceDataset {
  schemaVersion: 1; generatedAt: string; judgements: StageInferenceJudgement[]; audits: StageInferenceAudit[];
  inputs: Array<{ id: string; path: string; sha256: string }>; limitations: string[];
}
export interface StageInferenceQuery { asOf?: string; knownAt?: string; censusId?: string; projectId?: string; }
export interface ProjectStageInferenceEstimate {
  modelVersion: typeof PROJECT_STAGE_INFERENCE_VERSION; judgementId: string; stage: string; label: string; point: number;
  gates: Array<{ gate: Gate; progress: number; points: number; rationale: string }>;
  rationale: string; sourceUrl: string; sourceAsOf: string | null; evaluatedAt: string; confidence: StageInferenceJudgement['confidence'];
  statusBasis: StageInferenceJudgement['statusBasis']; bottleneck: string; applyToAverage: boolean;
  status: StageInferenceJudgement['status']; identityStatus: StageInferenceJudgement['identityStatus'];
  assumptions: string[]; limitations: string[]; sourceEvidence: StageInferenceEvidence[];
}

const PROJECT_FIELDS = 'id sourceId sourceRecordId name types region state status generationMw storageMw loadMw capacityStatus eligible exclusionReason sourceUrl sourceAsOf rawStatus identityScope'.split(' ');
const MAINLAND = new Set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const nullableId = (v: unknown) => v === null || text(v);
function instant(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
function sourceDate(v: unknown, cutoff: string): v is string | null { return v === null || typeof v === 'string' && (isCalendarDay(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v)) && v <= cutoff; }
function evidenceDate(v: unknown, cutoff: string): v is string | null { return sourceDate(v, cutoff) || typeof v === 'string' && /^\d{4}$/.test(v) && v <= cutoff.slice(0, 4); }
function https(v: unknown): v is string { if (!text(v)) return false; try { const url = new URL(v); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; } catch { return false; } }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error('Project stage inference: ' + message); }
export function stageInferenceCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stageInferenceCanonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stageInferenceCanonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const identityKey = (j: Pick<StageInferenceJudgement, 'censusId' | 'projectId'>) => j.censusId !== null ? 'census:' + j.censusId : 'project:' + j.projectId;
export function validateStageInferenceProjectSnapshot(project: unknown, cutoff: string): asserts project is Project {
  check(object(project) && PROJECT_FIELDS.every(key => key in project) && Object.keys(project).every(key => PROJECT_FIELDS.includes(key)), 'complete project snapshot required');
  check(['id', 'sourceId', 'sourceRecordId', 'name', 'region'].every(key => text(project[key])) && Array.isArray(project.types) && project.types.length > 0 && project.types.every(t => ['generation', 'storage', 'load'].includes(String(t))) && new Set(project.types).size === project.types.length, 'project snapshot identity');
  check(nullableId(project.state) && ['active', 'operational', 'withdrawn', 'reference', 'unknown'].includes(String(project.status)) && typeof project.eligible === 'boolean' && nullableId(project.exclusionReason) && project.identityScope === 'source_record', 'project snapshot state');
  check(['generationMw', 'storageMw', 'loadMw'].every(key => project[key] === null || typeof project[key] === 'number' && Number.isFinite(project[key]) && project[key] >= 0) && ['known', 'partial', 'unknown'].includes(String(project.capacityStatus)), 'project snapshot capacity');
  check(https(project.sourceUrl) && sourceDate(project.sourceAsOf, cutoff) && typeof project.rawStatus === 'string', 'project snapshot provenance');
}
function validateCollections(data: ProjectStageInferenceDataset | ProjectStageInferenceFragment, now: Date): void {
  check(object(data) && data.schemaVersion === 1 && instant(data.generatedAt) && Date.parse(data.generatedAt) <= now.getTime(), 'schema/generatedAt');
  check(Array.isArray(data.judgements) && Array.isArray(data.audits) && texts(data.limitations), 'collections');
  const judgements = new Map<string, StageInferenceJudgement>(), identities = new Set<string>();
  for (const j of data.judgements) {
    const fields = 'id censusId projectId projectSnapshot evaluatedAt asOf status statusBasis stage confidence bottleneck rationale assumptions limitations identityStatus identityRationale applyToAverage sourceEvidence'.split(' ');
    check(object(j) && fields.every(key => key in j) && Object.keys(j).every(key => fields.includes(key)), 'judgement fields; arbitrary model points or gate overrides are not allowed');
    check(object(j) && text(j.id) && !judgements.has(j.id) && nullableId(j.censusId) && nullableId(j.projectId) && (j.censusId !== null || j.projectId !== null), 'judgement identity');
    check(instant(j.evaluatedAt) && j.evaluatedAt <= data.generatedAt && sourceDate(j.asOf, calendarDayKst(j.evaluatedAt)), 'evaluation/source chronology');
    const key = identityKey(j) + ':' + j.evaluatedAt + ':' + j.asOf; check(!identities.has(key), 'ambiguous concurrent judgement'); identities.add(key);
    check(['active', 'operating', 'withdrawn', 'unknown'].includes(j.status) && ['explicit', 'inferred'].includes(j.statusBasis) && ['high', 'medium', 'low'].includes(j.confidence) && (j.stage === null || BY_STAGE.has(j.stage)), 'predefined stage/status/confidence');
    check(text(j.bottleneck) && text(j.rationale) && texts(j.assumptions) && (j.stage === null || j.assumptions.length > 0) && texts(j.limitations) && text(j.identityRationale) && ['clear', 'representative', 'possible_duplicate', 'unresolved'].includes(j.identityStatus) && typeof j.applyToAverage === 'boolean', 'rationale, assumptions or identity review');
    if (j.projectSnapshot !== null) { validateStageInferenceProjectSnapshot(j.projectSnapshot, calendarDayKst(j.evaluatedAt)); check(j.projectId === j.projectSnapshot.id, 'snapshot/project ID mismatch'); }
    check(j.projectSnapshot === null || j.projectId !== null, 'unlinked project snapshot');
    check(!j.applyToAverage || j.stage !== null && j.asOf !== null && j.status === 'active' && ['clear', 'representative'].includes(j.identityStatus) && j.projectSnapshot !== null && j.projectSnapshot.eligible && j.projectSnapshot.status === 'active' && MAINLAND.has(j.projectSnapshot.state ?? ''), 'average requires a dated, deduplicated, eligible active project snapshot');
    check(Array.isArray(j.sourceEvidence) && j.sourceEvidence.length > 0, 'source evidence required');
    const sources = new Set<string>();
    for (const e of j.sourceEvidence) {
      check(object(e) && https(e.url) && text(e.name) && ['official', 'utility', 'customer', 'media'].includes(e.publisherKind) && text(e.excerpt) && typeof e.sha256 === 'string' && /^[a-f0-9]{64}$/.test(e.sha256), 'source provenance');
      check(instant(e.retrievedAt) && e.retrievedAt <= j.evaluatedAt && evidenceDate(e.publishedAt, calendarDayKst(e.retrievedAt)) && evidenceDate(e.sourceAsOf, calendarDayKst(e.retrievedAt)), 'source acquisition chronology');
      const key = e.url + ':' + e.sha256; check(!sources.has(key), 'duplicate source artifact'); sources.add(key);
    }
    judgements.set(j.id, j);
  }
  const auditIds = new Set<string>(), audited = new Set<string>();
  for (const audit of data.audits) {
    check(object(audit) && text(audit.id) && !auditIds.has(audit.id) && nullableId(audit.censusId) && nullableId(audit.projectId) && (audit.censusId !== null || audit.projectId !== null) && instant(audit.evaluatedAt) && audit.evaluatedAt <= data.generatedAt && text(audit.reason), 'audit identity or chronology'); auditIds.add(audit.id);
    check(['judged', 'no_judgement', 'not_reviewed'].includes(audit.outcome), 'audit outcome');
    if (audit.outcome !== 'judged') check(audit.judgementId === null, 'unjudged audit cannot reference a judgement');
    else {
      const j = audit.judgementId ? judgements.get(audit.judgementId) : undefined;
      check(j && j.censusId === audit.censusId && j.projectId === audit.projectId && j.evaluatedAt === audit.evaluatedAt && !audited.has(j.id), 'audit must reference its exact judgement once'); audited.add(j.id);
    }
  }
  check(audited.size === judgements.size, 'every judgement needs an explicit audit');
}
export function validateProjectStageInferences(input: unknown, now = new Date()): asserts input is ProjectStageInferenceDataset {
  check(object(input), 'dataset'); validateCollections(input as unknown as ProjectStageInferenceDataset, now);
  const data = input as unknown as ProjectStageInferenceDataset; check(Array.isArray(data.inputs), 'input manifests');
  const ids = new Set<string>(); for (const item of data.inputs) { check(object(item) && text(item.id) && !ids.has(item.id) && text(item.path) && /^[a-f0-9]{64}$/.test(item.sha256), 'input manifest'); ids.add(item.id); }
}
export function validateProjectStageInferenceFragment(input: unknown, now = new Date()): asserts input is ProjectStageInferenceFragment {
  check(object(input) && text(input.id), 'fragment ID'); validateCollections(input as unknown as ProjectStageInferenceFragment, now);
}

function queryCutoff(query: StageInferenceQuery): string | undefined {
  if (query.asOf !== undefined && !isCalendarDay(query.asOf)) throw new Error('Invalid inference asOf day');
  if (query.knownAt === undefined) return undefined;
  if (isCalendarDay(query.knownAt)) return endOfKstDay(query.knownAt);
  if (!instant(query.knownAt)) throw new Error('Invalid inference knownAt instant');
  return query.knownAt;
}
interface LatestSelection { values: StageInferenceJudgement[]; byProject: Map<string, StageInferenceJudgement[]>; byCensus: Map<string, StageInferenceJudgement>; }
// Datasets are immutable append-preserved snapshots. Keep query-specific indexes
// per snapshot so rating an entire national register does not rescan every review.
const SELECTION_CACHE = new WeakMap<ProjectStageInferenceDataset, Map<string, LatestSelection>>();
function selected(data: ProjectStageInferenceDataset, query: StageInferenceQuery): LatestSelection {
  const cutoff = queryCutoff(query), queryKey = JSON.stringify([query.asOf ?? null, cutoff ?? null]);
  let cached = SELECTION_CACHE.get(data);
  if (!cached) { cached = new Map(); SELECTION_CACHE.set(data, cached); }
  const hit = cached.get(queryKey); if (hit) return hit;
  const latest = new Map<string, StageInferenceJudgement>();
  for (const j of data.judgements) {
    // An undated review can still withdraw the *current* average membership.
    // Its evaluation day gates that decision without inventing a source date or
    // applying the retraction to days before the review actually took place.
    const selectableDay = j.asOf ?? calendarDayKst(j.evaluatedAt);
    if (cutoff && j.evaluatedAt > cutoff || query.asOf && selectableDay > query.asOf) continue;
    const key = identityKey(j), previous = latest.get(key);
    if (!previous || j.evaluatedAt > previous.evaluatedAt || j.evaluatedAt === previous.evaluatedAt && (j.asOf ?? '') > (previous.asOf ?? '')) latest.set(key, j);
  }
  const values = [...latest.values()].sort((a, b) => identityKey(a).localeCompare(identityKey(b)));
  const byProject = new Map<string, StageInferenceJudgement[]>(), byCensus = new Map<string, StageInferenceJudgement>();
  for (const j of values) {
    if (j.projectId !== null) byProject.set(j.projectId, [...(byProject.get(j.projectId) ?? []), j]);
    if (j.censusId !== null) byCensus.set(j.censusId, j);
  }
  const result = { values, byProject, byCensus };
  if (cached.size >= 64) cached.delete(cached.keys().next().value!);
  cached.set(queryKey, result); return result;
}
/** Select the latest reviewed opinion, including a null-stage retraction. Never filter out nulls first. */
export function selectLatestStageInferences(data: ProjectStageInferenceDataset, query: StageInferenceQuery = {}): StageInferenceJudgement[] {
  const latest = selected(data, query);
  const values = query.projectId ? latest.byProject.get(query.projectId) ?? [] : query.censusId ? (latest.byCensus.has(query.censusId) ? [latest.byCensus.get(query.censusId)!] : []) : latest.values;
  return values.filter(j => (!query.censusId || j.censusId === query.censusId) && (!query.projectId || j.projectId === query.projectId));
}
export function latestStageInference(data: ProjectStageInferenceDataset, censusId: string, query: StageInferenceQuery = {}): StageInferenceJudgement | null { return selectLatestStageInferences(data, { ...query, censusId })[0] ?? null; }
export function matchingProjectStageInference(data: ProjectStageInferenceDataset, project: Project, query: StageInferenceQuery = {}): StageInferenceJudgement | null {
  const matches = selectLatestStageInferences(data, { ...query, projectId: project.id });
  if (matches.length !== 1) return null;
  const j = matches[0]; return j.projectSnapshot !== null && stageInferenceCanonicalJson(j.projectSnapshot) === stageInferenceCanonicalJson(project) ? j : null;
}
/** Dated display estimate is allowed for unknown current status; inclusion in an active mean is separate. */
export function scoreStageInference(j: StageInferenceJudgement): ProjectStageInferenceEstimate | null {
  const stage = j.stage === null ? undefined : BY_STAGE.get(j.stage); if (!stage) return null;
  return { modelVersion: PROJECT_STAGE_INFERENCE_VERSION, judgementId: j.id, stage: stage.stage, label: stage.label, point: stage.point,
    gates: GATES.map(gate => ({ gate, progress: stage.progress[gate], points: 20 * (1 - stage.progress[gate]), rationale: `${stage.label}에서 ${GATE_LABELS[gate]} ${stage.progress[gate] * 100}%를 부여한 모형 가정이며 직접 확인된 진행률이 아닙니다. ${stage.rationale}` })),
    rationale: `${j.rationale} ${stage.rationale} 정성 자료에 대한 검토 판단이며 다섯 요건의 직접 근거 평가를 변경하지 않습니다.`, sourceUrl: j.sourceEvidence[0].url, sourceAsOf: j.asOf,
    evaluatedAt: j.evaluatedAt, confidence: j.confidence, statusBasis: j.statusBasis, bottleneck: j.bottleneck, applyToAverage: j.applyToAverage,
    status: j.status, identityStatus: j.identityStatus, assumptions: [...j.assumptions], limitations: [...j.limitations], sourceEvidence: structuredClone(j.sourceEvidence) };
}
export function estimateProjectStageInference(data: ProjectStageInferenceDataset, project: Project, query: StageInferenceQuery = {}): ProjectStageInferenceEstimate | null {
  const j = matchingProjectStageInference(data, project, query);
  return j?.applyToAverage && j.status === 'active' && ['clear', 'representative'].includes(j.identityStatus) && project.eligible && project.status === 'active' ? scoreStageInference(j) : null;
}
export function stageInferenceCoverage(data: ProjectStageInferenceDataset, censusIds: string[] = [], query: StageInferenceQuery = {}) {
  const cutoff = queryCutoff(query), latest = new Map<string, StageInferenceAudit>();
  for (const audit of data.audits) {
    if (cutoff && audit.evaluatedAt > cutoff || query.censusId && audit.censusId !== query.censusId || query.projectId && audit.projectId !== query.projectId) continue;
    const key = identityKey(audit), previous = latest.get(key); if (!previous || audit.evaluatedAt > previous.evaluatedAt) latest.set(key, audit);
  }
  const audits = [...latest.values()], judgements = selectLatestStageInferences(data, query), reviewedCensusIds = new Set(audits.filter(a => a.outcome !== 'not_reviewed').map(a => a.censusId));
  return { reviewedCount: audits.filter(a => a.outcome !== 'not_reviewed').length, judgedCount: audits.filter(a => a.outcome === 'judged').length, noJudgementCount: audits.filter(a => a.outcome === 'no_judgement').length, notReviewedCount: audits.filter(a => a.outcome === 'not_reviewed').length,
    scoredCount: judgements.filter(j => j.stage !== null).length, averageApprovedCount: judgements.filter(j => j.applyToAverage).length,
    unreviewedCensusIds: [...new Set(censusIds)].filter(id => !reviewedCensusIds.has(id)), audits };
}
const csvCell = (value: unknown) => { const text = value === null || value === undefined ? '' : String(value); return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; };
export function projectStageInferencesCsv(data: ProjectStageInferenceDataset, query: StageInferenceQuery = {}): string {
  const rows: unknown[][] = [['judgement_id', 'census_id', 'project_id', 'evaluated_at', 'source_as_of', 'status', 'status_basis', 'stage', 'model_version', 'model_point', 'confidence', 'apply_to_average', 'identity_status', 'identity_rationale', 'bottleneck', 'rationale', 'assumptions', 'limitations', 'source_evidence']];
  for (const j of selectLatestStageInferences(data, query)) rows.push([j.id, j.censusId, j.projectId, j.evaluatedAt, j.asOf, j.status, j.statusBasis, j.stage, PROJECT_STAGE_INFERENCE_VERSION, scoreStageInference(j)?.point ?? null, j.confidence, j.applyToAverage, j.identityStatus, j.identityRationale, j.bottleneck, j.rationale, j.assumptions.join(' | '), j.limitations.join(' | '), JSON.stringify(j.sourceEvidence)]);
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
