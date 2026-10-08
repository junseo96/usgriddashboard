import { MODEL_VERSION, type Assessment, type CollectionRun, type DashboardResponse, type Filters, type HealthResponse, type ImportPayload, type Project, type ProjectScore, type SnapshotMeta, type Source } from '../shared/types.ts';
import { scoreProject, summarize, validateAssessment } from '../shared/scoring.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay as date } from '../shared/time.ts';
import { compareMarkets } from '../shared/market.ts';
import { publicDemand, publicPipeline } from './market-data.ts';
import { captureSnapshot, inventoryRevisionGuard, listSnapshots, MAX_PROJECTS, readAssessments, readInventoryWithRevision, readSnapshot, recordCollectionRun, seedDatabase, sha256, sourceReplacementStatements, stableJson, type Inventory, type SqlDatabase } from './database.ts';

export type { SqlDatabase, SqlStatement } from './database.ts';
export interface ApiEnvironment { DB: SqlDatabase; ADMIN_TOKEN?: string; LOCAL_DEV?: string; SCHEDULE_ENABLED?: string; SCHEDULE_CADENCE?: string; }
class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const LIMITATIONS = [
  '미국 본토 공개 자료에서 확보한 신청 레코드 기준이며 전국 전수 데이터가 아닙니다.',
  '서로 다른 기관의 신청을 하나의 실제 프로젝트로 연결하는 식별 작업은 완료되지 않았습니다.',
  '미공개 절차는 별도 집계하며 평균 점수에는 모든 해당 요건을 평가한 신청만 포함합니다.',
  '수집 성공, 원장 정규화, 절차 평가, 예약 실행은 각각 별도 상태입니다.',
  '과거 스냅샷 이전 시점의 원장과 점수는 생성하지 않습니다.',
];
const TYPES = ['generation', 'storage', 'load'];
const STATES = new Set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const PROJECT_FIELDS = ['id','sourceId','sourceRecordId','name','types','region','state','status','generationMw','storageMw','loadMw','capacityStatus','eligible','exclusionReason','sourceUrl','sourceAsOf','rawStatus','identityScope'];
const SOURCE_FIELDS = ['id','name','region','types','url','coverage','sourceAsOf','lastCheckedAt','refreshCadence','recordCount','gaps','adapter'];
const ASSESSMENT_FIELDS = ['projectId','gate','status','progress','basis','sourceUrl','effectiveAt','publishedAt','observedAt','rationale','modelVersion'];
const RUN_FIELDS = ['id','startedAt','finishedAt','status','details'];
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactObject(value: unknown, fields: string[], name: string, required = fields): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some(k => !fields.includes(k)) || required.some(k => !(k in value))) throw new ApiError(400, `${name}: invalid or missing fields`);
}
function nonempty(value: unknown, max = 500): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value); }
function id(value: unknown): value is string { return nonempty(value, 250) && !/[\u007f]/.test(value); }
function https(value: unknown): value is string {
  if (!nonempty(value, 2048)) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname; } catch { return false; }
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !date(value.slice(0, 10))) return false;
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  return Number.isFinite(Date.parse(value)) && Number(value.slice(11,13)) < 24 && Number(value.slice(14,16)) < 60 && Number(value.slice(17,19)) < 60 && (!offset || (Number(offset[1]) < 24 && Number(offset[2]) < 60));
}
function sourceDate(value: unknown): boolean { return value === null || (typeof value === 'string' && value <= calendarDayKst() && (date(value) || /^\d{4}-(0[1-9]|1[0-2])$/.test(value))); }
function types(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.length <= 3 && new Set(value).size === value.length && value.every(t => TYPES.includes(t)); }
function validateProject(value: unknown, sourceId?: string): asserts value is Project {
  exactObject(value, PROJECT_FIELDS, 'project');
  if (!id(value.id) || !id(value.sourceId) || !id(value.sourceRecordId) || (sourceId && value.sourceId !== sourceId) || !nonempty(value.name, 1500) || !nonempty(value.region, 100) || !types(value.types)) throw new ApiError(400, 'Invalid project identity or source scope');
  if (value.state !== null && (typeof value.state !== 'string' || value.state.length > 100)) throw new ApiError(400, 'Invalid project state');
  if (!['active','withdrawn','operational','unknown','reference'].includes(value.status as string) || typeof value.eligible !== 'boolean' || !['known','partial','unknown'].includes(value.capacityStatus as string) || value.identityScope !== 'source_record') throw new ApiError(400, 'Invalid project classification');
  for (const field of ['generationMw','storageMw','loadMw']) { const mw = value[field]; if (mw !== null && (typeof mw !== 'number' || !Number.isFinite(mw) || mw < 0 || mw > 1e8)) throw new ApiError(400, 'Invalid project capacity'); }
  const projectTypes = value.types as string[];
  if (TYPES.some(t => !projectTypes.includes(t) && value[t + 'Mw'] !== null)) throw new ApiError(400, 'Capacity must correspond to a declared project type');
  const knownComponents = projectTypes.filter(t => value[t + 'Mw'] !== null).length;
  if ((value.capacityStatus === 'known' && knownComponents !== projectTypes.length) || (value.capacityStatus === 'unknown' && knownComponents !== 0) || (value.capacityStatus === 'partial' && knownComponents === 0)) throw new ApiError(400, 'Capacity disclosure status is inconsistent');
  if (!https(value.sourceUrl) || !sourceDate(value.sourceAsOf) || typeof value.rawStatus !== 'string' || value.rawStatus.length > 2000 || (value.exclusionReason !== null && !nonempty(value.exclusionReason, 1000))) throw new ApiError(400, 'Invalid project provenance');
  if (value.eligible && (value.status !== 'active' || !STATES.has(value.state as string) || value.exclusionReason !== null)) throw new ApiError(400, 'Eligible projects must be active mainland individual requests with no exclusion reason');
  if (!value.eligible && !nonempty(value.exclusionReason, 1000)) throw new ApiError(400, 'Excluded projects need an exclusion reason');
}
function validateSource(value: unknown): asserts value is Source {
  exactObject(value, SOURCE_FIELDS, 'source');
  if (!id(value.id) || !nonempty(value.name, 1000) || !nonempty(value.region, 100) || !types(value.types) || !https(value.url) || !sourceDate(value.sourceAsOf)) throw new ApiError(400, 'Invalid source identity or provenance');
  if (!['full_register','filtered_register','aggregate','case','not_reviewed','access_failed','not_public'].includes(value.coverage as string) || !['weekly','monthly','annual'].includes(value.refreshCadence as string)) throw new ApiError(400, 'Invalid source classification');
  if (value.lastCheckedAt !== null && (date(value.lastCheckedAt) ? value.lastCheckedAt > calendarDayKst() : (!timestamp(value.lastCheckedAt) || Date.parse(value.lastCheckedAt) > Date.now()))) throw new ApiError(400, 'Invalid source collection timestamp');
  if (value.recordCount !== null && (!Number.isInteger(value.recordCount) || (value.recordCount as number) < 0)) throw new ApiError(400, 'Invalid source record count');
  if (!Array.isArray(value.gaps) || value.gaps.length > 100 || value.gaps.some(g => !nonempty(g, 3000)) || (value.adapter !== null && !nonempty(value.adapter, 250))) throw new ApiError(400, 'Invalid source gaps or adapter');
}
function validateInventory(projects: unknown, sources: unknown): asserts projects is Project[] {
  if (!Array.isArray(projects) || projects.length === 0 || projects.length > MAX_PROJECTS || !Array.isArray(sources) || !sources.length || sources.length > 1000) throw new ApiError(400, 'Inventory must contain 1–100000 projects and 1–1000 sources');
  sources.forEach(validateSource);
  const sourceIds = new Set(sources.map(s => s.id));
  const sourceMap = new Map((sources as Source[]).map(s => [s.id,s]));
  if (sourceIds.size !== sources.length) throw new ApiError(400, 'Duplicate source ids');
  const projectIds = new Set<string>(), sourceRecordIds = new Set<string>();
  for (const project of projects) {
    validateProject(project);
    if (project.eligible && !['full_register','filtered_register'].includes(sourceMap.get(project.sourceId)?.coverage ?? '')) throw new ApiError(400, 'Eligible individual requests require a register source');
    const record = stableJson([project.sourceId, project.sourceRecordId]);
    if (!sourceIds.has(project.sourceId) || projectIds.has(project.id) || sourceRecordIds.has(record)) throw new ApiError(400, 'Unknown source or duplicate project identity');
    projectIds.add(project.id);
    sourceRecordIds.add(record);
  }
}
async function body(request: Request, maximum = 16 * 1024 * 1024): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'Content-Type must be application/json');
  if (Number(request.headers.get('Content-Length') ?? 0) > maximum) throw new ApiError(413, 'Request is too large');
  if (!request.body) throw new ApiError(400, 'JSON body required');
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > maximum) { await reader.cancel(); throw new ApiError(413, 'Request is too large'); } parts.push(part.value); }
  const combined = new Uint8Array(length); let offset = 0; for (const part of parts) { combined.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)); } catch { throw new ApiError(400, 'Invalid JSON'); }
}
function equalSecret(a: string, b: string): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function canWrite(request: Request, env: ApiEnvironment): boolean {
  const authorization = request.headers.get('Authorization');
  if (env.ADMIN_TOKEN && authorization?.startsWith('Bearer ') && equalSecret(authorization.slice(7), env.ADMIN_TOKEN)) return true;
  const url = new URL(request.url), origin = request.headers.get('Origin');
  return env.LOCAL_DEV === '1' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && (!origin || origin === url.origin);
}
function numberParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  if (!params.has(name)) return fallback;
  const text = params.get(name)!; if (!/^[1-9]\d*$/.test(text) || Number(text) > max) throw new ApiError(400, `Invalid ${name}`); return Number(text);
}
interface Query { filters: Filters; asOf: string; knownAt: string; cutoff: string; historyLimit: number; }
function query(url: URL): Query {
  const p = url.searchParams, now = new Date(), today = calendarDayKst(now);
  const asOf = p.get('asOf') || today, knownAt = p.get('knownAt') || now.toISOString();
  if (!date(asOf) || asOf > today || !timestamp(knownAt) || Date.parse(knownAt) > now.getTime()) throw new ApiError(400, 'Invalid or future asOf / knownAt');
  const type = p.get('type') || 'all', status = p.get('status') || 'all';
  if (![...TYPES, 'all'].includes(type) || !['all','scored','unknown'].includes(status)) throw new ApiError(400, 'Invalid type or status filter');
  const q = p.get('q') || '', region = p.get('region') || '';
  if (q.length > 200 || region.length > 100) throw new ApiError(400, 'Filter is too long');
  const normalizedKnownAt = new Date(knownAt).toISOString();
  return { filters: { type: type as Filters['type'], status: status as Filters['status'], q, region, asOf, knownAt: normalizedKnownAt, page: numberParam(p, 'page', 1, 100000), pageSize: numberParam(p, 'pageSize', 30, 100) }, asOf, knownAt: normalizedKnownAt, cutoff: [endOfKstDay(asOf), normalizedKnownAt].sort()[0], historyLimit: numberParam(p, 'historyLimit', 12, 52) };
}
function scoped(projects: Project[], filters: Filters): Project[] { return projects.filter(p => (!filters.type || filters.type === 'all' || p.types.includes(filters.type)) && (!filters.region || filters.region === 'all' || p.region === filters.region)); }
function scoresFor(projects: Project[], assessments: Assessment[], asOf: string, knownAt: string): ProjectScore[] {
  const grouped = new Map<string, Assessment[]>();
  for (const a of assessments) { const values = grouped.get(a.projectId) ?? []; values.push(a); grouped.set(a.projectId, values); }
  return projects.map(p => scoreProject(p, grouped.get(p.id) ?? [], { asOf, knownAt }));
}
function filterScores(scores: ProjectScore[], filters: Filters): ProjectScore[] {
  const q = filters.q?.toLocaleLowerCase();
  return scores.filter(s => (!q || [s.project.name,s.project.id,s.project.sourceRecordId,s.project.state ?? ''].some(v => v.toLocaleLowerCase().includes(q))) && (filters.status !== 'scored' || (s.project.eligible && s.point !== null)) && (filters.status !== 'unknown' || (s.project.eligible && s.point === null)));
}
async function dashboard(db: SqlDatabase, q: Query, includeHistory = true): Promise<DashboardResponse> {
  const snapshots = await listSnapshots(db, q.cutoff, includeHistory ? q.historyLimit + 1 : 1);
  const snapshot = snapshots[0] ?? null;
  const empty: DashboardResponse = { available: false, modelVersion: MODEL_VERSION, snapshot: null, summary: summarize([]), regions: [], projects: [], total: 0, page: q.filters.page!, pageSize: q.filters.pageSize!, sources: [], history: [], historyTruncated: false, nationalComplete: false, identityScope: 'source_record', limitations: LIMITATIONS };
  if (!snapshot) return empty;
  const [inventory, assessments] = await Promise.all([readSnapshot(db, snapshot.id), readAssessments(db, q.asOf, q.knownAt)]);
  const scores = scoresFor(scoped(inventory.projects, q.filters), assessments, q.asOf, q.knownAt);
  const visible = filterScores(scores, q.filters);
  const start = (q.filters.page! - 1) * q.filters.pageSize!;
  const result: DashboardResponse = { ...empty, available: true, snapshot, summary: summarize(scores), regions: [...new Set(inventory.projects.map(p => p.region))].sort(), sources: inventory.sources, projects: visible.slice(start, start + q.filters.pageSize!), total: visible.length, historyTruncated: includeHistory && snapshots.length > q.historyLimit };
  if (includeHistory) {
    // Each point describes evidence available by that observation, avoiding later information leakage.
    for (const meta of snapshots.slice(0, q.historyLimit).reverse()) {
      const past = meta.id === snapshot.id ? inventory : await readSnapshot(db, meta.id);
      const pointKnownAt = [q.knownAt, meta.capturedAt].sort()[0];
      result.history.push({ snapshot: meta, summary: summarize(scoresFor(scoped(past.projects, q.filters), assessments, calendarDayKst(meta.capturedAt), pointKnownAt)) });
    }
  }
  return result;
}
function csvValue(value: unknown): string { const raw = value === null || value === undefined ? '' : String(value); const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw; return '"' + safe.replaceAll('"', '""') + '"'; }
function validateRun(value: unknown): asserts value is CollectionRun {
  exactObject(value, RUN_FIELDS, 'collection run');
  if (!id(value.id) || !timestamp(value.startedAt) || Date.parse(value.startedAt) > Date.now() || !['running','success','partial','failed'].includes(value.status as string) || typeof value.details !== 'string' || value.details.length > 16000) throw new ApiError(400, 'Invalid collection run');
  if (value.status === 'running' ? value.finishedAt !== null : (!timestamp(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.startedAt as string) || Date.parse(value.finishedAt) > Date.now())) throw new ApiError(400, 'Invalid collection run completion timestamp');
}
export async function handleApi(request: Request, env: ApiEnvironment): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  try {
    if (request.method !== 'GET' && request.method !== 'POST') throw new ApiError(405, 'Method not allowed');
    if (request.method === 'POST' && !canWrite(request, env)) throw new ApiError(401, 'An administrator bearer token is required');
    if (path === '/api/demand' && request.method === 'GET') return json(publicDemand());
    if (path === '/api/load-pipeline' && request.method === 'GET') return json(publicPipeline());
    if (path === '/api/market-comparison' && request.method === 'GET') {
      const snapshots = await listSnapshots(env.DB, new Date().toISOString(), 1);
      if (!snapshots[0]) return json(compareMarkets([], null));
      const inventory = await readSnapshot(env.DB, snapshots[0].id);
      return json(compareMarkets(inventory.projects, snapshots[0].capturedAt));
    }
    if (path === '/api/health' && request.method === 'GET') {
      try {
        const [snapshots, run] = await Promise.all([listSnapshots(env.DB, new Date().toISOString(), 1), env.DB.prepare('SELECT started_at,status FROM collection_runs ORDER BY started_at DESC LIMIT 1').first<{ started_at: string; status: string }>()]);
        const health: HealthResponse = { ok: true, app: 'grid-atlas', modelVersion: MODEL_VERSION, database: 'ready', lastSnapshotAt: snapshots[0]?.capturedAt ?? null, canWrite: canWrite(request, env), schedule: { configured: env.SCHEDULE_ENABLED === '1' || env.SCHEDULE_ENABLED === 'true', cadence: env.SCHEDULE_CADENCE === 'monthly' ? '매월 1일 09:00 KST' : '매주 월요일 09:00 KST', lastRunAt: run?.started_at ?? null, lastRunStatus: run?.status ?? null } };
        return json(health);
      } catch {
        const health: HealthResponse = { ok: false, app: 'grid-atlas', modelVersion: MODEL_VERSION, database: 'uninitialized', lastSnapshotAt: null, canWrite: canWrite(request, env), schedule: { configured: false, cadence: '매주 월요일 또는 매월 1일 09:00 KST', lastRunAt: null, lastRunStatus: null } };
        return json(health, 503);
      }
    }
    if (path === '/api/dashboard' && request.method === 'GET') return json(await dashboard(env.DB, query(url)));
    if (path.startsWith('/api/projects/') && request.method === 'GET') {
      const projectId = decodeURIComponent(path.slice('/api/projects/'.length));
      if (!id(projectId)) throw new ApiError(400, 'Invalid project id');
      const q = query(url), snapshots = await listSnapshots(env.DB, q.cutoff, 1);
      if (!snapshots[0]) return json({ available: false, snapshot: null, score: null, assessments: [], assessmentsTruncated: false, totalAssessments: 0 });
      const [inventory, assessments] = await Promise.all([readSnapshot(env.DB, snapshots[0].id), readAssessments(env.DB, q.asOf, q.knownAt)]);
      const project = inventory.projects.find(p => p.id === projectId);
      if (!project) throw new ApiError(404, 'Project not found in selected snapshot');
      const events = assessments.filter(a => a.projectId === projectId).sort((a,b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
      const limit = numberParam(url.searchParams, 'limit', 100, 200);
      return json({ available: true, snapshot: snapshots[0], score: scoreProject(project, events, { asOf: q.asOf, knownAt: q.knownAt }), assessments: events.slice(0, limit), assessmentsTruncated: events.length > limit, totalAssessments: events.length });
    }
    if (path === '/api/export' && request.method === 'GET') {
      const q = query(url), snapshots = await listSnapshots(env.DB, q.cutoff, 1);
      if (!snapshots[0]) throw new ApiError(404, 'No inventory observed at selected time');
      const [inventory, assessments] = await Promise.all([readSnapshot(env.DB, snapshots[0].id), readAssessments(env.DB, q.asOf, q.knownAt)]);
      const scores = filterScores(scoresFor(scoped(inventory.projects, q.filters), assessments, q.asOf, q.knownAt), q.filters);
      if (scores.length > 25000) throw new ApiError(413, 'Export exceeds 25000 rows; narrow type or region');
      const headers = ['id','name','types','region','state','status','eligible','generation_mw','storage_mw','load_mw','bottleneck_score','lower','upper','assessed_gates','estimated','source_url','source_as_of','snapshot_captured_at','as_of','known_at','model_version'];
      const lines = scores.map(s => [s.project.id,s.project.name,s.project.types.join('|'),s.project.region,s.project.state,s.project.status,s.project.eligible,s.project.generationMw,s.project.storageMw,s.project.loadMw,s.point,s.lower,s.upper,s.assessedGates,s.estimated,s.project.sourceUrl,s.project.sourceAsOf,snapshots[0].capturedAt,q.asOf,q.knownAt,MODEL_VERSION].map(csvValue).join(','));
      return new Response('\uFEFF' + [headers.join(','),...lines].join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="grid-atlas.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (path === '/api/assessments' && request.method === 'POST') {
      const input = await body(request, 32_000); exactObject(input, ASSESSMENT_FIELDS, 'assessment');
      if (!id(input.projectId) || !https(input.sourceUrl) || typeof input.rationale !== 'string' || input.rationale.length > 16000) throw new ApiError(400, 'Invalid assessment identity or evidence size');
      const errors = validateAssessment(input as unknown as Omit<Assessment, 'id' | 'recordedAt'>, new Date());
      if (errors.length) throw new ApiError(400, errors.join('; '));
      const { inventory, revision } = await readInventoryWithRevision(env.DB);
      const project = inventory.projects.find(p => p.id === input.projectId);
      if (!project) throw new ApiError(404, 'Project is not in the current inventory');
      if (!project.eligible) throw new ApiError(400, 'Only eligible active individual projects can be assessed');
      const assessmentId = await sha256(stableJson(input));
      const existing = await env.DB.prepare('SELECT payload FROM assessments WHERE id = ?').bind(assessmentId).first<{ payload: string }>();
      if (existing) return json({ assessment: JSON.parse(existing.payload), duplicate: true });
      const assessment = { ...input, id: assessmentId, recordedAt: new Date().toISOString() } as unknown as Assessment;
      await env.DB.batch([inventoryRevisionGuard(env.DB,revision,false),env.DB.prepare('INSERT OR IGNORE INTO assessments (id,project_id,effective_at,recorded_at,payload) VALUES (?,?,?,?,?)').bind(assessment.id, assessment.projectId, assessment.effectiveAt, assessment.recordedAt, stableJson(assessment))]);
      const stored = await env.DB.prepare('SELECT payload FROM assessments WHERE id = ?').bind(assessment.id).first<{ payload: string }>();
      return json({ assessment: JSON.parse(stored!.payload), duplicate: false }, 201);
    }
    if (path === '/api/snapshots' && request.method === 'POST') {
      const input = await body(request, 1000); exactObject(input, ['trigger'], 'snapshot', []);
      if (input.trigger !== undefined && input.trigger !== 'manual' && input.trigger !== 'scheduled') throw new ApiError(400, 'Invalid snapshot trigger');
      return json(await captureSnapshot(env.DB, (input.trigger as SnapshotMeta['trigger']) ?? 'manual'), 201);
    }
    if (path === '/api/bootstrap' && request.method === 'POST') {
      const existing = await env.DB.prepare('SELECT id FROM sources LIMIT 1').first();
      if (existing) throw new ApiError(409, 'Bootstrap is only allowed on an empty inventory');
      const input = await body(request); exactObject(input, ['projects','sources'], 'bootstrap');
      validateInventory(input.projects, input.sources);
      return json(await seedDatabase(env.DB, input as unknown as Inventory), 201);
    }
    if (path === '/api/import' && request.method === 'POST') {
      const input = await body(request); exactObject(input, ['sourceId','projects','source','completeScope','retrievedAt','sourceSha256'], 'import');
      if (!id(input.sourceId) || input.completeScope !== true || !timestamp(input.retrievedAt) || Date.parse(input.retrievedAt) > Date.now() || typeof input.sourceSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.sourceSha256)) throw new ApiError(400, 'Full source scope and acquisition checksum are required');
      validateSource(input.source);
      if (input.source.id !== input.sourceId) throw new ApiError(400, 'Source id mismatch');
      if (!Array.isArray(input.projects) || !input.projects.length || input.projects.length > MAX_PROJECTS) throw new ApiError(400, 'Empty source replacement is blocked');
      const ids = new Set<string>(), recordIds = new Set<string>();
      for (const project of input.projects) { validateProject(project, input.sourceId); if (ids.has(project.id) || recordIds.has(project.sourceRecordId)) throw new ApiError(400, 'Duplicate project identity in import'); ids.add(project.id); recordIds.add(project.sourceRecordId); }
      if (input.projects.some(p => p.eligible) && !['full_register','filtered_register'].includes(input.source.coverage)) throw new ApiError(400, 'Eligible individual requests require a register source');
      if (input.source.recordCount !== null && input.source.recordCount !== input.projects.length) throw new ApiError(400, 'Source record count does not match complete imported scope');
      const { inventory, revision } = await readInventoryWithRevision(env.DB);
      const others = inventory.projects.filter(p => p.sourceId !== input.sourceId);
      if (others.some(p => ids.has(p.id))) throw new ApiError(409, 'Project id belongs to another source');
      const oldById = new Map(inventory.projects.filter(p => p.sourceId === input.sourceId).map(p => [p.id,p]));
      const oldByRecord = new Map(inventory.projects.filter(p => p.sourceId === input.sourceId).map(p => [p.sourceRecordId,p]));
      if (input.projects.some(p => (oldById.has(p.id) && oldById.get(p.id)!.sourceRecordId !== p.sourceRecordId) || (oldByRecord.has(p.sourceRecordId) && oldByRecord.get(p.sourceRecordId)!.id !== p.id))) throw new ApiError(409, 'A stored project identity cannot be reassigned');
      if (others.length + input.projects.length > MAX_PROJECTS) throw new ApiError(413, 'Inventory project limit exceeded');
      const payload = input as unknown as ImportPayload;
      const retrievedDay = calendarDayKst(payload.retrievedAt);
      if ((payload.source.sourceAsOf && payload.source.sourceAsOf > retrievedDay) || payload.projects.some(p => p.sourceAsOf && p.sourceAsOf > retrievedDay) || (payload.source.lastCheckedAt && (date(payload.source.lastCheckedAt) ? payload.source.lastCheckedAt > retrievedDay : Date.parse(payload.source.lastCheckedAt) > Date.parse(payload.retrievedAt)))) throw new ApiError(400, 'Source dates cannot follow acquisition');
      await env.DB.batch([inventoryRevisionGuard(env.DB, revision), ...sourceReplacementStatements(env.DB, payload.source, payload.projects, new Date(payload.retrievedAt).toISOString(), payload.sourceSha256.toLowerCase())]);
      return json({ sourceId: payload.sourceId, projectCount: payload.projects.length, retrievedAt: new Date(payload.retrievedAt).toISOString(), sourceSha256: payload.sourceSha256.toLowerCase(), snapshotRequired: true });
    }
    if (path === '/api/runs' && request.method === 'GET') {
      const limit = numberParam(url.searchParams, 'limit', 20, 100), page = numberParam(url.searchParams, 'page', 1, 100000);
      const rows = await env.DB.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?').bind(limit + 1, (page - 1) * limit).all<{ id:string; started_at:string; finished_at:string|null; status:CollectionRun['status']; details:string }>();
      return json({ runs: rows.results.slice(0,limit).map(r => ({ id:r.id, startedAt:r.started_at, finishedAt:r.finished_at, status:r.status, details:r.details })), page, limit, truncated:rows.results.length > limit });
    }
    if (path === '/api/runs' && request.method === 'POST') {
      const input = await body(request, 24_000); validateRun(input);
      const existing = await env.DB.prepare('SELECT started_at,status FROM collection_runs WHERE id = ?').bind(input.id).first<{ started_at:string; status:string }>();
      if (existing && (existing.status !== 'running' || existing.started_at !== new Date(input.startedAt).toISOString())) throw new ApiError(409, 'Completed runs or their start times cannot be replaced');
      await recordCollectionRun(env.DB, { ...input, startedAt:new Date(input.startedAt).toISOString(), finishedAt:input.finishedAt ? new Date(input.finishedAt).toISOString() : null });
      return json({ recorded: true, id: input.id }, 201);
    }
    throw new ApiError(404, 'API endpoint not found');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof URIError) return json({ error:'Invalid encoded project id' }, 400);
    // Never send SQL, bindings, stack traces or tokens back to the browser.
    return json({ error: 'Database operation failed. Verify migrations and local/server logs.' }, 503);
  }
}
