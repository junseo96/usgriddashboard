import { useEffect, useId, useState } from 'react';
import { ArrowDownToLine, ArrowRight, CircleHelp, ExternalLink, Factory, RefreshCw } from 'lucide-react';
import { LOAD_STAGE_CATALOG, isLoadBottleneckDataset, loadBottleneckCsv, rateLoadObservation, type LoadBottleneckDataset, type LoadBottleneckSeries, type LoadBottleneckObservation, type LoadBottleneckRating, type LoadRegion } from '../shared/load-bottleneck';
import './load-bottleneck.css';

const number = (value: number, digits = 1) => value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const date = (value: string | null | undefined) => !value ? '미공개' : /^\d{4}-Q[1-4]$/.test(value) ? value.replace(/^(\d{4})-Q([1-4])$/, '$1년 $2분기') : value.split('T')[0].replaceAll('-', '.');
const pointDate = (point: LoadBottleneckObservation) => point.datePrecision === 'quarter' ? `${point.date.slice(0, 4)}년 ${Math.floor((Number(point.date.slice(5, 7)) - 1) / 3) + 1}분기` : date(point.date.slice(0, point.datePrecision === 'year' ? 4 : point.datePrecision === 'month' ? 7 : 10));
const axisDate = (point: LoadBottleneckObservation) => point.datePrecision === 'quarter' ? `${point.date.slice(0, 4)} Q${Math.floor((Number(point.date.slice(5, 7)) - 1) / 3) + 1}` : point.datePrecision === 'year' ? point.date.slice(0, 4) : point.date.slice(0, 7).replace('-', '.');
const time = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const safeUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const weight = (series: LoadBottleneckSeries, value: number | null) => value === null ? '미공개' : series.weightBasis === 'project_count' ? `${number(value, 0)}건` : `${number(value / 1000, 3)} GW`;
const basis = (series: LoadBottleneckSeries) => series.weightBasis === 'project_count' ? '프로젝트 동일 가중' : '용량 가중';
const scopeLabel = (series: LoadBottleneckSeries) => ({ operator_register: '운영기관 공개 원장', operator_aggregate: '운영기관 집계', utility_subset: '전력회사 부분 범위', selected_projects: '선별 프로젝트' })[series.scopeType];
const populationLabel = (series: LoadBottleneckSeries) => ({ active_queue: '활성 접속 신청', tracked_pool: '운영·미분류를 포함한 추적군', contract_subset: '계약 사업만의 부분 집합', selected_projects: '확보한 개별 사례' })[series.population];
const dateBasis = (point: LoadBottleneckObservation) => point.dateBasis === 'archive_capture' ? '보관본 포착일' : point.dateBasis === 'observation' ? '원문 관측일' : point.dateBasis === 'publication' ? '공식 발표일' : '원자료 기준일';
const consumptionProxy = (series: LoadBottleneckSeries) => series.id === 'ercot-load-stages';
const hasReferenceIndex = (rating: LoadBottleneckRating) => rating.point === null && rating.trackedPoint !== null;
const displayPoint = (rating: LoadBottleneckRating) => rating.point ?? rating.trackedPoint;
const pointText = (rating: LoadBottleneckRating) => displayPoint(rating) === null ? '미산출' : `${number(displayPoint(rating)!)}점`;
const trackedCoverage = (rating: LoadBottleneckRating) => rating.trackedUnknownWeight !== null && rating.trackedRatedWeight + rating.trackedUnknownWeight > 0 ? `${number(rating.trackedRatedWeight / (rating.trackedRatedWeight + rating.trackedUnknownWeight) * 100)}%` : '미확인';
const scoreLabel = (rating: LoadBottleneckRating, series: LoadBottleneckSeries) => hasReferenceIndex(rating) ? '추적군 참고지수' : consumptionProxy(series) ? '관측 소비 MW 제외 단계지수' : '활성 신청 평균 병목점수';
const ordered = (series: LoadBottleneckSeries) => [...series.points].sort((a, b) => a.date.localeCompare(b.date));
const GATE_LABEL: Record<string, string> = { technical: '기술 검토', commercial: '계약·비용', permitting: '부지·인허가', construction: '설비·망 보강', energization: '통전 승인' };

export default function LoadBottleneckPanel({ revision }: { revision: number }) {
  const [dataset, setDataset] = useState<LoadBottleneckDataset | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [region, setRegion] = useState<LoadRegion>('ERCOT');
  const [seriesId, setSeriesId] = useState('');
  const [pointId, setPointId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    fetch('/api/load-bottleneck', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`수용가 진행 자료를 불러오지 못했습니다 (${response.status}).`);
      const value: unknown = await response.json();
      if (!isLoadBottleneckDataset(value)) throw new Error('수용가 진행 자료를 확인하지 못했습니다. 다시 불러와 주세요.');
      setDataset(value);
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, retry]);
  const regionInfo = dataset?.regions.find(row => row.region === region);
  const choices = dataset?.series.filter(row => row.region === region) ?? [];
  const series = choices.find(row => row.id === seriesId) ?? choices.find(row => row.id === regionInfo?.headlineSeriesId) ?? choices[0];
  const points = series ? ordered(series).filter(point => (!start || point.date >= start) && (!end || point.date <= end)) : [];
  const point = points.find(row => row.id === pointId) ?? points[points.length - 1];
  const rating = series && point ? rateLoadObservation(series, point) : null;
  const selectRegion = (value: LoadRegion) => { setRegion(value); setSeriesId(''); setPointId(''); setStart(''); setEnd(''); };
  const download = () => {
    if (!dataset || !series || !points.length) return;
    const csv = loadBottleneckCsv(dataset, { seriesId: series.id, ...(start ? { start } : {}), ...(end ? { end } : {}) });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `grid-atlas-load-stages-${series.id}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (loading && !dataset) return <div className="market-loading" role="status"><RefreshCw size={20} className="spin" />권역별 수용가 진행 근거를 불러오는 중…</div>;
  if (!dataset) return <div className="empty-state"><Factory size={30} /><h2>수용가 진행 자료 조회 실패</h2><p role="alert">{error}</p><button className="button primary" onClick={() => setRetry(value => value + 1)}>다시 불러오기<RefreshCw size={14} /></button></div>;
  return <div className="load-bottleneck-view">
    <section className="load-bottleneck-intro"><span><Factory size={24} /></span><div><span className="eyebrow">REGIONAL LOAD CONNECTION PROGRESS</span><h2>수용가 진행 단계, 권역별 근거</h2><p>ISO·RTO와 공개된 다른 권역의 단계 자료를 비교하고, 확보한 과거 시점의 변화를 확인합니다.</p></div></section>
    <div className="load-bottleneck-note"><CircleHelp size={18} /><div><strong>같은 점수라도 집계 대상과 가중 방식이 다릅니다.</strong><p>개별 신청 평균, 용량 가중 점수, 운영을 포함한 추적군 참고지수를 구분합니다. 전력회사 일부 사업을 권역 전체로 확대하거나 서로 합산하지 않으며, 이 값만으로 권역 순위를 매기지 않습니다.</p></div></div>
    {error && <div className="market-error" role="alert">{error} 이전에 불러온 자료를 표시합니다.</div>}
    <section className="load-region-cards" aria-label="권역별 수용가 점수 범위">{dataset.regions.map(({ region: value }) => {
      const info = dataset.regions.find(row => row.region === value);
      const headline = dataset.series.find(row => row.id === info?.headlineSeriesId);
      const latest = headline ? ordered(headline).at(-1) : undefined;
      const result = headline && latest ? rateLoadObservation(headline, latest) : null;
      return <button key={value} className={`load-region-card ${region === value ? 'selected' : ''}`} aria-pressed={region === value} onClick={() => selectRegion(value)}><span>{value}<ArrowRight size={13} /></span><strong>{result ? pointText(result) : '미산출'}</strong><small>{result && displayPoint(result) !== null ? `${hasReferenceIndex(result) ? '추적군 참고지수 · ' : consumptionProxy(headline!) ? '관측 소비 제외 · ' : ''}${basis(headline!)}` : '단계·분모 확인 필요'}</small><p>{headline ? headline.name : '공개 근거 공백'}</p><em>{headline && <>{scopeLabel(headline)}<br /></>}{latest ? `${pointDate(latest)} · ${dateBasis(latest)}` : '산출 가능한 시점 없음'}</em></button>;
    })}</section>
    <section className="panel load-score-controls"><label>권역<select aria-label="수용가 점수 권역" value={region} onChange={event => selectRegion(event.target.value as LoadRegion)}>{dataset.regions.map(({ region: value }) => <option key={value} value={value}>{value}</option>)}</select></label><label className="load-score-source-select">출처·집계 범위<select aria-label="수용가 점수 출처" value={series?.id ?? ''} disabled={!choices.length} onChange={event => { setSeriesId(event.target.value); setPointId(''); }}>{choices.length ? choices.map(row => <option key={row.id} value={row.id}>{row.name}</option>) : <option value="">확보한 단계 자료 없음</option>}</select></label><label>시작일<input aria-label="수용가 점수 시작일" type="date" value={start} max={end || undefined} onChange={event => setStart(event.target.value)} /></label><label>종료일<input aria-label="수용가 점수 종료일" type="date" value={end} min={start || undefined} onChange={event => setEnd(event.target.value)} /></label><button className="button compact" onClick={() => { setStart(''); setEnd(''); setPointId(''); }}>전체 기간</button></section>
    {regionInfo?.gaps.length ? <div className="load-region-gaps"><strong>{region}의 관측 범위와 공백</strong><ul>{regionInfo.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></div> : null}
    {region === 'NYISO' && <NyisoCohortComparison dataset={dataset} onSelect={id => { setSeriesId(id); setPointId(''); }} />}
    {series ? <>
      <section className="panel load-score-chart-panel"><div className="panel-heading"><div><span className="eyebrow">{scopeLabel(series)} · {basis(series)}</span><h2>{series.name}</h2></div><span className="small-pill">{points.length}개 시점</span></div><div className="load-score-scope"><strong>{populationLabel(series)}</strong><p>{series.scope}</p></div>
        {point && rating ? <><div className="load-score-headline"><div><span>{scoreLabel(rating, series)}</span><strong>{pointText(rating)}{displayPoint(rating) !== null && <small>/ 100</small>}</strong><p>{basis(series)} · {pointDate(point)} {dateBasis(point)}</p></div><div><span>{displayPoint(rating) === null ? '단계 해석 가능 범위' : '점수 분모'}</span><strong>{weight(series, hasReferenceIndex(rating) ? rating.trackedRatedWeight : rating.ratedWeight)}</strong><small>{hasReferenceIndex(rating) ? '운영·미분류 사업을 포함할 수 있음' : rating.point === null ? '평균 산출 조건 미충족' : consumptionProxy(series) ? '공개 관측 소비 MW만 제외한 분모' : '단계를 해석할 수 있는 활성 범위'}</small></div></div>{consumptionProxy(series) && <div className="load-tracked-warning"><strong>관측 소비 MW만 제외한 대리 지표입니다.</strong> 운영 사업의 전체 계약용량을 제외한 값이나 미통전 프로젝트의 평균으로 해석할 수 없습니다. 실제 가동 MW는 비동시 최대 소비 관측이며 잔여 요청 용량과 구분됩니다.</div>}{hasReferenceIndex(rating) && <div className="load-tracked-warning"><strong>이 값은 활성 접속 신청 평균이 아닌 추적군 참고지수입니다.</strong> 공개된 묶음에 운영 중이거나 활성 여부를 구분할 수 없는 사업이 포함됩니다. 활성 신청 평균은 미산출로 남깁니다.</div>}
          <LoadTrend series={series} points={points} selectedId={point.id} onSelect={setPointId} />
          <div className="load-score-point-select"><label>기준 시점<select aria-label="수용가 점수 기준 시점" value={point.id} onChange={event => setPointId(event.target.value)}>{points.map(row => { const result = rateLoadObservation(series, row); return <option key={row.id} value={row.id}>{pointDate(row)} · {pointText(result)}{hasReferenceIndex(result) ? ' · 참고지수' : ''}</option>; })}</select></label><span>{dateBasis(point)}에 공개·보존된 원문 기준</span></div>
          <div className="load-score-denominators"><div><span>{consumptionProxy(series) ? '관측 소비 제외 분모' : '활성 범위'}</span><strong>{weight(series, rating.activeWeight)}</strong></div><div><span>단계 미공개·미산출</span><strong>{weight(series, rating.unknownWeight)}</strong></div><div><span>활성 여부 미분류</span><strong>{weight(series, rating.unresolvedWeight)}</strong></div><div><span>{consumptionProxy(series) ? '관측 소비 MW · 지수 제외' : '운영 중 · 활성 평균 제외'}</span><strong>{weight(series, rating.operatingWeight)}</strong></div><div><span>철회 · 활성 평균 제외</span><strong>{weight(series, rating.withdrawnWeight)}</strong></div><div><span>{consumptionProxy(series) ? '소비 제외 분모 내 산출 비율' : '활성 범위 내 점수 산출률'}</span><strong>{rating.point === null ? '미산출' : rating.coverage === null ? '미확인' : `${number(rating.coverage * 100)}%`}</strong></div>{rating.trackedPoint !== null && <><div className="load-tracked-denominator"><span>참고지수 분모 · 운영 포함 가능</span><strong>{weight(series, rating.trackedRatedWeight)}</strong></div><div className="load-tracked-denominator"><span>추적군 단계 미공개 · 지수 제외</span><strong>{weight(series, rating.trackedUnknownWeight)}</strong></div><div className="load-tracked-denominator"><span>추적군 내 지수 산출 비율</span><strong>{trackedCoverage(rating)}</strong></div></>}</div>
          {rating.reasons.length > 0 && <ul className="load-score-reasons">{rating.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <LoadStageDetail series={series} point={point} />
        </> : <div className="historical-empty"><strong>선택 기간에 확인된 시점이 없습니다.</strong><p>기간을 넓혀 공개 자료를 확인하세요.</p></div>}
      </section>
      <div className="load-trend-caveat"><CircleHelp size={17} /><div><strong>평균 점수 상승만으로 접속 지연이 심해졌다고 단정할 수 없습니다.</strong><p>신규 신청이 늘거나 완료 사업이 원장에서 빠져도 평균은 달라집니다. 같은 사업군의 처리 기간·완료율을 추적한 결과와 구분해야 합니다. {series.comparability}</p></div></div>
      <section className="panel load-score-table"><div className="panel-heading"><div><span className="eyebrow">HISTORICAL STAGE EVIDENCE</span><h2>시점별 값과 점수 분모</h2></div><button className="button compact" disabled={!points.length} onClick={download}><ArrowDownToLine size={14} />CSV 내려받기</button></div><div className="table-scroll"><table><thead><tr><th>시점</th><th>{consumptionProxy(series) ? '관측 소비 제외 지수' : '활성 신청 평균'}</th><th>추적군 참고지수</th><th>{consumptionProxy(series) ? '소비 제외 점수 분모' : '활성 점수 분모'}</th><th>{consumptionProxy(series) ? '소비 제외 후 미산출' : '활성 미산출'}</th><th>공식 근거</th></tr></thead><tbody>{[...points].reverse().map(row => { const result = rateLoadObservation(series, row); return <tr key={row.id} className={row.id === point?.id ? 'selected' : ''}><td><button className="text-button" aria-pressed={row.id === point?.id} onClick={() => setPointId(row.id)}>{pointDate(row)}</button>{row.breakBefore && <small className="load-break-tag">연속 비교 단절</small>}</td><td>{result.point === null ? '미산출' : `${number(result.point)}점`}</td><td>{result.trackedPoint === null ? '—' : <>{number(result.trackedPoint)}점<small className="load-reference-table-meta">분모 {weight(series, result.trackedRatedWeight)}<br />미산출 {weight(series, result.trackedUnknownWeight)} · {trackedCoverage(result)}</small></>}</td><td>{weight(series, result.ratedWeight)}</td><td>{weight(series, result.unknownWeight)}</td><td><a className="source-link" href={safeUrl(row.source.url)} target="_blank" rel="noreferrer">{row.source.name}<ExternalLink size={12} /></a></td></tr>; })}</tbody></table></div></section>
    </> : <section className="panel load-score-empty"><Factory size={30} /><h2>{region}의 단계별 평균은 아직 산출할 수 없습니다</h2><p>요청 총량이나 계약 용량만으로 다섯 접속 요건의 진행 상태를 추정하지 않습니다. 확보한 단계별 분모가 있을 때 점수를 추가합니다.</p></section>}
    <details className="load-score-limitations"><summary>산정 범위와 자료의 한계</summary><ul>{dataset.limitations.map(note => <li key={note}>{note}</li>)}</ul><p>자료 생성 {time(dataset.generatedAt)} KST · 각 원자료의 기준일과 다릅니다.</p></details>
  </div>;
}

function NyisoCohortComparison({ dataset, onSelect }: { dataset: LoadBottleneckDataset; onSelect: (id: string) => void }) {
  const series = ['nyiso-load-register', 'nyiso-load-fixed-cohort'].map(id => dataset.series.find(row => row.id === id));
  if (series.some(row => !row || row.points.length < 2)) return null;
  return <section className="panel load-cohort-comparison"><div className="panel-heading"><div><span className="eyebrow">NYISO · 전체 확보 기간 비교</span><h2>전체 평균과 같은 사업의 진행을 함께 보기</h2></div></div><p>새 신청의 유입·기존 사업의 이탈이 있는 원장과, 같은 신청 ID를 계속 따라간 표본을 구분합니다.</p><div className="load-cohort-cards">{series.map((row, index) => {
    const source = row!; const points = ordered(source); const first = points[0]; const last = points[points.length - 1];
    const firstRating = rateLoadObservation(source, first); const lastRating = rateLoadObservation(source, last);
    return <article key={source.id}><span>{index === 0 ? '매 시점의 공개 활성 원장' : `동일 ${weight(source, firstRating.activeWeight)} 생존 표본`}</span><strong>{pointText(firstRating)} <ArrowRight size={18} /> {pointText(lastRating)}</strong><small>{pointDate(first)} → {pointDate(last)}</small><p>관측 대상 {weight(source, firstRating.activeWeight)} → {weight(source, lastRating.activeWeight)}<br />평균 분모 {weight(source, firstRating.ratedWeight)} → {weight(source, lastRating.ratedWeight)}</p><div className="load-cohort-sequence">{points.map(point => <span key={point.id}><small>{point.date.slice(0, 7).replace('-', '.')}</small><b>{pointText(rateLoadObservation(source, point))}</b></span>)}</div><button className="text-button" onClick={() => onSelect(source.id)}>이 집단의 단계·근거 보기<ArrowRight size={13} /></button></article>;
  })}</div><div className="load-cohort-warning"><strong>고정 표본에도 생존편향이 있습니다.</strong> 모든 시점에서 활성·평가 가능한 신청만 남긴 집단입니다. 완료·철회·미산출 사업을 포함한 전체 집단을 대표하지 않으며, 점수 하락을 권역 전체의 대기시간 단축으로 해석할 수 없습니다.</div></section>;
}

function LoadTrend({ series, points, selectedId, onSelect }: { series: LoadBottleneckSeries; points: LoadBottleneckObservation[]; selectedId: string; onSelect: (id: string) => void }) {
  const titleId = useId();
  const rows = points.map(point => ({ point, rating: rateLoadObservation(series, point) }));
  const known = rows.filter(row => displayPoint(row.rating) !== null);
  const min = Date.parse(points[0].date), max = Date.parse(points[points.length - 1].date);
  const px = (point: LoadBottleneckObservation) => min === max ? 475 : 70 + (Date.parse(point.date) - min) / (max - min) * 810;
  const py = (rating: LoadBottleneckRating) => 245 - displayPoint(rating)! * 1.9;
  const join = (previous: typeof rows[number] | undefined, current: typeof rows[number]) => {
    if (!previous || displayPoint(previous.rating) === null || displayPoint(current.rating) === null || current.point.breakBefore || hasReferenceIndex(previous.rating) !== hasReferenceIndex(current.rating)) return false;
    const month = (point: LoadBottleneckObservation) => Number(point.date.slice(0, 4)) * 12 + Number(point.date.slice(5, 7));
    if ((previous.point.datePrecision === 'month' || current.point.datePrecision === 'month') && month(current.point) - month(previous.point) > 1) return false;
    if (previous.point.datePrecision === 'quarter' && current.point.datePrecision === 'quarter' && month(current.point) - month(previous.point) > 3) return false;
    return true;
  };
  return <><div className="load-score-trend-status">{known.length < 2 ? <strong>비교 가능한 시점이 {known.length}개여서 과거 추세를 판단할 수 없습니다.</strong> : <span>각 공개 시점의 값입니다. 미공개 기간을 채우거나 점수의 상승·하락 방향을 가정하지 않습니다.</span>}</div><div className="load-score-svg"><svg viewBox="0 0 940 302" role="group" aria-labelledby={titleId}><title id={titleId}>{series.name}의 공개 시점별 점수. 동일한 값과 근거는 아래 표에서 확인할 수 있습니다.</title>{[0, 25, 50, 75, 100].map(value => <g key={value}><line x1="70" y1={245 - value * 1.9} x2="880" y2={245 - value * 1.9} stroke="#e3ece8" strokeDasharray="4 5" /><text x="54" y={249 - value * 1.9} textAnchor="end">{value}</text></g>)}{rows.map((row, index) => <g key={row.point.id}>{join(rows[index - 1], row) && <line x1={px(rows[index - 1].point)} y1={py(rows[index - 1].rating)} x2={px(row.point)} y2={py(row.rating)} stroke={hasReferenceIndex(row.rating) ? '#a08a55' : '#188777'} strokeWidth="2.5" />}{displayPoint(row.rating) !== null && <g className={`load-score-dot ${row.point.id === selectedId ? 'selected' : ''}`} tabIndex={0} role="button" aria-pressed={row.point.id === selectedId} aria-label={`${pointDate(row.point)}, ${pointText(row.rating)}, ${scoreLabel(row.rating, series)}`} onClick={() => onSelect(row.point.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.point.id); } }}><title>{pointDate(row.point)} · {pointText(row.rating)} · {scoreLabel(row.rating, series)}</title><circle className="load-score-dot-target" cx={px(row.point)} cy={py(row.rating)} r="16" fill="transparent" /><circle className="load-score-dot-halo" cx={px(row.point)} cy={py(row.rating)} r="10" fill="#e7edda" /><circle cx={px(row.point)} cy={py(row.rating)} r="5" fill={hasReferenceIndex(row.rating) ? '#a08a55' : '#188777'} stroke="white" strokeWidth="2" /></g>}{(index === 0 || index === rows.length - 1 || index % Math.max(1, Math.ceil(rows.length / 5)) === 0) && <text x={px(row.point)} y="278" textAnchor="middle">{axisDate(row.point)}</text>}</g>)}</svg>{!known.length && <div className="load-score-no-points"><strong>진행 점수 미산출</strong><span>아래의 공개 단계와 산출 제한 사유를 확인하세요.</span></div>}</div><div className="load-score-chart-legend"><span><i />{consumptionProxy(series) ? '관측 소비 MW 제외 단계지수' : '활성 신청 평균'}</span><span><i className="reference" />추적군 참고지수 · 운영 포함 가능</span><span>자료·집계 범위가 단절된 시점은 연결하지 않습니다.</span></div></>;
}

function LoadStageDetail({ series, point }: { series: LoadBottleneckSeries; point: LoadBottleneckObservation }) {
  const [stage, setStage] = useState('');
  const available = series.population === 'contract_subset' ? [] : point.bins.filter(bin => LOAD_STAGE_CATALOG.some(row => row.stage === bin.stage && row.point !== null));
  const selected = LOAD_STAGE_CATALOG.find(row => row.stage === stage && available.some(bin => bin.stage === row.stage)) ?? LOAD_STAGE_CATALOG.find(row => row.stage === available[0]?.stage);
  const maxWeight = Math.max(1, ...point.bins.flatMap(bin => bin.weight === null ? [] : [bin.weight]));
  return <section className="load-stage-detail"><div className="load-stage-heading"><h3>공개된 단계별 분포</h3><span>{series.weightBasis === 'project_count' ? '원문 건수' : '원문 용량'} · 단계 배점은 모형 가정</span></div><div className="load-stage-rows">{point.bins.map(bin => { const definition = LOAD_STAGE_CATALOG.find(row => row.stage === bin.stage); return <article key={bin.id}><div><strong>{bin.rawStage}</strong><span>{definition?.label ?? '해석 미확인'} · {({ active: consumptionProxy(series) ? '관측 소비 제외 구간' : '활성', operating: consumptionProxy(series) ? '관측 소비 MW' : '운영 중', withdrawn: '철회', unresolved: '활성 여부 미분류' })[bin.membership]}</span><div className="load-stage-weight-bar"><i style={{ width: `${bin.weight === null ? 0 : bin.weight / maxWeight * 100}%` }} /></div></div><div><strong>{weight(series, bin.weight)}</strong><small>{series.population === 'contract_subset' ? '계약 사실만 확인' : bin.membership === 'operating' || bin.membership === 'withdrawn' ? '활성 평균 제외' : definition?.point == null ? '배점 미산출' : `모형 ${number(definition.point)}점`}</small></div>{bin.notes.length > 0 && <p>{bin.notes.join(' ')}</p>}{bin.source && <a className="source-link" href={safeUrl(bin.source.url)} target="_blank" rel="noreferrer">단계 근거 원문{bin.sourceAsOf !== undefined && ` · 원자료 기준 ${date(bin.sourceAsOf)}`}<ExternalLink size={11} /></a>}</article>; })}</div>
    {selected && <div className="load-stage-assumptions"><label>단계별 배점 가정<select aria-label="수용가 단계별 배점 가정" value={selected.stage} onChange={event => setStage(event.target.value)}>{LOAD_STAGE_CATALOG.filter(row => available.some(bin => bin.stage === row.stage)).map(row => <option key={row.stage} value={row.stage}>{row.label} · 모형 {row.point}점</option>)}</select></label><p>{selected.rationale}</p>{series.stageMappings.filter(mapping => mapping.stage === selected.stage).map(mapping => <p key={mapping.rawStage}><strong>{mapping.rawStage}</strong> · {mapping.rationale}</p>)}<div className="load-stage-gates">{selected.gates.map(gate => <div key={gate.gate}><span>{GATE_LABEL[gate.gate] ?? gate.gate}</span><strong>{number(gate.points)}<small>/20점</small></strong><small>가정 진행률 {number(gate.progress * 100)}%</small></div>)}</div><small>이 진행률은 원문 단계에 적용한 공통 가정입니다. 실제 허가 취득이나 공정률을 확인한 수치가 아닙니다.</small></div>}
    <div className="load-stage-provenance"><dl><div><dt>원자료 기준일</dt><dd>{date(point.sourceAsOf)}</dd></div><div><dt>공식 발표일</dt><dd>{date(point.publishedAt)}</dd></div><div><dt>원문 취득 · KST</dt><dd>{time(point.source.retrievedAt)}</dd></div>{point.archiveCapturedAt && <div><dt>보관본 포착 · KST</dt><dd>{time(point.archiveCapturedAt)}</dd></div>}{point.observedAt && <div><dt>원문 관측 · KST</dt><dd>{time(point.observedAt)}</dd></div>}</dl>{point.notes.length > 0 && <ul>{point.notes.map(note => <li key={note}>{note}</li>)}</ul>}<a className="source-link" href={safeUrl(point.source.url)} target="_blank" rel="noreferrer">{point.source.name} · 근거 원문<ExternalLink size={13} /></a>{point.source.originalUrl && <a className="source-link" href={safeUrl(point.source.originalUrl)} target="_blank" rel="noreferrer">공식 출처 위치<ExternalLink size={12} /></a>}</div>
  </section>;
}
