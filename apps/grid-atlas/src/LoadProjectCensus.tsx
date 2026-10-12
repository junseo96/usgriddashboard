import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ChevronLeft, ChevronRight, ExternalLink, Search, X } from 'lucide-react';
import censusJson from '../data/load-project-census.json';
import { CENSUS_FAMILIES, censusCsv, filterCensusEntities, summarizeCensus, type CensusEntity, type CensusFilters, type LoadProjectCensus } from '../shared/load-project-census';
import './load-project-census.css';
import { CensusInference, inferenceByCensus } from './StageInferenceWorkspace';
import { scoreStageInference } from '../shared/project-stage-inference';

const data = censusJson as unknown as LoadProjectCensus;
const STATUS = { announced: '발표·개발 계획', application: '신청', study: '기술 검토', contracted: '공급계약', construction: '공사', operating: '운영', withdrawn: '철회·종료', unknown: '진행 미확인' };
const BASIS = { confirmed_request: '공급·접속 요청 확인', confirmed_contract: '공급계약 확인', announced: '개발 발표', inferred: '간접 단서', unknown: '연결 근거 미확인' };
const FAMILY = { utility: '유틸리티', puc: 'PUC·PSC', transmission: '송전계획', customer: '고객 공시' };
const ATTEMPT = { reviewed: '원문 검토', fetch_failed: '접근 실패', queued: '조사 대기', not_public: '비공개 확인' };
const ADDITIVE = { included: '확인된 활성 용량에 포함', possible_duplicate: '동일 사업 가능성 검토 중', component_of_parent: '상위 사업과 합산 제외', not_confirmed_connection: '신청·계약 미확인', capacity_conflict: '용량 근거 간 차이 확인 필요', unknown_capacity: '계통 용량 미공개', not_active: '활성 신청 용량에서 제외' };
const CAPACITY = { requested_grid: '계통 요청', contracted_grid: '계통 계약', site_power: '부지 전력 규모', it_power: 'IT 용량', generation: '자체 발전', unknown: '의미 미확인' };
const RAW_KIND = { customer_request: '고객 요청', named_development: '개발 사업', transmission_support: '송전 지원', historical: '과거 기록', grouped_case: '복수 사업 집계', unclassified: '분류 대기' };
const count = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const date = (v: string | null) => !v ? '미확인' : v.includes('T') ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) + ' KST' : v;
const safe = (v: string) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
const evidenceById = new Map(data.evidence.map(e => [e.id, e]));
const entityById = new Map(data.entities.map(e => [e.id, e]));
const rawById = new Map(data.rawRecords.map(e => [e.id, e]));
const documentCount = (e: CensusEntity) => new Set(e.evidenceIds.map(id => { const source = evidenceById.get(id)!; return `${source.url}|${source.sha256 ?? ''}`; })).size;
const PAGE_SIZE = 25;

export function CensusOverviewLink({ onOpen }: { onOpen: () => void }) {
  const summary = summarizeCensus(data);
  return <div className="census-overview-link"><div><strong>수용가 통합 조사 원장 · {count(summary.entityCount)}건</strong><span>공급 신청·규제 심사·송전계획·고객 공시를 연결 · 활성·종료·계획 포함</span></div><button className="text-button" onClick={onOpen}>중복 연결과 원문 확인 <ArrowRight size={15} /></button></div>;
}

export default function LoadProjectCensus({ region, onRegion, onScore }: { region: string; onRegion: (value: string) => void; onScore: (id: string) => void }) {
  const [tab, setTab] = useState<'entities' | 'decisions' | 'raw' | 'survey'>('entities');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<CensusFilters['status']>('all');
  const [basis, setBasis] = useState<CensusFilters['connectionBasis']>('all');
  const [family, setFamily] = useState<CensusFilters['sourceFamily']>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const filters = useMemo(() => ({ region, q, status, connectionBasis: basis, sourceFamily: family }), [region, q, status, basis, family]);
  const entities = useMemo(() => filterCensusEntities(data, filters), [filters]);
  const summary = useMemo(() => summarizeCensus(data, { region }), [region]);
  const entityIds = useMemo(() => new Set(entities.map(e => e.id)), [entities]);
  const query = q.toLowerCase().trim();
  const raw = useMemo(() => data.rawRecords.filter(r => (!region || r.region === region) && (!query || [r.name, r.nativeId, r.id, r.status].join(' ').toLowerCase().includes(query)) && (family === 'all' || r.evidenceIds.some(id => evidenceById.get(id)?.sourceFamily === family))), [region, query, family]);
  const decisions = useMemo(() => data.decisions.filter(d => d.entityIds.some(id => entityIds.has(id) || entityIds.has(data.entityAliases.find(a => a.aliasId === id)?.canonicalId ?? ''))), [entityIds]);
  const surveyRegion = ['West', 'Southeast'].includes(region) ? '' : region;
  const surveySummary = useMemo(() => summarizeCensus(data, { region: surveyRegion }).survey, [surveyRegion]);
  const utilities = useMemo(() => data.survey.utilities.filter(u => (!surveyRegion || u.regions.includes(surveyRegion)) && (!query || [u.id, u.name, ...u.states].join(' ').toLowerCase().includes(query))), [surveyRegion, query]);
  const attempts = data.attempts.filter(a => (!surveyRegion || a.region === surveyRegion || a.utilityIds.some(id => utilities.some(u => u.id === id))) && (family === 'all' || a.sourceFamily === family));
  const total = tab === 'entities' ? entities.length : tab === 'decisions' ? decisions.length : tab === 'raw' ? raw.length : utilities.length;
  useEffect(() => setPage(1), [region, q, status, basis, family, tab]);
  const start = (page - 1) * PAGE_SIZE;
  const download = () => { const url = URL.createObjectURL(new Blob([censusCsv(data, filters)], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'grid-atlas-load-census.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const open = (id: string) => setSelected(entityById.has(id) ? id : data.entityAliases.find(a => a.aliasId === id)?.canonicalId ?? null);
  return <div className="load-census">
    <section className="census-intro"><div><span className="eyebrow">CUSTOMER PROJECT CENSUS</span><h2>수용가 통합 조사 원장</h2><p>신청·계약·개발 발표를 함께 보존하고, 같은 사업의 여러 문서를 연결했습니다. 익명 요청과 용량 미공개 사업도 조회할 수 있습니다.</p></div><small>조사 원장 생성 {date(data.generatedAt)}<br />원자료 기준일은 각 사업에 표시</small></section>
    <div className="census-stats" aria-label="수용가 통합 조사 집계">
      <article><span>{region || '전체 권역'} · 사업·신청 식별</span><strong>{count(summary.entityCount)}<small>건</small></strong><p>활성·종료·개발 계획 포함</p></article>
      <article><span>공급·접속 근거 확인</span><strong>{count((summary.byConnectionBasis.confirmed_request ?? 0) + (summary.byConnectionBasis.confirmed_contract ?? 0))}<small>건</small></strong><p>운영·철회 포함 · 단계 필터로 구분</p></article>
      <article><span>확인된 활성 계통 용량</span><strong>{summary.knownGridMw === null ? '미확인' : count(summary.knownGridMw / 1000)}{summary.knownGridMw !== null && <small>GW</small>}</strong><p>{count(summary.additiveEntityCount)}건 · 중복 가능·증설 중첩 제외</p></article>
      <article><span>계통 MW 미확인</span><strong>{count(summary.unknownGridMwCount)}<small>건</small></strong><p>중복 가능 {count(summary.possibleDuplicateCount)}건 · 용량 차이 {count(summary.capacityConflictCount)}건</p></article>
    </div>
    <p className="workspace-caption">위 집계는 선택 권역의 확보 범위이며 전국 전수·현재 동시 대기량이 아닙니다. 서로 다른 기준일을 포함합니다. IT 용량·부지 개발규모·자체 발전은 계통 신청 MW에 더하지 않습니다. 점수는 진행 근거를 확인한 활성 신청에 한해 산출합니다.</p>
    <section className="panel census-panel">
      <div className="census-tabs" role="group" aria-label="통합 조사 자료 선택">{([['entities', '사업·신청 원장'], ['decisions', '중복·증설 연결'], ['raw', '전체 원문 기록'], ['survey', '조사 현황']] as const).map(([id, label]) => <button key={id} aria-pressed={tab === id} className={tab === id ? 'selected' : ''} onClick={() => { setTab(id); if (id !== 'entities') { setStatus('all'); setBasis('all'); } }}>{label}</button>)}</div>
      <div className="census-toolbar"><label className="search-field"><Search size={16} /><input aria-label="통합 수용가 검색" value={q} onChange={e => setQ(e.target.value)} placeholder={tab === 'survey' ? '전력회사 이름 · EIA ID · 주' : '사업 · 고객 · 유틸리티 · 원문 ID'} /></label><select aria-label="통합 조사 권역" value={region} onChange={e => onRegion(e.target.value)}><option value="">전체 권역</option>{[...new Set(data.entities.map(e => e.region))].sort().map(r => <option key={r}>{r}</option>)}</select><select aria-label="조사 출처 유형" value={family} onChange={e => setFamily(e.target.value as CensusFilters['sourceFamily'])}><option value="all">출처 유형 전체</option>{CENSUS_FAMILIES.map(f => <option key={f} value={f}>{FAMILY[f]}</option>)}</select>{tab === 'entities' && <><select aria-label="수용가 진행 단계" value={status} onChange={e => setStatus(e.target.value as CensusFilters['status'])}><option value="all">모든 진행 단계</option>{Object.entries(STATUS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="계통 연결 근거" value={basis} onChange={e => setBasis(e.target.value as CensusFilters['connectionBasis'])}><option value="all">연결 근거 전체</option>{Object.entries(BASIS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><button className="button compact" onClick={download}><ArrowDownToLine size={15} />CSV</button></>}</div>
      {tab === 'entities' && <div className="table-scroll"><table className="census-table"><thead><tr><th>사업·신청 / 고객</th><th>권역 / 유틸리티</th><th>연결 근거 / 진행</th><th>계통 용량</th><th>자료 연결 / 기준일</th><th>진행 판단 점수</th></tr></thead><tbody>{entities.slice(start, start + PAGE_SIZE).map(e => <tr key={e.id}><td><button className="project-name" onClick={() => open(e.id)}>{e.name}</button><small>{e.customer || '고객명 미공개'}{e.kind === 'anonymous_service_request' ? ' · 익명 요청' : ''}</small></td><td>{e.region} · {e.state || '주 미공개'}<small>{e.utility || '유틸리티 미확인'}</small></td><td><span className="census-basis">{BASIS[e.connectionBasis]}</span><small>{STATUS[e.status]}</small></td><td><strong>{e.knownGridMw === null ? '미확인' : `${count(e.knownGridMw)} MW`}</strong><small>{ADDITIVE[e.additiveStatus]}</small></td><td><button className="text-button" onClick={() => open(e.id)}>원문 {documentCount(e)}개 · 기록 {e.rawRefIds.length}건</button><small>{date(e.asOf)}</small></td><td><CensusInferencePoint id={e.id} onClick={() => open(e.id)} /></td></tr>)}</tbody></table></div>}
      {tab === 'decisions' && <><p className="census-note">확정 중복만 하나로 통합합니다. 동일 사업 가능성은 원장을 유지한 채 용량 합계에서 제외하고, 증설·송전 지원 관계는 별도로 보존합니다.</p><div className="census-decisions">{decisions.slice(start, start + PAGE_SIZE).map(d => <article key={d.id}><strong>{{ same_entity: '동일 사업 통합', possible_duplicate: '동일 사업 가능성', expansion_of: '상위 사업·증설', related_support: '송전 지원 연결' }[d.kind]}</strong><div>{d.entityIds.map(id => <button className="text-button" key={id} onClick={() => open(id)}>{entityById.get(id)?.name || id}</button>)}</div><p>{d.reason}</p><small>연결 근거 {d.evidenceIds.length}건 · {d.origin === 'exact_source_record' ? '동일 원문 식별자 일치' : '검토 근거에 따른 연결'}</small></article>)}</div></>}
      {tab === 'raw' && <><p className="census-note">송전 보강·과거 검토·복수 고객 집계도 원문 기록으로 보존합니다. 고객 사업에 연결되지 않은 행을 임의의 신규 프로젝트로 세지 않습니다.</p><div className="table-scroll"><table className="census-table"><thead><tr><th>원문 기록</th><th>권역 / 분류</th><th>원문 상태</th><th>사업 연결</th></tr></thead><tbody>{raw.slice(start, start + PAGE_SIZE).map(r => <tr key={r.id}><td>{r.name}<small>{r.nativeId}</small></td><td>{r.region}<small>{RAW_KIND[r.kind]}</small></td><td>{r.status || '미공개'}</td><td>{r.entityId ? <button className="text-button" onClick={() => open(r.entityId!)}>{entityById.get(r.entityId)?.name}</button> : <span>미연결 · 사업 수 제외</span>}<small>{r.evidenceIds.map(id => evidenceById.get(id)).filter(Boolean).slice(0, 2).map(e => <a key={e!.id} href={safe(e!.url)} target="_blank" rel="noreferrer">{e!.name} <ExternalLink size={11} /></a>)}</small></td></tr>)}</tbody></table></div></>}
      {tab === 'survey' && <><div className="census-note"><strong>EIA 사업자 명부 {count(surveySummary.utilityCount)}개 중 원문 검토 연결 {count(surveySummary.reviewedUtilityCount)}개</strong><p>{['West', 'Southeast'].includes(region) ? 'West·Southeast는 조사 편의상 묶은 권역으로 EIA의 ISO 명부와 범위가 다릅니다. 아래는 전국 사업자 명부입니다. ' : ''}소매 공급사 등도 포함하는 조사 대상 명부입니다. 명부에 등록됐다는 이유로 조사 완료로 처리하지 않습니다. 이 비율은 프로젝트 확보율이 아닙니다. 기관·기업의 별도 조사 기록 {count(attempts.length)}건.</p><div className="census-family-counts">{CENSUS_FAMILIES.map(f => <span key={f}>{FAMILY[f]} {count(surveySummary.byFamily[f])}회</span>)}</div></div><details className="census-attempts"><summary>기관·고객 조회 기록 · 조사 대기 · 실패 사유</summary>{attempts.map(a => <article key={a.id}><strong>{a.organization} · {FAMILY[a.sourceFamily]} · {ATTEMPT[a.status]}</strong><small>{date(a.checkedAt)}</small><p>{a.notes.join(' · ')}</p>{a.url && <a href={safe(a.url)} target="_blank" rel="noreferrer">조회 대상 <ExternalLink size={11} /></a>}</article>)}</details><div className="table-scroll"><table className="census-table"><thead><tr><th>사업자 / 주</th>{CENSUS_FAMILIES.map(f => <th key={f}>{FAMILY[f]}</th>)}</tr></thead><tbody>{utilities.slice(start, start + PAGE_SIZE).map(u => <tr key={u.id}><td>{u.name}<small>{u.id} · {u.states.join(', ')} · {u.geographicScope}</small></td>{CENSUS_FAMILIES.map(f => <td key={f}>{ATTEMPT[u.familyStatus[f]]}</td>)}</tr>)}</tbody></table></div></>}
      {!total && <div className="empty-table">조건에 맞는 기록이 없습니다. 조사 미확보는 사업이 없다는 뜻이 아닙니다.</div>}
      <div className="table-footer"><span>{count(total)}건 중 {total ? count(start + 1) : 0}–{count(Math.min(start + PAGE_SIZE, total))}건</span><div className="pagination"><button className="icon-button" aria-label="통합 조사 이전 페이지" disabled={page <= 1} onClick={() => setPage(v => v - 1)}><ChevronLeft size={16} /></button><span>{page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><button className="icon-button" aria-label="통합 조사 다음 페이지" disabled={start + PAGE_SIZE >= total} onClick={() => setPage(v => v + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
    <details className="census-limitations"><summary>조사·중복 제거의 범위와 남은 작업</summary><ul>{data.limitations.map(s => <li key={s}>{s}</li>)}{data.survey.limitations.map(s => <li key={s}>{s}</li>)}</ul></details>
    {selected && entityById.has(selected) && <CensusDrawer entity={entityById.get(selected)!} onClose={() => setSelected(null)} onOpen={open} onScore={id => { setSelected(null); onScore(id); }} />}
  </div>;
}

function CensusDrawer({ entity: e, onClose, onOpen, onScore }: { entity: CensusEntity; onClose: () => void; onOpen: (id: string) => void; onScore: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') { const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length); const first = items[0], last = items.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  const decisions = data.decisions.filter(d => d.entityIds.includes(e.id) || d.rawRefIds.some(id => e.rawRefIds.includes(id)));
  return <div className="census-overlay"><button className="census-scrim" aria-label="수용가 상세 닫기" onClick={onClose} /><div className="census-drawer" role="dialog" aria-modal="true" aria-labelledby="census-detail-title" tabIndex={-1} ref={ref}>
    <header><div><span className="eyebrow">PROJECT IDENTITY & EVIDENCE</span><h2 id="census-detail-title">{e.name}</h2><small>{e.id}</small></div><button className="icon-button" onClick={onClose} aria-label="상세 창 닫기"><X size={20} /></button></header>
    <dl><div><dt>권역·위치</dt><dd>{e.region} · {e.state || '주 미공개'} · {e.location || '위치 미공개'}</dd></div><div><dt>고객·공급사</dt><dd>{e.customer || '고객 미공개'} / {e.utility || '공급사 미확인'}</dd></div><div><dt>연결 근거</dt><dd>{BASIS[e.connectionBasis]}</dd></div><div><dt>진행 상태</dt><dd>{STATUS[e.status]} · 기준일 {date(e.asOf)}</dd></div><div><dt>용량 합계</dt><dd>{ADDITIVE[e.additiveStatus]}</dd></div></dl>
    {e.scoreProjectId ? <button className="button primary" onClick={() => onScore(e.scoreProjectId!)}>단계·병목점수 확인 <ArrowRight size={15} /></button> : <p className="census-note">개별 평가 원장 연결 전입니다. 알려진 진행 단서와 근거는 아래에 보존합니다.</p>}
    <CensusInference censusId={e.id} />
    {e.aliases.length > 0 && <section><h3>함께 연결한 이름·식별자</h3><p>{e.aliases.join(' · ')}</p></section>}
    <section><h3>용량 원문 · 의미별 구분</h3>{e.capacityFacts.length ? e.capacityFacts.map(f => <article className="census-fact" key={f.id}><strong>{f.value === null ? '미공개' : `${count(f.value)} ${f.unit}`} · {CAPACITY[f.basis]}</strong><small>범위 {f.scope} · {date(f.asOf)}</small><p>{f.note}</p></article>) : <p>공개 용량 근거를 아직 확보하지 못했습니다.</p>}</section>
    {(e.parentEntityId || e.possibleDuplicateIds.length > 0) && <section><h3>증설·동일 사업 가능성</h3>{[...(e.parentEntityId ? [e.parentEntityId] : []), ...e.possibleDuplicateIds].map(id => <button key={id} className="text-button" onClick={() => onOpen(id)}>{entityById.get(id)?.name || id}</button>)}</section>}
    <section><h3>원문 {documentCount(e)}개 · 근거 {e.evidenceIds.length}건</h3>{e.evidenceIds.map(id => evidenceById.get(id)!).map(v => <details key={v.id}><summary>{FAMILY[v.sourceFamily]} · {v.name}</summary><blockquote>{v.excerpt || '기존 정규화 원장 기록. 원문 인용문 추가 검토 필요.'}</blockquote><small>원자료 {date(v.sourceAsOf)} · 공개 {date(v.publishedAt)}<br />실제 취득 {date(v.retrievedAt)}</small><a href={safe(v.url)} target="_blank" rel="noreferrer">원문 열기 <ExternalLink size={13} /></a>{v.sha256 && <small className="census-hash">SHA-256 {v.sha256}</small>}{v.limitations.map(note => <p key={note}>{note}</p>)}</details>)}</section>
    <section><h3>연결한 기록 {e.rawRefIds.length}건</h3>{e.rawRefIds.map(id => rawById.get(id)!).map(r => <details key={r.id}><summary>{r.name} · {r.nativeId}</summary><p>{r.status}</p><pre>{JSON.stringify(r.payload, null, 2)}</pre></details>)}{e.relatedSupportRecordIds.length > 0 && <p>관련 송전 지원 기록 {e.relatedSupportRecordIds.length}건: {e.relatedSupportRecordIds.map(id => rawById.get(id)?.nativeId || id).join(', ')}</p>}</section>
    {decisions.length > 0 && <section><h3>중복·연결 판단 기록</h3>{decisions.map(d => <p key={d.id}>{d.reason}</p>)}</section>}
    <section><h3>해석 범위</h3><ul>{e.limitations.map(note => <li key={note}>{note}</li>)}</ul></section>
  </div></div>;
}

function CensusInferencePoint({ id, onClick }: { id: string; onClick: () => void }) { const j = inferenceByCensus.get(id), score = j && scoreStageInference(j); return <button className="text-button census-inference-point" onClick={onClick}>{score ? `${count(score.point)}점 · 정성 추정` : '점수 미산출'}{score && <small>{j!.applyToAverage ? '활성 평균 반영' : '활성 평균 제외'}</small>}</button>; }
