import { useEffect, useId, useMemo, useState } from 'react';
import { Activity, ArrowRight, ArrowUpRight, BatteryCharging, BookOpen, CircleHelp, Database, Factory, History, Layers3, RefreshCw, Sun } from 'lucide-react';
import type { DashboardResponse, HistoryPoint, ProjectType } from '../shared/types';
import { isHistoricalDataset, type HistoricalDataset, type HistoricalPoint, type HistoricalSeries } from '../shared/history';
import { MARKET_REGIONS, type DemandDataset, type LoadPipelineDataset, type MarketRegion, type RegionDemand } from '../shared/market-types';
import { isDemandDataset, type MarketComparison } from '../shared/market';
import { resolveRegionalPipelines, type ResolvedRegionalPipeline } from '../shared/regional-pipeline';
import { externalUrl, formatGw, marketDate, marketNumber, qualifiedGw } from './market-format';
import './national-overview.css';

interface Props {
  data: DashboardResponse;
  revision: number;
  onProjects: (region?: string, type?: ProjectType) => void;
  onScores: () => void;
  onTimeline: () => void;
}
const score = (value: number | null | undefined) => value == null ? '미산출' : value.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortStamp = (value: string | null | undefined) => !value ? '관측 미확보' : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const coverageLabel: Record<ResolvedRegionalPipeline['coverage'], string> = { operator_requests: '운영기관 요청', regional_aggregate: '기관 권역 집계', partial_pipeline: '일부 사업자·사업', register_only: '공개 원장', unavailable: '자료 미확보' };
function observationStatus(row: RegionDemand | undefined, now: number) {
  if (!row?.observedAt || row.latestMw === null) return '미확보';
  const elapsed = now - Date.parse(row.observedAt);
  return row.status !== 'available' || elapsed > ((row.intervalMinutes ?? 60) <= 5 ? 2 : 4) * 3_600_000 ? '과거 관측' : '최근 관측';
}
async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`자료 요청 오류 (${response.status})`);
  return response.json() as Promise<T>;
}

export default function NationalOverview({ data, revision, onProjects, onScores, onTimeline }: Props) {
  const [demand, setDemand] = useState<DemandDataset | null>(null);
  const [comparison, setComparison] = useState<MarketComparison | null>(null);
  const [pipeline, setPipeline] = useState<LoadPipelineDataset | null>(null);
  const [historical, setHistorical] = useState<HistoricalDataset | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [historyMode, setHistoryMode] = useState<'long-term' | 'observations'>('long-term');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setErrors({});
    const report = (key: string, error: Error) => { if (error.name !== 'AbortError') setErrors(previous => ({ ...previous, [key]: error.message })); };
    const refreshDemand = () => readJson<unknown>('/api/demand', controller.signal).then(value => {
      if (!isDemandDataset(value)) throw new Error('부하 자료 형식 확인 필요');
      setDemand(value); setErrors(previous => { const next = { ...previous }; delete next['부하']; return next; });
    }).catch(error => report('부하', error));
    void Promise.allSettled([
      refreshDemand(),
      readJson<MarketComparison>('/api/market-comparison', controller.signal).then(setComparison).catch(error => report('신청 용량', error)),
      readJson<LoadPipelineDataset>('/api/load-pipeline', controller.signal).then(setPipeline).catch(error => report('수용가 집계', error)),
      readJson<unknown>('/api/historical', controller.signal).then(value => {
        if (!isHistoricalDataset(value)) throw new Error('과거 자료 형식 확인 필요');
        setHistorical(value);
      }).catch(error => report('과거 점수', error)),
    ]).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = setInterval(() => { setNow(Date.now()); void refreshDemand(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [revision, retry]);
  const regional = useMemo(() => pipeline ? resolveRegionalPipelines(pipeline) : [], [pipeline]);
  const series = historical?.series.find(item => item.id === 'lbnl-all-all-bottleneck-score');
  const { summary } = data;
  const fraction = summary.eligibleCount ? Math.min(100, summary.ratedCount / summary.eligibleCount * 100) : 0;
  const lbnl = data.sources.find(source => source.id === 'lbnl-generation-storage-queues');
  const nyiso = data.sources.find(source => source.id === 'nyiso-load-register');
  const availableRegions = demand?.regions.filter(row => row.latestMw !== null && row.observedAt).length ?? 0;
  const currentRegions = demand?.regions.filter(row => observationStatus(row, now) === '최근 관측').length ?? 0;
  return <div className="national-overview">
    <div className="no-context"><span><i />미국 본토 · 공개 접속 자료</span><span>원장 관측 {marketDate(data.snapshot?.capturedAt)} KST</span></div>
    <section className="no-kpis" aria-label="전국 핵심 지표">
      <article className="no-kpi no-kpi-score">
        <div className="no-kpi-label"><Activity size={17} /><span>평균 병목점수</span><button type="button" onClick={onScores} aria-label="병목점수 계산과 평가 범위 보기"><ArrowUpRight size={17} /></button></div>
        <div className="no-kpi-value">{score(summary.ratingMean)}{summary.ratingMean !== null && <small>/ 100</small>}</div>
        <p>평가 가능한 공개 신청의 동일 가중 평균</p>
        <div className="no-score-meter" aria-hidden="true"><span style={{ width: `${summary.ratingMean ?? 0}%` }} /></div>
        <div className="no-kpi-foot"><span>평가 {marketNumber(summary.ratedCount)}건</span><span>미산출 {marketNumber(summary.ratingUnknownCount)}건</span></div>
      </article>
      <CapacityCard icon="generation" title="발전 접속 신청" value={summary.knownCapacityCounts.generation ? summary.generationMw : null} count={summary.typeCounts.generation} date={lbnl?.sourceAsOf} onClick={() => onProjects(undefined, 'generation')} />
      <CapacityCard icon="storage" title="저장 접속 신청" value={summary.knownCapacityCounts.storage ? summary.storageMw : null} count={summary.typeCounts.storage} date={lbnl?.sourceAsOf} onClick={() => onProjects(undefined, 'storage')} />
      <article className="no-kpi no-kpi-load"><div className="no-kpi-label"><Factory size={17} /><span>수용가 접속 요청</span></div><div className="no-load-unavailable">전국 합계 미확보</div><p>권역 기관 집계와 유틸리티별<br />요청·계약·계획을 구분해 확인합니다.</p><button className="no-card-link" type="button" onClick={() => document.getElementById('national-regional-comparison')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}>7개 권역 공개 규모 <ArrowRight size={15} /></button></article>
    </section>
    <p className="no-kpi-caption">공개 원장 범위의 지표입니다. 복합 발전·저장 신청은 유형별로 겹치며, 용량은 실제 소비·공급 전망이 아닙니다.</p>

    <div className="no-insight-grid">
      <section className="no-panel no-history-panel" aria-labelledby="national-history-heading">
        <div className="no-panel-heading"><div><span className="no-eyebrow">HISTORICAL VIEW</span><h2 id="national-history-heading">병목점수의 변화</h2></div><button className="no-text-link" type="button" onClick={onTimeline}>시계열 전체 <ArrowUpRight size={15} /></button></div>
        <div className="no-history-modes" role="group" aria-label="전국 평균 점수 시계열 범위"><button type="button" aria-pressed={historyMode === 'long-term'} onClick={() => setHistoryMode('long-term')}>발전·저장 장기</button><button type="button" aria-pressed={historyMode === 'observations'} onClick={() => setHistoryMode('observations')}>전체 평균 관측</button></div>
        <p className="no-panel-subtitle">{historyMode === 'long-term' ? 'LBNL 연말 공개 원장 · 당시 단계에 동일한 추정 모형 적용' : '발전·저장·수용가 전체 · 실제 저장한 원장의 평가 가능 평균'}</p>
        {historyMode === 'observations' ? <AppObservationMini history={data.history} truncated={data.historyTruncated} /> : series ? <MiniHistory series={series} /> : <div className="no-chart-empty" role="status"><History size={24} /><span>{loading ? '과거 연말 자료를 불러오는 중…' : '과거 점수 자료를 불러오지 못했습니다.'}</span></div>}
        <p className="no-chart-note">{historyMode === 'long-term' ? '연도마다 신청 구성·단계 공개율이 달라집니다. 위의 발전·저장·수용가 평균과는 별도 계열입니다.' : '실제 관측한 시점만 표시합니다. 첫 관측 이전의 전체 평균을 과거 발전·저장 점수로 채우지 않습니다.'}</p>
      </section>
      <section className="no-panel no-coverage-panel" aria-labelledby="national-coverage-heading">
        <div className="no-panel-heading"><div><span className="no-eyebrow">ASSESSMENT SCOPE</span><h2 id="national-coverage-heading">평가한 범위</h2></div><Layers3 size={19} /></div>
        <div className="no-coverage-number"><strong>{marketNumber(summary.ratedCount)}</strong><span>/ {marketNumber(summary.eligibleCount)}건</span><b>{marketNumber(fraction)}%</b></div>
        <div className="no-coverage-track" role="img" aria-label={`공개 활성 신청 ${marketNumber(summary.eligibleCount)}건 중 ${marketNumber(summary.ratedCount)}건 평가, ${marketNumber(summary.ratingUnknownCount)}건 미산출`}><span style={{ width: `${fraction}%` }} /></div>
        <div className="no-coverage-key"><span><i />평가 가능</span><span><i />진행 근거 미확인</span></div>
        <div className="no-type-scores">{(['generation', 'storage', 'load'] as const).map(type => <div key={type}><span>{type === 'generation' ? '발전' : type === 'storage' ? '저장' : '수용가 원장'}<small>{marketNumber(summary.ratingTypeCounts[type])}건 평가{type === 'load' ? ' · 확보 범위' : ''}</small></span><strong>{score(summary.ratingTypeMeans[type])}<small>{summary.ratingTypeMeans[type] !== null ? '점' : ''}</small></strong></div>)}</div>
        <p className="no-coverage-note">원장·자료 종합 추정 포함 {marketNumber(summary.ratingEstimatedCount)}건 · 미확인은 100점으로 대체하지 않습니다. 평가 비율은 확보한 원장 내부 기준입니다.</p>
        <button className="no-text-link" type="button" onClick={onScores}>점수 산출 범위 살펴보기 <ArrowRight size={14} /></button>
      </section>
    </div>

    <section className="no-panel no-regional-panel" id="national-regional-comparison" aria-labelledby="national-regional-heading">
      <div className="no-panel-heading"><div><span className="no-eyebrow">REGIONAL COMPARISON</span><h2 id="national-regional-heading">권역별 부하와 접속 신청</h2></div><span className="no-unit-tag">용량 GW</span></div>
      <div className="no-regional-intro"><p>실제 계통 부하와 앞으로 연결하려는 규모를 같은 표에서 확인하세요.</p><span><i className={currentRegions ? '' : 'is-old'} />관측 확보 {availableRegions} / 7 · 최근 관측 {currentRegions}개 권역</span></div>
      {Object.keys(errors).length > 0 && <div className="no-error" role="status"><span>{Object.keys(errors).join('·')} 자료를 다시 확인해 주세요. 표시된 이전 값의 기준일은 유지됩니다.</span><button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />다시 불러오기</button></div>}
      <div className="no-table-scroll" tabIndex={0} role="region" aria-label="권역별 부하와 신청 비교 표, 작은 화면에서는 가로로 이동"><table className="no-regional-table"><thead><tr><th scope="col">권역</th><th scope="col">최근 부하<small>관측 시각 KST</small></th><th scope="col">일 피크<small>최근 확보 현지일</small></th><th scope="col">발전 신청<small>명판 용량</small></th><th scope="col">저장 신청<small>출력 용량</small></th><th scope="col">수용가 요청·파이프라인<small>표시된 출처 범위 기준</small></th></tr></thead><tbody>{MARKET_REGIONS.map(region => <RegionalRow key={region} region={region} demand={demand?.regions.find(row => row.region === region)} comparison={comparison?.regions.find(row => row.region === region)} pipeline={regional.find(row => row.region === region)} now={now} loading={loading} onProjects={onProjects} />)}</tbody></table></div>
      <div className="no-regional-footnote"><CircleHelp size={15} /><p>일 피크는 가장 최근 확보일 기준이며, 일부 구간은 ‘잠정’으로 표시합니다. 이전 하루 전체 피크는 범위·출처에서 확인합니다. 신청·계약·문의는 서로 합산하지 않습니다.</p></div>
      <div className="no-regional-actions"><span>부하 게시 자료는 1분마다 다시 확인합니다. {demand ? `최근 수집 시도 ${marketDate(demand.lastAttemptAt)} KST` : ''}</span><button className="no-text-link" type="button" onClick={onTimeline}>통합 시계열 탐색 <ArrowRight size={14} /></button></div>
    </section>

    <details className="no-source-details"><summary><span><BookOpen size={17} />자료의 출처와 기준일</span><span>공개 범위 확인</span></summary><div className="no-source-body"><div><strong>발전·저장 신청</strong><p>LBNL 공개 원장 · 원자료 {marketDate(lbnl?.sourceAsOf, false)}<br />원문 확인 {marketDate(lbnl?.lastCheckedAt)}{lbnl?.lastCheckedAt?.includes('T') ? ' KST' : ''}</p>{lbnl && <a href={externalUrl(lbnl.url)} target="_blank" rel="noreferrer">원장 출처 <ArrowUpRight size={13} /></a>}</div><div><strong>수용가 개별 점수</strong><p>NYISO 원장과 검토된 개별 전력공급 요청·계약<br />NYISO 확인 {marketDate(nyiso?.lastCheckedAt)}</p>{nyiso && <a href={externalUrl(nyiso.url)} target="_blank" rel="noreferrer">원장 출처 <ArrowUpRight size={13} /></a>}</div><div><strong>권역별 집계·부하</strong><p>각 권역 행의 ‘범위·출처’에서 확인합니다. 자료 게시일·신청 기준일·실제 부하 관측일은 서로 다릅니다.</p><button className="no-text-link" type="button" onClick={onScores}><Database size={13} />점수 산출 범위</button></div></div></details>
  </div>;
}

function CapacityCard({ icon, title, value, count, date, onClick }: { icon: 'generation' | 'storage'; title: string; value: number | null; count: number; date?: string | null; onClick: () => void }) {
  const Icon = icon === 'generation' ? Sun : BatteryCharging;
  return <article className={`no-kpi no-kpi-${icon}`}><div className="no-kpi-label"><Icon size={17} /><span>{title}</span></div><div className="no-kpi-value">{formatGw(value)}{value !== null && <small>GW</small>}</div><p>알려진 {icon === 'generation' ? '명판' : '출력'} 용량 · 활성 {marketNumber(count)}건</p><div className="no-capacity-foot"><span>원자료 {marketDate(date, false)}</span><button type="button" onClick={onClick} aria-label={`${title} 원장 보기`}><ArrowUpRight size={17} /></button></div></article>;
}

function MiniHistory({ series }: { series: HistoricalSeries }) {
  const [selectedId, setSelectedId] = useState('');
  const chartId = useId();
  const points = [...series.points].sort((a, b) => a.date.localeCompare(b.date));
  const selected = points.find(point => point.id === selectedId) ?? points.at(-1);
  const width = 700, height = 215, left = 37, right = 25, top = 25, bottom = 24;
  const x = (index: number) => left + index / Math.max(1, points.length - 1) * (width - left - right);
  const y = (value: number) => top + (100 - value) / 100 * (height - top - bottom);
  const paths: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) return;
    const prior = points[index - 1];
    const canJoin = prior?.value !== null && prior !== undefined && !point.breakBefore && Number(point.date.slice(0, 4)) - Number(prior.date.slice(0, 4)) === 1;
    if (!canJoin) paths.push(`M${x(index)} ${y(point.value)}`);
    else paths[paths.length - 1] += ` L${x(index)} ${y(point.value)}`;
  });
  return <div className="no-mini-history">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={chartId}><title id={chartId}>LBNL 발전·저장 연말 평균 병목점수. {points.map(point => `${point.date.slice(0, 4)}년 ${score(point.value)}점`).join(', ')}.</title>{[0, 50, 100].map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="no-chart-grid" /><text x={left - 10} y={y(value) + 4} textAnchor="end">{value}</text></g>)}{paths.map((path, index) => <path key={index} d={path} className="no-chart-line" />)}{points.map((point, index) => point.value === null ? null : <g key={point.id}><circle cx={x(index)} cy={y(point.value)} r={selected?.id === point.id ? 6 : 4} className={selected?.id === point.id ? 'no-chart-point is-selected' : 'no-chart-point'} /><text x={x(index)} y={y(point.value) - 15} textAnchor="middle" className="no-chart-value">{score(point.value)}</text></g>)}</svg>
    <div className="no-year-buttons" role="group" aria-label="과거 점수의 연도별 평가 범위">{points.map(point => <button type="button" key={point.id} aria-pressed={selected?.id === point.id} onClick={() => setSelectedId(point.id)} aria-label={`${point.date.slice(0, 4)}년 점수 ${score(point.value)}, 평가 범위 보기`}>{point.date.slice(0, 4)}</button>)}</div>
    {selected && <HistoricalScope point={selected} />}
  </div>;
}
function HistoricalScope({ point }: { point: HistoricalPoint }) {
  return <div className="no-history-scope" aria-live="polite"><strong>{point.date.slice(0, 4)}년 말 <span>{score(point.value)}점</span></strong><span>평가 {marketNumber(point.ratedCount)} / {marketNumber(point.projectCount)}건 <i>·</i> 미산출 {marketNumber(point.unknownCount)}건</span><a href={externalUrl(point.source.url)} target="_blank" rel="noreferrer" aria-label={`${point.date.slice(0, 4)}년 LBNL 원문 보기`}>원문 <ArrowUpRight size={12} /></a></div>;
}

function AppObservationMini({ history, truncated }: { history: HistoryPoint[]; truncated: boolean }) {
  const [selectedId, setSelectedId] = useState('');
  const chartId = useId();
  const points = [...history].sort((a, b) => a.snapshot.capturedAt.localeCompare(b.snapshot.capturedAt));
  const selected = points.find(point => point.snapshot.id === selectedId) ?? points.at(-1);
  if (!selected) return <div className="no-chart-empty"><History size={24} /><span>저장된 전체 평균 관측이 없습니다.</span></div>;
  const width = 700, height = 215, left = 37, right = 25, top = 25, bottom = 32;
  const first = Date.parse(points[0].snapshot.capturedAt), last = Date.parse(points.at(-1)!.snapshot.capturedAt);
  const x = (point: HistoryPoint) => first === last ? (left + width - right) / 2 : left + (Date.parse(point.snapshot.capturedAt) - first) / (last - first) * (width - left - right);
  const y = (value: number) => top + (100 - value) / 100 * (height - top - bottom);
  return <div className="no-mini-history no-app-observations">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={chartId}><title id={chartId}>전체 평균 실제 관측 {points.length}개. {points.map(point => `${marketDate(point.snapshot.capturedAt)} KST ${score(point.summary.ratingMean)}점`).join(', ')}. 관측 사이의 점수를 보간하지 않습니다.</title>{[0, 50, 100].map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="no-chart-grid" /><text x={left - 10} y={y(value) + 4} textAnchor="end">{value}</text></g>)}{points.map(point => point.summary.ratingMean === null ? null : <g key={point.snapshot.id}><circle cx={x(point)} cy={y(point.summary.ratingMean)} r={selected.snapshot.id === point.snapshot.id ? 6 : 4} className={selected.snapshot.id === point.snapshot.id ? 'no-chart-point is-selected' : 'no-chart-point'} />{selected.snapshot.id === point.snapshot.id && <text x={x(point)} y={y(point.summary.ratingMean) - 15} textAnchor="middle" className="no-chart-value">{score(point.summary.ratingMean)}</text>}</g>)}<text x={left} y={height - 5} textAnchor="start">{shortStamp(points[0].snapshot.capturedAt)}</text>{first !== last && <text x={width - right} y={height - 5} textAnchor="end">{shortStamp(points.at(-1)!.snapshot.capturedAt)}</text>}</svg>
    <label className="no-observation-selector">실제 관측 시점<select aria-label="전체 평균 실제 관측 시점" value={selected.snapshot.id} onChange={event => setSelectedId(event.target.value)}>{points.map(point => <option key={point.snapshot.id} value={point.snapshot.id}>{marketDate(point.snapshot.capturedAt)} KST · {score(point.summary.ratingMean)}점</option>)}</select></label>
    <div className="no-history-scope" aria-live="polite"><strong>전체 평균 <span>{score(selected.summary.ratingMean)}점</span></strong><span>평가 {marketNumber(selected.summary.ratedCount)} / {marketNumber(selected.summary.eligibleCount)}건 <i>·</i> 미산출 {marketNumber(selected.summary.ratingUnknownCount)}건</span></div>
    <p className="no-observation-note">{points.length === 1 ? '실제 저장된 관측 1개 · 한 시점만 표시' : `실제 저장된 관측 ${marketNumber(points.length)}개 · 시각 KST`}{truncated ? ' · 전체 기록 중 조회된 범위' : ''}</p>
  </div>;
}

function RegionalRow({ region, demand, comparison, pipeline, now, loading, onProjects }: { region: MarketRegion; demand?: RegionDemand; comparison?: MarketComparison['regions'][number]; pipeline?: ResolvedRegionalPipeline; now: number; loading: boolean; onProjects: (region?: string) => void }) {
  const peaks = [...(demand?.dailyPeaks ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const peak = peaks[0];
  const completePeak = peaks.find(item => item.complete);
  const status = observationStatus(demand, now);
  const localToday = demand ? new Intl.DateTimeFormat('en-CA', { timeZone: demand.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)) : null;
  const olderPeak = !!(peak && localToday && Date.parse(localToday) - Date.parse(peak.date) > 86_400_000);
  const headline = pipeline?.headline;
  const placeholder = loading ? '불러오는 중' : '미확보';
  return <tr><th scope="row"><button type="button" onClick={() => onProjects(region)} aria-label={`${region} 프로젝트 원장 보기`}>{region}<ArrowUpRight size={12} /></button></th><td><strong className="no-table-number">{demand?.latestMw != null ? formatGw(demand.latestMw) : placeholder}</strong><span className={`no-observation-status ${status === '과거 관측' ? 'is-old' : ''}`}>{status}</span><small>{demand?.observedAt ? `${shortStamp(demand.observedAt)}` : '관측 시각 미확보'}</small>{demand?.intervalMinutes && <small>{demand.intervalMinutes}분 간격</small>}</td><td><strong className="no-table-number">{peak ? formatGw(peak.peakMw) : placeholder}</strong><small>{peak?.date.replaceAll('-', '.') ?? '피크일 미확보'}</small>{peak && <small>{peak.intervalMinutes ?? demand?.intervalMinutes ?? '?'}분 관측값의 최댓값</small>}<span className={`no-peak-completeness ${peak && (!peak.complete || olderPeak) ? 'is-old' : ''}`}>{peak ? peak.complete ? olderPeak ? '과거 일 피크 · 하루 전체' : '하루 전체 확보' : `잠정 · ${peak.observations}/${peak.expectedObservations}구간` : ''}</span></td>{(['generation', 'storage'] as const).map(type => <td key={type}><strong className="no-table-number">{comparison ? formatGw(comparison[`${type}Count`] > 0 ? comparison[`${type}Mw`] : null) : placeholder}</strong><small>{comparison?.[`${type}Count`] ? `${marketNumber(comparison[`${type}Count`])}건 활성 신청` : '신청 원장 미확보'}</small><small>원자료 {comparison?.sourceAsOf.length ? comparison.sourceAsOf.map(date => marketDate(date, false)).join(' · ') : '미공개'}</small></td>)}<td className="no-pipeline-cell"><div className="no-pipeline-value"><strong className="no-table-number">{headline ? qualifiedGw(headline) : placeholder}</strong>{pipeline && <span>{coverageLabel[pipeline.coverage]}</span>}</div><p>{pipeline?.scopeLabel ?? '권역 수용가 공개 범위 확인 중'}</p><small>원자료 {marketDate(headline?.sourceAsOf, false)}</small><details className="no-row-source"><summary>범위·출처</summary><div><p>{pipeline?.explanation ?? '검증된 수용가 집계가 없습니다. 미확보를 0 MW로 바꾸지 않습니다.'}</p>{headline && <><a href={externalUrl(headline.sourceUrl)} target="_blank" rel="noreferrer">{headline.sourceName} <ArrowUpRight size={12} /></a><small>확인 {marketDate(headline.checkedAt)}{headline.checkedAt?.includes('T') ? ' KST' : ''}</small>{headline.caveats.map(note => <p key={note} className="no-source-caveat">{note}</p>)}</>}{!!pipeline?.additional.length && <><strong>별도 내역·참고 지표 · 서로 합산 안 함</strong><dl>{pipeline.additional.map(item => <div key={item.id}><dt><a href={externalUrl(item.sourceUrl)} target="_blank" rel="noreferrer">{item.name}<ArrowUpRight size={11} /></a><small>원자료 {marketDate(item.sourceAsOf, false)}</small></dt><dd>{qualifiedGw(item)}{item.capacityMw !== null ? ' GW' : ''}</dd></div>)}</dl></>}{demand && <a href={externalUrl(demand.sourceUrl)} target="_blank" rel="noreferrer">부하 출처 · {demand.sourceName} <ArrowUpRight size={12} /></a>}{completePeak && completePeak.date !== peak?.date && <><p>별도 최근 하루 전체 피크: {formatGw(completePeak.peakMw)} GW · {completePeak.date.replaceAll('-', '.')} 현지일 · {completePeak.intervalMinutes ?? demand?.intervalMinutes ?? '?'}분 관측값의 최댓값</p><a href={externalUrl(completePeak.sourceUrl ?? demand?.sourceUrl ?? '')} target="_blank" rel="noreferrer">하루 전체 피크 출처 · {completePeak.sourceName ?? demand?.sourceName ?? '미확보'} <ArrowUpRight size={12} /></a></>}{peak && <a href={externalUrl(peak.sourceUrl ?? demand?.sourceUrl ?? '')} target="_blank" rel="noreferrer">표시한 피크 출처 · {peak.sourceName ?? demand?.sourceName ?? '미확보'} <ArrowUpRight size={12} /></a>}{peak && <small>일 피크 시각 {marketDate(peak.peakAt)} KST · {demand?.timezone}</small>}</div></details></td></tr>;
}
