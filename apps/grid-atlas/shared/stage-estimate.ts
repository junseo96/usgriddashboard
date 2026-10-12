/**
 * An explicit stage proxy, separate from verified five-gate assessments.
 * Every gate value below is a model assumption, including undisclosed permits.
 * Source stages are not asserted to prove any individual gate's completion.
 */
import type { Gate, Project } from './types.ts';
import { matchingReviewedLoadProject } from './reviewed-load-projects.ts';
import { STAGE_ESTIMATE_CATALOG } from './stage-estimate-catalog.ts';
import { projectStageInferences } from './project-stage-inference-data.ts';
import { matchingProjectStageInference, estimateProjectStageInference, type ProjectStageInferenceEstimate, type StageInferenceQuery } from './project-stage-inference.ts';
export { STAGE_ESTIMATE_CATALOG } from './stage-estimate-catalog.ts';
export type { StageEstimateDefinition } from './stage-estimate-catalog.ts';

export const STAGE_ESTIMATE_VERSION = 'stage-proxy-v1' as const;
const GATE_ORDER: readonly Gate[] = ['technical', 'commercial', 'permitting', 'construction', 'energization'];
const GATE_LABEL: Record<Gate, string> = {
  technical: '기술 검토', commercial: '계약·비용', permitting: '인허가',
  construction: '공사·망보강', energization: '통전',
};

export interface StageEstimateGate {
  gate: Gate;
  progress: number;
  points: number;
  rationale: string;
}

export interface OfficialStageEstimate {
  modelVersion: typeof STAGE_ESTIMATE_VERSION;
  stage: string;
  label: string;
  point: number;
  gates: StageEstimateGate[];
  rationale: string;
  sourceUrl: string;
  sourceAsOf: string | null;
}
export type StageEstimate = OfficialStageEstimate | ProjectStageInferenceEstimate;

const BY_STAGE = new Map(STAGE_ESTIMATE_CATALOG.map(item => [item.stage, item]));
const LBNL_STAGES: Readonly<Record<string, string>> = {
  'Not Started': 'not_started',
  'Feasibility Study': 'feasibility_study',
  'Cluster Study': 'impact_study',
  'System Impact Study': 'impact_study',
  'Facility Study': 'facilities_study',
  'IA Pending': 'ia_pending',
  'IA Executed': 'ia_executed',
  'Construction': 'construction',
};
const NYISO_STAGES: Readonly<Record<string, string>> = {
  'Scoping Meeting Pending': 'scoping_pending',
  'SRIS/SIS Pending': 'impact_pending',
  'SRIS/SIS in Progress': 'impact_study',
  'SRIS/SIS Approved': 'impact_approved',
  'FS Pending': 'facilities_pending',
  'FS in Progress': 'facilities_study',
  'Accepted Cost Allocation/IA in Progress': 'ia_pending',
  'Under Construction': 'construction',
};

function verifiedSource(project: Project): Readonly<Record<string, string>> | null {
  try {
    const url = new URL(project.sourceUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (project.sourceId === 'lbnl-generation-storage-queues' && url.hostname === 'emp.lbl.gov') return LBNL_STAGES;
    if (project.sourceId === 'nyiso-load-register' && url.hostname === 'www.nyiso.com') return NYISO_STAGES;
  } catch { /* Invalid provenance cannot support a stage estimate. */ }
  return null;
}

export function estimateStage(project: Project, options: StageInferenceQuery = {}): StageEstimate | null {
  if (!project.eligible || project.status !== 'active') return null;
  // A reviewed retraction or average exclusion must not fall back to an older proxy.
  if (matchingProjectStageInference(projectStageInferences, project, options)) {
    return estimateProjectStageInference(projectStageInferences, project, options);
  }
  const mapping = verifiedSource(project);
  const review = matchingReviewedLoadProject(project);
  const stageId = mapping && Object.hasOwn(mapping, project.rawStatus) ? mapping[project.rawStatus] : review?.stage;
  const stage = stageId ? BY_STAGE.get(stageId) : undefined;
  if (!stage) return null;
  return {
    modelVersion: STAGE_ESTIMATE_VERSION,
    stage: stage.stage, label: stage.label, point: stage.point,
    gates: GATE_ORDER.map(gate => ({
      gate, progress: stage.progress[gate], points: 20 * (1 - stage.progress[gate]),
      rationale: `${stage.label} 단계에서 ${GATE_LABEL[gate]} 진행률 ${stage.progress[gate] * 100}%를 배정한 모형 가정, 해당 요건의 직접 확인 아님. ${stage.rationale}`,
    })),
    rationale: `공식 원문 상태 “${project.rawStatus}”에 ${STAGE_ESTIMATE_VERSION}를 적용한 단계 기반 추정입니다. ${review ? review.stageRationale + ' ' : ''}${stage.rationale} 실제 다섯 요건의 근거 평가는 변경하지 않습니다.`,
    sourceUrl: project.sourceUrl, sourceAsOf: project.sourceAsOf,
  };
}
