import rawDataset from '../data/reviewed-load-projects.json' with { type: 'json' };
import type { Project, Source } from './types.ts';
import { calendarDayKst, isCalendarDay } from './time.ts';

export type LoadIdentityBasis = 'official_service_request' | 'official_single_site_docket' | 'official_single_site_contract' | 'official_permit_only' | 'grouped_case' | 'unresolved';
export type LoadCapacityBasis = 'requested_grid_mw' | 'contracted_grid_mw' | 'unknown';
export const REVIEWED_LOAD_STAGES = ['not_started', 'scoping_pending', 'feasibility_study', 'impact_pending', 'impact_study', 'impact_approved', 'facilities_pending', 'facilities_study', 'ia_pending', 'ia_executed', 'construction'] as const;
export type ReviewedLoadStage = typeof REVIEWED_LOAD_STAGES[number];
export interface ReviewedLoadEvidence {
  url: string; name: string; retrievedAt: string; sha256: string;
  publishedAt: string | null; sourceAsOf: string | null; excerpt: string;
}
export interface ReviewedLoadProject {
  projectId: string; authority: string; docketId: string | null; identityBasis: LoadIdentityBasis;
  capacityBasis: LoadCapacityBasis; stage: ReviewedLoadStage | null; stageRationale: string;
  sourceEvidence: ReviewedLoadEvidence[]; limitations: string[];
}
export interface ReviewedLoadDataset {
  schemaVersion: 1; generatedAt: string; projects: Project[]; sources: Source[];
  reviews: ReviewedLoadProject[]; limitations: string[];
}

const MAINLAND = new Set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const ELIGIBLE_IDENTITIES = new Set<LoadIdentityBasis>(['official_service_request', 'official_single_site_docket', 'official_single_site_contract']);
const IDENTITY_BASES = [...ELIGIBLE_IDENTITIES, 'official_permit_only', 'grouped_case', 'unresolved'];
const PROJECT_FIELDS = 'id sourceId sourceRecordId name types region state status generationMw storageMw loadMw capacityStatus eligible exclusionReason sourceUrl sourceAsOf rawStatus identityScope'.split(' ');
const SOURCE_FIELDS = 'id name region types url coverage sourceAsOf lastCheckedAt refreshCadence recordCount gaps adapter'.split(' ');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 5000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const identifier = (v: unknown): v is string => text(v, 250) && !/[\r\n\t]/.test(v);
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => text(s));
function requireValid(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Reviewed load projects: ${message}`); }
function fields(v: unknown, names: string[], label: string): asserts v is Record<string, unknown> {
  requireValid(object(v) && names.every(k => k in v) && Object.keys(v).every(k => names.includes(k)), `${label} fields`);
}
function https(v: unknown): v is string { if (!text(v, 2048)) return false; try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; } }
function instant(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
function sourceDate(v: unknown, latest: string): v is string | null { return v === null || typeof v === 'string' && (isCalendarDay(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v)) && v <= latest; }
function loadOnly(v: unknown): boolean { return Array.isArray(v) && v.length === 1 && v[0] === 'load'; }

/** A review is an explicit decision about a source record, never a fuzzy name match. */
export function validateReviewedLoadProjects(input: unknown, now = new Date()): asserts input is ReviewedLoadDataset {
  fields(input, ['schemaVersion', 'generatedAt', 'projects', 'sources', 'reviews', 'limitations'], 'dataset');
  requireValid(input.schemaVersion === 1 && instant(input.generatedAt) && Date.parse(input.generatedAt) <= now.getTime(), 'version or generatedAt');
  const generatedAt = input.generatedAt, day = calendarDayKst(generatedAt);
  requireValid(Array.isArray(input.projects) && Array.isArray(input.sources) && Array.isArray(input.reviews) && texts(input.limitations), 'dataset collections');
  const sources = new Map<string, Source>();
  for (const source of input.sources) {
    fields(source, SOURCE_FIELDS, 'source');
    requireValid(identifier(source.id) && !sources.has(source.id) && text(source.name, 1000) && text(source.region, 100) && loadOnly(source.types) && https(source.url), 'source identity');
    requireValid(['full_register', 'filtered_register', 'aggregate', 'case', 'not_reviewed', 'access_failed', 'not_public'].includes(String(source.coverage)) && ['weekly', 'monthly', 'annual'].includes(String(source.refreshCadence)), 'source classification');
    requireValid(sourceDate(source.sourceAsOf, day) && (source.lastCheckedAt === null || isCalendarDay(source.lastCheckedAt) && source.lastCheckedAt <= day || instant(source.lastCheckedAt) && source.lastCheckedAt <= generatedAt), 'source dates');
    requireValid((source.recordCount === null || Number.isInteger(source.recordCount) && Number(source.recordCount) >= 0) && texts(source.gaps) && (source.adapter === null || identifier(source.adapter)), 'source count or gaps');
    sources.set(source.id, source as unknown as Source);
  }
  const projects = new Map<string, Project>(), records = new Set<string>();
  for (const project of input.projects) {
    fields(project, PROJECT_FIELDS, 'project');
    requireValid(identifier(project.id) && !projects.has(project.id) && identifier(project.sourceId) && sources.has(project.sourceId) && identifier(project.sourceRecordId) && text(project.name, 1500) && text(project.region, 100), 'project identity or source');
    const key = JSON.stringify([project.sourceId, project.sourceRecordId]);
    requireValid(!records.has(key), 'duplicate source record'); records.add(key);
    requireValid(loadOnly(project.types) && project.identityScope === 'source_record' && project.generationMw === null && project.storageMw === null, 'reviewed projects must be individual load records');
    requireValid(project.loadMw === null || typeof project.loadMw === 'number' && Number.isFinite(project.loadMw) && project.loadMw >= 0 && project.loadMw <= 1e8, 'invalid load capacity');
    requireValid(project.capacityStatus === (project.loadMw === null ? 'unknown' : 'known'), 'capacity disclosure mismatch');
    requireValid(['active', 'withdrawn', 'operational', 'unknown', 'reference'].includes(String(project.status)) && typeof project.eligible === 'boolean' && (project.state === null || text(project.state, 100)), 'project classification');
    requireValid(https(project.sourceUrl) && sourceDate(project.sourceAsOf, day) && typeof project.rawStatus === 'string' && project.rawStatus.length <= 2000, 'project provenance');
    requireValid(project.eligible ? project.status === 'active' && MAINLAND.has(String(project.state)) && project.exclusionReason === null && ['full_register', 'filtered_register', 'case'].includes(sources.get(project.sourceId)!.coverage) : text(project.exclusionReason, 1000), 'eligible active mainland individual request or exclusion reason');
    projects.set(project.id, project as unknown as Project);
  }
  const reviews = new Set<string>();
  for (const review of input.reviews) {
    fields(review, ['projectId', 'authority', 'docketId', 'identityBasis', 'capacityBasis', 'stage', 'stageRationale', 'sourceEvidence', 'limitations'], 'review');
    requireValid(identifier(review.projectId) && projects.has(review.projectId) && !reviews.has(review.projectId) && text(review.authority, 1000) && (review.docketId === null || identifier(review.docketId)), 'review identity');
    reviews.add(review.projectId);
    requireValid(IDENTITY_BASES.includes(String(review.identityBasis)) && ['requested_grid_mw', 'contracted_grid_mw', 'unknown'].includes(String(review.capacityBasis)) && (review.stage === null || REVIEWED_LOAD_STAGES.includes(review.stage as ReviewedLoadStage)) && text(review.stageRationale) && texts(review.limitations), 'review classification, stage or rationale');
    const project = projects.get(review.projectId)!;
    requireValid(!project.eligible || ELIGIBLE_IDENTITIES.has(review.identityBasis as LoadIdentityBasis), 'permit-only, grouped or unresolved records cannot be eligible');
    requireValid(project.loadMw === null ? review.capacityBasis === 'unknown' : review.capacityBasis !== 'unknown', 'known MW needs an explicit grid request/contract basis');
    requireValid(review.stage === null || project.eligible, 'excluded records cannot supply an active stage estimate');
    requireValid(Array.isArray(review.sourceEvidence) && review.sourceEvidence.length > 0, 'review evidence required');
    let latestEvidenceDay = '';
    const evidenceKeys = new Set<string>();
    for (const evidence of review.sourceEvidence) {
      fields(evidence, ['url', 'name', 'retrievedAt', 'sha256', 'publishedAt', 'sourceAsOf', 'excerpt'], 'evidence');
      requireValid(https(evidence.url) && text(evidence.name, 1500) && instant(evidence.retrievedAt) && evidence.retrievedAt <= generatedAt && typeof evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256) && text(evidence.excerpt, 20000), 'evidence provenance');
      const retrievedDay = calendarDayKst(evidence.retrievedAt);
      requireValid(sourceDate(evidence.publishedAt, retrievedDay) && sourceDate(evidence.sourceAsOf, retrievedDay), 'evidence chronology');
      const key = JSON.stringify([evidence.url, evidence.sha256]); requireValid(!evidenceKeys.has(key), 'duplicate evidence'); evidenceKeys.add(key);
      latestEvidenceDay = [latestEvidenceDay, retrievedDay].sort()[1];
    }
    requireValid(!project.sourceAsOf || project.sourceAsOf <= latestEvidenceDay, 'project date follows supporting acquisition');
  }
  requireValid(reviews.size === projects.size, 'every project needs exactly one review');
  const usedSources = new Set([...projects.values()].map(project => project.sourceId));
  requireValid([...sources.keys()].every(id => usedSources.has(id)), 'unused reviewed source');
}

/** Stable equality includes status, MW and source date so later changes need re-review. */
export function reviewedCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(reviewedCanonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + reviewedCanonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

validateReviewedLoadProjects(rawDataset);
export const reviewedLoadProjects: ReviewedLoadDataset = rawDataset;
const checkedProjects = new Map(reviewedLoadProjects.projects.map(project => [project.id, reviewedCanonicalJson(project)]));
const checkedReviews = new Map(reviewedLoadProjects.reviews.map(review => [review.projectId, review]));

export function matchingReviewedLoadProject(project: Project): ReviewedLoadProject | null {
  return checkedProjects.get(project.id) === reviewedCanonicalJson(project) ? checkedReviews.get(project.id) ?? null : null;
}

/** Reviewed cases are allowed without requiring an ISO queue ID or a complete utility register. */
export function eligibleSourceForProject(project: Project, source: Source | undefined): boolean {
  if (!source || source.id !== project.sourceId) return false;
  if (source.coverage === 'full_register' || source.coverage === 'filtered_register') return true;
  if (source.coverage !== 'case') return false;
  const review = matchingReviewedLoadProject(project);
  const reviewedSource = reviewedLoadProjects.sources.find(item => item.id === source.id);
  return project.eligible && !!review && ELIGIBLE_IDENTITIES.has(review.identityBasis)
    && !!reviewedSource && source.url === reviewedSource.url && source.region === reviewedSource.region;
}
