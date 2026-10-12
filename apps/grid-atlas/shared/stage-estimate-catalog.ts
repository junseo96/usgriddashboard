import type { Gate } from './types.ts';
const GATE_ORDER: readonly Gate[] = ['technical', 'commercial', 'permitting', 'construction', 'energization'];

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
