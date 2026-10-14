import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Activity, ArrowDownToLine, CalendarDays, ChevronLeft, ChevronRight, Database, ExternalLink, Factory, GitBranch, History, RefreshCw, Search } from 'lucide-react';
import { isHistoricalDataset, type HistoricalDataset } from '../shared/history';
import { isLoadBottleneckDataset, type LoadBottleneckDataset } from '../shared/load-bottleneck';
import { isDemandDataset } from '../shared/market';
import type { DemandDataset } from '../shared/market-types';
import { buildTimelineSeries, comparableTimelineSeries, filterTimelineSeries, timelineCanJoin, timelineCsv, timelineMetricTransition, timelineRegionLabel,
  type TimelineMetric, type TimelineOrigin, type TimelinePoint, type TimelineSeries, type TimelineFilters } from '../shared/timeline';
import ProjectLifecyclePanel from './ProjectLifecyclePanel';
import './timeline-workspace.css';
import { LargeLoadFacilityHistory } from './LargeLoadFacilities';
import LoadApiPanel from './LoadApiPanel';

const METRICS: { id: TimelineMetric; label: string }[] = [{ id: 'score', label: '병목점수' }, { id: 'capacity', label: '신청·계약 용량' }, { id: 'count', label: '신청·사업 건수' }, { id: 'demand', label: '실측 부하' }, { id: 'peak', label: '일별 피크' }];
const ORIGINS: Record<TimelineOrigin, string> = { historical: '과거 원장·공시·API', load_stage: '수용가 단계 자료', system: '계통 부하 관측' };
const BASIS: Record<string, string> = { source_as_of: '원자료 기준', publication: '발표일 기준', archive_capture: '보관본 포착일', observation: '원문 취득일', observed_instant: '실측 시각 · KST', market_local_day: '시장 현지일' };
const nf = (n: number, digits = 2) => n.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const stamp = (value: string | null) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '미공개';
const period = (value: string | null) => value ? value.replace(/^(\d{4})-Q(\d)$/, '$1년 $2분기').replaceAll('-', '.') : '미공개';
const pointDate = (p: TimelinePoint) => p.precision === 'instant' ? stamp(p.observedAt) : p.precision === 'quarter' ? `${p.date.slice(0, 4)}년 ${Math.floor((Number(p.date.slice(5, 7)) - 1) / 3) + 1}분기` : period(p.date.slice(0, p.precision === 'year' ? 4 : p.precision === 'month' ? 7 : 10));
const unit = (s: TimelineSeries) => s.unit === 'score' ? '점' : s.unit === 'projects' ? '건' : 'GW';
const plotted = (s: TimelineSeries, value: number) => s.unit === 'MW' ? value / 1000 : value;
const valueText = (s: TimelineSeries, p: TimelinePoint) => p.value === null ? '미산출·미공개' : `${p.qualifier === 'approximate' ? '약 ' : p.qualifier === 'greater_than' ? '> ' : p.qualifier === 'at_least' ? '≥ ' : ''}${nf(plotted(s, p.value), s.unit === 'projects' ? 0 : 2)} ${unit(s)}`;
const denominatorText = (value: number | null, u: TimelinePoint['denominatorUnit']) => value === null ? '미공개' : `${nf(value)} ${u === 'MW' ? 'MW' : u === 'observations' ? '관측 구간' : '건'}`;
const url = (value: string) => { try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } };
const scoreBasis = (s: TimelineSeries) => s.metric === 'score' ? s.weightBasis === 'capacity_mw' ? '용량 가중 지수' : '프로젝트 동일 가중' : s.measure;
type Selection = { seriesId: string; pointId: string };

export default function TimelineWorkspace({ revision, observationContent }: { revision: number; observationContent?: ReactNode }) {
  const [tab, setTab] = useState<'series' | 'projects' | 'facilities' | 'observations' | 'load-api'>(() => { const mode = window.location.hash.split('?')[0].split('/')[1]; return mode === 'facilities' || mode === 'projects' || mode === 'observations' || mode === 'load-api' ? mode : 'series'; });
  useEffect(() => {
    const onHash = () => { const mode = window.location.hash.split('?')[0].split('/')[1]; setTab(mode === 'facilities' || mode === 'projects' || mode === 'observations' || mode === 'load-api' ? mode : 'series'); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [historical, setHistorical] = useState<HistoricalDataset | null>(null);
  const [load, setLoad] = useState<LoadBottleneckDataset | null>(null);
  const [demand, setDemand] = useState<DemandDataset | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [metric, setMetric] = useState<TimelineMetric>('score');
  const [region, setRegion] = useState('all');
  const [type, setType] = useState<NonNullable<TimelineFilters['type']>>('all');
  const [origin, setOrigin] = useState<TimelineOrigin | 'all'>('all');
  const [search, setSearch] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [seriesId, setSeriesId] = useState('history:lbnl-all-all-bottleneck-score');
  const [compareId, setCompareId] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const tabsId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setErrors([]);
    const get = async <T,>(path: string, name: string, check: (value: unknown) => value is T, accept: (value: T) => void) => {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error(`${name}: 불러오기 실패 (${response.status})`);
      const result: unknown = await response.json();
      if (!check(result)) throw new Error(`${name}: 자료 형식을 확인하지 못했습니다.`);
      if (!controller.signal.aborted) accept(result);
    };
    void Promise.allSettled([
      get('/api/historical', '공식 과거 자료', isHistoricalDataset, setHistorical),
      get('/api/load-bottleneck', '수용가 단계 자료', isLoadBottleneckDataset, setLoad),
      get('/api/demand', '계통 부하', isDemandDataset, setDemand),
    ]).then(results => {
      if (controller.signal.aborted) return;
      setErrors(results.flatMap(result => result.status === 'rejected' ? [String(result.reason?.message ?? result.reason)] : []));
      setLoading(false);
    });
    return () => controller.abort();
  }, [revision, retry]);
  const all = useMemo(() => buildTimelineSeries({ historical, load, demand }), [historical, load, demand]);
  const invalidRange = !!(start && end && start > end);
  const options = useMemo(() => filterTimelineSeries(all, { metric, region, type, origin, search }), [all, metric, region, type, origin, search]);
  const candidates = useMemo(() => invalidRange ? options.map(s => ({ ...s, points: [] })) : filterTimelineSeries(options, { start, end }), [options, invalidRange, start, end]);
  const primary = candidates.find(s => s.id === seriesId) ?? candidates[0];
  const compareOptions = primary ? candidates.filter(s => comparableTimelineSeries(primary, s)) : [];
  const compare = compareOptions.find(s => s.id === compareId);
  const plottedSeries = [primary, compare].filter((s): s is TimelineSeries => !!s);
  const selectedSeries = plottedSeries.find(s => s.id === selection?.seriesId && s.points.some(p => p.id === selection.pointId)) ?? primary;
  const selectedPoint = selectedSeries?.points.find(p => p.id === selection?.pointId) ?? selectedSeries?.points.at(-1);
  const tableRows = plottedSeries.flatMap(series => series.points.map(point => ({ series, point }))).sort((a, b) => b.point.timestamp - a.point.timestamp || a.series.id.localeCompare(b.series.id));
  const effectivePage = Math.min(tablePage, Math.max(0, Math.ceil(tableRows.length / 20) - 1));
  const resetPoint = () => { setSelection(null); setTablePage(0); };
  const chooseMetric = (next: TimelineMetric) => { const filters = timelineMetricTransition(next, { region, type, origin }); setMetric(filters.metric); setRegion(filters.region); setType(filters.type); setOrigin(filters.origin); setSeriesId(''); setCompareId(''); resetPoint(); };
  const preset = (kind: 'national' | 'cohort' | 'demand') => {
    setSearch(''); setStart(''); setEnd(''); resetPoint(); setOrigin(kind === 'cohort' ? 'load_stage' : kind === 'national' ? 'historical' : 'system');
    setMetric(kind === 'demand' ? 'demand' : 'score'); setRegion(kind === 'national' ? '미국 본토' : kind === 'cohort' ? 'NYISO' : 'PJM'); setType(kind === 'national' ? 'all' : kind === 'cohort' ? 'load' : 'system');
    setSeriesId(kind === 'national' ? 'history:lbnl-all-all-bottleneck-score' : kind === 'cohort' ? 'load:nyiso-load-register:active' : 'demand:PJM');
    setCompareId(kind === 'cohort' ? 'load:nyiso-load-fixed-cohort:active' : '');
  };
  const download = () => {
    const blobUrl = URL.createObjectURL(new Blob([timelineCsv(plottedSeries)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = blobUrl; link.download = `grid-atlas-timeline-${metric}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };
  return <div className="timeline-workspace">
    <header className="tw-intro"><div><span className="eyebrow">HISTORY & PROGRESS</span><h2>시간이 흐르며, 무엇이 달라졌을까</h2><p>신청 규모, 진행 점수, 실제 계통 부하를 같은 탐색 화면에서 확인합니다.</p></div><div className="tw-intro-meta"><strong>{all.length ? nf(all.length, 0) : '—'}</strong><span>구분된 지표 계열<br />공개 시점만 연결</span></div></header>
    <div className="tw-tabs" role="tablist" aria-label="통합 시계열 탐색 방식">{([{ id: 'series', label: '지표 시계열', icon: History }, { id: 'projects', label: '프로젝트 생애주기', icon: GitBranch }, { id: 'facilities', label: '시설 진행 이력', icon: Factory }, { id: 'load-api', label: 'API 수집·이력', icon: RefreshCw }, ...(observationContent ? [{ id: 'observations', label: '앱 관측 기록', icon: Database }] : [])] as const).map(item => <button key={item.id} id={`${tabsId}-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${tabsId}-content`} className={tab === item.id ? 'selected' : ''} onClick={() => { setTab(item.id as typeof tab); window.location.hash = item.id === 'series' ? 'history' : `history/${item.id}`; }}><item.icon size={17} />{item.label}</button>)}</div>
    <div id={`${tabsId}-content`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
      {tab === 'load-api' ? <LoadApiPanel revision={revision} /> : tab === 'facilities' ? <LargeLoadFacilityHistory /> : tab === 'projects' ? <ProjectLifecyclePanel revision={revision} /> : tab === 'observations' ? <><div className="tw-notice">앱이 실제로 저장한 관측 기록입니다. 공식 과거 자료를 앱의 과거 관측으로 소급 생성하지 않습니다.</div>{observationContent}</> : <>
        <div className="tw-presets" aria-label="시계열 빠른 선택"><span>바로 살펴보기</span><button type="button" onClick={() => preset('national')}>전국 공개 원장</button><button type="button" onClick={() => preset('cohort')}>NYISO 전체 · 동일 7건</button><button type="button" onClick={() => preset('demand')}>PJM 실제 부하</button></div>
        <div className="tw-notice"><strong>{metric === 'score' ? '당시 상태에 현재 모형을 적용한 과거 재평가입니다.' : '원문·제공자 API에서 확보한 공개 시점의 값입니다.'}</strong> 자료가 없는 날짜는 채우지 않습니다. 전국 LBNL 원장, NYISO 수용가, 회사별 부분 자료는 각각의 범위로 조회하며 하나의 전국 평균으로 합치지 않습니다.</div>
        {errors.length > 0 && <div className="tw-error" role="alert"><div>{errors.map(error => <p key={error}>{error}</p>)}<small>현재 불러올 수 있거나 이전에 확인한 자료만 표시합니다.</small></div><button className="button compact" onClick={() => setRetry(n => n + 1)}><RefreshCw size={14} />다시 불러오기</button></div>}
        <section className="panel tw-filter-panel" aria-label="통합 시계열 필터">
          <div className="tw-metrics" role="group" aria-label="시계열 지표">{METRICS.map(item => <button type="button" key={item.id} aria-pressed={metric === item.id} className={metric === item.id ? 'selected' : ''} onClick={() => chooseMetric(item.id)}>{item.label}</button>)}</div>
          <div className="tw-filters"><label>권역<select value={region} onChange={event => { setRegion(event.target.value); setSeriesId(''); setCompareId(''); resetPoint(); }}><option value="all">전체 권역에서 선택</option>{[...new Set(all.map(s => s.region))].sort((a, b) => a === '미국 본토' ? -1 : b === '미국 본토' ? 1 : a.localeCompare(b)).map(r => <option key={r} value={r}>{timelineRegionLabel(r)}</option>)}</select></label>
            <label>유형<select value={type} onChange={event => { setType(event.target.value as typeof type); setCompareId(''); resetPoint(); }}><option value="all">전체 유형</option><option value="generation">발전원</option><option value="storage">저장전원</option><option value="load">수용가</option><option value="system">계통 전체 실측</option></select></label>
            <label>자료 종류<select value={origin} onChange={event => { setOrigin(event.target.value as typeof origin); setCompareId(''); resetPoint(); }}><option value="all">모든 자료</option>{Object.entries(ORIGINS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label className="tw-search">출처·계열 검색<span><Search size={15} /><input value={search} onChange={event => { setSearch(event.target.value); resetPoint(); }} placeholder="예: ERCOT, PG&E, 동일 표본" /></span></label>
            <label className="tw-series-select">주 계열<select value={primary?.id ?? ''} onChange={event => { setSeriesId(event.target.value); setCompareId(''); resetPoint(); }} disabled={!candidates.length}>{!candidates.length && <option value="">해당 조건의 자료 없음</option>}{candidates.map(s => <option key={s.id} value={s.id}>{s.name} · {ORIGINS[s.origin]}</option>)}</select></label>
            <label className="tw-series-select">함께 볼 계열<select value={compare?.id ?? ''} onChange={event => { setCompareId(event.target.value); resetPoint(); }} disabled={!compareOptions.length}><option value="">비교하지 않음</option>{compareOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>시작일<input type="date" aria-label="통합 시계열 시작일" value={start} max={end || undefined} onChange={event => { setStart(event.target.value); resetPoint(); }} /></label><label>종료일<input type="date" aria-label="통합 시계열 종료일" value={end} min={start || undefined} onChange={event => { setEnd(event.target.value); resetPoint(); }} /></label><button className="button compact tw-period-reset" onClick={() => { setStart(''); setEnd(''); resetPoint(); }}><CalendarDays size={14} />전체 기간</button>
          </div><p className="tw-filter-note">동일 지표·단위의 계열을 나란히 표시합니다. 점수는 건수 가중과 MW 가중을 구분합니다. 실측 날짜는 KST, 일 피크 날짜는 시장 현지일입니다.</p>
          {invalidRange && <p className="tw-range-error" role="alert">시작일을 종료일 이전으로 설정해 주세요.</p>}
        </section>
        {loading && !all.length ? <div className="tw-empty" role="status"><RefreshCw size={24} className="spin" /><strong>과거 자료와 부하 관측을 불러오는 중…</strong></div> : !primary ? <div className="panel tw-empty"><History size={28} /><h3>이 조건에 해당하는 계열이 없습니다</h3><p>유형이나 출처 조건을 바꾸면 다른 확보 자료를 확인할 수 있습니다.</p><button className="button compact" onClick={() => { setType('all'); setOrigin('all'); setRegion('all'); setSearch(''); }}>필터 초기화</button></div> : <>
          <section className="panel tw-chart-panel"><div className="tw-panel-heading"><div><span className="eyebrow">{timelineRegionLabel(primary.region)} · {METRICS.find(m => m.id === metric)?.label}</span><h3>{compare ? '서로 다른 집단의 흐름 비교' : primary.name}</h3></div><span className="tw-pill">{nf(tableRows.length, 0)}개 공개 시점 · {unit(primary)}</span></div>
            <div className="tw-series-cards">{plottedSeries.map((s, index) => { const last = s.points.at(-1); return <article key={s.id} className={index ? 'comparison' : ''}><span><i />{s.name}</span><strong>{last ? valueText(s, last) : '선택 기간 자료 없음'}</strong><small>{last ? `${pointDate(last)} · ${BASIS[last.dateBasis]}` : '기간을 넓혀 확인하세요'}</small><p>{scoreBasis(s)}{last?.complete === false ? ' · 일부 구간 잠정 피크' : ''}</p></article>; })}</div>
            <TimelineChart series={plottedSeries} selection={selectedPoint && selectedSeries ? { seriesId: selectedSeries.id, pointId: selectedPoint.id } : null} onSelect={setSelection} />
            <p className="tw-chart-caption">점·메뉴·표에서 시점을 선택하면 근거를 확인할 수 있습니다. 선은 공개 값 사이의 연결이며, 중간 날짜의 값을 추정하지 않습니다. 누락 구간과 집계 기준 변경은 연결하지 않습니다.</p>
            <div className="tw-scope-grid">{plottedSeries.map((s, index) => <div key={s.id}><span className={index ? 'comparison' : ''}>{index ? '비교 계열' : '주 계열'} · {s.measure}</span><p>{s.scope}</p><small>{s.comparability}</small></div>)}</div>
            {selectedSeries && selectedPoint && <PointDetail series={selectedSeries} point={selectedPoint} onSelect={pointId => setSelection({ seriesId: selectedSeries.id, pointId })} />}
          </section>
          <section className="panel tw-values"><div className="tw-panel-heading"><div><span className="eyebrow">VALUES & SOURCES</span><h3>시점별 값과 근거</h3></div><button className="button compact" disabled={!tableRows.length} onClick={download}><ArrowDownToLine size={15} />CSV 내려받기</button></div><div className="table-scroll"><table><thead><tr><th>시점</th>{compare && <th>계열</th>}<th>공개 값</th><th>{metric === 'score' ? '점수 분모 / 미산출' : metric === 'peak' ? '관측 구간 / 예상 구간' : '공개 대상·분모'}</th><th>날짜·완전성</th><th>출처</th></tr></thead><tbody>{tableRows.slice(effectivePage * 20, effectivePage * 20 + 20).map(({ series, point }) => <tr key={`${series.id}:${point.id}`} className={selectedSeries?.id === series.id && selectedPoint?.id === point.id ? 'selected' : ''}><td><button className="text-button" onClick={() => setSelection({ seriesId: series.id, pointId: point.id })}>{pointDate(point)}</button></td>{compare && <td className="tw-table-series">{series.name}</td>}<td><strong>{valueText(series, point)}</strong></td><td>{denominatorText(point.denominator, point.denominatorUnit)}{metric === 'score' && <small>미산출 {denominatorText(point.unknown, point.denominatorUnit)}</small>}{metric === 'peak' && <small>예상 {denominatorText(point.population, point.denominatorUnit)}</small>}</td><td>{BASIS[point.dateBasis]}{point.breakBefore && <small>집계 기준 변경</small>}{point.complete === false && <small>일부 구간·잠정</small>}</td><td><a href={url(point.source.url)} target="_blank" rel="noreferrer">{point.source.name}<ExternalLink size={12} /></a></td></tr>)}</tbody></table>{!tableRows.length && <div className="tw-empty"><p>선택 기간의 공개 시점이 없습니다. 값은 0으로 채우지 않습니다.</p></div>}</div><div className="tw-pagination"><span>{nf(tableRows.length, 0)}개 중 {tableRows.length ? effectivePage * 20 + 1 : 0}–{Math.min(tableRows.length, (effectivePage + 1) * 20)}개 · CSV는 선택한 전체 기간</span><div><button className="button compact" aria-label="시계열 표 이전 페이지" disabled={effectivePage === 0} onClick={() => setTablePage(effectivePage - 1)}><ChevronLeft size={16} /></button><span>{effectivePage + 1} / {Math.max(1, Math.ceil(tableRows.length / 20))}</span><button className="button compact" aria-label="시계열 표 다음 페이지" disabled={(effectivePage + 1) * 20 >= tableRows.length} onClick={() => setTablePage(effectivePage + 1)}><ChevronRight size={16} /></button></div></div></section>
        </>}
        <footer className="tw-footnote"><Activity size={16} /><p>미래 연도 부하 전망은 이 관측 차트에 섞지 않습니다. 연·월·분기 자료의 축 날짜는 해당 기간의 시작 앵커이며 정확한 사업 진행일이 아닙니다. 실측 부하는 확보한 최근 기간만 있고, 장기간 자료를 새로 만들어 채우지 않습니다.</p></footer>
      </>}
    </div>
  </div>;
}

function TimelineChart({ series, selection, onSelect }: { series: TimelineSeries[]; selection: Selection | null; onSelect: (value: Selection) => void }) {
  const title = useId();
  const points = series.flatMap(s => s.points);
  const known = series.flatMap(s => s.points.flatMap(p => p.value === null ? [] : [plotted(s, p.value)]));
  if (!points.length) return <div className="tw-empty"><CalendarDays size={28} /><strong>이 기간에 공개된 시점이 없습니다.</strong></div>;
  const minimum = Math.min(...points.map(p => p.timestamp)); const maximum = Math.max(...points.map(p => p.timestamp));
  const upper = series[0].unit === 'score' ? 100 : Math.max(1, ...known) * 1.08;
  const px = (p: TimelinePoint) => minimum === maximum ? 492 : 78 + (p.timestamp - minimum) / (maximum - minimum) * 836;
  const py = (s: TimelineSeries, p: TimelinePoint) => 258 - plotted(s, p.value!) / upper * 210;
  const ticks = minimum === maximum ? [minimum] : Array.from({ length: 5 }, (_, i) => minimum + (maximum - minimum) * i / 4);
  const tickLabel = (at: number) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', ...(series[0].metric === 'demand' ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric', month: '2-digit', ...(maximum - minimum < 90 * 86_400_000 ? { day: '2-digit' as const } : {}) }) }).format(new Date(at));
  return <div className="tw-chart"><svg viewBox="0 0 980 320" role="group" aria-labelledby={title}><title id={title}>공개된 시점별 값. 같은 값과 출처는 아래 메뉴와 표에서도 확인할 수 있습니다.</title>{[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="78" x2="914" y1={258 - i * 52.5} y2={258 - i * 52.5} stroke="#dce7e2" strokeDasharray="4 5" /><text x="64" y={263 - i * 52.5} textAnchor="end">{nf(upper * i / 4, 1)}</text></g>)}<text x="64" y="24" textAnchor="end">{unit(series[0])}</text>{series.map((s, si) => {
    let path = ''; s.points.forEach((p, i) => { if (p.value !== null) path += `${timelineCanJoin(s, s.points[i - 1], p) ? 'L' : 'M'}${px(p)},${py(s, p)} `; });
    const many = s.points.length > 100; const stride = Math.max(1, Math.ceil(s.points.length / 30));
    return <g key={s.id}><path d={path} fill="none" stroke={si ? '#ae8050' : '#1f8276'} strokeWidth="2.5" />{s.points.map((p, i) => {
      const selected = selection?.seriesId === s.id && selection.pointId === p.id;
      if (p.value === null || (many && !selected && i % stride !== 0 && i !== s.points.length - 1)) return null;
      return <g key={p.id} className={`tw-chart-point ${selected ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`${s.name}, ${pointDate(p)}, ${valueText(s, p)}`} aria-pressed={selected} onClick={() => onSelect({ seriesId: s.id, pointId: p.id })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ seriesId: s.id, pointId: p.id }); } }}><title>{pointDate(p)} · {valueText(s, p)}{p.complete === false ? ' · 잠정' : ''}</title><circle cx={px(p)} cy={py(s, p)} r="15" fill="transparent" /><circle className="tw-dot-halo" cx={px(p)} cy={py(s, p)} r="10" fill={si ? '#f2e6d4' : '#d9eee7'} /><circle cx={px(p)} cy={py(s, p)} r={many ? 3 : 4.5} fill={p.qualifier !== 'exact' || p.complete === false ? '#fff' : si ? '#ae8050' : '#1f8276'} stroke={si ? '#ae8050' : '#1f8276'} strokeWidth="2" /></g>;
    })}</g>;
  })}{ticks.map((at, i) => <text key={i} x={minimum === maximum ? 492 : 78 + (at - minimum) / (maximum - minimum) * 836} y="296" textAnchor="middle">{tickLabel(at)}</text>)}</svg>{known.length === 0 && <p className="tw-chart-no-values">공개된 시점은 있으나 산출 가능한 값이 없습니다.</p>}</div>;
}

function PointDetail({ series, point, onSelect }: { series: TimelineSeries; point: TimelinePoint; onSelect: (id: string) => void }) {
  return <section className="tw-detail"><div className="tw-detail-heading"><label>근거를 확인할 시점<select aria-label="통합 시계열 기준 시점" value={point.id} onChange={event => onSelect(event.target.value)}>{[...series.points].reverse().map(p => <option key={p.id} value={p.id}>{pointDate(p)} · {valueText(series, p)}</option>)}</select></label><div aria-live="polite"><span>{series.name}</span><strong>{valueText(series, point)}</strong></div></div><dl><div><dt>날짜의 의미</dt><dd>{BASIS[point.dateBasis]}</dd></div><div><dt>원자료 기준일</dt><dd>{period(point.sourceAsOf)}</dd></div><div><dt>발표일</dt><dd>{period(point.publishedAt)}</dd></div><div><dt>{series.metric === 'score' ? '점수 분모' : series.metric === 'peak' ? '확보 관측 구간' : '공개 대상·분모'}</dt><dd>{denominatorText(point.denominator, point.denominatorUnit)}</dd></div><div><dt>{series.metric === 'peak' ? '예상 관측 구간' : '해당 공개 집단'}</dt><dd>{denominatorText(point.population, point.denominatorUnit)}</dd></div><div><dt>{series.metric === 'peak' ? '미확보 구간' : '미산출·단계 미공개'}</dt><dd>{denominatorText(point.unknown, point.denominatorUnit)}</dd></div>{point.observedAt && <div><dt>{series.metric === 'peak' ? '피크 시각 · KST' : '관측·취득 시각 · KST'}</dt><dd>{stamp(point.observedAt)}</dd></div>}{point.archiveCapturedAt && <div><dt>보관본 포착 · KST</dt><dd>{stamp(point.archiveCapturedAt)}</dd></div>}<div><dt>원문 취득 · KST</dt><dd>{stamp(point.source.retrievedAt)}</dd></div>{point.modelVersion && <div><dt>재평가 모형</dt><dd>{point.modelVersion}</dd></div>}{point.complete !== null && <div><dt>일 피크 완전성</dt><dd>{point.complete ? '전체 구간 확보' : '일부 구간 · 잠정'}</dd></div>}</dl>{point.breakBefore && <p className="tw-detail-warning">앞선 시점과 집계 기준이 달라 차트 선을 연결하지 않았습니다.</p>}<a className="tw-source" href={url(point.source.url)} target="_blank" rel="noreferrer">{point.source.name}<ExternalLink size={14} /></a>{point.source.originalUrl && <a className="tw-source" style={{ marginLeft: 14 }} href={url(point.source.originalUrl)} target="_blank" rel="noreferrer">제공자가 연결한 원보고서<ExternalLink size={14} /></a>}<details><summary>산정 범위·주석{point.source.sha256 ? '·원문 검증값' : ''}</summary><ul>{point.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>{point.source.sha256 && <p>SHA-256 <code>{point.source.sha256}</code></p>}</details></section>;
}
