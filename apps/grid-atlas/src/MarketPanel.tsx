import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowUpRight, BatteryCharging, CircleHelp, Clock3, Factory, RefreshCw, Sun } from 'lucide-react';
import { MARKET_REGIONS, type CapacityBasis, type DemandDataset, type DemandPoint, type LoadPipelineDataset, type MarketRegion, type PipelineAggregate, type RegionDemand } from '../shared/market-types';
import './market.css';

type ComparisonRegion = {
  region: string; generationMw: number | null; storageMw: number | null; loadMw: number | null;
  generationCount: number; storageCount: number; loadCount: number; capacityUnknownCount: number; sourceAsOf: string[];
};
type Comparison = { regions: ComparisonRegion[]; snapshotAsOf: string | null };
const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
export const marketNumber = (value: number | null | undefined) => value === null || value === undefined ? '미확보' : nf.format(value);
export const CAPACITY_LABELS: Record<CapacityBasis, string> = { requested_grid_mw: '계통 접속 요청', contracted_grid_mw: '계통 공급 계약', site_power_mw: '부지 전체 전력', it_mw: 'IT 설비 전력', generation_mw: '발전 용량', mixed_mw: '용량 기준 혼재', unknown: '용량 기준 미확인' };
export const qualifiedCapacity = (row: PipelineAggregate) => `${row.capacityMw === null ? '' : ({ approximate: '약 ', greater_than: '> ', at_least: '≥ ', exact: '' }[row.capacityQualifier ?? 'exact'])}${marketNumber(row.capacityMw)}`;
export const marketDate = (value: string | null | undefined, time = true) => {
  if (!value) return '미공개';
  if (!value.includes('T')) return value.replaceAll('-', '.');
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '미공개' : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(parsed);
};
export const externalUrl = (url: string) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } };
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
const capacityValue = (row: ComparisonRegion | undefined, type: 'generation' | 'storage' | 'load') => row && row[`${type}Count`] > 0 ? row[`${type}Mw`] : null;

export default function MarketPanel({ revision }: { revision: number }) {
  const [dataset, setDataset] = useState<DemandDataset | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [pipeline, setPipeline] = useState<LoadPipelineDataset | null>(null);
  const [error, setError] = useState('');
  const [comparisonError, setComparisonError] = useState('');
  const [pipelineError, setPipelineError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MarketRegion>('PJM');
  const [clock, setClock] = useState(Date.now());
  const [peakDate, setPeakDate] = useState('');
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setComparisonError(''); setPipelineError('');
    void Promise.all([
      marketFetch<DemandDataset>('/api/demand', controller.signal).then(setDataset).catch(e => { if (e.name !== 'AbortError') setError(e.message); }),
      marketFetch<Comparison>('/api/market-comparison', controller.signal).then(setComparison).catch(e => { if (e.name !== 'AbortError') setComparisonError(e.message); }),
      marketFetch<LoadPipelineDataset>('/api/load-pipeline', controller.signal).then(setPipeline).catch(e => { if (e.name !== 'AbortError') setPipelineError(e.message); }),
    ]).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = setInterval(() => {
      marketFetch<DemandDataset>('/api/demand', controller.signal).then(next => { setDataset(next); setError(''); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [revision]);
  const demand = dataset?.regions.find(row => row.region === selected);
  const queue = comparison?.regions.find(row => row.region === selected);
  const peaks = [...(demand?.dailyPeaks ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const peak = peaks.find(row => row.date === peakDate) ?? peaks.find(row => row.complete) ?? peaks[0];
  const age = freshness(demand, clock);
  const available = dataset?.regions.filter(row => row.latestMw !== null).length ?? 0;
  const choose = (region: MarketRegion) => { setSelected(region); setPeakDate(''); };
  if (loading && !dataset && !comparison) return <div className="market-loading" role="status"><RefreshCw size={20} className="spin" /> 계통 부하와 신청 원장을 불러오는 중…</div>;
  return <div className="market-view">
    <section className="market-intro"><div className="market-intro-icon"><Activity size={25} /></div><div><span className="eyebrow">DEMAND & CONNECTION QUEUES</span><h2>실제 부하 옆에, 접속을 기다리는 용량</h2><p>7개 ISO·RTO의 공개 부하 관측과 발전·저장·수용가 신청 규모를 같은 MW 단위로 비교합니다.</p></div><span className="market-count"><strong>{available}<small>/ 7</small></strong>권역 관측 확보</span></section>
    <div className="market-notice"><Clock3 size={17} /><div><strong>관측 주기와 게시 지연을 확인하세요.</strong><p>5분 관측과 시간 단위 자료를 출처별로 구분합니다. 시간 단위 자료는 분 단위 실시간 값이 아닙니다. ‘최신’은 확보된 자료의 마지막 관측이며, 오래된 값에는 경과 시간을 표시합니다. 일 피크의 날짜는 각 시장 현지일, 시각 표시는 KST입니다.</p>{dataset && <small>자료 생성 {marketDate(dataset.generatedAt)} KST · 최근 수집 시도 {marketDate(dataset.lastAttemptAt)} KST · 수집 목표 {dataset.refreshMinutes}분 · 화면은 게시 자료를 1분마다 재조회</small>}</div></div>
    {error && <div className="market-error" role="alert">부하 자료: {error}</div>}
    {comparisonError && <div className="market-error" role="alert">신청 원장 비교: {comparisonError}</div>}
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
      <section className="panel queue-comparison"><div className="panel-heading"><div><span className="eyebrow">SCALE COMPARISON</span><h2>{selected} 피크 대비 신청 용량</h2></div></div><label className="market-peak-selector">비교할 현지일 피크<select aria-label="비교할 현지일 피크" value={peak?.date ?? ''} onChange={e => setPeakDate(e.target.value)} disabled={!peaks.length}>{!peaks.length && <option value="">피크 미확보</option>}{peaks.map(item => <option key={item.date} value={item.date}>{item.date} · {item.complete ? '전체 구간 확보' : '일부 구간·잠정'}</option>)}</select></label><CapacityBars peakMw={peak?.peakMw ?? null} queue={queue} /><p className="market-caveat">배수는 규모 비교입니다. 발전 명판 MW·저장 출력 MW·수용가 요청 MW는 서로 다른 값으로, 합산하거나 실제 소비·공급 전망으로 해석하지 않습니다.</p>{queue && <div className="market-queue-meta"><span>용량 전체·일부 미공개 <strong>{marketNumber(queue.capacityUnknownCount)}건</strong></span><span>공개된 원자료 기준일 <strong>{queue.sourceAsOf.length ? queue.sourceAsOf.map(value => marketDate(value)).join(', ') : '미공개'}</strong></span>{selected === 'NYISO' && <span>NYISO 수용가 원장 기준일 <strong>미공개 · 위 날짜와 별도</strong></span>}</div>}</section>
    </div>
    <AggregateContext region={selected} aggregates={pipeline?.aggregates.filter(row => row.region === selected) ?? []} error={pipelineError} />
    <section className="panel daily-peaks-panel"><div className="panel-heading"><div><span className="eyebrow">DAILY PEAK OBSERVATIONS</span><h2>{selected} 일별 피크</h2></div><span className="market-timezone">시장 현지일 · {demand?.timezone ?? '시간대 미확보'}</span></div><div className="market-table-scroll"><table className="market-table"><thead><tr><th>시장 현지일</th><th>피크 부하</th><th>피크 시각 (KST)</th><th>관측 구간·출처</th><th>완전성</th></tr></thead><tbody>{peaks.length ? peaks.map(item => <tr key={item.date}><td>{marketDate(item.date)}</td><td><strong>{marketNumber(item.peakMw)}</strong> MW</td><td>{marketDate(item.peakAt)}</td><td>{item.observations} / {item.expectedObservations}<small>{item.intervalMinutes ?? demand?.intervalMinutes ?? "?"}분 간격 · <a href={externalUrl(item.sourceUrl ?? demand?.sourceUrl ?? "")} target="_blank" rel="noreferrer">{item.sourceName ?? demand?.sourceName ?? "출처 미확보"}</a></small></td><td><span className={`market-badge ${item.complete ? '' : 'warning'}`}>{item.complete ? '하루 전체 확보' : '잠정 · 일부 구간'}</span></td></tr>) : <tr><td colSpan={5} className="market-empty">일 피크 자료가 없습니다. 이전 값을 오늘의 값으로 대체하지 않습니다.</td></tr>}</tbody></table></div><p className="market-caveat">현지 자정부터 다음 자정까지 관측한 최댓값입니다. 일부 구간만 확보된 날짜의 피크는 하루 확정 피크가 아니며, 일광절약시간 전환일의 구간 수는 달라질 수 있습니다.</p></section>
    <section className="panel market-all-regions"><div className="panel-heading"><div><span className="eyebrow">SEVEN-MARKET COMPARISON</span><h2>권역별 부하와 공개 신청 규모</h2></div><span className="market-timezone">단위 MW · 알려진 용량만</span></div><div className="market-table-scroll"><table className="market-table"><thead><tr><th>ISO / RTO</th><th>최신 관측 부하</th><th>최근 완전한 일 피크</th><th>발전 명판 용량</th><th>저장 출력 용량</th><th>수용가 신청 용량</th></tr></thead><tbody>{MARKET_REGIONS.map(region => {
      const row = dataset?.regions.find(item => item.region === region);
      const capacity = comparison?.regions.find(item => item.region === region);
      const completePeak = [...(row?.dailyPeaks ?? [])].filter(item => item.complete).sort((a, b) => b.date.localeCompare(a.date))[0];
      return <tr key={region}><th><button className="market-region-link" onClick={() => choose(region)}>{region}<ArrowUpRight size={12} /></button></th><td>{marketNumber(row?.latestMw)}<small>{row?.observedAt ? `${marketDate(row.observedAt)} KST` : '관측 미확보'}</small></td><td>{marketNumber(completePeak?.peakMw)}<small>{completePeak ? `${completePeak.date} 현지일` : '완전한 하루 미확보'}</small></td>{(['generation', 'storage', 'load'] as const).map(type => <td key={type}>{marketNumber(capacityValue(capacity, type))}<small>{capacity?.[`${type}Count`] ? `${marketNumber(capacity[`${type}Count`])}개 공개 신청` : '공개 개별 원장 미확보'}</small></td>)}</tr>;
    })}</tbody></table></div><p className="market-caveat"><CircleHelp size={14} /> 신청은 공개 원장의 활성 프로젝트 범위이며 시점과 포괄 범위가 부하 관측과 다릅니다. 미확보는 신청이 없다는 뜻이 아닙니다. 원장 관측 {marketDate(comparison?.snapshotAsOf)}{comparison?.snapshotAsOf?.includes('T') ? ' KST' : ''}.</p></section>
  </div>;
}

function AggregateContext({ region, aggregates, error }: { region: string; aggregates: PipelineAggregate[]; error: string }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [region]);
  return <section className="panel market-aggregate-context"><div className="panel-heading"><div><span className="eyebrow">LARGE LOAD PIPELINE CONTEXT</span><h2>{region} 수용가 공개 파이프라인</h2></div><span className="market-badge">공식 집계 · 참고 범위</span></div><p className="market-section-description">개별 신청 목록을 공개하지 않는 지역도 사업자·지역 집계에는 큰 규모의 수요가 나타납니다. 아래 집계는 위 신청 원장과 별도이며, 전력회사 일부 범위를 ISO·RTO 전체로 해석하거나 중복 합산하지 않습니다.</p>{error && <div className="market-error">집계 자료: {error}</div>}<div className="pipeline-aggregate-grid">{aggregates.length ? aggregates.slice(0, expanded ? aggregates.length : 3).map(row => <article key={row.id} className="pipeline-aggregate"><div className="pipeline-card-top"><span>{row.region}</span><a href={externalUrl(row.sourceUrl)} target="_blank" rel="noreferrer" aria-label={`${row.name} 원문 열기`}><ArrowUpRight size={16} /></a></div><h3>{row.name}</h3><strong className="aggregate-value">{qualifiedCapacity(row)}{row.capacityMw !== null && <small> MW</small>}</strong><span className="aggregate-basis">{CAPACITY_LABELS[row.capacityBasis]}{row.projectCount !== null && ` · ${marketNumber(row.projectCount)}건`}</span><p>{row.scope}</p>{!!row.caveats.length && <ul>{row.caveats.map(caveat => <li key={caveat}>{caveat}</li>)}</ul>}<div className="pipeline-provenance"><a href={externalUrl(row.sourceUrl)} target="_blank" rel="noreferrer">{row.sourceName} <ArrowUpRight size={11} /></a><span>원자료 {marketDate(row.sourceAsOf, false)}</span><span>확인 {marketDate(row.checkedAt)}{row.checkedAt?.includes('T') ? ' KST' : ''}</span></div></article>) : <p className="market-empty">이 권역의 공개 집계 자료를 확보하지 못했습니다. 신청이 없는 것으로 집계하지 않습니다.</p>}</div>{aggregates.length > 3 && <div className="pipeline-more"><span>{aggregates.length}개 집계 · 범위별 중복 가능</span><button className="button" onClick={() => setExpanded(value => !value)}>{expanded ? '간단히 보기' : '이 권역의 집계 모두 보기'}</button></div>}</section>;
}

function CapacityBars({ peakMw, queue }: { peakMw: number | null; queue?: ComparisonRegion }) {
  const rows = [{ key: 'peak', label: '관측 일 피크', mw: peakMw, count: null, icon: Activity }, ...(['generation', 'storage', 'load'] as const).map(type => ({ key: type, label: { generation: '발전 신청 · 명판', storage: '저장 신청 · 출력', load: '수용가 신청 · 요청' }[type], mw: capacityValue(queue, type), count: queue?.[`${type}Count`] ?? null, icon: { generation: Sun, storage: BatteryCharging, load: Factory }[type] }))];
  const maximum = Math.max(1, ...rows.map(row => row.mw ?? 0));
  return <div className="capacity-bars">{rows.map(row => <div className={`capacity-bar-row ${row.key}`} key={row.key}><div className="capacity-bar-title"><span><row.icon size={14} />{row.label}</span><strong>{marketNumber(row.mw)}{row.mw !== null && <small> MW</small>}</strong></div><div className="capacity-bar-track"><span style={{ width: row.mw === null ? 0 : `${Math.max(row.mw > 0 ? 1 : 0, row.mw / maximum * 100)}%` }} /></div><small>{row.key === 'peak' ? '선택한 현지일의 관측 최댓값' : `${row.count ? `${marketNumber(row.count)}개 신청 · ` : ''}${row.mw !== null && peakMw !== null && peakMw > 0 ? `피크의 ${marketNumber(row.mw / peakMw)}배 · 알려진 MW 기준` : '비교 가능한 용량 미확보'}`}</small></div>)}</div>;
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
