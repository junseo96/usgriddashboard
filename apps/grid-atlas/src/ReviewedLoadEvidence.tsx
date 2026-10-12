import { ExternalLink, FileCheck2 } from 'lucide-react';
import { matchingReviewedLoadProject, type ReviewedLoadDataset } from '../shared/reviewed-load-projects';
import reviewedJson from '../data/reviewed-load-projects.json';
import type { Project } from '../shared/types';
import './reviewed-load.css';
import { projectStatusReviews } from '../shared/project-status-review-data';
import { latestProjectStatusReviews } from '../shared/project-status-reviews';

const originalReviewed = reviewedJson as unknown as ReviewedLoadDataset;
const statusReviews = latestProjectStatusReviews(projectStatusReviews);
const reviewed = { ...originalReviewed, projects: originalReviewed.projects.map(p => statusReviews.get(p.id)?.project ?? p) };
const safeUrl = (raw: string) => { try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const time = (raw: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(raw)) + ' KST';
const BASIS = { requested_grid_mw: '공식 요청 부하', contracted_grid_mw: '전력공급 계약 수요', unknown: '용량 미확인' };

export function ReviewedLoadScope({ region, onProject }: { region: string; onProject?: (id: string) => void }) {
  const projects = reviewed.projects.filter(project => !region || project.region === region);
  if (!projects.length) return <div className="reviewed-load-empty">이 권역의 주 규제기관 개별 사건 연결은 추가 조사 중입니다. 사업이 없다는 뜻은 아닙니다.</div>;
  const groups = reviewed.sources.flatMap(source => {
    const rows = projects.filter(project => project.sourceId === source.id);
    return rows.length ? [{ source, rows, active: rows.filter(project => project.eligible).length }] : [];
  });
  const cases = projects.filter(project => reviewed.reviews.some(review => review.projectId === project.id && review.identityBasis !== 'official_service_request'));
  return <section className="reviewed-load-scope" aria-label="수용가 신청과 주 규제기관 사건 연결 범위">
    <header><FileCheck2 size={20} /><div><h2>전력공급 요청 · 주 규제기관 사건을 연결한 원장</h2><p>NYISO 외에도 공식 서비스 요청번호와 개별 공급계약 사건으로 사업을 식별합니다.</p></div></header>
    <p>접속·전력공급 신청은 주로 유틸리티가 접수하고, 주 PUC·PSC는 특별 공급계약·요금·전력설비 등을 심사합니다. 부지·건축 허가만으로 접속 신청을 확인하지 않으며, 같은 사업의 여러 문서를 별도 프로젝트로 늘리지 않습니다.</p>
    <div className="reviewed-source-grid">{groups.map(({ source, rows, active }) => <article key={source.id}><strong>{source.name}</strong><span>{rows[0].region} · {rows.length.toLocaleString('ko-KR')}개 검토 기록</span><b>자료 기준 활성 신청·계약 {active.toLocaleString('ko-KR')}건</b><small>종료·중복 가능·참고 {rows.length - active}건 · 점수 유무 별도</small><small>원자료 {source.sourceAsOf || '개별 문서 기준'} · 새 확인일과 구분</small></article>)}</div>
    <p className="reviewed-scope-note">위 숫자는 검토해 연결한 출처별 기록입니다. 서로 다른 기준일을 포함하며 전국 수용가 전수나 현재 동시 대기량이 아닙니다. ‘진행 중’만 공개된 요청은 100점으로 채우지 않고 미산출로 둡니다.</p>
    {cases.length > 0 && <details><summary>주 규제기관·공급계약의 개별 사업 {cases.length}건</summary><div className="reviewed-case-list">{cases.map(project => {
      const review = reviewed.reviews.find(row => row.projectId === project.id)!;
      return <article key={project.id}>{onProject ? <button className="text-button" onClick={() => onProject(project.id)}>{project.name}</button> : <strong>{project.name}</strong>}<span>{review.authority} · {review.docketId || '개별 문서 식별'} · {project.state}</span><p>{project.rawStatus}</p>{!project.eligible && <small>활성 집계 제외: {project.exclusionReason}</small>}</article>;
    })}</div></details>}
  </section>;
}

export function ReviewedLoadEvidence({ project }: { project: Project }) {
  const review = matchingReviewedLoadProject(project);
  if (!review) return null;
  return <section className="reviewed-load-evidence" aria-label="개별 신청과 규제기관 원문 검증">
    <h3>신청·공급계약의 식별 근거</h3><dl><div><dt>기관</dt><dd>{review.authority}</dd></div><div><dt>사건·요청번호</dt><dd>{review.docketId || project.sourceRecordId}</dd></div><div><dt>MW의 의미</dt><dd>{BASIS[review.capacityBasis]}</dd></div></dl>
    {review.identityBasis === 'inferred_single_site_connection' && <p className="inference-note">개별 고객 공급설비·증설계획으로 접속 진행을 추정한 기록입니다. 고객 신청서나 공급계약 체결을 직접 확인한 기록과 구분합니다.</p>}
    <p>{review.stageRationale}</p><ul>{review.limitations.map(note => <li key={note}>{note}</li>)}</ul>
    {review.sourceEvidence.map((evidence, index) => <details key={`${evidence.sha256}-${index}`}><summary>{evidence.name}</summary><p>{evidence.excerpt}</p><small>원자료 {evidence.sourceAsOf || '미공개'} · 공개 {evidence.publishedAt || '미확인'}<br />실제 확인 {time(evidence.retrievedAt)}</small><a className="source-link" href={safeUrl(evidence.url)} target="_blank" rel="noreferrer">기관 원문 열기<ExternalLink size={12} /></a></details>)}
  </section>;
}
