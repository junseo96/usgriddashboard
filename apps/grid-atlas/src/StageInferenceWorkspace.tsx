import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ExternalLink, Search } from 'lucide-react';
import censusJson from '../data/load-project-census.json';
import auditProjectJson from '../data/project-stage-audit-index.json';
import { projectStageInferences as data } from '../shared/project-stage-inference-data';
import { selectLatestStageInferences, scoreStageInference, projectStageInferencesCsv, type StageInferenceJudgement, type StageInferenceAudit, type ProjectStageInferenceEstimate } from '../shared/project-stage-inference';
import type { LoadProjectCensus } from '../shared/load-project-census';
import type { ProjectType } from '../shared/types';
import './stage-inference.css';

const census = censusJson as unknown as LoadProjectCensus;
const entities = new Map(census.entities.map(e => [e.id, e]));
export const inferenceByCensus = new Map(selectLatestStageInferences(data).filter(j => j.censusId).map(j => [j.censusId!, j]));
const judgements = selectLatestStageInferences(data);
const latestAudits = [...data.audits.reduce((map, audit) => {
  const key = audit.censusId ? `census:${audit.censusId}` : `project:${audit.projectId}`;
  const previous = map.get(key);
  if (!previous || audit.evaluatedAt > previous.evaluatedAt) map.set(key, audit);
  return map;
}, new Map<string, StageInferenceAudit>()).values()];
const projects = new Map(judgements.flatMap(j => j.projectSnapshot ? [[j.projectSnapshot.id, j.projectSnapshot] as const] : []));
const rawProjects = new Map(census.rawRecords.filter(r => r.inputCollection === 'bootstrap').map(r => [r.nativeId, r]));
const auditProjects = new Map((auditProjectJson as Array<{ id: string; name: string; region: string; types: ProjectType[] }>).map(p => [p.id, p]));
const CONFIDENCE = { high: '높음', medium: '보통', low: '낮음' };
const STATUS = { active: '진행 중', operating: '운영', withdrawn: '철회·종료', unknown: '현재 상태 미확인' };
const GATE = { technical: '기술 검토', commercial: '계약·비용', permitting: '부지·인허가', construction: '공사·망보강', energization: '통전·운영 승인' };
const n = (v: number) => v.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const time = (v: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) + ' KST';

export function InferenceEvidence({ estimate }: { estimate: ProjectStageInferenceEstimate }) {
  return <section className="inference-evidence" aria-label="정성 판단과 출처">
    <div className="inference-tags"><span>정성 판단 · 신뢰도 {CONFIDENCE[estimate.confidence]}</span><span>{STATUS[estimate.status]} · {estimate.statusBasis === 'explicit' ? '명시된 상태' : '자료 종합 추정'}</span><span>{estimate.applyToAverage ? '활성 평가 대상' : '활성 평가 제외'}</span></div>
    <h3>{estimate.label} · {n(estimate.point)}점</h3><p><strong>남은 절차 판단: </strong>{estimate.bottleneck}</p><p>{estimate.rationale}</p>
    <p className="inference-date">진행 근거 기준 {estimate.sourceAsOf || '날짜 미확인'} · 실제 판단 {time(estimate.evaluatedAt)}</p>
    <div className="inference-gates">{estimate.gates.map(g => <div key={g.gate} title={g.rationale}><span>{GATE[g.gate]}</span><strong>{n(g.points)}<small>/20</small></strong><small>가정 진행률 {n(g.progress * 100)}%</small></div>)}</div>
    <p className="inference-note">각 진행률은 단계를 점수로 바꾸기 위한 가정입니다. 신뢰도는 자료의 구체성과 일치 정도이며, 완공 확률을 뜻하지 않습니다. 활성 평가 대상이어도 선택한 유형의 양수 공개 MW가 없으면 용량 가중평균에서는 제외됩니다.</p>
    <details><summary>판단에 사용한 가정·남은 불확실성</summary><ul>{[...estimate.assumptions, ...estimate.limitations].map((s, i) => <li key={i}>{s}</li>)}</ul></details>
    <div className="inference-sources">{estimate.sourceEvidence.map((e, i) => <details key={e.url + e.sha256}><summary>{i + 1}. {e.name} <span>{{ official: '공식 기관', utility: '전력회사', customer: '고객 공시', media: '언론보도' }[e.publisherKind]}</span></summary><blockquote>{e.excerpt}</blockquote><small>원자료 {e.sourceAsOf || '미공개'} · 공개 {e.publishedAt || '미확인'} · 실제 취득 {time(e.retrievedAt)}</small><a href={e.url} target="_blank" rel="noreferrer">근거 원문 <ExternalLink size={12} /></a></details>)}</div>
  </section>;
}

export function CensusInference({ censusId }: { censusId: string }) {
  const j = inferenceByCensus.get(censusId), score = j && scoreStageInference(j);
  const audit = latestAudits.find(a => a.censusId === censusId && a.outcome === 'no_judgement');
  return score ? <InferenceEvidence estimate={score} /> : j ? <div className="inference-note"><strong>{STATUS[j.status]} · 점수 미산출</strong><p>{j.rationale}</p></div> : audit ? <div className="inference-note"><strong>자료 검토 · 점수 판단 보류</strong><p>{audit.reason}</p></div> : null;
}

function metadata(j: StageInferenceJudgement) {
  const e = j.censusId ? entities.get(j.censusId) : null;
  return { name: j.projectSnapshot?.name ?? e?.name ?? j.projectId ?? j.censusId ?? j.id, region: j.projectSnapshot?.region ?? e?.region ?? '미확인', types: j.projectSnapshot?.types ?? ['load'] as ProjectType[], state: j.projectSnapshot?.state ?? e?.state };
}
function auditMetadata(a: StageInferenceAudit) {
  const entity = a.censusId ? entities.get(a.censusId) : null;
  const project = a.projectId ? projects.get(a.projectId) : null;
  const raw = a.projectId ? rawProjects.get(a.projectId) : null;
  const index = a.projectId ? auditProjects.get(a.projectId) : null;
  return { name: entity?.name ?? project?.name ?? index?.name ?? raw?.name ?? a.projectId ?? a.censusId,
    region: entity?.region ?? project?.region ?? index?.region ?? raw?.region,
    types: project?.types ?? index?.types ?? (entity || raw ? ['load'] as ProjectType[] : []) };
}

export default function StageInferenceWorkspace({ region, type, onRegion, onProject }: { region: string; type: ProjectType | 'all'; onRegion: (v: string) => void; onProject: (id: string) => void }) {
  const [q, setQ] = useState(''), [scope, setScope] = useState('all'), [confidence, setConfidence] = useState('all'), [page, setPage] = useState(1), [open, setOpen] = useState<string | null>(null);
  const scoped = useMemo(() => judgements.filter(j => { const m = metadata(j); return (!region || m.region === region) && (type === 'all' || m.types.includes(type)); }), [region, type]);
  const scopedAudits = useMemo(() => latestAudits.filter(a => { const m = auditMetadata(a); return (!region || m.region === region) && (type === 'all' || m.types.includes(type)); }), [region, type]);
  const withheld = scopedAudits.filter(a => a.outcome === 'no_judgement');
  const notReviewed = scopedAudits.filter(a => a.outcome === 'not_reviewed');
  const rows = useMemo(() => scoped.filter(j => { const m = metadata(j); return (confidence === 'all' || j.confidence === confidence) && (scope === 'all' || scope === 'mean' && j.applyToAverage || scope === 'excluded' && j.stage !== null && !j.applyToAverage || scope === 'unknown' && j.stage === null) && (!q.trim() || [m.name, j.projectId, j.censusId, j.bottleneck, j.rationale].join(' ').toLowerCase().includes(q.trim().toLowerCase())); }), [scoped, scope, confidence, q]);
  useEffect(() => { setPage(1); setOpen(null); }, [region, type, scope, confidence, q]);
  const scored = scoped.filter(j => j.stage !== null), included = scored.filter(j => j.applyToAverage);
  const download = () => { const ids = new Set(rows.map(j => j.id)); const csv = projectStageInferencesCsv({ ...data, judgements: data.judgements.filter(j => ids.has(j.id)) }); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'grid-atlas-stage-inferences.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <div className="inference-workspace">
    <section className="inference-intro"><span className="eyebrow">EVIDENCE REVIEW</span><h2>자료를 종합한 프로젝트별 진행 판단</h2><p>공급 신청, 기술검토, 계약, 공사 현황과 언론보도를 연결해 남은 절차를 판단했습니다. 현재 활성 여부가 불명확한 사업도 당시 자료에 따른 점수와 판단 이유를 확인할 수 있습니다.</p><small>검토 기록 갱신 {time(data.generatedAt)}</small></section>
    <div className="inference-stats"><article><span>선택 범위 판단 기록</span><strong>{n(scoped.length)}<small>건</small></strong><p>운영·종료·상태 미확인 포함</p></article><article><span>단계 점수 판단</span><strong>{n(scored.length)}<small>건</small></strong><p>평균 제외 {n(scored.length - included.length)}건 포함</p></article><article><span>활성 평가 대상</span><strong>{n(included.length)}<small>건</small></strong><p>현재 활성·동일 사업 검토 후 반영</p></article><article><span>단계 판단 보류</span><strong>{n(scoped.length - scored.length + withheld.length)}<small>건</small></strong><p>판단 기록 미산출 {n(scoped.length - scored.length)}건 · 조사 보류 {n(withheld.length)}건</p></article></div>
    <p className="inference-note">전국 평균은 이 판단을 기존 개별 점수와 합쳐 신청별 한 번씩 계산합니다. 이 표의 모든 점수를 평균내지는 않습니다. 송전 보강 설비가 완공돼도 고객 시설의 실제 통전·운영과는 구분합니다.</p>
    <section className="panel"><div className="inference-toolbar"><label className="search-field"><Search size={16} /><input aria-label="진행 판단 검색" placeholder="사업명 · 신청 ID · 계류 절차" value={q} onChange={e => setQ(e.target.value)} /></label><select aria-label="진행 판단 권역" value={region} onChange={e => onRegion(e.target.value)}><option value="">전체 권역</option>{[...new Set(judgements.map(j => metadata(j).region))].sort().map(r => <option key={r}>{r}</option>)}</select><select aria-label="진행 판단 평균 반영" value={scope} onChange={e => setScope(e.target.value)}><option value="all">모든 판단</option><option value="mean">활성 평가 대상</option><option value="excluded">점수 있음 · 평균 제외</option><option value="unknown">판단 기록 중 점수 미산출</option></select><select aria-label="판단 신뢰도" value={confidence} onChange={e => setConfidence(e.target.value)}><option value="all">신뢰도 전체</option>{Object.entries(CONFIDENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="button compact" onClick={download}><ArrowDownToLine size={15} />CSV</button></div>
      <div className="inference-list">{rows.slice((page - 1) * 25, page * 25).map(j => { const m = metadata(j), score = scoreStageInference(j); return <article className="inference-row" key={j.id}><button className="inference-row-heading" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}><span><strong>{m.name}</strong><small>{m.region} · {m.state || '주 미공개'} · {j.asOf || '근거일 미확인'}</small><span>{j.bottleneck}</span></span><span className="inference-row-point"><strong>{score ? `${n(score.point)}점` : '미산출'}</strong><small>{score?.label ?? STATUS[j.status]}</small><small>신뢰도 {CONFIDENCE[j.confidence]} · {j.applyToAverage ? '평균 반영' : '평균 제외'}</small></span></button>{open === j.id && <div className="inference-row-detail">{score ? <InferenceEvidence estimate={score} /> : <><p>{j.rationale}</p>{j.sourceEvidence.map(e => <p key={e.url + e.sha256}><a href={e.url} target="_blank" rel="noreferrer">{e.name} <ExternalLink size={12} /></a></p>)}</>}{j.projectId && <button className="text-button" onClick={() => onProject(j.projectId!)}>개별 원장과 기존 근거 보기 <ArrowRight size={14} /></button>}<p className="inference-note">식별 검토: {j.identityRationale}</p></div>}</article>; })}</div>
      {!rows.length && <p className="empty-table">현재 조건에서 검토된 판단이 없습니다.</p>}<div className="table-footer"><span>{n(rows.length)}건 중 {rows.length ? n((page - 1) * 25 + 1) : 0}–{n(Math.min(page * 25, rows.length))}건</span><div className="pagination"><button className="button compact" disabled={page === 1} onClick={() => setPage(p => p - 1)}>이전</button><span>{page} / {Math.max(1, Math.ceil(rows.length / 25))}</span><button className="button compact" disabled={page * 25 >= rows.length} onClick={() => setPage(p => p + 1)}>다음</button></div></div>
    </section>
    <details className="inference-audit"><summary>조사 범위 · 판단 보류 {n(withheld.length)}건 · 미검토 {n(notReviewed.length)}건</summary><p>선택 유형·권역 범위 {n(scopedAudits.length)}건 중 실제 검토 {n(scopedAudits.length - notReviewed.length)}건, 아직 검토하지 않은 사업 {n(notReviewed.length)}건입니다. 아래는 점수 판단 표와 별도로 보존한 조사 기록이며, 검색·신뢰도·평가 대상 필터와 CSV에는 포함되지 않습니다. 원자료가 없거나 식별이 불명확한 경우 점수를 채우지 않습니다.</p>{withheld.map(a => <p key={a.id}><strong>{auditMetadata(a).name}</strong> — {a.reason}</p>)}{notReviewed.length > 0 && <details className="inference-unreviewed"><summary>아직 검토하지 않은 사업 {n(notReviewed.length)}건 보기</summary><p>이 목록은 자료를 검토했으나 점수를 판단하지 못한 사업과 다릅니다.</p>{notReviewed.map(a => <p key={a.id}><strong>{auditMetadata(a).name}</strong> — {a.reason}</p>)}</details>}<ul>{data.limitations.map(s => <li key={s}>{s}</li>)}</ul></details>
  </div>;
}
