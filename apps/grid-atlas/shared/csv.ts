import { projectCapacityMw, ratingPoint } from './scoring.ts';
import { AGGREGATION_VERSION, type ProjectScore, type ProjectType } from './types.ts';

/** Keep the original columns in place; append review provenance for existing consumers. */
export const PROJECT_CSV_HEADERS = [
  'id', 'name', 'types', 'region', 'state', 'status', 'eligible', 'generation_mw', 'storage_mw', 'load_mw',
  'bottleneck_score', 'lower', 'upper', 'assessed_gates', 'estimated', 'source_url', 'source_as_of',
  'snapshot_captured_at', 'as_of', 'known_at', 'model_version', 'rating_score', 'rating_basis',
  'rating_model_version', 'raw_status', 'stage_model_rationale',
  'stage_model_stage', 'stage_model_source_url', 'stage_model_source_as_of',
  'stage_inference_judgement_id', 'stage_inference_confidence', 'stage_inference_bottleneck',
  'stage_inference_evaluated_at', 'stage_inference_status', 'stage_inference_status_basis',
  'stage_inference_apply_to_average', 'stage_inference_identity_status',
  'stage_inference_assumptions', 'stage_inference_limitations', 'stage_inference_source_evidence',
  'aggregation_version', 'weighting_type', 'weighting_basis', 'score_weight_mw',
  'capacity_weight_eligible', 'weight_exclusion_reason', 'weighted_contribution', 'capacity_component_partial',
] as const;

export interface ProjectCsvContext {
  snapshotCapturedAt: string;
  asOf?: string;
  knownAt?: string;
  modelVersion: string;
  type?: ProjectType | 'all';
}

function csvValue(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function projectCsv(scores: readonly ProjectScore[], context: ProjectCsvContext): string {
  const rows = scores.map(score => {
    const project = score.project, stage = score.stageEstimate;
    const review = stage?.modelVersion === 'qualitative-stage-v1' ? stage : null;
    const type = context.type ?? 'all', weight = projectCapacityMw(project, type), rating = ratingPoint(score);
    const reason = !project.eligible ? 'project_excluded' : type !== 'all' && !project.types.includes(type) ? 'outside_type_scope' : rating === null ? 'score_unknown' : weight === null ? 'capacity_undisclosed' : weight === 0 ? 'zero_capacity' : '';
    const included = reason === '';
    const partial = type === 'all' && weight !== null && project.types.some(member => project[`${member}Mw`] === null);
    return [
      project.id, project.name, project.types.join('|'), project.region, project.state, project.status,
      project.eligible, project.generationMw, project.storageMw, project.loadMw,
      score.point, score.lower, score.upper, score.assessedGates, score.estimated,
      project.sourceUrl, project.sourceAsOf, context.snapshotCapturedAt, context.asOf, context.knownAt,
      context.modelVersion, ratingPoint(score),
      score.point !== null ? (score.estimated ? 'gate_estimate' : 'gate_evidence') : stage ? 'stage_model' : 'unknown',
      score.point !== null ? context.modelVersion : stage?.modelVersion ?? '', project.rawStatus, stage?.rationale ?? '',
      stage?.stage, stage?.sourceUrl, stage?.sourceAsOf,
      review?.judgementId, review?.confidence, review?.bottleneck, review?.evaluatedAt,
      review?.status, review?.statusBasis, review?.applyToAverage, review?.identityStatus,
      review ? JSON.stringify(review.assumptions) : '', review ? JSON.stringify(review.limitations) : '',
      review ? JSON.stringify(review.sourceEvidence) : '',
      AGGREGATION_VERSION, type, type === 'all' ? 'disclosed_component_mw' : `${type}_mw`, weight,
      included, reason, included ? weight! * rating! : null, partial,
    ].map(csvValue).join(',');
  });
  return '\uFEFF' + [PROJECT_CSV_HEADERS.join(','), ...rows].join('\r\n');
}
