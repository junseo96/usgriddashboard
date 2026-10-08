import { useMemo } from 'react';
import { ArrowUpRight, CircleHelp } from 'lucide-react';
import { resolveRegionalPipelines, type ResolvedRegionalPipeline } from '../shared/regional-pipeline';
import type { DemandDataset, LoadPipelineDataset, MarketRegion, PipelineAggregate } from '../shared/market-types';
import type { MarketComparison } from '../shared/market';
import { CAPACITY_LABELS, externalUrl, formatGw, marketDate, marketNumber, qualifiedGw } from './market-format';
import './market.css';

interface Props {
  pipeline: LoadPipelineDataset | null;
  comparison: MarketComparison | null;
  demand?: DemandDataset | null;
  selectedRegion?: MarketRegion;
  onChoose?: (region: MarketRegion) => void;
}
const coverageLabels: Record<ResolvedRegionalPipeline['coverage'], string> = {
  operator_requests: '운영기관 요청 집계', partial_pipeline: '일부 사업자·사업 범위', register_only: '공개 신청 원장 범위', unavailable: '공개 규모 미확보',
};

export default function RegionalPipelinePanel({ pipeline, comparison, demand, selectedRegion, onChoose }: Props) {
  const rows = useMemo(() => pipeline ? resolveRegionalPipelines(pipeline) : [], [pipeline]);
  return <section className="panel regional-pipeline-panel" aria-label="ISO/RTO별 수용가 요청·파이프라인">
    <div className="panel-heading"><div><span className="eyebrow">REGIONAL LOAD PIPELINE</span><h2>ISO/RTO별 수용가 요청·파이프라인</h2></div><span className="regional-unit">용량 GW · 전국 합산 안 함</span></div>
    <p className="regional-intro">개별 명단이 없는 권역도 공식 집계와 사업자 공시로 규모를 확인합니다. <strong>수용가 열의 공개 범위와 지표를 함께 비교하세요.</strong> 발전·저장은 같은 ISO/RTO의 공개 활성 신청입니다.</p>
    {!pipeline ? <div className="regional-loading" role="status">권역별 공개 파이프라인을 불러오는 중…</div> : <>
      <div className="regional-coverage-legend"><span className="regional-coverage operator_requests">운영기관 요청 집계</span><span className="regional-coverage partial_pipeline">일부 사업자·계획·계약</span><span className="regional-coverage register_only">공개 신청 원장</span><span>집계 범위가 서로 다르며, 부분 자료를 권역 전체로 대체하지 않습니다.</span></div>
      <div className="regional-table-wrap"><table className="regional-pipeline-table"><thead><tr><th>ISO / RTO</th><th>수용가 요청·파이프라인 <span>공개 범위를 함께 표시</span></th><th>발전 신청 <span>명판 용량</span></th><th>저장 신청 <span>출력 용량</span></th>{demand && <th>실제 계통 부하 <span>관측·일 피크</span></th>}</tr></thead><tbody>{rows.map(row => {
        const capacity = comparison?.regions.find(item => item.region === row.region);
        const observed = demand?.regions.find(item => item.region === row.region);
        const completePeak = [...(observed?.dailyPeaks ?? [])].filter(item => item.complete).sort((a, b) => b.date.localeCompare(a.date))[0];
        const headline = row.headline;
        return <tr key={row.region} className={selectedRegion === row.region ? 'regional-selected' : ''}>
          <th scope="row">{onChoose ? <button aria-pressed={selectedRegion === row.region} onClick={() => onChoose(row.region)}>{row.region}<ArrowUpRight size={13} /></button> : <strong>{row.region}</strong>}</th>
          <td className="regional-load-cell"><div className="regional-load-main"><strong className={`regional-load-value ${headline?.capacityMw == null ? 'is-missing' : ''}`}>{headline ? qualifiedGw(headline) : '미확보'}{headline?.capacityMw != null && <small>GW</small>}</strong><span className={`regional-coverage ${row.coverage}`}>{coverageLabels[row.coverage]}</span></div><strong className="regional-scope">{row.scopeLabel}</strong><span className="regional-metric-label">{row.metricLabel}</span>{headline && <div className="regional-primary-source"><a href={externalUrl(headline.sourceUrl)} target="_blank" rel="noreferrer">{headline.sourceName}<ArrowUpRight size={11} /></a><span>원자료 {marketDate(headline.sourceAsOf, false)}</span></div>}{row.coverage !== 'operator_requests' && <span className="regional-scope-gap">{row.coverage === 'register_only' ? '공개 원장 밖의 신청은 미포함' : 'ISO/RTO 전체 접속요청 합계는 미확보'}</span>}<details className="regional-evidence"><summary>공개 범위·근거{row.additional.length ? `와 추가 지표 ${row.additional.length}개` : ''}</summary><p>{row.explanation}</p>{headline && <IndicatorEvidence item={headline} headline />}{row.additional.length > 0 && <><p className="regional-additional-note">같은 지역의 다른 공개 지표입니다. 서로 겹칠 수 있어 위 값이나 아래 값끼리 더하지 않습니다.</p>{row.additional.map(item => <IndicatorEvidence key={item.id} item={item} />)}</>}</details></td>
          {(['generation', 'storage'] as const).map(type => { const mw = capacity?.[`${type}Count`] ? capacity[`${type}Mw`] : null; return <td key={type} className="regional-capacity-cell" data-label={type === 'generation' ? '발전 신청 · 명판' : '저장 신청 · 출력'}><strong>{formatGw(mw)}{mw !== null && <small>GW</small>}</strong><span>{capacity?.[`${type}Count`] ? `${marketNumber(capacity[`${type}Count`])}개 활성 신청` : '공개 원장 미확보'}</span><small>공개 원자료 {capacity?.sourceAsOf.length ? capacity.sourceAsOf.map(date => marketDate(date, false)).join(', ') : '미공개'}</small></td>; })}
          {demand && <td className="regional-demand-cell" data-label="실제 계통 부하"><strong>{formatGw(observed?.latestMw)}{observed?.latestMw != null && <small>GW</small>}</strong><span>{observed?.observedAt ? `${marketDate(observed.observedAt)} KST` : '관측 미확보'}</span>{observed?.intervalMinutes && <small>{observed.intervalMinutes}분 관측 간격</small>}<div><span>최근 완전한 일 피크</span><strong>{formatGw(completePeak?.peakMw)}{completePeak && <small>GW</small>}</strong><small>{completePeak ? `${completePeak.date} · 시장 현지일` : '완전한 하루 미확보'}</small></div></td>}
        </tr>;
      })}</tbody></table></div>
      <div className="regional-footnote"><CircleHelp size={15} /><p>공시된 요청, 계획·계약, 공개 신청 원장은 범위와 단계가 다릅니다. 동일 물리 사업의 중복 대조가 끝나지 않아 권역 간 전국 합계도 산출하지 않습니다. 발전·저장 용량과 실제 소비·공급 전망으로 합산하지 않습니다.</p></div>
    </>}
  </section>;
}

function IndicatorEvidence({ item, headline = false }: { item: PipelineAggregate; headline?: boolean }) {
  return <article className={`regional-indicator ${headline ? 'is-headline' : ''}`}><div><strong>{item.name}</strong>{!headline && <span>{qualifiedGw(item)}{item.capacityMw !== null && ' GW'}</span>}</div><p>{item.scope}</p><span className="regional-indicator-basis">{CAPACITY_LABELS[item.capacityBasis]}{item.projectCount !== null && ` · ${marketNumber(item.projectCount)}건`}</span>{item.caveats.length > 0 && <ul>{item.caveats.map(caveat => <li key={caveat}>{caveat}</li>)}</ul>}<div className="regional-indicator-source"><a href={externalUrl(item.sourceUrl)} target="_blank" rel="noreferrer">{item.sourceName}<ArrowUpRight size={12} /></a><span>원자료 {marketDate(item.sourceAsOf, false)} · 확인 {marketDate(item.checkedAt)}{item.checkedAt?.includes('T') ? ' KST' : ''}</span></div></article>;
}
