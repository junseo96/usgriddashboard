import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, RefreshCw, Search } from 'lucide-react';
import { isLoadApiDataset, loadApiCsv, orderedLoadApiRecords, publicLoadApiUrl, type LoadApiDataset, type LoadApiRecord } from '../shared/load-api';
import { largeLoadFacilities } from '../shared/large-load-facility-data';
import './load-api.css';

const number = (value: number, digits = 2) => value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const mw = (value: number | null) => value === null ? '제공값 없음' : `${number(value / 1000, 3)} GW`;
const day = (value: string) => value.replaceAll('-', '.');
const stamp = (value: string | null) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '확인 기록 없음';
const elapsed = (value: string | null) => value ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000)) : null;
const ISSUE_LABELS: Record<string, string> = {
  stages_incomplete: '단계별 제공값 누락', stages_total_mismatch: '단계 합계와 전체 규모 차이',
  size_total_mismatch: '규모 구간 합계와 전체 규모 차이', zone_scope_unverified: '지역 구분의 포괄 범위 미확인',
  type_total_mismatch: '수용가 유형 합계와 전체 규모 차이', colocated_total_mismatch: '입지 유형 합계와 전체 규모 차이',
  trend_vintage_difference: '이 보고서에 과거월 재기재 값 포함', type_capacity_derivation_unverified: '유형별 용량의 추출·환산 방법 확인 필요',
};
const STAGES: Record<string, string> = { no_studies_submitted: '검토자료 미제출', under_ercot_review: 'ERCOT 검토 중',
  planning_studies_approved: '계획 검토 승인', approved_to_energize_not_operational: '통전 승인·운영 전', observed_energized: '실제 통전 관측' };
const epochSource = largeLoadFacilities.sources.filter(source => source.url === 'https://epoch.ai/data/data_centers/data_centers.csv').sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];
const permitSource = largeLoadFacilities.sources.filter(source => source.url.startsWith('https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Build_Out_Analysis/MapServer/9')).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];

export default function LoadApiPanel({ revision }: { revision: number }) {
  const [data, setData] = useState<LoadApiDataset | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [month, setMonth] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetch('/api/load-api', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`API 수집 이력을 불러오지 못했습니다 (${response.status}).`);
      const value: unknown = await response.json();
      if (!isLoadApiDataset(value)) throw new Error('API 수집 이력의 자료 형식을 확인하지 못했습니다.');
      if (!controller.signal.aborted) setData(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause?.message ?? cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, retry]);
  const ordered = useMemo(() => orderedLoadApiRecords(data?.records ?? []), [data]);
  const months = useMemo(() => [...new Set(ordered.map(row => row.snapshotMonth.slice(0, 7)))], [ordered]);
  const versions = useMemo(() => new Map(months.map(value => [value, ordered.filter(row => row.snapshotMonth.startsWith(value)).length])), [months, ordered]);
  const filtered = useMemo(() => ordered.filter(row => (month === 'all' || row.snapshotMonth.startsWith(month))
    && `${row.snapshotMonth} ${row.reportDate} ${row.sourceUrl} ${row.qualityIssues.map(issue => ISSUE_LABELS[issue.code] ?? issue.code).join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [ordered, month, search]);
  const latest = ordered[0];
  const selected = filtered.find(row => row.id === selectedId) ?? filtered[0];
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 12) - 1));
  const download = () => {
    const blob = URL.createObjectURL(new Blob([loadApiCsv(filtered)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = blob; link.download = 'grid-atlas-large-load-api-history.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(blob), 1000);
  };
  return <div className="load-api-panel">
    <header className="la-intro"><span className="eyebrow">LARGE LOAD · COLLECTION HISTORY</span><h3>수용가 데이터를 정기적으로 확인합니다</h3><p>새 자료와 과거 보고서의 수정값을 함께 보존합니다. 수집한 날짜와 실제 자료의 기준월을 나누어 확인하세요.</p></header>
    <nav className="la-source-shortcuts" aria-label="자동 수집 범위 바로가기"><a href="#projects/register/load"><strong>전국 여러 권역 · Epoch AI</strong><span>{epochSource ? '공개 CSV 연결' : '연결 준비'} · AI 시설 연구 표본</span></a><a href="#projects/register/load/PJM"><strong>PJM 일부 · 공공 인허가 API</strong><span>{permitSource ? '공개 API 연결' : '연결 준비'} · 건물·개발 단계</span></a><button type="button" onClick={() => document.getElementById('la-history-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><strong>ERCOT · Kardashev API</strong><span>권역 집계와 월별 보고서 이력 ↓</span></button></nav>
    {error && <div className="la-notice warning" role="alert"><CircleAlert size={18} /><div><strong>{error}</strong>{data && <p>이 화면에서 이전에 불러온 자료를 유지합니다.</p>}<button type="button" className="button compact" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />다시 불러오기</button></div></div>}
    {loading && !data ? <div className="tw-empty" role="status"><RefreshCw className="spin" size={24} /><strong>실제 수집 이력을 불러오는 중…</strong></div> : data && <>
      <div className={`la-run ${data.collection.status === 'failed' ? 'failed' : ''}`} role="status">
        {data.collection.status === 'success' ? <CheckCircle2 size={19} /> : <CircleAlert size={19} />}
        <div><strong>{data.collection.status === 'success' ? '최근 API 수집 성공' : '최근 API 수집 실패 · 이전 값 유지'}</strong><span>실제 시도 {stamp(data.collection.completedAt)} KST · 마지막 성공 {stamp(data.collection.lastSuccessAt)}{data.collection.lastSuccessAt ? ' KST' : ''}</span><small>매주 월요일 10:40 KST 확인 목표 · 원자료 갱신은 월간 또는 비정기</small></div>
        <a href="https://github.com/junseo96/usgriddashboard/actions/workflows/grid-atlas-load-api.yml" target="_blank" rel="noreferrer">실행 기록 <ExternalLink size={13} /></a>
      </div>
      {latest ? <>
        <section className="la-kpis" aria-label="ERCOT API 수집 요약">
          <article><span>ERCOT 최신 대형 부하 추적 규모</span><strong>{mw(latest.totalMw)}</strong><p>{day(latest.snapshotMonth.slice(0, 7))} 기준 · 통전 관측도 포함</p><small>개별 프로젝트 명단·점수와 다른 자료</small></article>
          <article><span>원자료 보고일</span><strong>{day(latest.reportDate)}</strong><p>보고일로부터 {number(elapsed(`${latest.reportDate}T00:00:00Z`) ?? 0, 0)}일 경과</p><small>API를 다시 확인해도 기준월은 바뀌지 않습니다.</small></article>
          <article><span>보존한 공개 시점</span><strong>{number(months.length, 0)}<small>개월</small></strong><p>{number(ordered.length, 0)}개 보고서·수정본 기록</p><small>공백 월은 추정값으로 채우지 않습니다.</small></article>
        </section>
        <div className="la-notice"><CircleAlert size={18} /><p>ERCOT 공개 보고서를 Kardashev가 추출한 <strong>권역 집계</strong>입니다. 단계·구간 합계가 전체와 다르면 차이를 표시하며, 이 API만으로 개별 프로젝트를 추가하거나 병목점수를 바꾸지 않습니다. <a href="#history">기존 검토 자료와 시계열 함께 보기 →</a></p></div>
        <section className="la-section" aria-labelledby="la-history-title">
          <div className="la-heading"><div><span className="eyebrow">MONTHS & REVISIONS</span><h3 id="la-history-title">월별 공개값과 보고서 이력</h3></div><button type="button" className="button compact" onClick={download} disabled={!filtered.length}><ArrowDownToLine size={15} />CSV 내려받기</button></div>
          <p className="la-description">같은 기준월도 보고서에 따라 값이 수정될 수 있습니다. 각 기록을 별도로 남기며 서로 더하지 않습니다.</p>
          <div className="la-filters"><label>기준월<select value={month} onChange={event => { setMonth(event.target.value); setPage(0); }}><option value="all">확보한 모든 월</option>{months.map(value => <option key={value} value={value}>{day(value)} · {versions.get(value)}개 기록</option>)}</select></label><label>보고일·출처·검토사항 검색<span><Search size={15} /><input value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="예: 2026-05, 합계" /></span></label></div>
          <div className="la-table-scroll"><table><thead><tr><th scope="col">자료 기준월</th><th scope="col">추적 규모</th><th scope="col">보고일</th><th scope="col">품질·수정 이력</th><th scope="col">원자료</th></tr></thead><tbody>{filtered.slice(effectivePage * 12, effectivePage * 12 + 12).map(row => <tr key={row.id} className={selected?.id === row.id ? 'selected' : ''}><th scope="row"><button type="button" className="la-text-button" onClick={() => setSelectedId(row.id)} aria-pressed={selected?.id === row.id}>{day(row.snapshotMonth.slice(0, 7))}</button></th><td><strong>{mw(row.totalMw)}</strong></td><td>{day(row.reportDate)}<small>최초 취득 {stamp(row.fetchedAt)} KST</small></td><td>{row.qualityIssues.length ? <span className="la-badge warning">검토사항 {row.qualityIssues.length}개</span> : <span className="la-badge">수치 형식 확인</span>}<small>{versions.get(row.snapshotMonth.slice(0, 7))}개 기록 · 원문 전체 대조 전</small></td><td><a href={publicLoadApiUrl(row.sourceUrl)} target="_blank" rel="noreferrer">ERCOT 보고서 <ExternalLink size={12} /></a><button type="button" className="la-text-button" onClick={() => setSelectedId(row.id)}>세부 값·출처 보기</button></td></tr>)}</tbody></table></div>
          {!filtered.length && <p className="la-empty">해당 조건의 자료가 없습니다. 다른 기준월이나 검색어를 선택하세요.</p>}
          <div className="la-pagination"><span>{number(filtered.length, 0)}개 기록 · CSV는 필터에 해당하는 전체 기록</span><div><button type="button" aria-label="API 이력 이전 페이지" disabled={!effectivePage} onClick={() => setPage(effectivePage - 1)}><ChevronLeft size={16} /></button><span>{effectivePage + 1} / {Math.max(1, Math.ceil(filtered.length / 12))}</span><button type="button" aria-label="API 이력 다음 페이지" disabled={(effectivePage + 1) * 12 >= filtered.length} onClick={() => setPage(effectivePage + 1)}><ChevronRight size={16} /></button></div></div>
          {selected && <RecordDetail record={selected} />}
        </section>
      </> : <div className="la-notice warning"><CircleAlert size={18} /><p>아직 성공적으로 저장한 API 관측값이 없습니다. 수집 실패를 0 MW로 표시하지 않습니다.</p></div>}
      {data.collection.warnings.length > 0 && <details className="la-details"><summary>최근 수집의 검토사항 {data.collection.warnings.length}개</summary><ul>{data.collection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </>}
    <section className="la-section" aria-labelledby="la-coverage-title"><div className="la-heading"><div><span className="eyebrow">SOURCES & COVERAGE</span><h3 id="la-coverage-title">다른 권역은 어떻게 갱신하나요?</h3></div></div><p className="la-description">전국 시설 목록과 권역 집계는 목적이 다릅니다. 아래는 실제 연결된 수집과 접근 검토 중인 API의 구분입니다.</p><div className="la-table-scroll"><table><thead><tr><th scope="col">자료원</th><th scope="col">공개 범위·용도</th><th scope="col">현재 상태</th></tr></thead><tbody>
      <tr><th scope="row">사업자·정부·산업 공개 목록</th><td>전국 데이터센터·대형 산업시설의 계획·건설·운영과 개별 근거<small>권역별 확보 범위가 다르며 신청 전수 목록이 아닙니다.</small></td><td><a href="#projects/register/load">시설·개발 원장 <ExternalLink size={12} /></a><small>별도 주간 수집 · 월요일 10:10 KST 목표</small></td></tr>
      <tr><th scope="row"><a href="https://epoch.ai/data/ai-data-centers" target="_blank" rel="noreferrer">Epoch AI <ExternalLink size={12} /></a></th><td>전국 AI 시설 연구 표본 · 공개 CSV<small>PJM·ERCOT·MISO·SPP 등 여러 권역. 시설·IT 전력 추정치는 접속 신청량과 구분합니다.</small></td><td>{epochSource ? '공개 CSV 연결 · 주간 확인' : '공개 CSV 연결 준비'}{epochSource && <small>자료 기준 {epochSource.sourceAsOf ? day(epochSource.sourceAsOf) : '미공개'}<br />실제 취득 {stamp(epochSource.retrievedAt)} KST</small>}<small><a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · 동일 시설·확장 단계를 검토해 연결</small></td></tr>
      <tr><th scope="row"><a href="https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Build_Out_Analysis/MapServer/9" target="_blank" rel="noreferrer">Prince William County <ExternalLink size={12} /></a></th><td>PJM 소재 버지니아 카운티의 데이터센터 건물·개발 단계 · 공개 GIS API<small>카운티 부분 범위입니다. 건물별 기록을 별도 캠퍼스로 세지 않으며 접속 신청 MW·통전은 미확인입니다.</small></td><td>{permitSource ? '공개 API 연결 · 주간 확인' : '공개 API 연결 준비'}{permitSource && <small>실제 취득 {stamp(permitSource.retrievedAt)} KST<br />원자료 기준일 {permitSource.sourceAsOf ? day(permitSource.sourceAsOf) : '별도 미공개'}</small>}<small>시설 원장에서 건물·확장 단계로 확인</small></td></tr>
      <tr><th scope="row"><a href="https://data.kardashevlabs.org/docs" target="_blank" rel="noreferrer">Kardashev <ExternalLink size={12} /></a></th><td>ERCOT 대형 수용가 규모·단계 집계와 과거 보고서<small>개별 고객·계약 명단은 제공하지 않습니다.</small></td><td>{data?.collection.lastSuccessAt ? 'API 연결 · 수집 이력 위에 표시' : '첫 수집 결과 확인 필요'}<small>주간 확인 · 월요일 10:40 KST 목표</small></td></tr>
      <tr><th scope="row"><a href="https://wattstreet.net/developers/" target="_blank" rel="noreferrer">Watt Street <ExternalLink size={12} /></a></th><td>BPA·NYISO 수용가 신청 목록 제공 안내<small>실제 응답의 권역별 수록 범위는 검증 전입니다.</small></td><td>인증 필요 · 자동 수집 미연결</td></tr>
      <tr><th scope="row"><a href="https://www.yesenergy.com/products/infrastructure-insights" target="_blank" rel="noreferrer">Yes Energy <ExternalLink size={12} /></a></th><td>북미 대형 부하 계획 프로젝트 DB 제공 안내</td><td>실제 데이터 접근·공개 게시 조건 확인 전</td></tr>
      <tr><th scope="row"><a href="https://interxdata.com/" target="_blank" rel="noreferrer">interXdata <ExternalLink size={12} /></a></th><td>미국·캐나다 대형 부하·규제문서 연결 제공 안내</td><td>실제 데이터 접근·지역별 수록량 확인 전</td></tr>
    </tbody></table></div><p className="la-description">PJM·MISO·CAISO·ISO-NE·SPP 등의 기존 유틸리티·규제기관·사업자 자료도 계속 사용합니다. 운영 중인 계통의 실측 부하 API는 신규 수용가의 접속 신청량과 별개입니다. <a href="#projects">권역별 프로젝트 확인 →</a></p></section>
  </div>;
}

function RecordDetail({ record }: { record: LoadApiRecord }) {
  return <section className="la-record" aria-label="선택한 API 기록의 세부 근거"><div className="la-heading"><div><span className="eyebrow">SELECTED REPORT</span><h4>{day(record.snapshotMonth.slice(0, 7))} 기준 · {day(record.reportDate)} 보고서</h4></div><strong>{mw(record.totalMw)}</strong></div>
    <dl><div><dt>앱의 실제 최초 취득 · KST</dt><dd>{stamp(record.fetchedAt)}</dd></div><div><dt>제공자가 원문을 추출한 시각 · KST</dt><dd>{stamp(record.providerExtractedAt)}{record.providerExtractedAt && <small>{elapsed(record.providerExtractedAt)}일 경과</small>}</dd></div><div><dt>원문 대조 상태</dt><dd>제공자 추출값 · 원문 전체 대조 전</dd></div></dl>
    {record.qualityIssues.length > 0 && <div className="la-quality"><h5>이 보고서의 검토사항</h5><ul>{record.qualityIssues.map((issue, index) => <li key={`${issue.code}:${index}`}><strong>{ISSUE_LABELS[issue.code] ?? '추가 검토 필요'}</strong>{issue.reportedSumMw !== undefined && issue.expectedMw !== undefined && <span>공개 구분 합계 {mw(issue.reportedSumMw)} · 보고 전체 {mw(issue.expectedMw)}</span>}<details><summary>제공값 검토 내용</summary><p>{issue.detail}</p></details></li>)}</ul><p>범위·반올림·보고서 수정의 영향을 확인해야 합니다. 차이를 임의 배분하거나 합계가 맞도록 값을 고치지 않습니다.</p></div>}
    {record.byStatus && <div className="la-stage-values"><h5>공개 단계별 용량</h5><dl>{Object.entries(record.byStatus).map(([key, value]) => <div key={key}><dt>{STAGES[key] ?? key}</dt><dd>{mw(value)}</dd></div>)}</dl><p>단계 구분이 전체 추적 규모를 모두 설명하는지 확인 전입니다. 이 표로 병목점수를 자동 계산하지 않습니다.</p></div>}
    {record.trailing12mo && Object.keys(record.trailing12mo).length > 0 && <details className="la-details"><summary>이 보고서에 재기재된 과거월 값 {Object.keys(record.trailing12mo).length}개</summary><p>아래 값은 {day(record.reportDate)} 보고서에서 과거월을 다시 제시한 값입니다. 해당 월에 발행된 보고서의 값과 다를 수 있습니다.</p><div className="la-vintage-values">{Object.entries(record.trailing12mo).sort(([a], [b]) => b.localeCompare(a)).map(([month, value]) => <div key={month}><span>{day(month)}</span><strong>{mw(value)}</strong></div>)}</div></details>}
    <details className="la-details"><summary>원문·API 취득 근거</summary><a href={publicLoadApiUrl(record.sourceUrl)} target="_blank" rel="noreferrer">ERCOT 원자료 열기 <ExternalLink size={12} /></a><a href={publicLoadApiUrl(record.receipt.url)} target="_blank" rel="noreferrer">API 출처 열기 <ExternalLink size={12} /></a><p>API 응답 취득 {stamp(record.receipt.fetchedAt)} KST</p><p>API 응답 SHA-256 <code>{record.receipt.sha256}</code></p><p>해당 보고서 값 SHA-256 <code>{record.payloadSha256}</code></p></details>
  </section>;
}
