import type { ReactNode } from 'react';
import { ArrowRight, BadgeCheck, ChartNoAxesCombined, CircleHelp, FileSearch, Layers3 } from 'lucide-react';
import { GATES, type DashboardResponse, type Gate, type GateStatus, type ProjectScore, type ProjectType } from '../shared/types';
import { ratingPoint } from '../shared/scoring';
import LoadBottleneckPanel from './LoadBottleneckPanel';
import './bottleneck-workspace.css';
import StageInferenceWorkspace from './StageInferenceWorkspace';
import LargeLoadFacilities from './LargeLoadFacilities';

export type ScoreTab = 'projects' | 'inferences' | 'regional' | 'methodology' | 'facilities';
interface Props {
  data: DashboardResponse | null;
  revision: number;
  onProject: (id: string) => void;
  projectTable: ReactNode;
  projectControls?: ReactNode;
  projectFallback: ReactNode;
  methodology: ReactNode;
  onCoverage: () => void;
  tab: ScoreTab;
  onTabChange: (tab: ScoreTab) => void;
  selectedType: ProjectType | 'all';
  selectedRegion: string;
  onRegionChange: (region: string) => void;
  onOpenRegional: (region: string) => void;
}
const TYPES: ProjectType[] = ['generation', 'storage', 'load'];
const TYPE_LABEL: Record<ProjectType, string> = { generation: '발전원', storage: '저장전원', load: '수용가' };
const GATE_LABEL: Record<Gate, string> = {
  technical: '기술 검토', commercial: '계약·비용보증', permitting: '부지·인허가',
  construction: '설비·계통 보강', energization: '통전·운영 승인',
};
const GATE_STATUS: Record<GateStatus, string> = {
  unknown: '미확인', not_started: '미진행 확인', in_progress: '진행 중', complete: '통과 확인', not_applicable: '해당 없음',
};
const number = (value: number) => value.toLocaleString('ko-KR');
const decimal = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const gw = (value: number) => (value / 1000).toLocaleString('ko-KR', { maximumFractionDigits: value > 0 && value < 1000 ? 3 : 2 });
const pointLabel = (value: number | null) => value === null ? '미산출' : decimal(value);
const dateLabel = (value: string | null) => value ? value.replaceAll('-', '.') : '원자료 기준일 미공개';

/** Display the same rating selected by the API, with model gates kept distinct from evidence. */
function GateCell({ score, gate }: { score: ProjectScore; gate: Gate }) {
  const direct = score.gates.find(item => item.gate === gate);
  const useModel = score.point === null && score.stageEstimate !== null && !score.gates.some(item => item.assessment !== null);
  const modeled = useModel ? score.stageEstimate?.gates.find(item => item.gate === gate) : undefined;
  const progress = modeled?.progress ?? direct?.progress ?? null;
  const points = modeled?.points ?? direct?.points ?? null;
  const notApplicable = !modeled && direct?.status === 'not_applicable';
  const label = modeled ? '모형 가정' : direct?.assessment?.basis === 'estimate' ? '근거 추정' : direct?.assessment ? '공식 근거' : '근거 없음';
  const description = modeled?.rationale ?? direct?.assessment?.rationale ?? (notApplicable ? '해당 요건의 면제 근거가 있습니다.' : '점수를 계산할 진행 근거가 없습니다.');
  return <td className={`bw-gate-cell ${modeled ? 'modeled' : points === null ? 'unknown' : 'evidenced'}`} title={description}>
    <strong>{notApplicable ? '해당 없음' : points === null ? '미확인' : decimal(points)}{points !== null && <small>/20</small>}</strong>
    <span className="bw-gate-status">{modeled ? `가정 진행률 ${decimal(progress! * 100)}%` : direct ? GATE_STATUS[direct.status] : '미확인'}</span>
    {progress !== null && <span className="bw-gate-progress" aria-label={`${modeled ? '모형 가정 ' : ''}진행률 ${decimal(progress * 100)}%`}><i style={{ width: `${progress * 100}%` }} /></span>}
    <small className="bw-gate-basis">{label}</small>
  </td>;
}

function ProjectMatrix({ data, onProject }: { data: DashboardResponse; onProject: Props['onProject'] }) {
  const first = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data.total ? first + data.projects.length - 1 : 0;
  return <section className="bw-matrix panel" aria-label="현재 검색 페이지의 프로젝트별 절차 점수">
    <header className="bw-section-heading"><div><span className="eyebrow">PROJECT PROGRESS</span><h2>프로젝트별 절차와 잔여점수</h2></div><span className="bw-page-count">검색 {number(data.total)}건 중 {number(first)}–{number(last)}건</span></header>
    <p className="bw-section-note">현재 검색 페이지의 {number(data.projects.length)}건입니다. 행을 선택하면 원문 단계·기준일·평가 이유를 확인할 수 있습니다. 아래 행의 분포를 전국 분포로 해석하지 않습니다.</p>
    <div className="bw-matrix-legend"><span><i className="model" />진행 자료에 적용한 모형 가정</span><span><i className="evidence" />별도 입력된 요건별 근거</span><span><i className="unknown" />미확인 · 점수 없음</span></div>
    <div className="bw-table-scroll" tabIndex={0} aria-label="프로젝트 절차 표 · 좁은 화면에서는 가로로 이동">
      <table className="bw-matrix-table"><thead><tr><th scope="col">프로젝트 · 원문 진행 상태</th>{GATES.map(gate => <th scope="col" key={gate}>{GATE_LABEL[gate]}<small>잔여 0–20점</small></th>)}<th scope="col">전체 병목점수</th></tr></thead>
        <tbody>{data.projects.map(score => {
          const point = ratingPoint(score);
          const components = (data.summary.weightingType === 'all' ? score.project.types : [data.summary.weightingType]).map(type => score.project[`${type}Mw`]);
          const knownComponents = components.filter((value): value is number => value !== null);
          const weightingMw = knownComponents.length ? knownComponents.reduce((sum, value) => sum + value, 0) : null;
          const model = score.point === null ? score.stageEstimate : null;
          const basis = model ? model.modelVersion === 'qualitative-stage-v1' ? '자료 종합 추정' : '단계 추정' : score.point !== null ? score.estimated ? '요건별 근거 추정 포함' : '요건별 공식 근거' : '진행 근거 부족';
          return <tr key={score.project.id} onClick={() => onProject(score.project.id)} className={score.project.eligible ? '' : 'bw-excluded-row'}>
            <th scope="row"><button className="bw-project-button" onClick={event => { event.stopPropagation(); onProject(score.project.id); }}>{score.project.name}<ArrowRight size={13} /></button>
              <span className="bw-project-meta">{score.project.region} · {score.project.types.map(type => TYPE_LABEL[type]).join(' / ')} · {score.project.sourceRecordId}</span>
              <span className="bw-source-status">{score.project.rawStatus || '원장 단계 미공개'}</span>
              {model && <span className="bw-model-stage">모형 분류: {model.label}{model.modelVersion === 'qualitative-stage-v1' && ` · 신뢰도 ${{ high: '높음', medium: '보통', low: '낮음' }[model.confidence]}`}</span>}
              <small className="bw-source-date">{dateLabel(score.project.sourceAsOf)}</small>
            </th>
            {GATES.map(gate => <GateCell key={gate} score={score} gate={gate} />)}
            <td className="bw-total-cell"><strong className={point !== null && point >= 70 ? 'high' : ''}>{pointLabel(point)}{point !== null && <small>/100</small>}</strong><span className={model ? 'bw-model-tag' : 'bw-direct-tag'}>{basis}</span>
              {score.project.eligible && point !== null && <small className="bw-source-date">{weightingMw === null ? '가중평균 제외 · MW 미공개' : weightingMw <= 0 ? '가중평균 제외 · 0 MW' : `평균 가중치 ${decimal(weightingMw)} MW`}</small>}
              {!score.project.eligible && <small className="bw-exclusion">평균 제외 · {score.project.exclusionReason || '적격 범위 밖'}</small>}
              {score.point === null && !model && score.gates.some(gate => gate.assessment) && <small className="bw-partial-note">일부 근거만 확보</small>}
            </td>
          </tr>;
        })}</tbody>
      </table>
      {!data.projects.length && <div className="bw-empty"><FileSearch size={24} /><strong>현재 검색 조건의 프로젝트가 없습니다.</strong><p>권역·유형 또는 원장 검색 조건을 변경해 주세요.</p></div>}
    </div>
    <footer className="bw-matrix-footer"><CircleHelp size={15} /><p>모형 진행률은 실제 공정률·허가 취득 확인값이 아닙니다. 직접 근거가 일부라도 있으면 단계 추정으로 빈 요건을 채우지 않습니다. ‘해당 없음’ 요건이 있는 직접 평가는 적용 요건의 합을 100점으로 환산합니다.</p></footer>
  </section>;
}

export default function BottleneckWorkspace({ data, revision, onProject, projectTable, projectControls, projectFallback, methodology, onCoverage, tab, onTabChange, selectedType, selectedRegion, onRegionChange, onOpenRegional }: Props) {
  const selectTab = onTabChange;
  const s = data?.summary;
  const officialCount = s ? s.ratedCount - s.ratingEstimatedCount : 0;
  const modeledCount = s ? s.ratedCount - s.scoredCount : 0;
  const observedAt = data?.snapshot ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.snapshot.capturedAt)) + ' KST' : '관측 자료 없음';
  return <div className="bottleneck-workspace">
    <nav className="bw-tabs" aria-label="병목점수 보기">{([
      ['facilities', '전국 수용가 시설·개발 점수', <Layers3 size={16} />],
      ['projects', selectedType === 'load' ? '개별 수용가 신청·계약' : '개별 프로젝트 평가', <Layers3 size={16} />],
      ['inferences', '자료 종합·진행 판단', <FileSearch size={16} />],
      ['regional', '수용가 권역별 평가', <ChartNoAxesCombined size={16} />],
      ['methodology', '산정 기준', <CircleHelp size={16} />],
    ] as const).map(([key, label, icon]) => <button key={key} aria-pressed={tab === key} className={tab === key ? 'selected' : ''} onClick={() => selectTab(key)}>{icon}{label}</button>)}</nav>
    {tab === 'facilities' ? <LargeLoadFacilities region={selectedRegion} onRegion={onRegionChange} onProject={onProject} scoreFocus /> : tab === 'inferences' ? <StageInferenceWorkspace region={selectedRegion} type={selectedType} onRegion={onRegionChange} onProject={onProject} /> : tab === 'regional' ? <LoadBottleneckPanel revision={revision} onCoverage={onCoverage} selectedRegion={selectedRegion} onRegionChange={onRegionChange} /> : tab === 'methodology' ? methodology : <>
      {(selectedType === 'all' || selectedType === 'load') && <LoadBottleneckPanel revision={revision} onCoverage={onCoverage} selectedRegion={selectedRegion} onRegionChange={onOpenRegional} overviewOnly />}
      {selectedType === 'load' && <div className="bw-scope-note bw-load-register-scope"><CircleHelp size={17} /><div><strong>개별 전력공급 요청과 검토된 주 규제기관 계약 사건입니다.</strong><p>공식 요청번호 또는 단일 사업의 계약 사건을 연결합니다. 진행 단계가 부족하면 점수는 미산출이며, 회사별 MW 집계는 위 권역별 카드에서 별도로 조회합니다.</p><button onClick={() => onOpenRegional(selectedRegion)}>선택 권역의 수용가 평가 보기<ArrowRight size={13} /></button></div></div>}
      {!data?.available || !s ? projectFallback : <>
      <section className="bw-summary" aria-label="선택 범위의 병목점수와 평가 분모">
        <article className="bw-mean"><span>{selectedType === 'load' ? '수용가 원장 용량 가중평균' : '선택 범위 용량 가중평균'}</span><strong>{pointLabel(s.ratingMean)}{s.ratingMean !== null && <small>/ 100</small>}</strong><p>낮을수록 잔여 절차가 적음 · 공개 MW로 가중</p></article>
        <article><span>평균의 용량 분모</span><strong>{gw(s.ratedCapacityMw)}<small>GW</small></strong><p>{number(s.ratingWeightedCount)}건 · 건수 평균 {pointLabel(s.projectCountRatingMean)}점 ({number(s.ratedCount)}건)</p></article>
        <article><span>추정 포함 / 공식 근거</span><strong>{number(s.ratingEstimatedCount)}<em>/</em>{number(officialCount)}</strong><p>단계 모형 {number(modeledCount)}건 · 공식 근거만 완비 {number(officialCount)}건</p></article>
        <article className="bw-unknown-card"><span>미산출 신청</span><strong>{number(s.ratingUnknownCount)}<small>건</small></strong><p>공개 MW 중 점수 없음 {gw(s.ratingUnscoredCapacityMw)} GW</p></article>
      </section>
      <div className="bw-summary-caption"><p>선택한 유형·권역에서 점수와 양수 MW가 모두 있는 적격 신청을 집계합니다. 평가값이 있어도 MW 미공개 {number(s.ratedMissingCapacityCount)}건·0 MW {number(s.ratedZeroCapacityCount)}건은 가중평균에서 제외합니다. 용량 일부만 공개된 {number(s.partialCapacityCount)}건은 공개 성분만 사용합니다. 검색어·페이지와 평균 분모는 별도입니다.</p><span>원장 관측 {observedAt}</span></div>
      <section className="bw-type-grid" aria-label="유형별 프로젝트 평균 병목점수">{TYPES.map(type => <article key={type} className={`bw-type-${type}`}><span>{type === 'load' ? '수용가 원장 MW 가중평균' : `${TYPE_LABEL[type]} MW 가중평균`}</span><strong>{pointLabel(s.ratingTypeMeans[type])}{s.ratingTypeMeans[type] !== null && <small>/ 100</small>}</strong><p>분모 {gw(s.ratingTypeCapacityMw[type])} GW · {number(s.ratingTypeWeightedCounts[type])}건<br />건수 평균 {pointLabel(s.projectCountRatingTypeMeans[type])}점 · 점수 미산출 {number(s.typeCounts[type] - s.ratingTypeCounts[type])}건</p></article>)}</section>
      <div className="bw-scope-note"><CircleHelp size={17} /><div><p>유형별 평균은 해당 유형의 공개 MW로 가중합니다. 전체 평균은 같은 ID의 공개 발전·저장·수용 MW 성분을 합한 가중치이며 순계통접속 한도와 다릅니다. 수용가 시설·개발 원장 및 회사별 집계 지수는 별도 모집단으로 유지합니다.</p><button onClick={() => onOpenRegional(selectedRegion)}>다른 권역의 수용가 진행 근거 보기<ArrowRight size={13} /></button></div></div>
      <section className="bw-gate-guide" aria-label="다섯 요건의 동일 배점"><header><div><h2>5개 요건에 각 20점</h2><p>잔여점수 = 20 × (1 − 진행률). 확인된 미진행은 20점, 완전히 통과하면 0점입니다.</p></div><button onClick={() => selectTab('methodology')}>산정 기준<ArrowRight size={14} /></button></header><ol>{GATES.map((gate, index) => <li key={gate}><span>{String(index + 1).padStart(2, '0')}</span><strong>{GATE_LABEL[gate]}</strong><small>20 → 0점</small></li>)}</ol></section>
      {projectControls && <div className="bw-project-controls">{projectControls}</div>}
      <ProjectMatrix data={data} onProject={onProject} />
      <details className="bw-register"><summary><FileSearch size={18} /><span>원장 검색·필터·페이지 이동<small>현재 {number(data.page)}페이지 · 검색 {number(data.total)}건 · CSV 내보내기</small></span><ArrowRight size={16} /></summary><div>{projectTable}</div></details>
      <details className="bw-regional-summary"><summary><ChartNoAxesCombined size={18} /><span>권역별 개별 프로젝트 평균<small>선택 범위의 전체 적격 신청 · {number(s.ratingRegions.length)}개 권역</small></span><ArrowRight size={16} /></summary><div className="bw-table-scroll"><table><thead><tr><th scope="col">권역</th><th scope="col">용량 가중평균</th><th scope="col">용량 분모 / 건수</th><th scope="col">건수 평균 · 보조</th><th scope="col">추정 포함</th><th scope="col">미산출</th></tr></thead><tbody>{s.ratingRegions.map(row => <tr key={row.region}><th scope="row">{row.region}</th><td><strong>{pointLabel(row.mean)}</strong>{row.mean !== null && <small>/100</small>}</td><td>{gw(row.ratedCapacityMw)} GW<small className="muted-cell">{number(row.weightedCount)}건 · MW 미공개 {number(row.missingCapacityCount)}건</small></td><td>{pointLabel(row.projectCountMean)}점<small className="muted-cell">{number(row.ratedCount)}건</small></td><td>{number(row.estimatedCount)}건</td><td>{number(row.unknownCount)}건</td></tr>)}</tbody></table>{!s.ratingRegions.length && <p className="bw-empty">선택 범위에 적격 프로젝트가 없습니다.</p>}</div></details>
      <div className="bw-bottom-note"><BadgeCheck size={17} /><p>전체 원장 {number(s.recordCount)}건 중 평균 집계 제외 {number(s.excludedCount)}건. 출처별 신청 ID 기준으로 계산하며 미국 전체 물리 프로젝트의 전수 평균을 뜻하지 않습니다.</p><button onClick={onCoverage}>수집 범위 확인<ArrowRight size={13} /></button></div>
      </>}
    </>}
  </div>;
}
