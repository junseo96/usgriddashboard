import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, BatteryCharging, BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Database, ExternalLink, Factory, FileCheck2, FileText, Globe2, History, Layers3, ListFilter, LoaderCircle, LockKeyhole, Menu, Network, Plus, RefreshCw, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { GATES, MODEL_VERSION, type Assessment, type CollectionRun, type DashboardResponse, type Gate, type GateScore, type GateStatus, type HealthResponse, type Project, type ProjectScore, type ProjectType, type Source } from '../shared/types';
import { calendarDayKst } from '../shared/time';
import { ratingPoint } from '../shared/scoring';
import { STAGE_ESTIMATE_CATALOG } from '../shared/stage-estimate';
import MarketPanel from './MarketPanel';
import LoadPipelinePanel from './LoadPipelinePanel';
import RegionalPipelinePanel from './RegionalPipelinePanel';
import HistoricalPanel from './HistoricalPanel';
import LoadBottleneckPanel from './LoadBottleneckPanel';
import type { LoadPipelineDataset, MarketRegion } from '../shared/market-types';
import type { MarketComparison } from '../shared/market';
import './styles.css';

type View = 'overview' | 'market' | 'pipeline' | 'projects' | 'history' | 'sources' | 'method';
type TypeFilter = ProjectType | 'all';
type Detail = { available: boolean; score: ProjectScore | null; assessments: Assessment[]; assessmentsTruncated: boolean; totalAssessments: number };
const NAV = [
  { id: 'overview', label: '전국 개요', icon: Globe2 },
  { id: 'market', label: '부하·신청 비교', icon: Activity },
  { id: 'pipeline', label: '수용가 파이프라인', icon: Factory },
  { id: 'projects', label: '프로젝트 원장', icon: Layers3 },
  { id: 'history', label: '관측 시계열', icon: History },
  { id: 'sources', label: '데이터 커버리지', icon: Database },
  { id: 'method', label: '평가 방법론', icon: BookOpen },
] as const;
const TYPES = [{ id: 'all', label: '전체 프로젝트', icon: Layers3 }, { id: 'generation', label: '발전원', icon: Sun }, { id: 'storage', label: '저장전원', icon: BatteryCharging }, { id: 'load', label: '수용가', icon: Factory }] as const;
const TYPE_LABEL: Record<ProjectType, string> = { generation: '발전', storage: '저장', load: '수용가' };
const GATE_LABEL: Record<Gate, string> = { technical: '기술 검토', commercial: '계약·비용·보증', permitting: '부지·인허가', construction: '설비·계통 보강', energization: '통전·운영 승인' };
const GATE_DESCRIPTION: Record<Gate, Record<ProjectType, string>> = {
  technical: { generation: '타당성·계통영향·시설 연구와 기술 요건 확인', storage: '충·방전 운전 특성을 반영한 계통영향 연구', load: '부하 연결 가능성·전력 공급·계통영향 검토' },
  commercial: { generation: '접속 계약, 비용 분담, 보증금·담보 확정', storage: '충·방전 접속 계약과 비용·담보 조건 확정', load: '전력 공급·접속 계약, 비용 책임과 보증 확정' },
  permitting: { generation: '발전 부지, 환경·건설 허가, 송전 권원 확보', storage: '저장설비 부지, 안전·건설 허가, 권원 확보', load: '수용가 부지, 개발 허가, 접속 경로 권원 확보' },
  construction: { generation: '발전 접속설비와 필요한 계통 보강 이행', storage: '저장 접속설비·보호 체계와 계통 보강 이행', load: '변전소·선로·수용 설비와 계통 보강 이행' },
  energization: { generation: '시험·보호 설정·운영 요건 확인과 통전 승인', storage: '충·방전 시험, 운영 요건 확인과 통전 승인', load: '수전 시험·운영 요건 확인과 실제 통전 승인' },
};
const STATUS_LABEL: Record<GateStatus, string> = { unknown: '미공개·미확인', not_started: '미진행 확인', in_progress: '진행 중', complete: '완료', not_applicable: '해당 없음' };
const COVERAGE_LABEL: Record<Source['coverage'], string> = { full_register: '개별 원장', filtered_register: '범위 제한 원장', aggregate: '집계 자료', case: '개별 사례', not_reviewed: '검토 대기', access_failed: '접근 실패', not_public: '비공개' };
const VIEW_DESCRIPTION: Record<View, string> = { overview: '발전·저장·수용가의 계통 연결, 진행의 근거를 한곳에서.', market: 'ISO·RTO의 공개 부하와 일 피크를 접속 신청 용량과 비교합니다.', pipeline: '공식 신청, 전력회사 자료, 계약·발표를 구분해 대형 수용가를 추적합니다.', projects: '공식 원장의 신청 단위와 요건별 평가 근거를 확인합니다.', history: '과거 공식 자료의 신청 용량·건수·추정 점수와 이후 관측 기록을 확인합니다.', sources: '확보한 원장과 아직 관측하지 못한 범위를 함께 공개합니다.', method: '다섯 가지 접속 요건을 같은 기준으로 평가합니다.' };
const nf = new Intl.NumberFormat('ko-KR');
const number = (value: number) => nf.format(value);
const decimal = (value: number, digits = 1) => value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const date = (value: string | null | undefined, withTime = false) => {
  if (!value) return '미공개';
  if (/^\d{4}-\d{2}$/.test(value)) return value.replace('-', '.');
  if (!value.includes('T')) return value.replaceAll('-', '.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '확인 필요';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(parsed);
};
const today = () => calendarDayKst();
const currentKstMinute = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
const safeUrl = (url: string) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } };
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `요청을 처리하지 못했습니다 (${res.status}).`);
  return body as T;
}

export default function App() {
  const [view, setView] = useState<View>('overview');
  const [historyMode, setHistoryMode] = useState<'load' | 'official' | 'app'>('load');
  const [type, setType] = useState<TypeFilter>('all');
  const [region, setRegion] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [asOf, setAsOf] = useState('');
  const [knownAt, setKnownAt] = useState('');
  const [timeOpen, setTimeOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [health, setHealth] = useState<(HealthResponse & { offlinePreview?: boolean }) | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pipeline, setPipeline] = useState<LoadPipelineDataset | null>(null);
  const [marketComparison, setMarketComparison] = useState<MarketComparison | null>(null);
  const [pipelineError, setPipelineError] = useState('');
  const [marketRegion, setMarketRegion] = useState<MarketRegion>('PJM');
  const [selected, setSelected] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 280); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setPage(1); }, [type, region, status, asOf, knownAt]);
  const params = new URLSearchParams({ type, region, q: query, status, page: String(page), pageSize: '20', historyLimit: '12' });
  if (asOf) params.set('asOf', asOf);
  if (knownAt) params.set('knownAt', new Date(`${knownAt}+09:00`).toISOString());
  const queryString = params.toString();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    request<DashboardResponse>(`/api/dashboard?${queryString}`, { signal: controller.signal })
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryString, revision]);
  useEffect(() => { request<HealthResponse>('/api/health').then(setHealth).catch(() => setHealth(null)); }, [revision]);
  useEffect(() => {
    if (view !== 'overview') return;
    const controller = new AbortController();
    setPipelineError('');
    Promise.all([
      request<LoadPipelineDataset>('/api/load-pipeline', { signal: controller.signal }),
      request<MarketComparison>('/api/market-comparison', { signal: controller.signal }),
    ]).then(([nextPipeline, nextComparison]) => {
      setPipeline(nextPipeline); setMarketComparison(nextComparison);
    }).catch(e => { if (e.name !== 'AbortError') setPipelineError(e.message); });
    return () => controller.abort();
  }, [view, revision]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 7000); return () => clearTimeout(timer); }, [notice]);
  const navigate = (next: View) => { setView(next); setMobileOpen(false); };
  const openMarket = (nextRegion: MarketRegion = 'PJM') => { setMarketRegion(nextRegion); navigate('market'); };
  const authHeaders = () => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  const capture = async () => {
    setCapturing(true);
    try { const result = await request<{ duplicate: boolean }>('/api/snapshots', { method: 'POST', headers: authHeaders(), body: '{}' }); setNotice(result.duplicate ? '변경 내용이 없어 기존 관측 기록을 유지했습니다.' : '현재 원장과 출처의 관측 기록을 저장했습니다. 원자료를 새로 수집한 것은 아닙니다.'); setRevision(v => v + 1); }
    catch (e) { setNotice(`관측 저장 실패: ${(e as Error).message}`); }
    finally { setCapturing(false); }
  };
  const currentNav = NAV.find(item => item.id === view)!;
  const filtersChanged = type !== 'all' || region !== '';
  const offline = health?.offlinePreview === true;
  const canWrite = !offline && (!!health?.canWrite || !!token);
  return <div className="app-shell">
    <a className="skip-link" href="#main">본문으로 이동</a>
    {mobileOpen && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <a href="#" className="brand" onClick={e => { e.preventDefault(); navigate('overview'); }} aria-label="Grid Atlas 전국 개요"><span className="brand-mark"><Network size={23} strokeWidth={1.6} /></span><span>GRID<span className="brand-light">ATLAS</span><small>GRID CONNECTION OBSERVATORY</small></span></a>
      <div className="sidebar-label">OBSERVATORY <span>01</span></div>
      <nav aria-label="주 메뉴">{NAV.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={19} strokeWidth={1.6} /><span>{item.label}</span>{view === item.id && <span className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-note"><span className="small-overline">OUR PRINCIPLE</span><p>진행은 근거로.<br />공백은 투명하게.</p><span>단계 미공개는<br />별도 집계합니다.</span><div className="note-orbit"><span /><span /><span /></div></div>
      <div className="sidebar-bottom"><div><span className={`status-dot ${health?.ok ? 'green' : 'amber'}`} /><span>{health?.ok ? (offline ? '공개 자료 불러옴' : '데이터베이스 연결됨') : '연결 상태 확인 중'}</span></div><button onClick={() => setAdminOpen(true)}><LockKeyhole size={14} /> 평가 관리 연결 <ChevronRight size={13} /></button><small>CONUS 48 STATES + DC<br />{MODEL_VERSION} · 기준 시각 KST</small></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button menu-button" aria-label="메뉴 열기" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><span>관측 워크스페이스</span><ChevronRight size={13} /><strong>{currentNav.label}</strong></div><div className="topbar-right"><span className="environment-badge"><span className={`status-dot ${health?.ok ? 'green' : 'amber'}`} />{offline ? '읽기 전용 대시보드' : health?.canWrite ? '로컬 작업공간' : '데이터 관측소'}</span><button className="icon-button" aria-label="데이터 새로 읽기" onClick={() => setRevision(v => v + 1)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button><span className="avatar">GA</span></div></header>
      <main id="main" tabIndex={-1}>
        <section className="page-heading"><div><div className="eyebrow"><span /> U.S. GRID CONNECTION INTELLIGENCE</div><h1>{view === 'overview' ? '미국 계통접속 관측소' : currentNav.label}<span className="heading-period">.</span></h1><p>{VIEW_DESCRIPTION[view]}</p></div>{view !== "market" && view !== "pipeline" && !(view === "history" && historyMode !== "app") && <div className="heading-date"><span>최근 관측</span><strong>{date(data?.snapshot?.capturedAt)}</strong><small>{data?.snapshot ? '원자료 기준일은 출처별 상이' : '관측 기록 확인 중'}</small></div>}</section>
        {view !== 'method' && view !== 'market' && view !== 'pipeline' && !(view === 'history' && historyMode !== 'app') && <>
          <div className="scope-toolbar"><div className="type-tabs" role="group" aria-label="프로젝트 유형">{TYPES.map(item => <button key={item.id} className={type === item.id ? 'selected' : ''} aria-pressed={type === item.id} onClick={() => setType(item.id)}><item.icon size={16} /><span>{item.label}</span>{item.id !== 'all' && data && <small>{number(data.summary.typeCounts[item.id])}</small>}</button>)}</div><button className={`button compact ${asOf || knownAt ? 'active-filter' : ''}`} aria-expanded={timeOpen} onClick={() => setTimeOpen(v => !v)}><CalendarDays size={15} />{asOf ? date(asOf) : '관측 시점'}<ChevronDown size={13} /></button></div>
          {timeOpen && <div className="temporal-panel"><div><strong>시점 기준 조회</strong><p>현재까지 확인한 근거로 과거를 재평가하거나, 당시 알려진 범위만 조회합니다.</p></div><label>평가 기준일<input type="date" max={today()} value={asOf} onChange={e => setAsOf(e.target.value)} /></label><label>근거가 알려진 시각 (KST)<input type="datetime-local" max={currentKstMinute()} value={knownAt} onChange={e => setKnownAt(e.target.value)} /></label><button className="button compact" onClick={() => { setAsOf(''); setKnownAt(''); }}>현재로 돌아가기</button></div>}
          <div className="disclosure"><CircleHelp size={16} /><span><strong>수집된 공개 원장 기준</strong> · 전국 전수 데이터가 아닙니다. 동일 출처 신청 ID로 집계하며, 원장 간 동일 실물 프로젝트의 중복 식별은 미완료입니다.</span><button onClick={() => navigate('sources')}>수집 범위 확인 <ArrowUpRight size={14} /></button></div>
        </>}
        {view === 'history' && <div className="historical-mode-tabs" role="group" aria-label="시계열 자료 구분"><button className={historyMode === 'load' ? 'selected' : ''} aria-pressed={historyMode === 'load'} onClick={() => setHistoryMode('load')}><Factory size={16} />수용가 권역 비교</button><button className={historyMode === 'official' ? 'selected' : ''} aria-pressed={historyMode === 'official'} onClick={() => setHistoryMode('official')}><History size={16} />공식 과거 자료</button><button className={historyMode === 'app' ? 'selected' : ''} aria-pressed={historyMode === 'app'} onClick={() => setHistoryMode('app')}><Database size={16} />앱 관측 기록</button></div>}
        {view === 'history' ? historyMode === 'load' ? <LoadBottleneckPanel revision={revision} /> : historyMode === 'official' ? <HistoricalPanel revision={revision} /> : error ? <div className="market-error" role="alert">관측 기록 조회 실패: {error}</div> : !data ? <LoadingSkeleton /> : !data.available ? <div className="empty-state"><CalendarDays size={36} /><h2>이 날짜에 저장된 앱 관측이 없습니다</h2><p>서비스 시작 전의 자료는 ‘공식 과거 자료’에서 확인할 수 있습니다.</p><button className="button primary" onClick={() => setHistoryMode('official')}>공식 과거 자료 보기 <ArrowRight size={15} /></button></div> : <HistoryView data={data} capturing={capturing} canWrite={canWrite} onCapture={capture} /> : view === 'market' ? <MarketPanel revision={revision} initialRegion={marketRegion} /> : view === 'pipeline' ? <LoadPipelinePanel revision={revision} onRegister={() => { setType('load'); setRegion(''); setSearch(''); setStatus('all'); setAsOf(''); setKnownAt(''); navigate('projects'); }} /> : error ? <div className="empty-state error-state"><Database size={34} /><h2>데이터를 불러오지 못했습니다</h2><p>{error}</p><button className="button primary" onClick={() => setRevision(v => v + 1)}><RefreshCw size={15} /> 다시 시도</button></div> : !data && loading ? <LoadingSkeleton /> : data && <>
          {loading && <div className="loading-strip" role="status">선택한 조건을 불러오는 중…</div>}
          {view === 'method' ? <Methodology /> : !data.available ? <div className="empty-state"><CalendarDays size={36} /><h2>이 시점의 관측 자료가 없습니다</h2><p>첫 수집 이전의 진행 상태를 현재 데이터로 채우지 않습니다.<br />다른 기준일을 선택하거나 현재 관측으로 돌아가세요.</p><button className="button primary" onClick={() => { setAsOf(''); setKnownAt(''); }}>현재 관측 보기 <ArrowRight size={15} /></button></div> : <>
            {view === 'overview' && <>
              <div className="national-load-scope"><Factory size={20} /><div><strong>전국 수용가 접속 요청 총량은 아직 미확보입니다.</strong><p>개별 신청 원장의 알려진 용량을 전국 수용가 총량으로 해석하지 않습니다. 아래에서는 각 ISO/RTO의 공식 요청 집계와 공개 파이프라인을 해당 권역의 발전·저장 신청과 함께 확인할 수 있습니다. 회사별 부분 집계와 단계별 수치를 전국 합계로 더하지 않습니다.</p></div></div>
              {(asOf || knownAt) && <div className="market-notice">아래 권역별 파이프라인은 최신 공개 자료입니다. 선택한 과거 시점은 그 아래 프로젝트 원장·평가에 적용됩니다.</div>}
              {pipelineError && <div className="market-error" role="alert">권역별 파이프라인 재조회 실패: {pipelineError}{pipeline ? ' 이전에 불러온 자료를 표시합니다.' : ''}</div>}
              {pipeline && marketComparison ? <RegionalPipelinePanel pipeline={pipeline} comparison={marketComparison} onChoose={openMarket} /> : !pipelineError && <div className="market-loading" role="status">ISO/RTO별 공개 요청·파이프라인을 불러오는 중…</div>}
              <p className="market-caveat">위 표는 7개 ISO/RTO 범위입니다. 아래 발전·저장 원장 합계에는 ISO/RTO 밖의 서부·남동부 자료도 포함되며, 수용가 전체 요청과 같은 모집단이 아닙니다.</p>
            </>}
            {(view === 'overview' || view === 'projects') && <Metrics data={data} scoped={filtersChanged} selectedType={type} selectedRegion={region} onMarket={() => openMarket()} />}
            {view === 'overview' && <>
              <div className="market-feature-links"><button className="market-feature-link" onClick={() => navigate('market')}><Activity size={23} /><span><strong>실제 부하와 신청 용량 비교</strong><small>7개 ISO·RTO · 공개 부하 관측과 일별 피크</small></span><ArrowRight size={17} /></button><button className="market-feature-link" onClick={() => navigate('pipeline')}><Factory size={23} /><span><strong>수용가 파이프라인 확장 보기</strong><small>데이터센터·공장 · 신청, 계약, 발표 근거 구분</small></span><ArrowRight size={17} /></button></div>
              <RatingBreakdown data={data} selectedRegion={region} onLoadComparison={() => { setHistoryMode('load'); navigate('history'); }} /><div className="overview-grid"><RegionMap data={data} region={region} setRegion={setRegion} type={type} /><CoverageCard data={data} onReview={() => { setStatus('unknown'); navigate('projects'); }} /></div><RegionalRatings data={data} onRegion={setRegion} />
              <div className="section-heading"><div><span className="eyebrow">THE FIVE REQUIREMENTS</span><h2>통전까지, 다섯 가지 접속 요건</h2></div><button className="text-button" onClick={() => navigate('method')}>점수 산정 방식 <ArrowRight size={15} /></button></div>
              <div className="gate-strip">{GATES.map((gate, i) => <button key={gate} className="gate-tile" onClick={() => navigate('method')}><span className="gate-number">0{i + 1}</span><span><strong>{GATE_LABEL[gate]}</strong><small>미진행 20 → 완료 0점</small></span><ArrowUpRight size={15} /></button>)}</div>
              <ProjectTable data={data} compact region={region} setRegion={setRegion} search={search} setSearch={setSearch} status={status} setStatus={setStatus} page={page} setPage={setPage} onProject={setSelected} onAll={() => navigate('projects')} exportQuery={queryString} />
            </>}
            {view === 'projects' && <ProjectTable data={data} region={region} setRegion={setRegion} search={search} setSearch={setSearch} status={status} setStatus={setStatus} page={page} setPage={setPage} onProject={setSelected} exportQuery={queryString} />}
            {view === 'sources' && <SourcesView sources={data.sources} type={type} health={health} revision={revision} />}
          </>}
        </>}
        <footer className="page-footer"><span><Network size={14} /> GRID ATLAS <i /> 공개 근거 기반 계통접속 관측</span><span>기준 시각 Asia/Seoul · {MODEL_VERSION}</span></footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><FileCheck2 size={19} /><span>{notice}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {selected && <ProjectDrawer projectId={selected} asOf={asOf} knownAt={knownAt} canWrite={canWrite} token={token} onClose={() => setSelected(null)} onSaved={() => { setRevision(v => v + 1); setNotice('평가 근거를 새 이력으로 저장했습니다. 이전 평가는 보존됩니다.'); }} onAdmin={() => setAdminOpen(true)} />}
    {adminOpen && <Modal title="평가 관리 연결" onClose={() => setAdminOpen(false)}><div className="admin-intro"><LockKeyhole size={25} /><p>공개 조회와 평가 기록 권한을 구분합니다. 운영 서버에서 평가·관측 기록을 저장할 때 관리 키가 필요합니다.</p></div>{health?.canWrite && <div className="inline-note success"><Check size={15} /> 로컬 개발 환경은 평가 기록이 허용됩니다.</div>}{offline ? <div className="inline-note">이 화면은 읽기 전용입니다. 평가 저장과 관리 키 연결은 실제 서버에서만 가능합니다.</div> : <label className="form-field">관리 키<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="ADMIN_TOKEN" /></label>}<p className="form-help">키는 이 화면의 메모리에만 보관합니다. 새로고침하면 사라집니다. 코드·파일·브라우저 저장소에는 저장하지 않습니다.</p><div className="dialog-actions"><button className="button" onClick={() => { setToken(''); setAdminOpen(false); }}>연결 해제</button><button className="button primary" onClick={() => setAdminOpen(false)}>설정 완료 <Check size={15} /></button></div></Modal>}
  </div>;
}

function Metrics({ data, scoped, selectedType, selectedRegion, onMarket }: { data: DashboardResponse; scoped: boolean; selectedType: TypeFilter; selectedRegion: string; onMarket: () => void }) {
  const s = data.summary;
  return <section className="metrics-grid" aria-label="관측 요약">
    <article className="metric metric-score"><div className="metric-label">{scoped ? '선택 범위' : '관측 프로젝트'} 평균 병목점수<BarChart3 size={17} /></div><div className={`metric-value ${s.ratingMean === null ? 'unavailable' : ''}`}>{s.ratingMean === null ? '미산출' : decimal(s.ratingMean)}{s.ratingMean !== null && <small>/ 100</small>}</div><p className="score-evidence-caption">{s.ratingEstimatedCount ? `단계·근거 추정 ${number(s.ratingEstimatedCount)}건 포함` : '입력된 요건별 근거 기준'} · 미산출 {number(s.ratingUnknownCount)}건 제외</p><div className="metric-bottom"><span className="tiny-dot" /> 평균 분모 {number(s.ratedCount)}건 · 용량 가중 없음</div><span className="metric-trace" /></article>
    <article className="metric"><div className="metric-label">평가 대상 신청<Layers3 size={17} /></div><div className="metric-value">{number(s.eligibleCount)}<small>건</small></div><div className="metric-bottom">본토 활성 신청 · 유형 간 혼합 사업 중복 제외</div></article>
    <article className="metric"><div className="metric-label">공개 개별 신청 원장 용량<Activity size={17} /></div><div className="capacity-stack">{(['generation', 'storage', 'load'] as ProjectType[]).filter(t => selectedType === 'all' || t === selectedType).map(t => <div key={t}><span><i className={`type-dot ${t}`} />{t === 'load' ? '수용가 원장' : TYPE_LABEL[t]}</span>{t === 'load' && selectedType === 'all' && !selectedRegion ? <button className="text-button" onClick={onMarket}>권역별 규모 확인 <ArrowRight size={13} /></button> : <strong>{s.knownCapacityCounts[t] > 0 ? decimal(s[`${t}Mw`] / 1000, 2) : '미확보'}{s.knownCapacityCounts[t] > 0 && <small>GW</small>}</strong>}</div>)}</div><div className="metric-bottom">{selectedType === 'load' ? '확보한 개별 원장 범위 · 전국 수용가 총량과 별도' : '수용가 파이프라인은 권역표의 공개 범위와 함께 확인'}</div></article>
    <article className="metric"><div className="metric-label">점수 미산출<CircleHelp size={17} /></div><div className="metric-value">{number(s.ratingUnknownCount)}<small>건</small></div><div className="metric-bottom"><span className="tiny-dot amber" />상태 미공개·해석 불가 · 평균에서 제외</div></article>
  </section>;
}

const MAP_REGIONS = [
  { id: 'CAISO', label: 'CAISO', caption: '캘리포니아', path: 'M48,77 L93,83 L111,144 L141,195 L108,195 L66,142 Z', x: 90, y: 137 },
  { id: 'West', label: 'WEST', caption: '서부', path: 'M99,35 L205,44 L204,162 L143,190 L116,139 L100,82 L57,72 L59,36 Z', x: 153, y: 91 },
  { id: 'SPP', label: 'SPP', caption: '중부 평원', path: 'M213,48 L271,48 L278,107 L297,144 L281,184 L211,161 Z', x: 247, y: 112 },
  { id: 'ERCOT', label: 'ERCOT', caption: '텍사스', path: 'M214,171 L276,193 L299,208 L288,243 L268,249 L241,222 L221,223 L190,199 Z', x: 251, y: 206 },
  { id: 'MISO', label: 'MISO', caption: '중북부', path: 'M280,40 L328,45 L341,70 L372,80 L354,115 L329,125 L316,169 L299,181 L290,184 L305,143 L287,106 Z', x: 313, y: 93 },
  { id: 'Southeast', label: 'SOUTHEAST', caption: '남동부', path: 'M322,178 L335,135 L377,126 L423,150 L401,185 L405,211 L428,240 L415,244 L389,212 L375,202 L311,203 L303,190 Z', x: 362, y: 170 },
  { id: 'PJM', label: 'PJM', caption: '중동부', path: 'M367,91 L390,82 L428,81 L448,99 L431,143 L381,117 L364,116 Z', x: 410, y: 109 },
  { id: 'NYISO', label: 'NYISO', caption: '뉴욕', path: 'M401,61 L431,46 L451,58 L450,90 L431,73 L399,75 Z', x: 426, y: 63 },
  { id: 'ISO-NE', label: 'ISO-NE', caption: '뉴잉글랜드', path: 'M459,28 L476,17 L489,49 L480,72 L458,85 L459,57 Z', x: 476, y: 52 },
];
function RegionMap({ data, region, setRegion, type }: { data: DashboardResponse; region: string; setRegion: (v: string) => void; type: TypeFilter }) {
  const sources = data.sources.filter(s => type === 'all' || s.types.includes(type));
  return <section className="panel map-panel"><div className="panel-heading"><div><span className="eyebrow">REGIONAL COVERAGE</span><h2>미국 본토 관측 범위</h2></div><span className="small-pill">48 STATES + DC</span></div><div className="map-subhead"><span>권역을 선택해 원장과 평가 대상을 확인하세요.</span>{region && <button className="text-button" onClick={() => setRegion('')}>전체 보기 <X size={13} /></button>}</div><div className="map-wrap"><svg viewBox="20 0 490 270" role="img" aria-label="미국 본토 권역 도식. 실제 지리 경계와 다릅니다."><defs><pattern id="map-dot" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".75" fill="#dce5e7" /></pattern></defs><rect width="550" height="280" fill="url(#map-dot)" />{MAP_REGIONS.map(r => {
    const regionSources = sources.filter(s => s.region === r.id);
    const hasRegister = regionSources.some(s => s.coverage === 'full_register' || s.coverage === 'filtered_register');
    return <g key={r.id} className={`map-region ${region === r.id ? 'chosen' : ''} ${hasRegister ? 'has-register' : 'coverage-gap'}`} role="button" tabIndex={0} aria-label={`${r.label} 권역 선택`} aria-pressed={region === r.id} onClick={() => setRegion(region === r.id ? '' : r.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRegion(region === r.id ? '' : r.id); } }}><title>{r.caption}: {hasRegister ? '일부 공개 원장 확보' : '개별 원장 공백 또는 미확인'}</title><path d={r.path} /><text x={r.x} y={r.y} textAnchor="middle">{r.label}</text></g>;
  })}</svg></div><div className="map-caption"><span><i className="legend-box teal" />일부 개별 원장 확보</span><span><i className="legend-box sand" />개별 원장 공백·미확인</span><small>권역 도식 · 실제 경계와 다름</small></div><div className="region-pills"><button className={!region ? 'selected' : ''} onClick={() => setRegion('')}>전체 권역</button>{data.regions.map(r => <button key={r} className={region === r ? 'selected' : ''} onClick={() => setRegion(region === r ? '' : r)}>{r}</button>)}</div></section>;
}
function CoverageCard({ data, onReview }: { data: DashboardResponse; onReview: () => void }) {
  const s = data.summary; const pct = s.eligibleCount ? s.ratedCount / s.eligibleCount * 100 : 0;
  return <section className="panel evaluation-panel"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE & STAGE ESTIMATES</span><h2>점수 산출 범위</h2></div><ShieldCheck size={21} /></div><div className="coverage-ring" style={{ background: `conic-gradient(#167e76 0% ${pct}%, #eaf0ef ${pct}% 100%)` }}><div><span>추정 포함 점수 산출</span><strong>{number(s.ratedCount)}<small>건</small></strong><span>{decimal(pct)}% <i>관측 대상 내 비율</i></span></div></div><div className="coverage-key"><div><span><i className="type-dot generation" />요건별 근거 점수 산출</span><strong>{number(s.scoredCount)} <small>건</small></strong></div><div><span><i className="type-dot storage" />단계·근거 추정 포함</span><strong>{number(s.ratingEstimatedCount)} <small>건</small></strong></div><div><span><i className="type-dot unknown" />상태 미확인·해석 불가</span><strong>{number(s.ratingUnknownCount)} <small>건</small></strong></div></div><div className="coverage-note">원장의 연구·계약·공사 단계에 공통 가정을 적용한 <strong>추정 점수</strong>를 포함합니다. 실제 요건별 근거와 구분하며, 미확인 상태를 100점으로 채우지 않습니다.</div><button className="button full-width" onClick={onReview}>점수 미산출 프로젝트 검토 <ArrowRight size={15} /></button></section>;
}

function RatingBreakdown({ data, selectedRegion, onLoadComparison }: { data: DashboardResponse; selectedRegion: string; onLoadComparison: () => void }) {
  const s = data.summary;
  return <section className="rating-type-grid" aria-label="유형별 추정 포함 평균 점수">{(['generation', 'storage', 'load'] as ProjectType[]).map(type => <article key={type}><span><i className={`type-dot ${type}`} />{type === 'load' ? `${selectedRegion && selectedRegion !== 'NYISO' ? selectedRegion : 'NYISO'} 수용가` : TYPE_LABEL[type]} 평균 병목점수</span><strong>{s.ratingTypeMeans[type] === null ? '미산출' : decimal(s.ratingTypeMeans[type]!)}{s.ratingTypeMeans[type] !== null && <small>/ 100</small>}</strong><p>추정 포함 · 평균 분모 {number(s.ratingTypeCounts[type])}건</p>{type === 'load' && <button className="load-score-overview-link" onClick={onLoadComparison}>권역별 수용가 진행 근거 <ArrowRight size={13} /></button>}</article>)}<p>발전·저장 원장의 기준일은 주로 2025.12.31이며 현재 확인 시각과 다릅니다. 같은 프로젝트의 복합 유형은 각 유형 평균에 포함되며 전체 평균에서는 한 번 셉니다.</p><p className="load-score-overview-note">수용가 원장 평균은 현재 NYISO 개별 신청 범위입니다. 다른 권역의 용량 가중 단계 점수·추적군 참고지수는 별도 화면에서 집계 범위와 함께 확인합니다.</p></section>;
}
function RegionalRatings({ data, onRegion }: { data: DashboardResponse; onRegion: (region: string) => void }) {
  return <section className="panel regional-rating-panel"><div className="panel-heading"><div><span className="eyebrow">PROJECT BOTTLENECK RATINGS</span><h2>권역별 프로젝트 평균 점수</h2></div><span className="small-pill sand">단계 추정 포함 · 동일 가중</span></div><p className="panel-description">공개 원장의 활성 신청별 점수를 평균합니다. 수용가 집계 자료의 MW는 프로젝트 점수 분모에 넣지 않습니다.</p><div className="table-scroll"><table className="rating-region-table"><thead><tr><th>권역</th><th>평균 병목점수</th><th>평균 분모</th><th>추정 포함</th><th>미산출·제외</th></tr></thead><tbody>{data.summary.ratingRegions.map(row => <tr key={row.region}><td><button className="text-button" onClick={() => onRegion(row.region)}>{row.region}<ArrowUpRight size={12} /></button></td><td><strong>{row.mean === null ? '미산출' : decimal(row.mean)}{row.mean !== null && <small>/ 100</small>}</strong></td><td>{number(row.ratedCount)}건</td><td>{number(row.estimatedCount)}건</td><td>{number(row.unknownCount)}건</td></tr>)}</tbody></table></div></section>;
}
function RatingBadge({ score }: { score: ProjectScore }) {
  const point = ratingPoint(score); const modeled = score.point === null && score.stageEstimate !== null;
  return point === null ? <span className="unknown-pill">미산출</span> : <span className="project-rating"><span className={`score-pill ${point >= 70 ? 'high' : point <= 30 ? 'low' : ''}`}>{decimal(point)}<small>/100</small></span>{modeled ? <small className="stage-estimate-tag">단계 추정</small> : score.estimated ? <small className="stage-estimate-tag">근거 추정 포함</small> : <small className="verified-rating-tag">요건별 근거</small>}</span>;
}

function ProjectTable({ data, compact = false, region, setRegion, search, setSearch, status, setStatus, page, setPage, onProject, onAll, exportQuery }: { data: DashboardResponse; compact?: boolean; region: string; setRegion: (v: string) => void; search: string; setSearch: (v: string) => void; status: string; setStatus: (v: string) => void; page: number; setPage: (v: number) => void; onProject: (id: string) => void; onAll?: () => void; exportQuery: string }) {
  const rows = compact ? data.projects.slice(0, 6) : data.projects;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportCsv = async () => {
    setExporting(true); setExportError('');
    try {
      const response = await fetch(`/api/export?${exportQuery}`);
      if (!response.ok) throw new Error(`CSV 파일을 만들지 못했습니다 (${response.status}).`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `grid-atlas-projects-${today()}.csv`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setExportError((e as Error).message); } finally { setExporting(false); }
  };
  return <section className="panel projects-panel"><div className="panel-heading"><div><span className="eyebrow">PROJECT REGISTER</span><h2>프로젝트 원장 <span className="count-badge">{number(data.total)}</span></h2></div>{compact ? <button className="text-button" onClick={onAll}>원장 전체 보기 <ArrowRight size={15} /></button> : <button className="button compact" onClick={exportCsv} disabled={exporting}>{exporting ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}CSV 내보내기</button>}</div><div className="table-toolbar"><label className="search-field"><Search size={17} /><input aria-label="프로젝트 검색" value={search} onChange={e => setSearch(e.target.value)} placeholder="이름 · ID · 진행 단계 검색" /></label><div className="table-filters"><label><span className="sr-only">권역</span><select aria-label="권역 필터" value={region} onChange={e => setRegion(e.target.value)}><option value="">전체 권역</option>{data.regions.map(r => <option key={r}>{r}</option>)}</select></label><label className="status-select"><ListFilter size={15} /><select aria-label="평가 상태 필터" value={status} onChange={e => setStatus(e.target.value)}><option value="all">모든 평가 상태</option><option value="scored">점수 있음 · 추정 포함</option><option value="unknown">점수 미산출</option></select></label></div></div><div className="source-stage-note"><FileText size={14} /><span><strong>원장 진행 상태는 출처의 원문입니다.</strong> 단계 추정은 이 상태에 공통 가정을 적용한 점수이며, 실제 요건별 확인 근거와 구분합니다. 해석 불가 상태는 평균에서 제외합니다.</span></div>{exportError && <div className="inline-note" role="alert">{exportError}</div>}<div className="table-scroll"><table className="project-table"><thead><tr><th>프로젝트 / 신청 ID</th><th>유형</th><th>권역</th><th>공개 용량</th><th className="source-stage-heading">원장 진행 상태<small>출처 원문</small></th><th>5개 요건 근거</th><th>병목점수</th><th><span className="sr-only">상세</span></th></tr></thead><tbody>{rows.map(row => <tr key={row.project.id}><td><button className="project-name" onClick={() => onProject(row.project.id)}>{row.project.name || row.project.sourceRecordId}</button><small className="record-id">{row.project.sourceRecordId}{!row.project.eligible && <span className="excluded-inline"> · 평가 제외</span>}</small></td><td><div className="type-badges">{row.project.types.map(t => <span key={t} className={`type-badge ${t}`}>{TYPE_LABEL[t]}</span>)}</div></td><td><span className="region-name">{row.project.region}</span><small className="muted-cell">{row.project.state || '주 미공개'}</small></td><td><ProjectCapacity project={row.project} /></td><td className="source-stage-cell"><span className={row.project.rawStatus.trim() ? "source-stage-value" : "source-stage-value is-missing"}>{row.project.rawStatus.trim() ? row.project.rawStatus : "원장 상태 미공개"}</span></td><td><div className="mini-gates" aria-label={`5개 요건 중 ${row.assessedGates}개 확인`}>{row.gates.map(g => <span key={g.gate} className={g.points !== null ? 'known' : ''} title={`${GATE_LABEL[g.gate]}: ${STATUS_LABEL[g.status]}`} />)}<small>{row.assessedGates}/5</small></div>{row.estimated && <small className="estimate-label">추정 포함</small>}</td><td><RatingBadge score={row} /></td><td><button className="icon-button" onClick={() => onProject(row.project.id)} aria-label={`${row.project.name || row.project.sourceRecordId} 상세 보기`}><ArrowUpRight size={16} /></button></td></tr>)}{!rows.length && <tr><td colSpan={8}><div className="empty-table"><Search size={27} /><strong>조건에 맞는 프로젝트가 없습니다</strong><span>검색어와 필터를 조정해 주세요.</span></div></td></tr>}</tbody></table></div><div className="table-footer"><span>{compact ? `검색 결과 ${number(data.total)}건 중 ${rows.length}건 표시` : `${number(data.total)}건 중 ${data.total ? number((data.page - 1) * data.pageSize + 1) : 0}–${number(Math.min(data.page * data.pageSize, data.total))}건`}<small>평균의 분모는 유형·권역 기준 · 검색·평가 상태 필터와 별도</small></span>{!compact && <div className="pagination"><button aria-label="이전 페이지" className="icon-button" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span>{data.page} <i>/ {Math.max(1, Math.ceil(data.total / data.pageSize))}</i></span><button aria-label="다음 페이지" className="icon-button" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div>}</div></section>;
}
function ProjectCapacity({ project }: { project: Project }) {
  return <div className="project-capacity">{project.types.map(t => <div key={t}><span>{TYPE_LABEL[t]}</span><strong>{project[`${t}Mw`] === null ? '미공개' : `${decimal(project[`${t}Mw`] as number)} MW`}</strong></div>)}{project.capacityStatus === 'partial' && <small>일부 용량 미공개</small>}</div>;
}

function SourcesView({ sources, type, health, revision }: { sources: Source[]; type: TypeFilter; health: HealthResponse | null; revision: number }) {
  const [filter, setFilter] = useState('all'); const [runs, setRuns] = useState<CollectionRun[]>([]); const [runError, setRunError] = useState(false);
  useEffect(() => { request<CollectionRun[] | { runs: CollectionRun[] }>('/api/runs').then(r => { setRuns(Array.isArray(r) ? r : r.runs); setRunError(false); }).catch(() => setRunError(true)); }, [revision]);
  const typed = sources.filter(s => type === 'all' || s.types.includes(type));
  const visible = typed.filter(s => filter === 'all' || (filter === 'register' ? ['full_register', 'filtered_register'].includes(s.coverage) : !['full_register', 'filtered_register'].includes(s.coverage)));
  const register = typed.filter(s => ['full_register', 'filtered_register'].includes(s.coverage)).length;
  return <><div className="source-summary"><div className="panel source-stat"><Database size={22} /><span>등록된 데이터 출처</span><strong>{typed.length}<small>개</small></strong></div><div className="panel source-stat"><FileCheck2 size={22} /><span>개별 원장 제공 출처</span><strong>{register}<small>개</small></strong></div><div className="panel source-stat"><CircleHelp size={22} /><span>개별 원장 미확보 출처</span><strong>{typed.length - register}<small>개</small></strong></div></div><section className="schedule-card"><span className="schedule-icon"><Clock3 size={24} /></span><div><span className="eyebrow">COLLECTION & REFRESH</span><h2>{health?.schedule.configured ? '프로젝트 원장 정기 실행 설정' : '프로젝트 원장 정기 수집 연결 대기'}</h2><p>{health?.schedule.configured ? `설정 주기: ${health.schedule.cadence}. 설정 여부와 실제 수집 성공은 아래 실행 기록으로 구분합니다.` : '프로젝트 원장의 주간·월간 자동 적재는 아직 가동하지 않습니다. 실측 부하의 별도 갱신 상태는 부하·신청 비교 화면에서 확인할 수 있습니다.'}</p></div><div className="schedule-status"><span className={`small-pill ${health?.schedule.configured ? 'teal' : 'sand'}`}>{health?.schedule.configured ? '설정됨' : '미가동'}</span><small>마지막 실행 {health?.schedule.lastRunAt ? date(health.schedule.lastRunAt, true) : '기록 없음'}</small></div></section><section className="panel source-panel"><div className="panel-heading"><div><span className="eyebrow">SOURCE TRANSPARENCY</span><h2>출처별 수집 범위와 공백</h2></div><select aria-label="출처 상태 필터" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">모든 출처</option><option value="register">개별 원장 확보</option><option value="gaps">개별 원장 미확보</option></select></div><div className="table-scroll"><table className="source-table"><thead><tr><th>출처 / 권역</th><th>공개 범위</th><th>원자료 기준일</th><th>실제 확인일</th><th>갱신 계획 / 처리기</th><th>공개 데이터의 한계</th></tr></thead><tbody>{visible.map(s => <tr key={s.id}><td><a href={safeUrl(s.url)} target="_blank" rel="noreferrer">{s.name}<ExternalLink size={12} /></a><small>{s.region} · {s.types.map(t => TYPE_LABEL[t]).join(' / ')}</small></td><td><span className={`coverage-pill ${['full_register', 'filtered_register'].includes(s.coverage) ? 'teal' : 'sand'}`}>{COVERAGE_LABEL[s.coverage]}</span></td><td>{date(s.sourceAsOf)}</td><td>{date(s.lastCheckedAt)}</td><td><span>{s.refreshCadence === 'weekly' ? '주간' : s.refreshCadence === 'monthly' ? '월간' : '연간'}</span><small>{s.adapter ? '정규화 처리기 있음' : '처리기 미연결'}</small></td><td><p className="source-gap">{s.gaps.length ? s.gaps.join(' · ') : '전국 전수 확보를 의미하지 않음'}</p></td></tr>)}</tbody></table></div>{!visible.length && <div className="empty-table">선택한 유형에 등록된 출처가 없습니다.</div>}</section><section className="panel run-panel"><div className="panel-heading"><div><span className="eyebrow">RUN LOG</span><h2>수집 실행 기록</h2></div></div>{runError ? <div className="empty-table">실행 기록을 불러오지 못했습니다.</div> : !runs.length ? <div className="inline-empty"><Clock3 size={22} /><div><strong>저장된 수집 실행 기록이 없습니다</strong><p>기존 원장을 가져온 관측 기록과 실제 원자료를 새로 수집한 실행 기록은 구분합니다.</p></div></div> : <div className="run-list">{runs.map(r => <div key={r.id}><span className={`status-dot ${r.status === 'success' ? 'green' : 'amber'}`} /><strong>{r.status === 'success' ? '성공' : r.status === 'partial' ? '일부 성공' : r.status === 'failed' ? '실패' : '실행 중'}</strong><time>{date(r.startedAt, true)}</time><p>{r.details}</p></div>)}</div>}</section></>;
}

function HistoryView({ data, canWrite, capturing, onCapture }: { data: DashboardResponse; canWrite: boolean; capturing: boolean; onCapture: () => void }) {
  const history = [...data.history].sort((a, b) => a.snapshot.capturedAt.localeCompare(b.snapshot.capturedAt));
  const [mode, setMode] = useState<'observed' | 'monthly'>('observed');
  const byMonth = new Map<string, typeof history[number]>();
  for (const row of history) byMonth.set(calendarDayKst(row.snapshot.capturedAt).slice(0, 7), row);
  const points = mode === 'monthly' ? [...byMonth.values()] : history;
  const scored = points.filter(p => p.summary.ratingMean !== null);
  const minTime = points.length ? new Date(points[0].snapshot.capturedAt).getTime() : 0;
  const maxTime = points.length ? new Date(points[points.length - 1].snapshot.capturedAt).getTime() : 0;
  const px = (time: string) => maxTime === minTime ? 460 : 58 + (new Date(time).getTime() - minTime) / (maxTime - minTime) * 806;
  return <><section className="panel history-chart-panel"><div className="panel-heading"><div><span className="eyebrow">OBSERVATION HISTORY</span><h2>평균 병목점수의 변화</h2></div><div className="segmented"><button className={mode === 'observed' ? 'active' : ''} onClick={() => setMode('observed')}>관측별</button><button className={mode === 'monthly' ? 'active' : ''} onClick={() => setMode('monthly')}>월 마지막 관측</button></div></div><p className="panel-description">원장 단계 추정과 입력된 요건별 점수를 포함한 평균입니다. 각 관측에 저장된 원장 상태에 같은 모델을 적용하며, 관측하지 않은 과거를 현재 자료로 채우지 않습니다.</p><div className="history-chart"><svg viewBox="0 0 930 290" role="img" aria-label={`병목점수 시계열, ${points.length}개 관측 중 ${scored.length}개 시점에서 평균 산출`}>
      {[0, 20, 40, 60, 80, 100].map(n => <g key={n}><line x1="58" y1={238 - n * 2} x2="865" y2={238 - n * 2} stroke="#e7eced" strokeDasharray="4 5" /><text x="40" y={242 - n * 2} textAnchor="end" className="axis-label">{n}</text></g>)}
      {points.map((p, i) => { const prev = points[i - 1]; const point = p.summary.ratingMean; const x = px(p.snapshot.capturedAt); return <g key={p.snapshot.id}>{point !== null && prev?.summary.ratingMean != null && <line x1={px(prev.snapshot.capturedAt)} y1={238 - prev.summary.ratingMean * 2} x2={x} y2={238 - point * 2} stroke="#167e76" strokeWidth="3" />}{point !== null && <circle cx={x} cy={238 - point * 2} r="5" fill="#167e76" stroke="white" strokeWidth="2"><title>{date(p.snapshot.capturedAt, true)}: {decimal(point)}점 · {number(p.summary.ratedCount)}건</title></circle>}{(i === 0 || i === points.length - 1) && <text x={x} y="269" textAnchor="middle" className="axis-label">{date(p.snapshot.capturedAt)}</text>}</g>; })}</svg>{!scored.length && <div className="chart-empty"><span><Activity size={26} /></span><strong>해석 가능한 단계나 요건별 근거가 있으면 추세가 보입니다</strong><p>관측 기록 {points.length}개 · 평균 점수 산출 가능한 시점 없음</p></div>}</div><div className="history-footnote"><span><i className="type-dot generation" />단계 추정 포함 신청의 평균</span><span>미공개를 0점으로 채우지 않음</span></div></section><section className="panel history-table"><div className="panel-heading"><div><span className="eyebrow">IMMUTABLE SNAPSHOTS</span><h2>관측 원장</h2></div><button className="button compact" disabled={!canWrite || capturing} onClick={onCapture} title={!canWrite ? '평가 관리 연결이 필요합니다' : '현재 DB를 관측 기록으로 저장'}>{capturing ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}현재 관측 저장</button></div><p className="panel-description">관측 저장은 현재 데이터의 이력을 보존합니다. 원자료 수집이나 갱신을 대신하지 않습니다.</p><div className="table-scroll"><table><thead><tr><th>관측 시각 (KST)</th><th>기록 구분</th><th>평가 대상</th><th>평균 분모</th><th>미산출</th><th>평균 점수 · 추정 포함</th></tr></thead><tbody>{[...points].reverse().map(p => <tr key={p.snapshot.id}><td><strong>{date(p.snapshot.capturedAt, true)}</strong></td><td><span className="small-pill">{p.snapshot.trigger === 'bootstrap' ? '최초 가져오기' : p.snapshot.trigger === 'manual' ? '수동 관측' : '수집 관측'}</span></td><td>{number(p.summary.eligibleCount)}</td><td>{number(p.summary.ratedCount)}</td><td>{number(p.summary.ratingUnknownCount)}</td><td>{p.summary.ratingMean === null ? <span className="muted">미산출</span> : `${decimal(p.summary.ratingMean)}점`}</td></tr>)}</tbody></table></div>{data.historyTruncated && <div className="inline-note">최근 관측을 표시합니다. 월별 표시는 불러온 관측 범위 내 마지막 값입니다.</div>}</section></>;
}

function Methodology() {
  const [type, setType] = useState<ProjectType>('generation');
  return <div className="method-layout"><section className="method-hero"><span className="eyebrow">A COMMON FRAMEWORK</span><h2>같은 다섯 요건.<br /><span>서로 다른 진행 근거.</span></h2><p>발전원·저장전원·수용가의 계통 연결을 공통 요건으로 표준화합니다. 요건은 병렬로 진행될 수 있으며, 한 요건의 완료가 다른 요건의 완료를 의미하지 않습니다.</p><div className="formula"><span>프로젝트 병목점수</span><strong>Σ <em>20 × (1 − 진행률)</em></strong><small>5개 요건의 점수를 합산 · 0–100점</small></div></section><section className="panel method-gates"><div className="panel-heading"><h2>유형별 확인할 근거</h2><div className="segmented">{(['generation', 'storage', 'load'] as ProjectType[]).map(t => <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>{TYPE_LABEL[t]}</button>)}</div></div>{GATES.map((gate, i) => <div className="method-gate" key={gate}><span className="gate-number">0{i + 1}</span><div><strong>{GATE_LABEL[gate]}</strong><p>{GATE_DESCRIPTION[gate][type]}</p></div><span>20점</span></div>)}</section><StageEstimateMethod /><ScoreCalculator /><section className="panel method-rules"><div className="panel-heading"><div><span className="eyebrow">SCORING RULES</span><h2>숫자를 해석하는 기준</h2></div></div><div className="rules-grid"><article><span className="rule-icon teal"><Check size={22} /></span><h3>확인된 미진행은 100점</h3><p>5개 요건 모두 진행률 0%로 확인되면 100점입니다. 한 요건이 50% 진행되면 총 90점, 모두 완료하면 0점입니다.</p></article><article><span className="rule-icon sand"><CircleHelp size={22} /></span><h3>미공개는 별도 집계</h3><p>원장 상태를 해석할 수 있으면 단계 추정을 평균에 포함합니다. 해석 불가·미공개 상태는 별도 집계하며, 확인된 미진행으로 간주해 100점을 채우지 않습니다.</p></article><article><span className="rule-icon purple"><FileText size={22} /></span><h3>뉴스는 추정임을 명시</h3><p>정성 근거는 0·25·50·75·100% 구간으로 평가하며, 원문 링크·발생일·확인일·판단 이유를 남깁니다. 원장 단계 모델과 별개인 개별 근거로 저장하며 추정임을 표시합니다.</p></article><article><span className="rule-icon blue"><History size={22} /></span><h3>과거 기록은 보존</h3><p>새 평가를 추가해도 이전 평가를 덮어쓰지 않습니다. 사건 적용일과 시스템 기록일을 구분해 당시 정보만으로도 다시 조회할 수 있습니다.</p></article></div></section><section className="panel methodology-notes"><h2>집계와 해석의 한계</h2><div><strong>평균의 단위</strong><p>입력된 요건별 점수를 우선하며, 개별 근거가 없는 경우에 원장 단계 추정을 적용한 신청 레코드의 단순 산술평균입니다. 일부 요건의 근거만 입력된 경우에는 단계 추정으로 덮어쓰지 않습니다. 용량 가중 평균이 아닙니다. 혼합 발전·저장은 같은 ID라면 전체 집계에서 한 번 셉니다.</p></div><div><strong>전국 전수와 구분</strong><p>전국 수용가 개별 원장은 공개되어 있지 않습니다. 현재 지표는 관측 범위의 평균이며 미국 전체의 확정 점수로 해석할 수 없습니다. 서로 다른 출처 간 동일 실물 프로젝트 식별도 추가 검증이 필요합니다.</p></div><div><strong>해당 없음 처리</strong><p>공식 근거로 해당 없음이 확인된 요건은 분모에서 제외하고 남은 요건을 100점으로 재정규화합니다. 모든 요건이 해당 없음이면 점수를 산출하지 않습니다.</p></div><div><strong>용량의 의미</strong><p>발전·저장·수용 용량은 각각 표시합니다. MVA를 MW로 임의 환산하지 않으며, 미공개 용량은 0으로 대체하지 않습니다. 점수는 완공 확률이나 지연 기간을 의미하지 않습니다.</p></div></section></div>;
}

function ScoreCalculator() {
  const [progress, setProgress] = useState([0, 0, 0, 0, 0]);
  const score = progress.reduce((sum, value) => sum + 20 * (1 - value / 100), 0);
  return <section className="panel score-calculator"><div className="panel-heading"><div><span className="eyebrow">TRY THE MODEL</span><h2>진행률에 따른 점수 변화</h2></div><span className="small-pill sand">계산 예시 · 실제 평가 아님</span></div><div className="calculator-body"><div className="calculator-controls">{GATES.map((gate, i) => <label key={gate}><span>{GATE_LABEL[gate]}<strong>{progress[i]}%</strong></span><input type="range" min="0" max="100" step="25" value={progress[i]} aria-label={`${GATE_LABEL[gate]} 예시 진행률`} onChange={e => setProgress(previous => previous.map((n, index) => index === i ? Number(e.target.value) : n))} /><small>미진행 20점 <span>현재 {decimal(20 * (1 - progress[i] / 100))}점</span> 완료 0점</small></label>)}</div><div className="calculator-result"><span>예시 프로젝트 병목점수</span><strong>{decimal(score)}<small>/ 100</small></strong><p>확인된 진행률을 바꿔보세요.<br />슬라이더는 실제 원장이나<br />평가 이력에 저장되지 않습니다.</p><button className="button compact" onClick={() => setProgress([0, 0, 0, 0, 0])}><RefreshCw size={13} />모두 미진행으로 초기화</button></div></div></section>;
}

function ProjectRatingSummary({ score }: { score: ProjectScore }) {
  const point = ratingPoint(score); const model = score.point === null ? score.stageEstimate : null;
  return <div className="detail-score"><div><span>{model ? '원장 단계 추정 병목점수' : '요건별 근거 병목점수'}</span><strong>{point === null ? '미산출' : decimal(point)}{point !== null && <small> / 100</small>}</strong>{model && <small className="stage-estimate-tag">단계 추정 · 확인값 아님</small>}</div><div><span>별도 입력된 5개 요건 점수</span><strong className="score-range">{score.point === null ? '미산출' : decimal(score.point)}</strong><small className="detail-evidence-count">{score.assessedGates}/5개 요건 확인</small></div></div>;
}
function StageEstimateDetail({ score }: { score: ProjectScore }) {
  const estimate = score.stageEstimate;
  if (!estimate) return <div className="inline-note">{!score.project.eligible ? '평가 집계에서 제외된 프로젝트에는 단계 추정을 적용하지 않습니다.' : score.gates.some(gate => gate.assessment) ? '입력된 요건별 근거를 우선해 원장 단계 모델을 적용하지 않았습니다. 일부 요건이 미확인인 경우 전체 점수는 미산출로 남깁니다.' : '현재 원장 상태를 단계 모델로 해석할 수 없어 단계 추정은 미산출입니다. 해석 가능한 단계가 공개되거나 요건별 근거가 확보되면 점수를 산출합니다.'}</div>;
  return <section className="stage-estimate-panel"><div className="stage-estimate-heading"><div><span className="eyebrow">SOURCE-STAGE ESTIMATE</span><h3>{estimate.label} · {decimal(estimate.point)}점 추정</h3></div><span className="stage-estimate-tag">{estimate.modelVersion}</span></div><p>{estimate.rationale}</p><div className="stage-estimate-source"><span>원장 원문 <strong>{score.project.rawStatus}</strong></span><span>원자료 기준일 <strong>{date(estimate.sourceAsOf)}</strong></span><a href={safeUrl(estimate.sourceUrl)} target="_blank" rel="noreferrer">단계 출처 원문 <ExternalLink size={12} /></a></div><p className="stage-assumption-note">아래 진행률은 원장 단계에 적용한 공통 가정입니다. 개별 인허가·계약·공사 완료를 직접 확인한 값이 아니며, 실제 근거 이력을 생성하지 않습니다.{score.point !== null && ' 이 프로젝트의 표시 점수는 별도 입력된 요건별 점수를 우선합니다.'}</p><table className="stage-gate-table"><thead><tr><th>요건 · 가정 이유</th><th>가정 진행률</th><th>잔여 점수</th></tr></thead><tbody>{estimate.gates.map(gate => <tr key={gate.gate}><td><strong>{GATE_LABEL[gate.gate]}</strong><p>{gate.rationale}</p></td><td>{decimal(gate.progress * 100)}%</td><td>{decimal(gate.points)}<small>/20</small></td></tr>)}</tbody></table></section>;
}
function StageEstimateMethod() {
  return <section className="panel stage-method-panel"><div className="panel-heading"><div><span className="eyebrow">SOURCE-STAGE MODEL</span><h2>원장 진행 단계에서 추정 점수로</h2></div><span className="small-pill sand">모든 진행률은 모델 가정</span></div><p className="panel-description">아래 표는 원장 상태를 5개 요건의 가정 진행률로 변환합니다. 인허가를 포함한 개별 요건의 완료 확인을 뜻하지 않습니다. 공식 원장의 원문 단계·기준일과 추정 이유를 프로젝트 상세에서 확인할 수 있습니다.</p><div className="table-scroll"><table className="stage-method-table"><thead><tr><th>원장 단계 분류</th>{GATES.map(gate => <th key={gate}>{GATE_LABEL[gate]}</th>)}<th>추정 점수</th></tr></thead><tbody>{STAGE_ESTIMATE_CATALOG.map(stage => <tr key={stage.stage}><td><strong>{stage.label}</strong><small>{stage.rationale}</small></td>{GATES.map(gate => <td key={gate}>{decimal(stage.progress[gate] * 100)}%</td>)}<td><strong>{decimal(stage.point)}</strong></td></tr>)}</tbody></table></div><p className="panel-description stage-method-footnote">단순 Active, 단계 미공개, 해석 불가 상태는 100점으로 대체하지 않습니다. 단계 모델은 점수를 가정하며 실제 지연 기간이나 완공 확률을 예측하지 않습니다.</p></section>;
}

function ProjectDrawer({ projectId, asOf, knownAt, canWrite, token, onClose, onSaved, onAdmin }: { projectId: string; asOf: string; knownAt: string; canWrite: boolean; token: string; onClose: () => void; onSaved: () => void; onAdmin: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null); const [error, setError] = useState(''); const [tab, setTab] = useState<'gates' | 'history'>('gates'); const [editing, setEditing] = useState<Gate | null>(null); const [revision, setRevision] = useState(0);
  const drawerRef = useRef<HTMLElement>(null); const titleId = useId();
  useDialogFocus(drawerRef, onClose);
  useEffect(() => {
    const controller = new AbortController(); const params = new URLSearchParams(); if (asOf) params.set('asOf', asOf); if (knownAt) params.set('knownAt', new Date(`${knownAt}+09:00`).toISOString());
    setError(''); request<Detail>(`/api/projects/${encodeURIComponent(projectId)}?${params}`, { signal: controller.signal }).then(setDetail).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [projectId, asOf, knownAt, revision]);
  const score = detail?.score; const project = score?.project;
  return <div className="drawer-layer"><button className="drawer-scrim" onClick={onClose} aria-label="프로젝트 상세 닫기" /><section className="project-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={drawerRef} tabIndex={-1}><div className="drawer-topline"><span><Layers3 size={15} /> PROJECT RECORD</span><button className="icon-button" onClick={onClose} aria-label="프로젝트 상세 닫기"><X size={21} /></button></div>{error ? <div className="empty-state"><h2 id={titleId}>상세 정보 조회 실패</h2><p>{error}</p><button className="button" onClick={() => setRevision(v => v + 1)}>다시 시도</button></div> : !detail ? <div className="drawer-loading"><LoaderCircle className="spin" size={28} /><h2 id={titleId}>프로젝트 불러오는 중</h2></div> : !score || !project ? <div className="empty-state"><h2 id={titleId}>이 시점의 프로젝트 자료가 없습니다</h2></div> : <><div className="drawer-heading"><div className="type-badges">{project.types.map(t => <span key={t} className={`type-badge ${t}`}>{TYPE_LABEL[t]}</span>)}<span className="small-pill">{project.region} · {project.state || '주 미공개'}</span></div><h2 id={titleId}>{project.name || project.sourceRecordId}</h2><p>{project.sourceRecordId}</p><ProjectRatingSummary score={score} />{!project.eligible && <div className="inline-note">평가 집계 제외: {project.exclusionReason || '활성 본토 개별 신청 요건 미충족'}</div>}<div className="detail-meta"><div><span>공개된 용량</span><ProjectCapacity project={project} /></div><div><span>원자료 기준일</span><strong>{date(project.sourceAsOf)}</strong></div><div><span>원장 상태</span><strong>{project.rawStatus || '미공개'}</strong></div></div><a className="source-link" href={safeUrl(project.sourceUrl)} target="_blank" rel="noreferrer">공식 원장 출처 열기 <ExternalLink size={13} /></a></div><div className="drawer-tabs"><button className={tab === 'gates' ? 'active' : ''} onClick={() => setTab('gates')}>접속 요건 <span>5</span></button><button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>근거 이력 <span>{detail.totalAssessments}</span></button></div><div className="drawer-content">{tab === 'gates' ? <>{asOf && <div className="inline-note">{date(asOf)} 기준 조회 중입니다. 새 평가는 현재 시각에 추가 기록됩니다.</div>}<StageEstimateDetail score={score} /><div className="actual-evidence-heading"><h3>별도 입력된 요건별 근거</h3><p>아래는 실제 저장한 근거입니다. 위 단계 추정으로 미확인 요건을 완료 처리하지 않습니다.</p></div>{score.gates.map((g, i) => <GateDetail key={g.gate} gate={g} index={i} types={project.types} onEdit={() => { setEditing(g.gate); }} />)}{editing && <AssessmentForm key={editing} gate={editing} projectId={project.id} canWrite={canWrite} token={token} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setRevision(v => v + 1); onSaved(); }} onAdmin={onAdmin} />}</> : <div className="assessment-history">{!detail.assessments.length ? <div className="empty-table"><FileText size={27} /><strong>별도 입력된 요건별 근거가 없습니다</strong><span>단계 추정은 원장 상태에서 계산하며 이 이력을 자동 생성하지 않습니다.</span></div> : [...detail.assessments].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(a => <article key={a.id}><div className="event-dot" /><div className="history-event-top"><strong>{GATE_LABEL[a.gate]}</strong><span className={`small-pill ${a.basis === 'estimate' ? 'sand' : 'teal'}`}>{a.basis === 'estimate' ? '정성 추정' : '공식 근거'}</span></div><p>{STATUS_LABEL[a.status]}{a.progress !== null ? ` · 진행률 ${decimal(a.progress * 100)}%` : ''}</p><p className="evidence-rationale">{a.rationale}</p><dl><div><dt>적용일</dt><dd>{date(a.effectiveAt)}</dd></div><div><dt>시스템 기록</dt><dd>{date(a.recordedAt, true)}</dd></div></dl><a className="source-link" href={safeUrl(a.sourceUrl)} target="_blank" rel="noreferrer">근거 원문 <ExternalLink size={12} /></a></article>)}{detail.assessmentsTruncated && <div className="inline-note">최근 근거 이력만 표시됩니다. 전체 {number(detail.totalAssessments)}건.</div>}</div>}</div></>}</section></div>;
}
function GateDetail({ gate, index, types, onEdit }: { gate: GateScore; index: number; types: ProjectType[]; onEdit: () => void }) {
  return <article className={`gate-detail ${gate.status === 'complete' ? 'complete' : ''}`}><div className="gate-detail-heading"><span className="gate-number">0{index + 1}</span><div><h3>{GATE_LABEL[gate.gate]}</h3><span>{STATUS_LABEL[gate.status]}{gate.assessment?.basis === 'estimate' && ' · 정성 추정'}</span></div><strong>{gate.points === null ? '—' : decimal(gate.points)}<small> / 20</small></strong></div><p>{types.map(t => GATE_DESCRIPTION[gate.gate][t]).join(' · ')}</p><div className="gate-progress"><span style={{ width: `${(gate.progress ?? 0) * 100}%` }} /></div>{gate.assessment && <div className="gate-evidence"><p>{gate.assessment.rationale}</p><span>적용 {date(gate.assessment.effectiveAt)} · 확인 {date(gate.assessment.observedAt)}</span><a href={safeUrl(gate.assessment.sourceUrl)} target="_blank" rel="noreferrer">근거 원문 <ExternalLink size={11} /></a></div>}<button className="text-button" onClick={onEdit}><Plus size={13} />{gate.assessment ? '새 평가 근거 추가' : '평가 근거 기록'}</button></article>;
}
function AssessmentForm({ gate, projectId, canWrite, token, onCancel, onSaved, onAdmin }: { gate: Gate; projectId: string; canWrite: boolean; token: string; onCancel: () => void; onSaved: () => void; onAdmin: () => void }) {
  const [basis, setBasis] = useState<'official' | 'estimate'>('official'); const [status, setStatus] = useState<GateStatus>('unknown'); const [progress, setProgress] = useState('50'); const [sourceUrl, setSourceUrl] = useState(''); const [effectiveAt, setEffectiveAt] = useState(''); const [observedAt, setObservedAt] = useState(currentKstMinute()); const [publishedAt, setPublishedAt] = useState(''); const [rationale, setRationale] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null); useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!canWrite || saving) return; setError(''); setSaving(true);
    const payload: Omit<Assessment, 'id' | 'recordedAt'> = { projectId, gate, status, progress: status === 'in_progress' ? Number(progress) / 100 : status === 'complete' ? 1 : status === 'not_started' ? 0 : null, basis, sourceUrl, effectiveAt, observedAt: new Date(`${observedAt}+09:00`).toISOString(), publishedAt: publishedAt || null, rationale, modelVersion: MODEL_VERSION };
    try { await request('/api/assessments', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) }); onSaved(); } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  return <form className="assessment-form" ref={formRef} onSubmit={submit}><div className="form-title"><span className="eyebrow">APPEND EVIDENCE</span><h3>{GATE_LABEL[gate]} · 새 평가</h3></div><p className="form-help">직접 확인한 근거만 기록하세요. 상태 변화의 적용일과 실제 확인일을 구분합니다. 모든 평가가 이력에 남습니다.</p><div className="form-columns"><label className="form-field">근거 구분<select value={basis} onChange={e => { setBasis(e.target.value as 'official' | 'estimate'); if (e.target.value === 'estimate' && !['25', '50', '75'].includes(progress)) setProgress('50'); }}><option value="official">공식 정량 근거</option><option value="estimate">뉴스·정성 근거 추정</option></select></label><label className="form-field">요건 상태<select value={status} onChange={e => setStatus(e.target.value as GateStatus)}>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>{basis === 'estimate' && <div className="inline-note">정성 평가는 25% 단위로 기록합니다. 보도에 언급되지 않은 다른 요건까지 진행된 것으로 간주하지 않습니다.</div>}{status === 'in_progress' && <label className="form-field">진행률 (%) {basis === 'estimate' ? <select value={progress} onChange={e => setProgress(e.target.value)}><option value="25">25% · 초기 진행</option><option value="50">50% · 중간 진행</option><option value="75">75% · 완료 전</option></select> : <input type="number" required min="1" max="99" step="0.1" value={progress} onChange={e => setProgress(e.target.value)} />}</label>}<label className="form-field">근거 원문 URL<input type="url" required pattern="https://.*" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://공식기관 또는 뉴스 원문" /></label><div className="form-columns"><label className="form-field">사건·진행 상태 적용일<input type="date" required max={today()} value={effectiveAt} onChange={e => setEffectiveAt(e.target.value)} /></label><label className="form-field">실제 확인 시각 (KST)<input type="datetime-local" required max={currentKstMinute()} value={observedAt} onChange={e => setObservedAt(e.target.value)} /></label></div><label className="form-field">공시·기사 발행일 (선택)<input type="date" max={today()} value={publishedAt} onChange={e => setPublishedAt(e.target.value)} /></label><label className="form-field">판단 이유와 확인한 사실<textarea required minLength={5} maxLength={4000} rows={4} value={rationale} onChange={e => setRationale(e.target.value)} placeholder="어떤 문구·수치가 이 요건의 진행률을 뒷받침하는지 기록하세요." /></label>{error && <div className="form-error" role="alert">{error}</div>}{!canWrite && <div className="inline-note"><LockKeyhole size={15} />평가 기록에는 관리 연결이 필요합니다.<button type="button" className="text-button" onClick={onAdmin}>관리 키 입력</button></div>}<div className="form-actions"><button type="button" className="button" onClick={onCancel}>취소</button><button type="submit" className="button primary" disabled={!canWrite || saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}평가 이력에 저장</button></div></form>;
}

function useDialogFocus(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus();
    const handle = (e: KeyboardEvent) => { const dialogs = document.querySelectorAll('[role=dialog]'); if (dialogs[dialogs.length - 1] !== ref.current) return; if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); } if (e.key === 'Tab') { const focusable = ref.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex="0"]'); if (!focusable?.length) { e.preventDefault(); return; } const first = focusable[0], last = focusable[focusable.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
    document.addEventListener('keydown', handle); return () => { document.removeEventListener('keydown', handle); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [ref]);
}
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null); const titleId = useId(); useDialogFocus(ref, onClose);
  return <div className="modal-layer"><button className="drawer-scrim" onClick={onClose} aria-label={`${title} 닫기`} /><section className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label={`${title} 닫기`}><X size={19} /></button></div>{children}</section></div>;
}
function LoadingSkeleton() { return <div className="skeleton-layout" role="status" aria-label="데이터를 불러오는 중"><div className="metrics-grid">{[1, 2, 3, 4].map(n => <div className="skeleton skeleton-card" key={n} />)}</div><div className="skeleton skeleton-wide" /><div className="skeleton skeleton-wide short" /></div>; }
