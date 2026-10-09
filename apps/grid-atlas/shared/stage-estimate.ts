/**
 * An explicit stage proxy, separate from verified five-gate assessments.
 * Every gate value below is a model assumption, including undisclosed permits.
 * Source stages are not asserted to prove any individual gate's completion.
 */
import type { Gate, Project } from './types.ts';

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

export interface StageEstimate {
  modelVersion: typeof STAGE_ESTIMATE_VERSION;
  stage: string;
  label: string;
  point: number;
  gates: StageEstimateGate[];
  rationale: string;
  sourceUrl: string;
  sourceAsOf: string | null;
}

export interface StageEstimateDefinition {
  stage: string;
  label: string;
  point: number;
  progress: Readonly<Record<Gate, number>>;
  rationale: string;
}

type ProgressTuple = readonly [number, number, number, number, number];
function definition(stage: string, label: string, values: ProgressTuple, rationale: string): StageEstimateDefinition {
  const progress = Object.fromEntries(GATE_ORDER.map((gate, index) => [gate, values[index]])) as Record<Gate, number>;
  return { stage, label, progress, point: values.reduce((sum, value) => sum + 20 * (1 - value), 0), rationale };
}

/** Reviewed model parameters; callers can display the complete assumptions. */
export const STAGE_ESTIMATE_CATALOG: readonly StageEstimateDefinition[] = [
  definition('not_started', '연구 미착수', [0, 0, 0, 0, 0],
    '원문의 Not Started를 이 모형의 시작점으로 두어 100점을 부여합니다. 실제 다섯 요건 모두 미진행이라고 확인한 평가는 아닙니다.'),
  definition('scoping_pending', '범위 협의 대기', [0, 0, 0, 0, 0],
    '신청 접수 후 범위 협의 대기만 확인되고 완료한 요건이 드러나지 않아 모형 시작점 100점을 부여합니다. 접수만으로 진행률을 부여하지 않으며 실제 다섯 요건 모두 미진행이라고 확인한 평가는 아닙니다.'),
  definition('feasibility_study', '타당성 연구', [.25, .25, 0, 0, 0],
    '타당성 연구라는 초기 단계에 기술·상업 요건 각각 25%를 가정합니다. 계약 체결·허가 여부는 별도로 확인되지 않았습니다.'),
  definition('impact_pending', '계통영향 연구 대기', [.5, .25, 0, 0, 0],
    '계통영향 연구 대기라는 단계 위치를 기술 50%·상업 25%로 모형화합니다. 대기 상태를 연구 완료로 해석하지 않습니다.'),
  definition('impact_study', '계통영향·클러스터 연구', [.5, .25, .25, 0, 0],
    '계통영향 또는 클러스터 연구 단계를 기술 50%·상업 25%·인허가 25%의 공통 모형 위치로 둡니다. 인허가 진행은 원문에서 직접 확인한 사실이 아닙니다.'),
  definition('impact_approved', '계통영향 연구 승인', [.75, .25, .25, 0, 0],
    '계통영향 연구 승인을 기술 75%로 두며 뒤따르는 시설연구를 남겨 둡니다. 전체 기술 요건·계약·인허가 완료를 뜻하지 않습니다.'),
  definition('facilities_pending', '시설연구 대기', [.75, .25, .25, 0, 0],
    'NYISO FS는 Facilities Study이며 FES(Feasibility Study)와 다릅니다. 시설연구 대기는 영향연구 승인과 같은 모형 위치로 두고 추가 진척을 가정하지 않습니다.'),
  definition('facilities_study', '시설연구 진행', [.75, .5, .25, 0, 0],
    '시설연구 단계의 상세 설계·비용 검토를 기술 75%·상업 50%로 모형화합니다. 실제 공사 착수나 인허가 취득은 확인하지 않았습니다.'),
  definition('ia_pending', '접속계약 협의', [1, .75, .5, 0, 0],
    '접속계약 대기·협의 또는 비용배분 수락 후 IA 진행을 계약 75%의 모형 위치로 둡니다. 기술 100%·인허가 50%도 모형상 가정이며 전체 기술 완료나 실제 허가의 직접 확인이 아닙니다.'),
  definition('ia_executed', '접속계약 체결', [1, 1, .5, 0, 0],
    'IA Executed를 접속계약 체결 단계로 분류해 기술·상업 100%·인허가 50%를 가정합니다. IA 체결만으로 모든 계약·허가·공사 요건의 완료를 입증하지 않습니다.'),
  definition('construction', '공사 진행', [1, 1, 1, .75, 0],
    '공사 단계의 모형 위치를 기술·상업·인허가 100%, 공사 75%, 통전 0%로 둡니다. 75%는 실제 공정률이 아니며 필요한 허가 전부 취득·부분 통전 부재를 확인했다는 뜻도 아닙니다.'),
];

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

export function estimateStage(project: Project): StageEstimate | null {
  if (!project.eligible || project.status !== 'active') return null;
  const mapping = verifiedSource(project);
  if (!mapping || !Object.hasOwn(mapping, project.rawStatus)) return null;
  const stage = BY_STAGE.get(mapping[project.rawStatus]);
  if (!stage) return null;
  return {
    modelVersion: STAGE_ESTIMATE_VERSION,
    stage: stage.stage, label: stage.label, point: stage.point,
    gates: GATE_ORDER.map(gate => ({
      gate, progress: stage.progress[gate], points: 20 * (1 - stage.progress[gate]),
      rationale: `${stage.label} 단계에서 ${GATE_LABEL[gate]} 진행률 ${stage.progress[gate] * 100}%를 배정한 모형 가정, 해당 요건의 직접 확인 아님. ${stage.rationale}`,
    })),
    rationale: `공식 원문 상태 “${project.rawStatus}”에 ${STAGE_ESTIMATE_VERSION}를 적용한 단계 기반 추정입니다. ${stage.rationale} 실제 다섯 요건의 근거 평가는 변경하지 않습니다.`,
    sourceUrl: project.sourceUrl, sourceAsOf: project.sourceAsOf,
  };
}
