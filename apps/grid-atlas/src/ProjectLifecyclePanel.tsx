import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowDownToLine, CircleHelp, ExternalLink, RefreshCw, Route } from 'lucide-react';
import { validateLoadBottleneckDataset, type LoadBottleneckDataset } from '../shared/load-bottleneck';
import { lifecyclePeriod, lifecycleSegments, projectLifecycleCsv, projectLifecycles, type ProjectLifecycle, type ProjectLifecyclePoint } from '../shared/project-lifecycle';
import './project-lifecycle.css';

const number = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const scoreText = (value: number | null) => value === null ? '미산출' : `${number(value)}점`;
const dateBasis = { source_as_of: '원자료 기준', publication: '공개일', archive_capture: '보관본 포착일', observation: '실제 취득일' };
const gates = [{ id: 'technical', name: '기술 검토' }, { id: 'commercial', name: '계약·비용 보증' }, { id: 'permitting', name: '부지·인허가' }, { id: 'construction', name: '설비·계통 보강' }, { id: 'energization', name: '통전·운영 승인' }];
const stamp = (value: string | null) => !value ? '미확인' : value.includes('T') ? `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))} KST` : value;
const safeUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };

export default function ProjectLifecyclePanel({ revision, region: initialRegion }: { revision: number; region?: string }) {
  const [dataset, setDataset] = useState<LoadBottleneckDataset | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [region, setRegion] = useState(initialRegion || 'NYISO');
  const [projectId, setProjectId] = useState('nyiso-load-fixed-cohort::1484');
  const [pointId, setPointId] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setError('');
    fetch('/api/load-bottleneck', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`프로젝트 이력 조회 실패 (${response.status})`);
      const value: unknown = await response.json(); validateLoadBottleneckDataset(value); setDataset(value);
    }).catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, [revision, retry]);
  const histories = useMemo(() => dataset ? projectLifecycles(dataset) : [], [dataset]);
  const regions = [...new Set(histories.map(project => project.region))];
  const available = histories.filter(project => !region || project.region === region);
  const project = available.find(row => row.id === projectId) ?? available[0];
  const selected = project?.points.find(row => row.observationId === pointId) ?? project?.points.at(-1);
  const download = () => {
    if (!project) return;
    const url = URL.createObjectURL(new Blob([projectLifecycleCsv(project)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `grid-atlas-lifecycle-${project.projectId}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!dataset) return <section className="panel lifecycle-empty" role={error ? 'alert' : 'status'}>{error ? <><h2>프로젝트 이력을 불러오지 못했습니다</h2><p>{error}</p><button className="button primary" onClick={() => setRetry(value => value + 1)}>다시 불러오기</button></> : <><RefreshCw className="spin" size={20} />공식 원문에 남은 프로젝트별 단계를 불러오는 중…</>}</section>;
  return <div className="project-lifecycle-view">
    <section className="lifecycle-intro"><Route size={27} /><div><span className="eyebrow">PROJECT LIFECYCLE · HISTORICAL REASSESSMENT</span><h2>같은 프로젝트가 어떻게 진행됐는가</h2><p>확인된 같은 신청 ID·사업을 따라가며, 과거 원문 상태에 현재 모형을 적용한 점수와 다섯 요건의 잔여 배점을 비교합니다.</p></div></section>
    <div className="lifecycle-caveat"><CircleHelp size={19} /><p><strong>확보한 과거 시점의 재평가입니다.</strong> 실제 단계 전환일이나 신청부터 운영까지의 전 생애주기를 모두 확보한 것은 아닙니다. 미관측 시점은 비워 두며, 원문에서 사라졌다고 완료로 간주하지 않습니다.</p></div>
    {error && <p className="market-error" role="alert">{error} 이전 조회 자료를 표시합니다.</p>}
    <section className="lifecycle-controls"><label>확보 범위<select aria-label="프로젝트 이력 권역" value={region} onChange={event => { setRegion(event.target.value); setPointId(''); }}><option value="">전체 확보 범위</option>{regions.map(value => <option key={value} value={value}>{value === 'West' ? 'West · BPA 선별 원장' : value === 'MISO' ? 'MISO · DTE 2건' : 'NYISO · 고정 7건'}</option>)}{region && !regions.includes(region as typeof regions[number]) && <option value={region}>{region} · 개별 이력 미확보</option>}</select></label><label className="lifecycle-project-select">프로젝트<select aria-label="생애주기 프로젝트 선택" value={project?.id ?? ''} disabled={!available.length} onChange={event => { setProjectId(event.target.value); setPointId(''); }}>{available.map(row => <option key={row.id} value={row.id}>{row.projectId} · {row.name}</option>)}</select></label><button className="button compact" disabled={!project} onClick={download}><ArrowDownToLine size={15} />프로젝트 이력 CSV</button></section>
    {project && selected ? <>
      <section className="panel lifecycle-chart-panel"><div className="panel-heading"><div><span className="eyebrow">{project.region} · {project.projectId}</span><h2>{project.name}</h2><p>{project.identityRule}</p></div><div className="lifecycle-observation-count"><strong>{project.points.filter(row => row.observed && !row.reusedEvidence).length}</strong><span>개별 근거 시점</span></div></div><p className="lifecycle-scope">{project.scope}</p><LifecycleChart project={project} selectedId={selected.observationId} onSelect={setPointId} /><p className="lifecycle-chart-note">점은 공개·보관·취득 시점입니다. 점선은 비교 안내이며 중간 점수·실제 전환일을 추정하지 않습니다. 아래 표에서 정확한 날짜와 근거를 확인할 수 있습니다.</p></section>
      <section className="panel lifecycle-detail"><div className="panel-heading"><div><span className="eyebrow">선택 시점 · {dateBasis[selected.dateBasis]}</span><h2>{lifecyclePeriod(selected)} <span>{scoreText(selected.point)}</span></h2></div><label>자료 시점<select aria-label="프로젝트 이력 시점" value={selected.observationId} onChange={event => setPointId(event.target.value)}>{project.points.map(row => <option key={row.observationId} value={row.observationId}>{lifecyclePeriod(row)} · {row.observed ? scoreText(row.point) : '미관측'}{row.reusedEvidence ? ' · 이전 근거 재사용' : ''}</option>)}</select></label></div><p className="lifecycle-raw-stage">{selected.observed ? <>원문 상태 <strong>{selected.rawStage}</strong></> : '해당 선별 원문에서 이 프로젝트를 확인하지 못했습니다.'}{selected.reusedEvidence && <span className="lifecycle-reused">이전 근거 재사용 · 새 상태 확인 아님</span>}</p><div className="lifecycle-gates">{gates.map(gate => { const value = selected.definition?.gates.find(row => row.gate === gate.id); return <article key={gate.id}><span>{gate.name}</span><strong>{value ? number(value.points) : '—'}<small> / 20</small></strong><div className="lifecycle-gate-track"><span style={{ width: `${value ? value.points / 20 * 100 : 0}%` }} /></div><small>{value ? `모형 진행률 ${number(value.progress * 100)}%` : '단계·분모 미확인'}</small></article>; })}</div><p className="lifecycle-model-note">다섯 배점과 진행률은 원문 단계에 배정한 모형 가정이며, 실제 허가·공정률의 직접 확인이 아닙니다. {selected.definition?.rationale}</p><details className="lifecycle-source-detail"><summary>해당 시점의 원문·날짜·모형 해석</summary><a className="source-link" href={safeUrl(selected.source.url)} target="_blank" rel="noreferrer">{selected.source.name}<ExternalLink size={13} /></a><p>원자료 기준 {stamp(selected.sourceAsOf)} · 공개 {stamp(selected.publishedAt)}<br />보관본 포착 {stamp(selected.archiveCapturedAt)} · 관측 {stamp(selected.observedAt)}<br />실제 취득 {stamp(selected.source.retrievedAt)}</p><ul>{selected.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details></section>
      <section className="panel lifecycle-table"><div className="panel-heading"><h2>시점별 절차 배점과 원문 상태</h2><span>요건당 0–20점 · 합계 0–100점</span></div><div className="table-scroll"><table><thead><tr><th>자료 시점</th><th>합계</th>{gates.map(gate => <th key={gate.id}>{gate.name}</th>)}<th>원문 상태·근거</th></tr></thead><tbody>{project.points.map(row => <tr key={row.observationId} className={selected.observationId === row.observationId ? 'selected' : ''}><td><button className="text-button" aria-pressed={selected.observationId === row.observationId} onClick={() => setPointId(row.observationId)}>{lifecyclePeriod(row)}</button><small>{dateBasis[row.dateBasis]}</small>{row.reusedEvidence && <small>이전 근거 재사용</small>}</td><td><strong>{row.observed ? scoreText(row.point) : '미관측'}</strong></td>{gates.map(gate => <td key={gate.id}>{row.definition?.gates.find(item => item.gate === gate.id)?.points ?? '—'}</td>)}<td>{row.rawStage ?? '해당 ID 미관측 · 이후 상태 미확인'}<small><a className="source-link" href={safeUrl(row.source.url)} target="_blank" rel="noreferrer">{row.observed ? '개별 상태 원문' : '당시 선별표 원문'}<ExternalLink size={12} /></a></small></td></tr>)}</tbody></table></div></section>
      <aside className="lifecycle-limitations"><h3>이 프로젝트 이력의 범위</h3><p>{project.comparability}</p><ul>{project.limitations.map(note => <li key={note}>{note}</li>)}</ul><p>MW 집계, 서로 연결되지 않은 익명 사이트, 3건을 묶은 집계는 가상의 개별 프로젝트 이력으로 만들지 않습니다.</p></aside>
    </> : <section className="panel lifecycle-empty"><h2>이 권역의 개별 프로젝트 이력은 미확보입니다</h2><p>현재 확인된 NYISO·BPA·DTE 범위에서 선택할 수 있습니다. 권역 총량이나 전망으로 프로젝트의 과거 단계를 추정하지 않습니다.</p></section>}
  </div>;
}

function LifecycleChart({ project, selectedId, onSelect }: { project: ProjectLifecycle; selectedId: string; onSelect: (id: string) => void }) {
  const titleId = useId();
  const min = Date.parse(project.points[0].date), max = Date.parse(project.points.at(-1)!.date);
  const x = (point: ProjectLifecyclePoint) => min === max ? 440 : 65 + (Date.parse(point.date) - min) / (max - min) * 750;
  const y = (point: ProjectLifecyclePoint) => 228 - (point.point ?? 0) * 1.8;
  return <div className="lifecycle-chart-scroll"><svg className="lifecycle-chart" viewBox="0 0 880 292" role="img" aria-labelledby={titleId}><title id={titleId}>{project.name}의 확인된 시점별 병목점수. 아래 표에서 모든 값과 출처를 확인할 수 있습니다.</title>{[0, 20, 40, 60, 80, 100].map(value => <g key={value}><line x1="65" x2="815" y1={228 - value * 1.8} y2={228 - value * 1.8} className="lifecycle-grid-line" /><text x="47" y={233 - value * 1.8} textAnchor="end" className="lifecycle-axis-label">{value}</text></g>)}{lifecycleSegments(project).map(([a, b]) => <line key={b.observationId} x1={x(a)} y1={y(a)} x2={x(b)} y2={y(b)} className="lifecycle-trend-line" />)}{project.points.map((point, index) => <g key={point.observationId}>{point.point === null ? <><text x={x(point)} y="252" textAnchor="middle" className="lifecycle-missing-label">{point.observed ? '미산출' : '미관측'}</text><line x1={x(point) - 4} x2={x(point) + 4} y1="225" y2="233" className="lifecycle-missing-cross" /><line x1={x(point) - 4} x2={x(point) + 4} y1="233" y2="225" className="lifecycle-missing-cross" /></> : <><circle cx={x(point)} cy={y(point)} r={point.observationId === selectedId ? 7 : 5} className={`lifecycle-point ${point.reusedEvidence ? 'reused' : ''}`} role="button" tabIndex={0} aria-label={`${lifecyclePeriod(point)} ${scoreText(point.point)}${point.reusedEvidence ? ' 이전 근거 재사용' : ''}`} onClick={() => onSelect(point.observationId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.observationId); } }} />{!point.reusedEvidence && <text x={x(point)} y={y(point) - 14 - (index % 2) * 18} textAnchor="middle" className="lifecycle-value-label">{number(point.point)}</text>}</>}{(index === 0 || index === project.points.length - 1) && <text x={x(point)} y="280" textAnchor={index === 0 ? 'start' : 'end'} className="lifecycle-axis-label">{lifecyclePeriod(point)}</text>}</g>)}</svg></div>;
}
