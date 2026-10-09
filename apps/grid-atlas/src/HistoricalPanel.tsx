import { useEffect, useId, useState } from 'react';
import { ArrowDownToLine, CalendarDays, CircleHelp, ExternalLink, History, RefreshCw } from 'lucide-react';
import { historicalCsv, isHistoricalDataset, type HistoricalDataset, type HistoricalPoint, type HistoricalSeries } from '../shared/history';
import './history.css';

type Metric = HistoricalSeries['metric'];
const METRICS: { id: Metric; label: string }[] = [
  { id: 'load_requests', label: '대형 수용가 요청·파이프라인' },
  { id: 'load_contracts', label: '수용가 계약 용량' },
  { id: 'bottleneck_score', label: '과거 평균 병목점수' },
  { id: 'queue_capacity', label: '원장별 신청 용량' },
  { id: 'queue_count', label: '원장별 신청 건수' },
];
const formatNumber = (n: number, digits = 2) => n.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const shortDate = (date: string | null) => date ? /^\d{4}-Q[1-4]$/.test(date) ? date.replace(/^(\d{4})-Q([1-4])$/, '$1년 $2분기') : date.split('T')[0].replaceAll('-', '.') : '미공개';
const pointDate = (point: HistoricalPoint) => point.datePrecision === 'quarter' ? `${point.date.slice(0, 4)}년 ${Math.floor((Number(point.date.slice(5, 7)) - 1) / 3) + 1}분기` : shortDate(point.date.slice(0, point.datePrecision === 'year' ? 4 : point.datePrecision === 'month' ? 7 : 10));
const sourceLink = (url: string) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } };
const retrievedDate = (date: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
const unit = (series: HistoricalSeries) => series.unit === 'MW' ? 'GW' : series.unit === 'score' ? '점' : '건';
const plotValue = (series: HistoricalSeries, value: number) => series.unit === 'MW' ? value / 1000 : value;
const qualifier = (point: HistoricalPoint) => point.qualifier === 'approximate' ? '약 ' : point.qualifier === 'greater_than' ? '> ' : point.qualifier === 'at_least' ? '≥ ' : '';
const valueText = (series: HistoricalSeries, point: HistoricalPoint) => point.value === null ? '미산출' : `${qualifier(point)}${formatNumber(plotValue(series, point.value), series.unit === 'projects' ? 0 : 2)} ${unit(series)}`;
const dateBasisLabel = (point: HistoricalPoint) => point.dateBasis === 'archive_capture' ? '보관본 포착일' : point.dateBasis === 'observation' ? '원문 관측일' : point.dateBasis === 'publication' ? '발표 시점' : '원자료 기준일';
const scoreCoverage = (point: HistoricalPoint) => point.ratedCount !== null && point.projectCount !== null && point.projectCount > 0 ? `${formatNumber(point.ratedCount, 0)} / ${formatNumber(point.projectCount, 0)}건 · ${formatNumber(point.ratedCount / point.projectCount * 100, 1)}%` : '산출 비율 미확인';
const axisDate = (point: HistoricalPoint) => point.datePrecision === 'quarter' ? `${point.date.slice(0, 4)} Q${Math.floor((Number(point.date.slice(5, 7)) - 1) / 3) + 1}` : point.datePrecision === 'year' ? point.date.slice(0, 4) : point.date.slice(0, 7).replace('-', '.');
const canJoin = (previous: HistoricalPoint | undefined, point: HistoricalPoint) => {
  if (!previous || point.value === null || previous.value === null || point.breakBefore) return false;
  const month = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  if ((previous.datePrecision === 'month' || point.datePrecision === 'month') && month(point.date) - month(previous.date) > 1) return false;
  if (previous.datePrecision === 'month' && point.datePrecision === 'month') {
    return month(point.date) - month(previous.date) === 1;
  }
  if (previous.datePrecision === 'quarter' && point.datePrecision === 'quarter') {
    const quarter = (date: string) => Number(date.slice(0, 4)) * 4 + Math.floor((Number(date.slice(5, 7)) - 1) / 3);
    return quarter(point.date) - quarter(previous.date) === 1;
  }
  if (previous.datePrecision === 'year' && point.datePrecision === 'year') return Number(point.date.slice(0, 4)) - Number(previous.date.slice(0, 4)) === 1;
  return true;
};

export default function HistoricalPanel({ revision }: { revision: number }) {
  const [dataset, setDataset] = useState<HistoricalDataset | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [metric, setMetric] = useState<Metric>('load_requests');
  const [region, setRegion] = useState('');
  const [seriesId, setSeriesId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [pointId, setPointId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetch('/api/historical', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`과거 자료를 불러오지 못했습니다 (${response.status}).`);
      const result: unknown = await response.json();
      if (!isHistoricalDataset(result)) throw new Error('과거 자료의 형식을 확인하지 못했습니다. 다시 불러와 주세요.');
      setDataset(result);
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, retry]);
  const candidates = dataset?.series.filter(series => series.metric === metric) ?? [];
  const regions = [...new Set(candidates.map(series => series.region))];
  const seriesOptions = candidates.filter(series => !region || series.region === region);
  const series = seriesOptions.find(row => row.id === seriesId) ?? seriesOptions.find(row => metric === 'load_requests' && row.region === 'ERCOT') ?? seriesOptions[0];
  const points = [...(series?.points ?? [])].filter(point => (!start || point.date >= start) && (!end || point.date <= end)).sort((a, b) => a.date.localeCompare(b.date));
  const selected = points.find(point => point.id === pointId) ?? points[points.length - 1];
  const knownPoints = points.filter(point => point.value !== null);
  const latest = knownPoints[knownPoints.length - 1];
  const chooseMetric = (next: Metric) => { setMetric(next); setRegion(''); setSeriesId(''); setPointId(''); };
  const download = () => {
    if (!dataset || !series || !points.length) return;
    const csv = historicalCsv(dataset, { seriesId: series.id, ...(start ? { start } : {}), ...(end ? { end } : {}) });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `grid-atlas-history-${series.id}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (loading && !dataset) return <div className="market-loading" role="status"><RefreshCw size={20} className="spin" />과거 공식 자료를 불러오는 중…</div>;
  if (!dataset) return <div className="empty-state"><History size={32} /><h2>과거 자료를 불러오지 못했습니다</h2><p role="alert">{error || '공개된 자료가 아직 없습니다.'}</p><button className="button primary" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />다시 불러오기</button></div>;
  return <div className="historical-view">
    <section className="historical-intro"><span className="historical-intro-icon"><History size={24} /></span><div><span className="eyebrow">OFFICIAL HISTORICAL RECORDS</span><h2>접속 요청이 쌓여 온 흐름</h2><p>대형 수용가의 공개 요청 규모와 발전·저장 원장의 과거 기록을 출처별로 확인합니다.</p></div><div className="historical-range"><span>확보한 자료 범위</span><strong>{shortDate(dataset.coverageStart)} — {shortDate(dataset.coverageEnd)}</strong><small>출처별 시작일·마지막 기준일은 다릅니다</small></div></section>
    <div className="historical-disclosure"><CircleHelp size={18} /><p><strong>과거 공식 원장·발표 자료에서 확인한 값입니다.</strong> 매월의 연속 관측이나 미국 전체 수용가 총량은 아닙니다. 데이터센터와 다른 대형 부하가 함께 포함될 수 있으며, 미래 연도 전망은 과거 실적으로 표시하지 않습니다.</p></div>
    {error && <div className="market-error" role="alert">{error} 이전에 불러온 자료를 표시합니다.</div>}
    <section className="panel historical-controls" aria-label="과거 자료 선택">
      <label>확인할 지표<select value={metric} onChange={event => chooseMetric(event.target.value as Metric)}>{METRICS.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      <label>권역<select value={region} onChange={event => { setRegion(event.target.value); setSeriesId(''); setPointId(''); }}><option value="">전체 권역에서 선택</option>{regions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="historical-series-select">출처·집계 범위<select value={series?.id ?? ''} onChange={event => { setSeriesId(event.target.value); setPointId(''); }}>{seriesOptions.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>시작일<input type="date" aria-label="과거 자료 시작일" value={start} min={dataset.coverageStart} max={end || dataset.coverageEnd} onChange={event => setStart(event.target.value)} /></label>
      <label>종료일<input type="date" aria-label="과거 자료 종료일" value={end} min={start || dataset.coverageStart} max={dataset.coverageEnd} onChange={event => setEnd(event.target.value)} /></label>
      <button className="button compact" onClick={() => { setStart(''); setEnd(''); setPointId(''); }}><CalendarDays size={14} />전체 기간</button>
    </section>
    {series ? <>
      <section className="panel historical-chart-panel">
        <div className="panel-heading"><div><span className="eyebrow">{series.region} · {series.unit === 'score' ? 'RETROSPECTIVE STAGE ESTIMATE' : 'PUBLISHED OBSERVATIONS'}</span><h2>{series.name}</h2></div><span className="small-pill">{points.length}개 시점 · {unit(series)}</span></div>
        <div className="historical-scope"><p>{series.description}</p><p><strong>집계 범위</strong> {series.scope}</p>{series.unit === 'score' && <p className="historical-score-warning"><strong>연도별 대상·공개율이 달라 동일 사업군의 진행 속도를 뜻하지 않습니다.</strong> 당시 원장에서 단계를 판단할 수 있는 신청만 평균내며, 미산출 건수와 점수 산출 비율을 함께 확인하세요.</p>}</div>
        {latest && <div className="historical-latest"><span>선택 기간 마지막 공개 값<strong>{valueText(series, latest)}</strong>{series.unit === 'score' && <small>점수 산출 {scoreCoverage(latest)}</small>}</span><span>{pointDate(latest)} {dateBasisLabel(latest)}<small>{latest.dateBasis === 'publication' && !latest.sourceAsOf ? '원자료 기준일은 별도 미공개' : `발표일 ${shortDate(latest.publishedAt)}`}</small></span></div>}
        {points.length ? <HistoryChart series={series} points={points} selectedId={selected?.id} onSelect={setPointId} /> : <div className="historical-empty"><CalendarDays size={25} /><strong>선택 기간에 공개된 값이 없습니다.</strong><p>기간을 넓혀 과거 자료를 확인하세요.</p></div>}
        <div className="historical-chart-caption"><span><i />공개된 시점의 값 · 점을 선택하면 근거 확인</span><span>선은 공개 값의 연결입니다. 중간 날짜의 값은 추정하지 않으며, 누락된 월과 집계 기준이 달라진 지점은 연결하지 않습니다.</span></div>
        {selected && <PointDetail series={series} point={selected} points={points} onSelect={setPointId} />}
      </section>
      <div className="historical-comparability"><CircleHelp size={16} /><p><strong>추세를 읽을 때</strong> {series.comparability}{series.unit === 'score' && ' 각 연도 원장의 당시 상태에 공통 단계 모형을 적용한 재평가입니다. 해당 연도에 실제로 발표된 점수나 같은 사업들의 진행 추적은 아닙니다.'}</p></div>
      <section className="panel historical-values"><div className="panel-heading"><div><span className="eyebrow">SOURCE VALUES</span><h2>과거 값과 근거 원문</h2></div><button className="button compact" disabled={!points.length} onClick={download}><ArrowDownToLine size={15} />CSV 내려받기</button></div><p className="panel-description">값을 선택해 기준일·발표일·수집 시각을 확인합니다. 미공개 값은 0으로 채우지 않습니다.</p><div className="table-scroll"><table><thead><tr><th>자료 시점</th><th>{series.unit === 'score' ? '평균 점수 · 추정' : '공개 값'}</th><th>{series.unit === 'score' ? '산출 건수·비율 / 미산출' : '신청·프로젝트 수'}</th><th>날짜 기준</th><th>공식 출처</th></tr></thead><tbody>{[...points].reverse().map(point => <tr key={point.id} className={point.id === selected?.id ? 'selected' : ''}><td><button className="text-button" aria-pressed={point.id === selected?.id} aria-label={`${pointDate(point)} 근거 보기`} onClick={() => setPointId(point.id)}>{pointDate(point)}</button></td><td><strong>{valueText(series, point)}</strong></td><td>{series.unit === 'score' ? <>{scoreCoverage(point)}<small className="historical-table-subline">미산출 {point.unknownCount === null ? '미공개' : `${formatNumber(point.unknownCount, 0)}건`}</small></> : point.projectCount === null ? '미공개' : `${formatNumber(point.projectCount, 0)}건`}</td><td>{dateBasisLabel(point)}{point.breakBefore && <span className="historical-break-badge">연속 비교 단절</span>}</td><td><a className="source-link" href={sourceLink(point.source.url)} target="_blank" rel="noreferrer">{point.source.name}<ExternalLink size={12} /></a></td></tr>)}</tbody></table>{!points.length && <div className="inline-empty"><p>선택 기간의 자료가 없습니다.</p></div>}</div></section>
    </> : <div className="historical-empty"><History size={26} /><strong>이 조건의 과거 자료가 아직 없습니다.</strong><p>다른 지표나 권역을 선택하세요.</p></div>}
    <details className="historical-limitations"><summary>확보 범위와 아직 없는 이력</summary><ul>{dataset.limitations.map(text => <li key={text}>{text}</li>)}</ul><p>자료 파일 생성 {retrievedDate(dataset.generatedAt)} KST · 원자료 기준일과 다릅니다.</p></details>
  </div>;
}

function HistoryChart({ series, points, selectedId, onSelect }: { series: HistoricalSeries; points: HistoricalPoint[]; selectedId?: string; onSelect: (id: string) => void }) {
  const titleId = useId();
  const values = points.flatMap(point => point.value === null ? [] : [plotValue(series, point.value)]);
  const maximum = series.unit === 'score' ? 100 : Math.max(1, ...values) * 1.12;
  const minTime = Date.parse(points[0].date);
  const maxTime = Date.parse(points[points.length - 1].date);
  const px = (point: HistoricalPoint) => maxTime === minTime ? 477 : 75 + (Date.parse(point.date) - minTime) / (maxTime - minTime) * 805;
  const py = (point: HistoricalPoint) => 249 - plotValue(series, point.value!) / maximum * 197;
  const labels = points.length <= 6 ? points : points.filter((_, index) => index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 5) === 0);
  return <div className="historical-svg-wrap"><svg viewBox="0 0 940 305" aria-labelledby={titleId} role="group"><title id={titleId}>{series.name}, {values.length}개 공개 값. 아래 선택 메뉴와 표에서도 같은 값을 확인할 수 있습니다.</title>{[0, 1, 2, 3, 4].map(step => <g key={step}><line x1="75" y1={249 - step * 197 / 4} x2="880" y2={249 - step * 197 / 4} stroke="#e3ece8" strokeDasharray="4 5" /><text className="historical-axis" x="61" y={253 - step * 197 / 4} textAnchor="end">{formatNumber(maximum * step / 4, series.unit === 'projects' ? 0 : 1)}</text></g>)}<text className="historical-axis" x="61" y="27" textAnchor="end">{unit(series)}</text>
      {points.map((point, index) => { const previous = points[index - 1]; return <g key={point.id}>{point.breakBefore && <line x1={px(point)} y1="36" x2={px(point)} y2="253" stroke="#c1b88d" strokeDasharray="4 5"><title>연속 비교 단절 · 앞선 값과 선을 연결하지 않음</title></line>}{canJoin(previous, point) && <line x1={px(previous)} y1={py(previous)} x2={px(point)} y2={py(point)} stroke="#188777" strokeWidth="2.5" />}{point.value !== null ? <g className={`historical-point ${selectedId === point.id ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`${pointDate(point)}, ${valueText(series, point)}, 근거 보기`} aria-pressed={selectedId === point.id} onClick={() => onSelect(point.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.id); } }}><title>{pointDate(point)} · {valueText(series, point)}</title><circle className="historical-point-target" cx={px(point)} cy={py(point)} r="17" fill="transparent" /><circle className="historical-point-halo" cx={px(point)} cy={py(point)} r="10" fill="#d7eee7" /><circle cx={px(point)} cy={py(point)} r="5" fill={point.qualifier === 'exact' ? '#188777' : '#fff'} stroke="#188777" strokeWidth="2.5" /></g> : <g><path d={`M${px(point) - 4},245 l8,8 m-8,0 l8,-8`} stroke="#96aaa2" /><title>{pointDate(point)} · 자료 없음</title></g>}</g>; })}
      {labels.map(point => <text key={point.id} className="historical-axis" x={px(point)} y="283" textAnchor="middle">{axisDate(point)}</text>)}
    </svg>{!values.length && <div className="historical-chart-no-values"><strong>이 기간에는 산출된 값이 없습니다</strong><span>원자료와 미산출 이유는 아래에서 확인할 수 있습니다.</span></div>}</div>;
}

function PointDetail({ series, point, points, onSelect }: { series: HistoricalSeries; point: HistoricalPoint; points: HistoricalPoint[]; onSelect: (id: string) => void }) {
  return <div className="historical-detail"><div className="historical-detail-heading"><label>기준 시점 선택<select value={point.id} onChange={event => onSelect(event.target.value)}>{points.map(row => <option key={row.id} value={row.id}>{pointDate(row)} · {valueText(series, row)}</option>)}</select></label><div aria-live="polite"><span>{dateBasisLabel(point)}의 값{point.breakBefore && <span className="historical-break-badge">연속 비교 단절</span>}</span><strong>{valueText(series, point)}</strong></div></div><dl><div><dt>원자료 기준일</dt><dd>{shortDate(point.sourceAsOf)}</dd></div><div><dt>공식 발표일</dt><dd>{shortDate(point.publishedAt)}</dd></div>{point.archiveCapturedAt && <div><dt>보관본 포착 시각 · KST</dt><dd>{retrievedDate(point.archiveCapturedAt)}</dd></div>}{point.observedAt && <div><dt>원문 관측 시각 · KST</dt><dd>{retrievedDate(point.observedAt)}</dd></div>}<div><dt>자료 취득 시각 · KST</dt><dd>{retrievedDate(point.source.retrievedAt)}</dd></div>{series.unit === 'score' && <><div><dt>점수 산출 건수·비율</dt><dd>{scoreCoverage(point)}</dd></div><div><dt>평균 점수 분모</dt><dd>{point.ratedCount === null ? '미공개' : `${formatNumber(point.ratedCount, 0)}건 · 동일 가중`}</dd></div><div><dt>미산출·평균 제외</dt><dd>{point.unknownCount === null ? '미공개' : `${formatNumber(point.unknownCount, 0)}건`}</dd></div><div><dt>단계 추정 모형</dt><dd>{point.ratingModelVersion ?? '적용하지 않음'}</dd></div></>}</dl>{(point.dateBasis === 'archive_capture' || point.dateBasis === 'observation') && <p className="historical-date-note">{point.dateBasis === 'archive_capture' ? '보관본 포착일은 웹 아카이브가 해당 원장을 보존한 날짜입니다.' : '원문 관측일은 현재 원장을 실제 취득한 날짜입니다.'} 원장 전체의 기준일이 공개되지 않아 이 날짜를 사용하며, 사업 진행일이나 상태 변경일을 뜻하지 않습니다.</p>}{point.notes.length > 0 && <ul>{point.notes.map(note => <li key={note}>{note}</li>)}</ul>}<a className="source-link" href={sourceLink(point.source.url)} target="_blank" rel="noreferrer">{point.source.name} · 근거 원문 열기<ExternalLink size={13} /></a>{point.source.originalUrl && <a className="source-link historical-original-source" href={sourceLink(point.source.originalUrl)} target="_blank" rel="noreferrer">현재 공식 원장 위치<ExternalLink size={13} /></a>}</div>;
}
