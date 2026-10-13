import { AGGREGATION_VERSION, GATES, MODEL_VERSION } from './types.ts';
import type { Assessment, GateScore, Project, ProjectScore, ProjectType, Summary } from './types.ts';
import { calendarDayKst, isCalendarDay as calendarDay, startOfKstDay } from './time.ts';
import { estimateStage } from './stage-estimate.ts';

type AssessmentInput = Omit<Assessment, 'id' | 'recordedAt'>;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const STATUSES = ['unknown', 'not_started', 'in_progress', 'complete', 'not_applicable'];

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !calendarDay(value.slice(0, 10))) return null;
  const time = Date.parse(value);
  const hours = Number(value.slice(11, 13));
  const minutes = Number(value.slice(14, 16));
  const seconds = Number(value.slice(17, 19));
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!Number.isFinite(time) || hours > 23 || minutes > 59 || seconds > 59 ||
    (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59))) return null;
  return time;
}

function sourceTime(value: unknown): number | null {
  return calendarDay(value) ? Date.parse(startOfKstDay(value)) : timestamp(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function httpsSource(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * Validate client evidence before append-only storage. The server assigns id and
 * recordedAt; clients cannot backdate when a judgment entered the database.
 * effectiveAt is a KST calendar date; publishedAt may be a calendar date or an
 * RFC3339 timestamp; observedAt must be an RFC3339 timestamp. Date-only sources
 * have day precision, so publication/effectiveness may be on the KST observation
 * day. Day boundaries are used only for comparisons; raw dates are not rewritten.
 * Effective dates may precede publication; both must be known by observation.
 */
export function validateAssessment(input: AssessmentInput, now: Date = new Date()): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Assessment must be an object.'];
  if (!Number.isFinite(now.getTime())) throw new Error('Validation time must be a valid Date.');
  if (!nonempty(input.projectId)) errors.push('projectId is required.');
  if (!(GATES as readonly unknown[]).includes(input.gate)) errors.push('Unknown gate.');
  if (!STATUSES.includes(input.status)) errors.push('Unknown assessment status.');
  if (input.modelVersion !== MODEL_VERSION) errors.push('Unsupported modelVersion.');
  if (input.basis !== 'official' && input.basis !== 'estimate') errors.push('basis must be official or estimate.');
  if (!httpsSource(input.sourceUrl)) errors.push('sourceUrl must be an HTTPS URL without credentials.');
  if (typeof input.rationale !== 'string') errors.push('rationale must be a string.');
  if (input.basis === 'estimate' && !nonempty(input.rationale)) errors.push('An estimate requires a rationale.');
  if (input.status === 'not_applicable' && !nonempty(input.rationale)) errors.push('An exemption requires a rationale.');

  const progress = input.progress;
  if (input.status === 'in_progress') {
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
      errors.push('in_progress requires progress between 0 and 1.');
    }
  } else if (input.status === 'not_started') {
    if (progress !== null && progress !== 0) errors.push('not_started progress must be null or 0.');
  } else if (input.status === 'complete') {
    if (progress !== null && progress !== 1) errors.push('complete progress must be null or 1.');
  } else if (progress !== null) {
    errors.push('unknown and not_applicable progress must be null.');
  }
  if (input.basis === 'estimate' && progress !== null && ![0, 0.25, 0.5, 0.75, 1].includes(progress)) {
    errors.push('Estimated progress must be 0, 0.25, 0.5, 0.75, or 1.');
  }

  const nowTime = now.getTime();
  const effective = calendarDay(input.effectiveAt) ? sourceTime(input.effectiveAt) : null;
  const published = input.publishedAt === null ? null : sourceTime(input.publishedAt);
  const observed = timestamp(input.observedAt);
  if (effective === null) errors.push('effectiveAt must be a valid YYYY-MM-DD date.');
  if (input.publishedAt !== null && published === null) errors.push('publishedAt must be null or a valid date/timestamp.');
  if (observed === null) errors.push('observedAt must be a valid RFC3339 timestamp.');
  if (effective !== null && effective > nowTime) errors.push('effectiveAt cannot be in the future.');
  if (published !== null && published > nowTime) errors.push('publishedAt cannot be in the future.');
  if (observed !== null && observed > nowTime) errors.push('observedAt cannot be in the future.');
  if (observed !== null && effective !== null && effective > observed) errors.push('effectiveAt cannot follow observation.');
  if (observed !== null && published !== null && published > observed) errors.push('publishedAt cannot follow observation.');
  return errors;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function precise(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * Choose the latest effective evidence per gate, breaking effective-date ties
 * by server recordedAt, then id for deterministic replay. asOf restricts the
 * effective date; knownAt restricts when evidence entered our database. Omitting
 * knownAt reconstructs the past using knowledge available now. No evidence is
 * inferred from a project's legacy source status or its capacity. A separately
 * labeled stage model may estimate the overall rating when there is no saved
 * gate evidence; it does not change these evidence scores or their bounds.
 */
export function scoreProject(
  project: Project,
  assessments: readonly Assessment[],
  options: { asOf?: string; knownAt?: string } = {},
): ProjectScore {
  const now = new Date();
  const asOf = options.asOf ?? calendarDayKst(now);
  const knownAt = options.knownAt === undefined ? now.getTime() : timestamp(options.knownAt);
  if (!calendarDay(asOf)) throw new Error('asOf must be a valid YYYY-MM-DD date.');
  if (knownAt === null) throw new Error('knownAt must be a valid RFC3339 timestamp.');
  const selected = new Map<string, Assessment>();
  const seen = new Map<string, string>();
  for (const assessment of assessments) {
    if (assessment.projectId !== project.id) continue;
    if (assessment.modelVersion !== MODEL_VERSION) throw new Error(`Unsupported assessment model for ${project.id}.`);
    if (!nonempty(assessment.id)) throw new Error('Stored assessment id is required.');
    const storedAt = timestamp(assessment.recordedAt);
    if (storedAt === null) throw new Error(`Invalid recordedAt for assessment ${assessment.id}.`);
    const errors = validateAssessment(assessment, new Date(Math.max(now.getTime(), storedAt)));
    if (errors.length) throw new Error(`Invalid assessment ${assessment.id}: ${errors.join(' ')}`);
    if (timestamp(assessment.observedAt)! > storedAt) throw new Error(`Assessment ${assessment.id} was recorded before observation.`);
    const serialized = canonical(assessment);
    if (seen.has(assessment.id) && seen.get(assessment.id) !== serialized) throw new Error(`Conflicting assessment id: ${assessment.id}.`);
    seen.set(assessment.id, serialized);
    if (assessment.effectiveAt > asOf || storedAt > knownAt) continue;
    const previous = selected.get(assessment.gate);
    if (!previous || assessment.effectiveAt > previous.effectiveAt ||
      (assessment.effectiveAt === previous.effectiveAt && (storedAt > timestamp(previous.recordedAt)! ||
        (storedAt === timestamp(previous.recordedAt)! && assessment.id > previous.id)))) {
      selected.set(assessment.gate, assessment);
    }
  }
  const gates: GateScore[] = GATES.map(gate => {
    const assessment = selected.get(gate) ?? null;
    const status = assessment?.status ?? 'unknown';
    const progress = status === 'complete' ? 1 : status === 'not_started' ? 0 :
      status === 'in_progress' ? assessment!.progress : null;
    return { gate, status, progress, points: progress === null ? null : precise(20 * (1 - progress)), assessment };
  });
  const applicable = gates.filter(gate => gate.status !== 'not_applicable');
  const known = applicable.filter(gate => gate.points !== null);
  const assessedGates = gates.filter(gate => gate.status !== 'unknown').length;
  const estimated = gates.some(gate => gate.status !== 'unknown' && gate.assessment?.basis === 'estimate');
  // Saved evidence, including an explicit unknown correction, takes precedence
  // over a coarse source-status model. Never let that model mask a partial review.
  const stageEstimate = project.eligible && selected.size === 0 ? estimateStage(project, { asOf, ...(options.knownAt ? { knownAt: new Date(knownAt).toISOString() } : {}) }) : null;
  // An all-exempt record has no defined denominator, not a proved zero score.
  if (!applicable.length) return { project, gates, point: null, lower: 0, upper: 100, assessedGates, estimated, stageEstimate };
  const scale = GATES.length / applicable.length;
  const lower = precise(known.reduce((sum, gate) => sum + gate.points!, 0) * scale);
  const upper = precise(lower + (applicable.length - known.length) * 20 * scale);
  return { project, gates, point: known.length === applicable.length ? lower : null, lower, upper, assessedGates, estimated, stageEstimate };
}

/** Displayed rating: complete gate evidence first, otherwise a labeled model estimate. */
export function ratingPoint(score: ProjectScore): number | null {
  return score.point ?? score.stageEstimate?.point ?? null;
}

export function ratingIsEstimated(score: ProjectScore): boolean {
  return score.point !== null ? score.estimated : score.stageEstimate != null;
}

const CAPACITY_FIELDS = { generation: 'generationMw', storage: 'storageMw', load: 'loadMw' } as const;
const PROJECT_TYPES = ['generation', 'storage', 'load'] as const;

/** Disclosed member-component MW; null and disclosed zero remain distinct.
 * Overall sums components once per record, not a physical shared-POI capacity.
 */
export function projectCapacityMw(project: Project, type: ProjectType | 'all' = 'all'): number | null {
  const components = (type === 'all' ? [...new Set(project.types)] : project.types.includes(type) ? [type] : [])
    .map(member => project[CAPACITY_FIELDS[member]]).filter(value => value !== null);
  if (components.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`Invalid capacity for ${project.id}.`);
  if (!components.length) return null;
  const total = components.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total)) throw new Error(`Invalid capacity total for ${project.id}.`);
  return total;
}

/** Capacity-weighted means with the original project-count means retained as
 * explicitly named auxiliary metrics. Positive disclosed MW are required for
 * weighting; absent or zero MW never contribute to the numerator/denominator.
 * Bounds cover all eligible positive MW; point/rating means cover only scored
 * positive MW. Identical records collapse; conflicting identities fail.
 */
export function summarize(scores: readonly ProjectScore[], options: { type?: ProjectType | 'all' } = {}): Summary {
  const weightingType = options.type ?? 'all';
  if (weightingType !== 'all' && !PROJECT_TYPES.includes(weightingType)) throw new Error('Invalid weighting type.');
  const records = new Map<string, ProjectScore>();
  const sourceIds = new Map<string, string>();
  for (const score of scores) {
    const project = score.project;
    if (!nonempty(project.id) || !nonempty(project.sourceId) || !nonempty(project.sourceRecordId)) throw new Error('A source-record identity is required.');
    const sourceKey = canonical([project.sourceId, project.sourceRecordId]);
    if (sourceIds.has(sourceKey) && sourceIds.get(sourceKey) !== project.id) throw new Error(`Conflicting canonical IDs for source record ${sourceKey}.`);
    sourceIds.set(sourceKey, project.id);
    const existing = records.get(project.id);
    if (existing && canonical(existing) !== canonical(score)) throw new Error(`Conflicting duplicate project: ${project.id}.`);
    records.set(project.id, score);
  }
  if (weightingType !== 'all') for (const [id, score] of records) if (!score.project.types.includes(weightingType)) records.delete(id);
  const summary: Summary = {
    aggregationVersion: AGGREGATION_VERSION, weightingType,
    weightingBasis: weightingType === 'all' ? 'disclosed_component_mw' : `${weightingType}_mw`,
    ratedCapacityMw: 0, scoredCapacityMw: 0, boundsCapacityMw: 0,
    ratingWeightedCount: 0, scoredWeightedCount: 0, capacityWeightedCount: 0,
    ratingUnscoredCapacityMw: 0, missingCapacityCount: 0, zeroCapacityCount: 0,
    ratedMissingCapacityCount: 0, ratedZeroCapacityCount: 0, partialCapacityCount: 0,
    projectCountRatingMean: null, projectCountPointMean: null, projectCountLowerMean: null, projectCountUpperMean: null,
    projectCountRatingTypeMeans: { generation: null, storage: null, load: null },
    ratingTypeCapacityMw: { generation: 0, storage: 0, load: 0 },
    ratingTypeWeightedCounts: { generation: 0, storage: 0, load: 0 },
    ratingTypeUnscoredCapacityMw: { generation: 0, storage: 0, load: 0 },
    recordCount: records.size, eligibleCount: 0, scoredCount: 0, unknownCount: 0, excludedCount: 0,
    estimatedCount: 0, pointMean: null, lowerMean: null, upperMean: null,
    generationMw: 0, storageMw: 0, loadMw: 0, capacityUnknownCount: 0,
    typeCounts: { generation: 0, storage: 0, load: 0 },
    knownCapacityCounts: { generation: 0, storage: 0, load: 0 },
    ratingMean: null, ratedCount: 0, ratingUnknownCount: 0, ratingEstimatedCount: 0,
    ratingTypeMeans: { generation: null, storage: null, load: null },
    ratingTypeCounts: { generation: 0, storage: 0, load: 0 },
    ratingRegions: [],
  };
  let pointTotal = 0, ratingTotal = 0, lowerTotal = 0, upperTotal = 0;
  let pointWeightedTotal = 0, ratingWeightedTotal = 0, lowerWeightedTotal = 0, upperWeightedTotal = 0;
  const ratingTypeTotals = { generation: 0, storage: 0, load: 0 };
  const ratingTypeWeightedTotals = { generation: 0, storage: 0, load: 0 };
  const ratingRegions = new Map<string, { region: string; total: number; weightedTotal: number; ratedCount: number; unknownCount: number; estimatedCount: number; ratedCapacityMw: number; weightedCount: number; unscoredCapacityMw: number; missingCapacityCount: number; zeroCapacityCount: number; partialCapacityCount: number }>();
  for (const score of records.values()) {
    const project = score.project;
    if (!project.eligible) { summary.excludedCount++; continue; }
    if (!Number.isFinite(score.lower) || !Number.isFinite(score.upper) || score.lower < 0 || score.upper > 100 || score.lower > score.upper ||
      (score.point !== null && (!Number.isFinite(score.point) || score.point < 0 || score.point > 100 || score.point !== score.lower || score.point !== score.upper))) {
      throw new Error(`Invalid score bounds for ${project.id}.`);
    }
    const types = new Set(project.types);
    for (const type of types) if (!(type in summary.typeCounts)) throw new Error(`Invalid project type for ${project.id}.`);
    let missing = project.capacityStatus !== 'known';
    for (const [type, field] of Object.entries(CAPACITY_FIELDS) as [ProjectType, typeof CAPACITY_FIELDS[ProjectType]][]) {
      const capacity = project[field];
      if (capacity !== null && (!Number.isFinite(capacity) || capacity < 0)) throw new Error(`Invalid ${field} for ${project.id}.`);
      if (!types.has(type)) continue;
      if (capacity === null) missing = true;
      else { summary[field] += capacity; summary.knownCapacityCounts[type]++; }
    }
    if (missing) summary.capacityUnknownCount++;
    const weight = projectCapacityMw(project, weightingType);
    const isPartial = weightingType === 'all' && weight !== null && [...types].some(type => project[CAPACITY_FIELDS[type]] === null);
    summary.eligibleCount++;
    if (score.point === null) summary.unknownCount++;
    else { summary.scoredCount++; pointTotal += score.point; }
    if (score.estimated) summary.estimatedCount++;
    const rating = ratingPoint(score);
    if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 100)) throw new Error(`Invalid rating for ${project.id}.`);
    const ratingEstimated = ratingIsEstimated(score);
    const region = ratingRegions.get(project.region) ?? { region: project.region, total: 0, weightedTotal: 0, ratedCount: 0, unknownCount: 0, estimatedCount: 0, ratedCapacityMw: 0, weightedCount: 0, unscoredCapacityMw: 0, missingCapacityCount: 0, zeroCapacityCount: 0, partialCapacityCount: 0 };
    ratingRegions.set(project.region, region);
    if (rating === null) { summary.ratingUnknownCount++; region.unknownCount++; }
    else {
      summary.ratedCount++; ratingTotal += rating;
      region.ratedCount++; region.total += rating;
      if (ratingEstimated) { summary.ratingEstimatedCount++; region.estimatedCount++; }
    }
    lowerTotal += score.lower; upperTotal += score.upper;
    if (weight === null) {
      summary.missingCapacityCount++; region.missingCapacityCount++;
      if (rating !== null) summary.ratedMissingCapacityCount++;
    } else if (weight === 0) {
      summary.zeroCapacityCount++; region.zeroCapacityCount++;
      if (rating !== null) summary.ratedZeroCapacityCount++;
    } else {
      summary.capacityWeightedCount++; summary.boundsCapacityMw += weight;
      lowerWeightedTotal += weight * score.lower; upperWeightedTotal += weight * score.upper;
      if (score.point !== null) { summary.scoredWeightedCount++; summary.scoredCapacityMw += weight; pointWeightedTotal += weight * score.point; }
      if (rating !== null) {
        summary.ratingWeightedCount++; summary.ratedCapacityMw += weight; ratingWeightedTotal += weight * rating;
        region.weightedCount++; region.ratedCapacityMw += weight; region.weightedTotal += weight * rating;
      } else { summary.ratingUnscoredCapacityMw += weight; region.unscoredCapacityMw += weight; }
    }
    if (isPartial) { summary.partialCapacityCount++; region.partialCapacityCount++; }
    for (const type of types) {
      summary.typeCounts[type]++;
      const capacity = project[CAPACITY_FIELDS[type]];
      if (rating !== null) {
        summary.ratingTypeCounts[type]++; ratingTypeTotals[type] += rating;
        if (capacity !== null && capacity > 0) {
          summary.ratingTypeWeightedCounts[type]++; summary.ratingTypeCapacityMw[type] += capacity;
          ratingTypeWeightedTotals[type] += rating * capacity;
        }
      } else if (capacity !== null && capacity > 0) summary.ratingTypeUnscoredCapacityMw[type] += capacity;
    }
  }
  const mean = (total: number, denominator: number): number | null => {
    if (!Number.isFinite(total) || !Number.isFinite(denominator)) throw new Error('Capacity aggregation exceeds finite numeric range.');
    return denominator > 0 ? precise(total / denominator) : null;
  };
  summary.pointMean = mean(pointWeightedTotal, summary.scoredCapacityMw);
  summary.ratingMean = mean(ratingWeightedTotal, summary.ratedCapacityMw);
  summary.lowerMean = mean(lowerWeightedTotal, summary.boundsCapacityMw);
  summary.upperMean = mean(upperWeightedTotal, summary.boundsCapacityMw);
  summary.projectCountPointMean = mean(pointTotal, summary.scoredCount);
  summary.projectCountRatingMean = mean(ratingTotal, summary.ratedCount);
  summary.projectCountLowerMean = mean(lowerTotal, summary.eligibleCount);
  summary.projectCountUpperMean = mean(upperTotal, summary.eligibleCount);
  for (const type of PROJECT_TYPES) {
    summary.ratingTypeMeans[type] = mean(ratingTypeWeightedTotals[type], summary.ratingTypeCapacityMw[type]);
    summary.projectCountRatingTypeMeans[type] = mean(ratingTypeTotals[type], summary.ratingTypeCounts[type]);
    summary.ratingTypeCapacityMw[type] = precise(summary.ratingTypeCapacityMw[type]);
    summary.ratingTypeUnscoredCapacityMw[type] = precise(summary.ratingTypeUnscoredCapacityMw[type]);
  }
  summary.ratingRegions = [...ratingRegions.values()].sort((a, b) => a.region.localeCompare(b.region)).map(({ total, weightedTotal, ...region }) => ({
    ...region, ratedCapacityMw: precise(region.ratedCapacityMw), unscoredCapacityMw: precise(region.unscoredCapacityMw),
    mean: mean(weightedTotal, region.ratedCapacityMw), projectCountMean: mean(total, region.ratedCount),
  }));
  for (const field of ['generationMw', 'storageMw', 'loadMw', 'ratedCapacityMw', 'scoredCapacityMw', 'boundsCapacityMw', 'ratingUnscoredCapacityMw'] as const) summary[field] = precise(summary[field]);
  return summary;
}
