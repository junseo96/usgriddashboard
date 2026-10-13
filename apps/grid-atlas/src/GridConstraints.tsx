import { useId, useMemo, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowUpRight, Cable, CircleHelp, Database, History, Network, Search } from 'lucide-react';
import { GRID_CONSTRAINTS, type ConstraintMetric, type ConstraintObservation, formatConstraintValue } from '../shared/grid-constraints';
import { externalUrl, marketDate, marketNumber } from './market-format';
import './grid-constraints.css';

export type ConstraintPart = 'transmission' | 'distribution';
interface Props { part: ConstraintPart; onPartChange: (part: ConstraintPart) => void; }
const KIND_LABEL: Record<ConstraintMetric['kind'], string> = { constraint: '직접 제약 관측', economic: '시장·경제 영향', hosting_capacity: '배전 수용 여력', reliability: '공급 신뢰도 · 보조' };
const scopeKey = (row: ConstraintObservation) => JSON.stringify([row.region, row.scope, row.utility, row.state, row.assetId ?? '']);
const scopeLabel = (row: ConstraintObservation) => [row.region, row.utility, row.state, row.scope].filter((value, index, array) => value && array.indexOf(value) === index).join(' · ');
const periodLabel = (row: ConstraintObservation) => row.periodStart === row.periodEnd ? marketDate(row.periodEnd, false) : `${marketDate(row.periodStart, false)} – ${marketDate(row.periodEnd, false)}`;
const sourceMap = new Map(GRID_CONSTRAINTS.sources.map(source => [source.id, source]));
const format = (row: ConstraintObservation, metric: ConstraintMetric) => formatConstraintValue(row.value, metric.unit);

export default function GridConstraints({ part, onPartChange }: Props) {
  return <div className="grid-constraints"><nav className="gc-tabs" aria-label="송배전 제약 구분"><button aria-pressed={part === 'transmission'} onClick={() => onPartChange('transmission')}><Network size={19} /><span>송전<small>권역 간 흐름과 혼잡</small></span></button><button aria-pressed={part === 'distribution'} onClick={() => onPartChange('distribution')}><Cable size={19} /><span>배전<small>지역 공급망과 수용 여력</small></span></button></nav><ConstraintWorkspace key={part} part={part} /></div>;
}
function ConstraintWorkspace({ part }: { part: ConstraintPart }) {
  const metrics = GRID_CONSTRAINTS.metrics.filter(metric => metric.part === part);
  const metricIds = new Set(metrics.map(metric => metric.id));
  const partRows = GRID_CONSTRAINTS.observations.filter(row => metricIds.has(row.metricId));
  const [metricId, setMetricId] = useState(() => (part === 'distribution' ? metrics.find(metric => metric.id === 'pge_zero_load_headroom_percent')?.id : undefined) ?? metrics.find(metric => partRows.some(row => row.metricId === metric.id))?.id ?? metrics[0]?.id ?? '');
  const [region, setRegion] = useState('');
  const [state, setState] = useState('');
  const [utility, setUtility] = useState('');
  const [scope, setScope] = useState<string | null>(part === 'distribution' ? '' : null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [showCoverage, setShowCoverage] = useState(false);
  const metric = metrics.find(item => item.id === metricId) ?? metrics[0];
  const metricRows = partRows.filter(row => row.metricId === metric?.id && (!region || row.region === region));
  const states = [...new Set(metricRows.flatMap(row => row.state ? [row.state] : []))].sort();
  const utilities = [...new Set(metricRows.filter(row => !state || row.state === state).flatMap(row => row.utility ? [row.utility] : []))].sort();
  const regionalRows = metricRows.filter(row => (!state || row.state === state) && (!utility || row.utility === utility) && (!query || `${scopeLabel(row)} ${row.note} ${row.assetId ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const scopes = useMemo(() => {
    const groups = new Map<string, { row: ConstraintObservation; count: number }>();
    for (const row of regionalRows) { const key = scopeKey(row); const previous = groups.get(key); groups.set(key, { row, count: (previous?.count ?? 0) + 1 }); }
    return [...groups].sort((a, b) => b[1].count - a[1].count || scopeLabel(a[1].row).localeCompare(scopeLabel(b[1].row)));
  }, [regionalRows]);
  const selectedScope = scope !== null && (scope === '' || scopes.some(([key]) => key === scope)) ? scope : scopes[0]?.[0] ?? '';
  const rows = regionalRows.filter(row => !selectedScope || scopeKey(row) === selectedScope).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.id.localeCompare(b.id));
  const firstRow = rows[0];
  const canShowDistribution = !selectedScope && metric?.kind === 'hosting_capacity' && rows.length > 1 && new Set(rows.map(row => row.periodEnd)).size === 1 && new Set(rows.map(row => row.utility)).size === 1;
  const firstYear = partRows.reduce((minimum, row) => row.periodStart < minimum ? row.periodStart : minimum, '9999');
  const lastYear = partRows.reduce((maximum, row) => row.periodEnd > maximum ? row.periodEnd : maximum, '');
  const allRegions = [...new Set(partRows.map(row => row.region))];
  const regions = [...new Set(partRows.filter(row => row.metricId === metric?.id).map(row => row.region))].sort();
  const sourceIds = new Set(partRows.flatMap(row => row.sourceIds));
  const coverage = GRID_CONSTRAINTS.coverage.filter(row => row.part === part);
  const pageCount = Math.max(1, Math.ceil(rows.length / 25));
  const effectivePage = Math.min(page, pageCount);
  const visible = rows.slice((effectivePage - 1) * 25, effectivePage * 25);
  const reset = () => { setScope(part === 'distribution' ? '' : null); setQuery(''); setPage(1); };
  const csv = () => {
    const headers = ['metric', 'kind', 'unit', 'metric_definition', 'metric_caveat', 'region', 'scope', 'utility', 'state', 'asset_id', 'period_start', 'period_end', 'period_kind', 'value', 'customer_count', 'sample_count', 'numerator', 'denominator', 'source_urls', 'source_retrieved_at', 'source_sha256', 'locator', 'note'];
    const quote = (value: unknown) => { const raw = value == null ? '' : String(value); const safe = /^[=+@-]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; };
    const content = [headers, ...rows.map(row => { const sources = row.sourceIds.map(id => sourceMap.get(id)).filter(source => !!source); return [metric?.label, metric?.kind, metric?.unit, metric?.definition, metric?.caveat, row.region, row.scope, row.utility, row.state, row.assetId, row.periodStart, row.periodEnd, row.periodKind, row.value, row.customerCount, row.sampleCount, row.numerator, row.denominator, sources.map(source => source.url).join(' | '), sources.map(source => source.retrievedAt).join(' | '), sources.map(source => source.sha256).join(' | '), row.locator, row.note]; })].map(row => row.map(quote).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `grid-atlas-${part}-${metric?.id ?? 'observations'}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    <section className={`gc-intro gc-${part}`}><div><span className="eyebrow">{part === 'transmission' ? 'TRANSMISSION CONSTRAINTS' : 'DISTRIBUTION CAPACITY'}</span><h2>{part === 'transmission' ? '어디에서 전력의 흐름이 제한되는가' : '지역 전력망이 얼마나 더 받아들일 수 있는가'}</h2><p>{part === 'transmission' ? '운영기관·시장감시기관이 발표한 혼잡과 시장 영향을 확인합니다. 제약시간·혼잡비용은 서로 다른 지표이며, 발표 주기와 집계 정의를 함께 봅니다.' : '배전망 계획모형의 추가 부하 수용 여력과 실제 공급 신뢰도를 구분해 확인합니다. 모형상 여력은 순간 혼잡의 실측값이나 확정된 접속 승인 용량이 아닙니다.'}</p></div><div className="gc-intro-stat"><span>공개 관측 기록</span><strong>{marketNumber(partRows.length)}</strong><small>{allRegions.length}개 공개 범위 · {sourceIds.size}개 출처<br />{firstYear === '9999' ? '자료 미확보' : `${firstYear.slice(0, 4)}–${lastYear.slice(0, 4)}년 관측`}</small></div></section>
    <div className="gc-boundary"><CircleHelp size={17} /><p>프로젝트의 인허가·계약 진행 점수와 별도입니다. 정전 지표를 혼잡점수로 바꾸거나 정의가 다른 시장의 수치를 합산하지 않습니다. <strong>원자료 기준일과 실제 취득 시각을 구분</strong>하며, 미확보는 0이 아닙니다.</p></div>
    <section className="gc-panel gc-explorer" aria-label={`${part === 'transmission' ? '송전' : '배전'} 관측 탐색`}>
      <div className="gc-panel-heading"><div><span className="eyebrow">OBSERVED INDICATORS</span><h2>관측 지표</h2></div><button className="button compact" onClick={csv} disabled={!rows.length}><ArrowDownToLine size={15} />CSV</button></div>
      <div className="gc-filters"><label>지표<select aria-label="송배전 관측 지표" value={metric?.id ?? ''} onChange={event => { setMetricId(event.target.value); setRegion(''); setState(''); setUtility(''); reset(); }}>{metrics.map(item => <option key={item.id} value={item.id}>{item.label} · {KIND_LABEL[item.kind]}</option>)}</select></label><label>공개 권역<select aria-label="송배전 공개 권역" value={region} onChange={event => { setRegion(event.target.value); setState(''); setUtility(''); reset(); }}><option value="">전체 공개 권역</option>{regions.map(value => <option key={value} value={value}>{value === 'State-level' ? '주별 자료 · ISO 배분 없음' : value}</option>)}</select></label>{part === 'distribution' && <><label>주<select aria-label="배전 관측 주" value={state} onChange={event => { setState(event.target.value); setUtility(''); reset(); }}><option value="">전체 주</option>{states.map(value => <option key={value}>{value}</option>)}</select></label><label>사업자<select aria-label="배전 관측 사업자" value={utility} onChange={event => { setUtility(event.target.value); reset(); }}><option value="">전체 사업자</option>{utilities.map(value => <option key={value}>{value}</option>)}</select></label></>}<label className="gc-scope-filter">관측 범위<select aria-label="송배전 관측 범위" value={selectedScope} onChange={event => { setScope(event.target.value); setPage(1); }}><option value="">모든 범위 · 표로 비교</option>{scopes.map(([key, item]) => <option value={key} key={key}>{scopeLabel(item.row)} · {item.count}개 관측</option>)}</select></label></div>
      {metric && <><div className={`gc-metric-explanation gc-kind-${metric.kind}`}><span className="gc-kind">{KIND_LABEL[metric.kind]}</span><h3>{metric.label}<small>{metric.unit}</small></h3><p>{metric.definition}</p><p className="gc-caveat">{metric.caveat}</p></div>
        {firstRow && selectedScope ? <div className="gc-chart-layout"><div className="gc-latest"><span>선택 범위의 최근 관측</span><strong>{format(firstRow, metric)}</strong><p>{scopeLabel(firstRow)}</p><small>{periodLabel(firstRow)}</small>{rows.length > 1 && <small>{rows.length}개 관측 · 공개된 시점만 표시</small>}</div><ConstraintChart rows={rows} metric={metric} /></div> : canShowDistribution ? <HostingDistribution rows={rows} metric={metric} /> : <div className="gc-chart-notice"><History size={20} /><p>{rows.length ? '같은 범위의 변화를 보려면 관측 범위를 선택하세요. 서로 다른 범위의 값은 아래 표에서 조회합니다.' : '선택한 권역·지표의 수치 자료가 없습니다. 지표 또는 권역을 변경하면 확보한 관측을 볼 수 있습니다.'}</p></div>}
      </>}
      <div className="gc-table-toolbar"><span>{marketNumber(rows.length)}개 관측 · {metric?.unit}</span><label className="gc-search"><Search size={15} /><input aria-label="송배전 관측 검색" placeholder="사업자·설비·관측 내용 검색" value={query} onChange={event => { setQuery(event.target.value); setScope(null); setPage(1); }} /></label></div>
      <div className="gc-table-scroll" tabIndex={0} aria-label="송배전 관측표 · 가로로 이동 가능"><table><thead><tr><th scope="col">관측 기간</th><th scope="col">권역·시설·사업자</th><th scope="col">관측값</th><th scope="col">해석과 출처</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><td>{periodLabel(row)}<small>{row.periodKind === 'snapshot' ? '자료 취득 시점의 모형·공개 상태' : row.periodKind === 'forecast' ? '전망 · 실적 아님' : row.periodKind === 'multi_year' ? '다년 기간 집계' : '연간 집계'}</small></td><th scope="row">{row.scope}<small>{[row.region, row.utility, row.state].filter(Boolean).join(' · ')}</small>{row.assetId && <small>설비 ID {row.assetId}</small>}</th><td className="gc-value">{metric && format(row, metric)}{row.customerCount !== undefined && <small>보고 고객 수(참고) {marketNumber(row.customerCount)}</small>}{row.sampleCount !== undefined && <small>원문 구간 {marketNumber(row.sampleCount)}개</small>}{row.denominator !== undefined && <small>분자 {marketNumber(row.numerator)} / 분모 {marketNumber(row.denominator)}</small>}</td><td><p>{row.note}</p><details><summary>원문·취득 시각·위치</summary><p>{row.locator}</p>{row.sourceIds.map(id => { const source = sourceMap.get(id); return source ? <div className="gc-source" key={id}><a href={externalUrl(source.url)} target="_blank" rel="noreferrer">{source.title}<ArrowUpRight size={12} /></a><small>{source.publisher} · 원자료 {marketDate(source.sourceAsOf, false)}</small><small>실제 취득 {marketDate(source.retrievedAt)} KST</small><code>SHA-256 {source.sha256}</code></div> : null; })}</details></td></tr>)}</tbody></table>{!visible.length && <p className="gc-empty">조건에 해당하는 관측이 없습니다.</p>}</div>
      <div className="gc-pagination"><span>{rows.length ? (effectivePage - 1) * 25 + 1 : 0}–{Math.min(effectivePage * 25, rows.length)} / {marketNumber(rows.length)}개</span><div><button aria-label="송배전 관측 이전 페이지" disabled={effectivePage <= 1} onClick={() => setPage(effectivePage - 1)}>이전</button><span>{effectivePage} / {pageCount}</span><button aria-label="송배전 관측 다음 페이지" disabled={effectivePage >= pageCount} onClick={() => setPage(effectivePage + 1)}>다음</button></div></div>
    </section>
    <section className="gc-panel gc-coverage"><div className="gc-panel-heading"><div><span className="eyebrow">COVERAGE & NEXT OBSERVATIONS</span><h2>확보 범위와 남은 공백</h2></div><Database size={19} /></div><p className="gc-section-note">참고 출처가 있다는 사실을 수치 수집 완료로 표시하지 않습니다. 배전 관측은 해당 사업자·회선의 범위이며 권역 전체를 대표하지 않습니다.</p><div className="gc-coverage-grid">{coverage.slice(0, showCoverage ? undefined : 6).map((row, index) => <article key={`${row.region}-${index}`}><div><strong>{row.region}</strong><span className={`gc-coverage-status ${row.status}`}>{row.status === 'observed' ? '수치 관측 확보' : row.status === 'reference_only' ? '참고 출처 확보' : '수치 미확보'}</span></div><p>{row.detail}</p>{row.sourceIds.map(id => { const source = sourceMap.get(id); return source ? <a key={id} href={externalUrl(source.url)} target="_blank" rel="noreferrer">{source.publisher}<ArrowUpRight size={12} /></a> : null; })}</article>)}</div>{coverage.length > 6 && <button className="gc-more" onClick={() => setShowCoverage(value => !value)}>{showCoverage ? '접기' : `전체 ${coverage.length}개 공개 범위 보기`}</button>}
      <details className="gc-method"><summary><Activity size={16} />해석 기준과 갱신 범위</summary>{GRID_CONSTRAINTS.notes.map(note => <p key={note}>{note}</p>)}<p>자료 조립 시각 {marketDate(GRID_CONSTRAINTS.generatedAt)} KST. 개별 취득 시각은 각 출처에서 확인할 수 있습니다.</p></details>
    </section>
  </>;
}
function ConstraintChart({ rows, metric }: { rows: ConstraintObservation[]; metric: ConstraintMetric }) {
  const titleId = useId();
  const sorted = [...rows].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const width = 750, height = 245, left = 70, right = 25, top = 27, bottom = 45;
  const minimum = Math.min(0, ...sorted.map(row => row.value));
  const maximum = Math.max(...sorted.map(row => row.value), 1);
  const range = maximum - minimum;
  const first = Date.parse(sorted[0].periodEnd), last = Date.parse(sorted.at(-1)!.periodEnd);
  const x = (row: ConstraintObservation) => first === last ? (width + left - right) / 2 : left + (Date.parse(row.periodEnd) - first) / (last - first) * (width - left - right);
  const y = (value: number) => top + (maximum - value) / range * (height - top - bottom);
  return <div className="gc-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}><title id={titleId}>{metric.label}, {sorted.map(row => `${row.periodEnd}: ${format(row, metric)}`).join('; ')}. 관측 사이의 값은 보간하지 않습니다.</title>{[minimum, minimum + range / 2, maximum].map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="gc-chart-grid" /><text x={left - 10} y={y(value) + 4} textAnchor="end">{value.toLocaleString('ko-KR', { maximumFractionDigits: 1, notation: value >= 100000 ? 'compact' : 'standard' })}</text></g>)}{sorted.map(row => <g key={row.id}><line x1={x(row)} x2={x(row)} y1={y(minimum)} y2={y(row.value)} className="gc-chart-stem" /><circle cx={x(row)} cy={y(row.value)} r={sorted.length <= 30 ? 5 : 3} className="gc-chart-dot"><title>{periodLabel(row)}: {format(row, metric)}</title></circle></g>)}<text x={left} y={height - 14}>{sorted[0].periodEnd}</text>{first !== last && <text x={width - right} y={height - 14} textAnchor="end">{sorted.at(-1)!.periodEnd}</text>}</svg><p>단위 {metric.unit} · 관측 기간의 종료일에 표시 · 기간 사이 값 미생성</p></div>;
}

function HostingDistribution({ rows, metric }: { rows: ConstraintObservation[]; metric: ConstraintMetric }) {
  const titleId = useId();
  const maximum = Math.max(...rows.map(row => row.value), 1);
  const binWidth = maximum / 10;
  const bins = Array.from({ length: 10 }, () => 0);
  for (const row of rows) bins[Math.min(9, Math.floor(row.value / binWidth))]++;
  const largestBin = Math.max(...bins, 1);
  const width = 750, height = 225, left = 48, right = 24, top = 24, bottom = 37;
  const barWidth = (width - left - right) / 10;
  const number = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return <div className="gc-distribution-chart"><div><h3>선택한 회선들의 공개 값 분포</h3><span>{marketNumber(rows.length)}개 회선 · {rows[0].utility}</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}><title id={titleId}>{metric.label}의 회선 수 분포. {bins.map((count, index) => `${number(index * binWidth)}–${number((index + 1) * binWidth)} ${metric.unit}: ${count}개`).join('; ')}. 구간 상한은 마지막 구간 외에는 포함하지 않습니다.</title><line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} className="gc-chart-grid" />{bins.map((count, index) => { const barHeight = count / largestBin * (height - top - bottom); const x = left + index * barWidth; return <g key={index}><rect x={x + 5} y={height - bottom - barHeight} width={barWidth - 10} height={barHeight} rx={3} className="gc-histogram-bar"><title>{number(index * binWidth)}–{number((index + 1) * binWidth)} {metric.unit}: {marketNumber(count)}개 회선</title></rect><text x={x + barWidth / 2} y={height - bottom - barHeight - 7} textAnchor="middle">{marketNumber(count)}</text><text x={x + barWidth / 2} y={height - bottom + 18} textAnchor="middle">{number(index * binWidth)}–{number((index + 1) * binWidth)}</text></g>; })}</svg><p>가로축 {metric.unit} · 세로축 해당 구간의 회선 수. 같은 취득 스냅샷의 분포이며, 실제 분석월은 구간마다 다릅니다. 회선별 MW를 합산하거나 현재의 물리적 혼잡률로 해석하지 않습니다.</p></div>;
}
