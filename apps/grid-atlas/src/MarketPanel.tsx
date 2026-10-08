import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowUpRight, BatteryCharging, Clock3, Factory, RefreshCw, Sun } from 'lucide-react';
import { MARKET_REGIONS, type DemandDataset, type DemandPoint, type LoadPipelineDataset, type MarketRegion, type RegionDemand } from '../shared/market-types';
import type { MarketComparison, MarketComparisonRow } from '../shared/market';
import { resolveRegionalPipelines, type ResolvedRegionalPipeline } from '../shared/regional-pipeline';
import RegionalPipelinePanel from './RegionalPipelinePanel';
import { CAPACITY_LABELS, capacityQualifier, externalUrl, formatGw, marketDate, marketNumber, qualifiedGw } from './market-format';
export { CAPACITY_LABELS, externalUrl, marketDate, marketNumber, qualifiedCapacity } from './market-format';
import './market.css';

export async function marketFetch<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`자료를 불러오지 못했습니다 (${response.status}).`);
  return await response.json() as T;
}
const localDay = (at: number, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
function freshness(demand: RegionDemand | undefined, now: number) {
  if (!demand?.observedAt || demand.latestMw === null) return { label: '관측 미확보', stale: true, age: '현재 부하를 추정하지 않습니다.' };
  const hours = Math.max(0, (now - Date.parse(demand.observedAt)) / 3_600_000);
  const stale = demand.status !== 'available' || hours > ((demand.intervalMinutes ?? 60) <= 5 ? 2 : 4);
  return { label: stale ? '과거 관측' : '최신 공개 관측', stale, age: hours < 1 ? `${Math.floor(hours * 60)}분 전 관측` : hours < 48 ? `${marketNumber(hours)}시간 전 관측` : `${Math.floor(hours / 24)}일 전 관측` };
}
const capacityValue = (row: MarketComparisonRow | undefined, type: 'generation' | 'storage' | 'load') => row && row[`${type}Count`] > 0 ? row[`${type}Mw`] : null;

export default function MarketPanel({ revision, initialRegion = 'PJM' }: { revision: number; initialRegion?: MarketRegion }) {
  const [dataset, setDataset] = useState<DemandDataset | null>(null);
  const [comparison, setComparison] = useState<MarketComparison | null>(null);
  const [pipeline, setPipeline] = useState<LoadPipelineDataset | null>(null);
  const [error, setError] = useState('');
  const [comparisonError, setComparisonError] = useState('');
  const [pipelineError, setPipelineError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MarketRegion>(initialRegion);
  const [clock, setClock] = useState(Date.now());
  const [peakDate, setPeakDate] = useState('');
  useEffect(() => { setSelected(initialRegion); setPeakDate(''); }, [initialRegion]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setComparisonError(''); setPipelineError('');
    void Promise.all([
      marketFetch<DemandDataset>('/api/demand', controller.signal).then(setDataset).catch(e => { if (e.name !== 'AbortError') setError(e.message); }),
      marketFetch<MarketComparison>('/api/market-comparison', controller.signal).then(setComparison).catch(e => { if (e.name !== 'AbortError') setComparisonError(e.message); }),
      marketFetch<LoadPipelineDataset>('/api/load-pipeline', controller.signal).then(setPipeline).catch(e => { if (e.name !== 'AbortError') setPipelineError(e.message); }),
    ]).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = setInterval(() => {
      marketFetch<DemandDataset>('/api/demand', controller.signal).then(next => { setDataset(next); setError(''); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [revision]);
  const demand = dataset?.regions.find(row => row.region === selected);
  const queue = comparison?.regions.find(row => row.region === selected);
  const regionalPipelines = useMemo(() => pipeline ? resolveRegionalPipelines(pipeline) : [], [pipeline]);
  const resolvedLoad = regionalPipelines.find(row => row.region === selected);
  const peaks = [...(demand?.dailyPeaks ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const peak = peaks.find(row => row.date === peakDate) ?? peaks.find(row => row.complete) ?? peaks[0];
  const age = freshness(demand, clock);
  const available = dataset?.regions.filter(row => row.latestMw !== null).length ?? 0;
  const choose = (region: MarketRegion) => { setSelected(region); setPeakDate(''); };
  if (loading && !dataset && !comparison) return <div className="market-loading" role="status"><RefreshCw size={20} className="spin" /> 계통 부하와 신청 원장을 불러오는 중…</div>;
  return <div className="market-view">
    <section className="market-intro"><div className="market-intro-icon"><Activity size={25} /></div><div><span className="eyebrow">DEMAND & PUBLISHED PIPELINES</span><h2>실제 부하와 공개 파이프라인을 한눈에</h2><p>7개 ISO·RTO의 공개 부하와 발전·저장 신청, 수용가 요청·계약·계획 지표를 권역별로 비교합니다.</p></div><span className="market-count"><strong>{available}<small>/ 7</small></strong>권역 관측 확보</span></section>
    <div className="market-notice"><Clock3 size={17} /><div><strong>관측 주기와 게시 지연을 확인하세요.</strong><p>5분 관측과 시간 단위 자료를 출처별로 구분합니다. 시간 단위 자료는 분 단위 실시간 값이 아닙니다. ‘최신’은 확보된 자료의 마지막 관측이며, 오래된 값에는 경과 시간을 표시합니다. 일 피크의 날짜는 각 시장 현지일, 시각 표시는 KST입니다.</p>{dataset && <small>자료 생성 {marketDate(dataset.generatedAt)} KST · 최근 수집 시도 {marketDate(dataset.lastAttemptAt)} KST · 수집 목표 {dataset.refreshMinutes}분 · 화면은 게시 자료를 1분마다 재조회</small>}</div></div>
    {error && <div className="market-error" role="alert">부하 자료: {error}</div>}
    {comparisonError && <div className="market-error" role="alert">신청 원장 비교: {comparisonError}</div>}
    {pipelineError && <div className="market-error" role="alert">수용가 공개 집계: {pipelineError}</div>}
    <RegionalPipelinePanel pipeline={pipeline} comparison={comparison} demand={dataset} selectedRegion={selected} onChoose={choose} />
    <div className="market-regions" role="group" aria-label="부하 비교 권역">
      {MARKET_REGIONS.map(region => {
        const row = dataset?.regions.find(item => item.region === region);
        const status = freshness(row, clock);
        const todayPeak = row?.dailyPeaks.find(item => item.date === localDay(clock, row.timezone));
        return <button key={region} className={`market-region ${selected === region ? 'selected' : ''}`} aria-pressed={selected === region} onClick={() => choose(region)}><span className="market-region-name">{region}<i className={status.stale ? 'is-stale' : ''} /></span><strong>{marketNumber(row?.latestMw)}{row?.latestMw !== null && row?.latestMw !== undefined && <small>MW</small>}</strong><span className="market-region-age">{status.age}</span><span className="market-region-peak">현지 오늘 피크 <b>{todayPeak ? marketNumber(todayPeak.peakMw) : '미확보'}</b>{todayPeak ? ' MW · 잠정' : ''}</span></button>;
      })}
    </div>
    <div className="market-detail-grid">
      <section className="panel demand-chart-panel"><div className="panel-heading"><div><span className="eyebrow">OBSERVED SYSTEM DEMAND</span><h2>{selected} 공개 부하 추이</h2></div><span className={`market-badge ${age.stale ? 'warning' : ''}`}>{age.label}</span></div><div className="demand-lead"><strong>{marketNumber(demand?.latestMw)}<small>{demand?.latestMw !== null && demand?.latestMw !== undefined ? 'MW' : ''}</small></strong><span>{demand?.observedAt ? `${marketDate(demand.observedAt)} KST` : '관측 시각 미확보'}<small>{demand?.intervalMinutes ? `${demand.intervalMinutes}분 관측 간격` : '관측 주기 미확인'} · {age.age}</small></span></div><DemandChart points={demand?.series ?? []} intervalMinutes={demand?.intervalMinutes ?? null} /><div className="market-source"><a href={externalUrl(demand?.sourceUrl ?? '')} target="_blank" rel="noreferrer">{demand?.sourceName || '출처 미확보'} <ArrowUpRight size={13} /></a><span>취득 {marketDate(demand?.retrievedAt)}{demand?.retrievedAt ? ' KST' : ''}</span></div>{!!demand?.warnings.length && <ul className="market-warning-list">{demand.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}</section>
      <section className="panel queue-comparison"><div className="panel-heading"><div><span className="eyebrow">SCALE COMPARISON</span><h2>{selected} 부하·파이프라인 규모</h2></div></div><label className="market-peak-selector">비교할 현지일 피크<select aria-label="비교할 현지일 피크" value={peak?.date ?? ''} onChange={e => setPeakDate(e.target.value)} disabled={!peaks.length}>{!peaks.length && <option value="">피크 미확보</option>}{peaks.map(item => <option key={item.date} value={item.date}>{item.date} · {item.complete ? '전체 구간 확보' : '일부 구간·잠정'}</option>)}</select></label><CapacityBars peakMw={peak?.peakMw ?? null} queue={queue} resolvedLoad={resolvedLoad} /><p className="market-caveat">발전 명판·저장 출력·수용가 파이프라인은 서로 다른 지표입니다. 부분 사업자·계획·계약 자료에는 권역 전체 피크 대비 배수를 산출하지 않습니다. 부등호가 있는 막대는 공시된 경계값을 표시하며 실제 소비·공급 전망이 아닙니다.</p>{queue && <div className="market-queue-meta"><span>용량 전체·일부 미공개 <strong>{marketNumber(queue.capacityUnknownCount)}건</strong></span><span>공개된 원자료 기준일 <strong>{queue.sourceAsOf.length ? queue.sourceAsOf.map(value => marketDate(value)).join(', ') : '미공개'}</strong></span>{selected === 'NYISO' && <span>NYISO 수용가 원장 기준일 <strong>미공개 · 위 날짜와 별도</strong></span>}</div>}</section>
    </div>
    <section className="panel daily-peaks-panel"><div className="panel-heading"><div><span className="eyebrow">DAILY PEAK OBSERVATIONS</span><h2>{selected} 일별 피크</h2></div><span className="market-timezone">시장 현지일 · {demand?.timezone ?? '시간대 미확보'}</span></div><div className="market-table-scroll"><table className="market-table"><thead><tr><th>시장 현지일</th><th>피크 부하</th><th>피크 시각 (KST)</th><th>관측 구간·출처</th><th>완전성</th></tr></thead><tbody>{peaks.length ? peaks.map(item => <tr key={item.date}><td>{marketDate(item.date)}</td><td><strong>{marketNumber(item.peakMw)}</strong> MW</td><td>{marketDate(item.peakAt)}</td><td>{item.observations} / {item.expectedObservations}<small>{item.intervalMinutes ?? demand?.intervalMinutes ?? "?"}분 간격 · <a href={externalUrl(item.sourceUrl ?? demand?.sourceUrl ?? "")} target="_blank" rel="noreferrer">{item.sourceName ?? demand?.sourceName ?? "출처 미확보"}</a></small></td><td><span className={`market-badge ${item.complete ? '' : 'warning'}`}>{item.complete ? '하루 전체 확보' : '잠정 · 일부 구간'}</span></td></tr>) : <tr><td colSpan={5} className="market-empty">일 피크 자료가 없습니다. 이전 값을 오늘의 값으로 대체하지 않습니다.</td></tr>}</tbody></table></div><p className="market-caveat">현지 자정부터 다음 자정까지 관측한 최댓값입니다. 일부 구간만 확보된 날짜의 피크는 하루 확정 피크가 아니며, 일광절약시간 전환일의 구간 수는 달라질 수 있습니다.</p></section>

  </div>;
}

function CapacityBars({ peakMw, queue, resolvedLoad }: { peakMw: number | null; queue?: MarketComparisonRow; resolvedLoad?: ResolvedRegionalPipeline }) {
  const headline = resolvedLoad?.headline;
  const loadMw = headline?.capacityMw ?? null;
  const rows = [
    { key: 'peak', label: '관측 일 피크', mw: peakMw, icon: Activity, count: null },
    { key: 'load', label: '수용가 요청·파이프라인', mw: loadMw, icon: Factory, count: headline?.projectCount ?? null },
    ...(['generation', 'storage'] as const).map(type => ({ key: type, label: type === 'generation' ? '발전 신청 · 명판' : '저장 신청 · 출력', mw: capacityValue(queue, type), icon: type === 'generation' ? Sun : BatteryCharging, count: queue?.[`${type}Count`] ?? null })),
  ];
  const maximum = Math.max(1, ...rows.map(row => row.mw ?? 0));
  const loadRatio = loadMw !== null && peakMw !== null && peakMw > 0 && resolvedLoad?.coverage === 'operator_requests' && headline;
  const ratio = loadRatio ? loadMw / peakMw : null;
  const ratioValue = ratio === null ? '' : ['greater_than', 'at_least'].includes(headline?.capacityQualifier ?? '') ? String(Math.floor(ratio * 100) / 100) : ratio.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return <div className="capacity-bars">{rows.map(row => <div className={`capacity-bar-row ${row.key}`} key={row.key}>
    <div className="capacity-bar-title"><span><row.icon size={14} />{row.label}</span><strong>{row.key === 'load' && headline ? qualifiedGw(headline) : formatGw(row.mw)}{row.mw !== null && <small> GW</small>}</strong></div>
    {row.key === 'load' && <div className="capacity-load-scope"><strong>{resolvedLoad?.scopeLabel ?? '공개 범위 미확보'}</strong><span>{resolvedLoad?.metricLabel ?? '검증된 수용가 지표 미확보'}</span></div>}
    <div className="capacity-bar-track"><span style={{ width: row.mw === null ? 0 : `${Math.max(row.mw > 0 ? 1 : 0, row.mw / maximum * 100)}%` }} /></div>
    <small>{row.key === 'peak' ? '선택한 현지일의 관측 최댓값' : row.key === 'load' ? loadRatio ? `피크 대비 ${capacityQualifier(headline!)}${ratioValue}배 규모 · 관측 기준일은 서로 다름` : row.mw !== null ? '부분 공개 범위 · 권역 전체 피크 대비 배수 산출 제외' : '공개 규모 미확보 · 신청이 없다는 뜻이 아님' : `${row.count ? `${marketNumber(row.count)}개 활성 신청 · ` : ''}${row.mw !== null && peakMw !== null && peakMw > 0 ? `피크의 ${marketNumber(row.mw / peakMw)}배 · 알려진 용량` : '비교 가능한 용량 미확보'}`}</small>
    {row.key === 'load' && headline && <div className="capacity-load-source"><a href={externalUrl(headline.sourceUrl)} target="_blank" rel="noreferrer">{headline.sourceName}<ArrowUpRight size={11} /></a><span>원자료 {marketDate(headline.sourceAsOf, false)} · {CAPACITY_LABELS[headline.capacityBasis]}</span>{resolvedLoad?.coverage !== 'register_only' && !!queue?.loadCount && <span>별도 개별 신청 원장: {marketNumber(queue.loadCount)}건 · {formatGw(queue.loadMw)} GW · 공시 지표와 합산하지 않음</span>}</div>}
  </div>)}</div>;
}

function DemandChart({ points, intervalMinutes }: { points: DemandPoint[]; intervalMinutes: number | null }) {
  const ordered = useMemo(() => [...points].filter(point => Number.isFinite(point.mw) && Number.isFinite(Date.parse(point.observedAt))).sort((a, b) => a.observedAt.localeCompare(b.observedAt)), [points]);
  if (!ordered.length) return <div className="demand-chart-empty"><Activity size={28} /><p>부하 시계열 미확보</p><small>누락 관측을 0으로 그리지 않습니다.</small></div>;
  const width = 620, height = 190, left = 54, right = 16, top = 15, bottom = 38;
  const maxMw = Math.max(...ordered.map(point => point.mw), 1) * 1.08;
  const first = Date.parse(ordered[0].observedAt), last = Date.parse(ordered.at(-1)!.observedAt);
  const x = (at: string) => left + (Date.parse(at) - first) / Math.max(1, last - first) * (width - left - right);
  const y = (mw: number) => top + (1 - mw / maxMw) * (height - top - bottom);
  const paths: string[] = [];
  ordered.forEach((point, i) => {
    const gap = i > 0 && Date.parse(point.observedAt) - Date.parse(ordered[i - 1].observedAt) > (intervalMinutes ?? 60) * 90_000;
    if (i === 0 || gap) paths.push(`M${x(point.observedAt)},${y(point.mw)}`);
    else paths[paths.length - 1] += ` L${x(point.observedAt)},${y(point.mw)}`;
  });
  const stamp = (at: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', hour12: false }).format(new Date(at));
  return <div className="demand-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`공개 부하 ${ordered.length}개 관측, ${marketDate(ordered[0].observedAt)}부터 ${marketDate(ordered.at(-1)!.observedAt)} KST`}><text x={left} y={10} className="chart-unit">MW</text>{[0, .5, 1].map(fraction => { const value = fraction * maxMw; return <g key={fraction}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="demand-grid" /><text x={left - 8} y={y(value) + 4} textAnchor="end">{marketNumber(value)}</text></g>; })}{paths.map((path, i) => <path key={i} d={path} className="demand-line" />)}{ordered.filter((_, i) => i === 0 || i === ordered.length - 1).map((point, i) => <g key={point.observedAt}><circle cx={x(point.observedAt)} cy={y(point.mw)} r={3} className="demand-point" /><text x={x(point.observedAt)} y={height - 10} textAnchor={i === 0 ? 'start' : 'end'}>{stamp(point.observedAt)}</text></g>)}</svg><span>관측 시각 KST · 누락 구간은 선을 연결하지 않음</span></div>;
}
