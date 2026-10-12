/** Exact, reviewed changes to current project status. Original source fields remain intact. */
import type { Project, Source } from './types.ts';
import { calendarDayKst, isCalendarDay } from './time.ts';
import { stageInferenceCanonicalJson, validateStageInferenceProjectSnapshot, type StageInferenceEvidence } from './project-stage-inference.ts';

export type ProjectStatusIdentityBasis = 'existing_register_record' | 'official_service_request' | 'official_single_site_docket' | 'official_single_site_contract' | 'inferred_single_site_connection';
export interface ProjectStatusReview {
  id: string; judgementId: string; evaluatedAt: string; asOf: string | null; statusBasis: 'explicit' | 'inferred';
  baseProject: Project | null; project: Project; identityBasis: ProjectStatusIdentityBasis;
  identityRationale: string; statusRationale: string; sourceEvidence: StageInferenceEvidence[]; limitations: string[];
}
export interface ProjectStatusReviewDataset { schemaVersion: 1; generatedAt: string; reviews: ProjectStatusReview[]; limitations: string[]; }
const MAINLAND = new Set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const CHANGEABLE = new Set(['status', 'state', 'eligible', 'exclusionReason']);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function instant(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
function sourceDate(v: unknown, cutoff: string): v is string | null { return v === null || typeof v === 'string' && (isCalendarDay(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v)) && v <= cutoff; }
function evidenceDate(v: unknown, cutoff: string): v is string | null { return sourceDate(v, cutoff) || typeof v === 'string' && /^\d{4}$/.test(v) && v <= cutoff.slice(0, 4); }
function https(v: unknown): v is string { if (!text(v)) return false; try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; } }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error('Project status review: ' + message); }
function preserved(project: Project) { return Object.fromEntries(Object.entries(project).filter(([key]) => !CHANGEABLE.has(key))); }
export function validateProjectStatusReviews(input: unknown, now = new Date()): asserts input is ProjectStatusReviewDataset {
  check(object(input) && input.schemaVersion === 1 && instant(input.generatedAt) && Date.parse(input.generatedAt) <= now.getTime() && Array.isArray(input.reviews) && texts(input.limitations), 'dataset');
  const data = input as unknown as ProjectStatusReviewDataset, ids = new Set<string>(), byProject = new Map<string, ProjectStatusReview[]>();
  for (const review of data.reviews) {
    check(object(review) && text(review.id) && !ids.has(review.id) && text(review.judgementId) && instant(review.evaluatedAt) && review.evaluatedAt <= data.generatedAt && sourceDate(review.asOf, calendarDayKst(review.evaluatedAt)), 'review identity or chronology'); ids.add(review.id);
    check(['explicit', 'inferred'].includes(review.statusBasis) && ['existing_register_record', 'official_service_request', 'official_single_site_docket', 'official_single_site_contract', 'inferred_single_site_connection'].includes(review.identityBasis) && text(review.identityRationale) && text(review.statusRationale) && texts(review.limitations), 'review rationale or identity basis');
    check(review.identityBasis !== 'inferred_single_site_connection' || review.statusBasis === 'inferred', 'inferred single-site connections must remain explicitly labelled inferred');
    check(review.baseProject !== null, 'new records must first pass the reviewed source/identity import; a base project is required');
    validateStageInferenceProjectSnapshot(review.baseProject, calendarDayKst(review.evaluatedAt)); validateStageInferenceProjectSnapshot(review.project, calendarDayKst(review.evaluatedAt));
    check(stageInferenceCanonicalJson(preserved(review.baseProject)) === stageInferenceCanonicalJson(preserved(review.project)), 'only status/state/eligibility/exclusion may change; source identity, dates, rawStatus and MW must remain intact');
    const p = review.project;
    check(p.eligible ? p.status === 'active' && MAINLAND.has(p.state ?? '') && p.exclusionReason === null : text(p.exclusionReason), 'eligible active mainland project or explicit exclusion reason');
    check(!p.eligible || !p.types.includes('load') || review.baseProject.eligible || review.identityBasis !== 'existing_register_record', 'newly eligible loads need explicit individual request/site/contract identity');
    check(Array.isArray(review.sourceEvidence) && review.sourceEvidence.length > 0, 'evidence required');
    const artifacts = new Set<string>();
    for (const e of review.sourceEvidence) {
      check(object(e) && https(e.url) && text(e.name) && ['official', 'utility', 'customer', 'media'].includes(e.publisherKind) && text(e.excerpt) && /^[a-f0-9]{64}$/.test(e.sha256) && instant(e.retrievedAt) && e.retrievedAt <= review.evaluatedAt && evidenceDate(e.publishedAt, calendarDayKst(e.retrievedAt)) && evidenceDate(e.sourceAsOf, calendarDayKst(e.retrievedAt)), 'evidence provenance or chronology');
      const key = e.url + ':' + e.sha256; check(!artifacts.has(key), 'duplicate evidence artifact'); artifacts.add(key);
    }
    byProject.set(p.id, [...(byProject.get(p.id) ?? []), review]);
  }
  for (const reviews of byProject.values()) {
    reviews.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
    for (let i = 1; i < reviews.length; i++) check(reviews[i - 1].evaluatedAt < reviews[i].evaluatedAt && stageInferenceCanonicalJson(reviews[i].baseProject) === stageInferenceCanonicalJson(reviews[i - 1].project), 'history must form an unambiguous exact base-to-target chain');
  }
}
const LATEST = new WeakMap<ProjectStatusReviewDataset, Map<string, ProjectStatusReview>>();
/** Datasets are immutable snapshots, so this index is shared across national-register lookups. */
export function latestProjectStatusReviews(data: ProjectStatusReviewDataset): ReadonlyMap<string, ProjectStatusReview> {
  let index = LATEST.get(data); if (index) return index;
  index = new Map(); for (const review of data.reviews) { const previous = index.get(review.project.id); if (!previous || review.evaluatedAt > previous.evaluatedAt) index.set(review.project.id, review); }
  LATEST.set(data, index); return index;
}
export function matchingProjectStatusReview(data: ProjectStatusReviewDataset, project: Project): ProjectStatusReview | null {
  const review = latestProjectStatusReviews(data).get(project.id);
  return review && stageInferenceCanonicalJson(review.project) === stageInferenceCanonicalJson(project) ? review : null;
}
/** All source records remain; the overlay neither fabricates a queue ID nor rewrites source statuses. */
export function applyProjectStatusReviews(projects: Project[], data: ProjectStatusReviewDataset, sources?: Source[], now = new Date()): Project[] {
  validateProjectStatusReviews(data, now);
  check(new Set(projects.map(p => p.id)).size === projects.length, 'duplicate input project ID');
  const records = new Set<string>(); for (const p of projects) { const key = JSON.stringify([p.sourceId, p.sourceRecordId]); check(!records.has(key), 'duplicate input source record'); records.add(key); }
  const result = new Map(projects.map(p => [p.id, structuredClone(p)])), grouped = new Map<string, ProjectStatusReview[]>();
  for (const review of data.reviews) grouped.set(review.project.id, [...(grouped.get(review.project.id) ?? []), review]);
  for (const [id, reviews] of grouped) {
    reviews.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
    const current = result.get(id); check(current, `missing base project: ${id}`);
    const last = reviews.at(-1)!;
    if (sources) check(sources.some(s => s.id === last.project.sourceId), `unknown source: ${id}`);
    if (stageInferenceCanonicalJson(current) === stageInferenceCanonicalJson(last.project)) continue;
    const start = reviews.findIndex(r => stageInferenceCanonicalJson(r.baseProject) === stageInferenceCanonicalJson(current));
    check(start >= 0, `stale base project requires re-review: ${id}`);
    result.set(id, structuredClone(last.project));
  }
  return projects.map(project => result.get(project.id)!);
}
