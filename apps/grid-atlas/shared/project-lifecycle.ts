/** Retrospective per-project views of reviewed, explicitly linked identities only. */
import { LOAD_STAGE_CATALOG, type LoadBottleneckDataset, type LoadBottleneckObservation, type LoadBottleneckSource, type LoadRegion, type LoadStageDefinition } from './load-bottleneck.ts';

const NYISO_IDS = new Set(['1213', '1484', '1536', '580', '776', '850', '979']);
const DTE_NAMES: Record<string, string> = { 'oracle-saline': 'Oracle · Saline Township', 'google-van-buren': 'Google · Van Buren Township' };
const SUPPORTED = ['nyiso-load-fixed-cohort', 'bpa-explicit-mainland-loads', 'miso-dte-selected-load-projects'] as const;
const CATALOG = new Map(LOAD_STAGE_CATALOG.map(stage => [stage.stage, stage]));

export interface ProjectLifecyclePoint {
  observationId: string; date: string; datePrecision: LoadBottleneckObservation['datePrecision'];
  dateBasis: LoadBottleneckObservation['dateBasis']; sourceAsOf: string | null; publishedAt: string | null;
  archiveCapturedAt: string | null; observedAt: string | null;
  observed: boolean; rawStage: string | null; membership: string | null;
  point: number | null; definition: LoadStageDefinition | null;
  source: LoadBottleneckSource; reusedEvidence: boolean; breakBefore: boolean; notes: string[];
}
export interface ProjectLifecycle {
  id: string; projectId: string; name: string; seriesId: string; seriesName: string; region: LoadRegion;
  scope: string; comparability: string; identityRule: string; limitations: string[];
  points: ProjectLifecyclePoint[];
}

function allowedIdentity(seriesId: string, id: string): boolean {
  if (seriesId === 'nyiso-load-fixed-cohort') return NYISO_IDS.has(id);
  if (seriesId === 'bpa-explicit-mainland-loads') return /^L\d+$/.test(id);
  return seriesId === 'miso-dte-selected-load-projects' && Object.hasOwn(DTE_NAMES, id);
}

/** MW bins, anonymous cross-year AES rows and Duquesne's three-project aggregate never become individual histories. */
export function projectLifecycles(dataset: LoadBottleneckDataset): ProjectLifecycle[] {
  return SUPPORTED.flatMap(seriesId => {
    const series = dataset.series.find(row => row.id === seriesId);
    if (!series || series.weightBasis !== 'project_count') return [];
    const observations = [...series.points].sort((a, b) => a.date.localeCompare(b.date));
    const ids = [...new Set(observations.flatMap(row => row.bins.filter(bin => allowedIdentity(seriesId, bin.id)).map(bin => bin.id)))];
    return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(projectId => {
      const latestBin = observations.flatMap(row => row.bins.filter(bin => bin.id === projectId)).at(-1)!;
      const name = seriesId === 'miso-dte-selected-load-projects' ? DTE_NAMES[projectId] : latestBin.notes[0]?.split(' · ')[0] || projectId;
      const points = observations.map((observation): ProjectLifecyclePoint => {
        const matches = observation.bins.filter(bin => bin.id === projectId);
        const bin = matches.length === 1 ? matches[0] : undefined;
        const definition = bin && bin.weight === 1 ? CATALOG.get(bin.stage) ?? null : null;
        const source = bin?.source ?? observation.source;
        // A pooled snapshot may retain an earlier source for one named project.
        // Such a row is not a new confirmation or a new lifecycle event.
        const reusedEvidence = !!bin?.source && bin.source.sha256 !== observation.source.sha256;
        const earlierSourcePoint = reusedEvidence ? observations.filter(p => p.date < observation.date && p.source.sha256 === source.sha256).at(-1) : undefined;
        const scoreAllowed = !!bin && bin.weight === 1 && ['active', 'operating'].includes(bin.membership);
        return {
          observationId: observation.id, date: observation.date, datePrecision: observation.datePrecision, dateBasis: observation.dateBasis,
          sourceAsOf: bin && Object.hasOwn(bin, 'sourceAsOf') ? bin.sourceAsOf ?? null : observation.sourceAsOf,
          publishedAt: reusedEvidence ? earlierSourcePoint?.publishedAt ?? null : observation.publishedAt,
          archiveCapturedAt: reusedEvidence ? earlierSourcePoint?.archiveCapturedAt ?? null : observation.archiveCapturedAt ?? null,
          observedAt: reusedEvidence ? earlierSourcePoint?.observedAt ?? null : observation.observedAt ?? null,
          observed: !!bin, rawStage: bin?.rawStage ?? null, membership: bin?.membership ?? null,
          point: scoreAllowed ? definition?.point ?? null : null, definition: scoreAllowed ? definition : null,
          source, reusedEvidence, breakBefore: observation.breakBefore ?? false,
          notes: [...observation.notes, ...(bin?.notes ?? []),
            ...(!bin ? ['해당 시점의 선별 자료에서 이 ID를 확인하지 못했습니다. 신청 전·철회·완료 중 어느 상태인지 추정하지 않습니다.'] : []),
            ...(bin && bin.weight !== 1 ? ['해당 행이 단일 프로젝트라는 분모를 확인할 수 없어 점수를 산출하지 않습니다.'] : []),
            ...(reusedEvidence ? ['이 행은 이전 개별 근거를 재사용한 집계 시점입니다. 새로운 상태 확인이나 실제 단계 전환일이 아닙니다.'] : [])],
        };
      });
      return {
        id: `${seriesId}::${projectId}`, projectId, name, seriesId, seriesName: series.name, region: series.region,
        scope: series.scope, comparability: series.comparability,
        identityRule: seriesId === 'nyiso-load-fixed-cohort' ? '같은 NYISO 신청 ID를 확인한 고정 7건' : seriesId === 'bpa-explicit-mainland-loads' ? 'BPA 원장의 같은 L 신청 ID' : '공식 문서에서 확인한 같은 고객·사업 위치',
        limitations: [
          '과거 원문 상태에 현재 load-stage-v1 모형을 적용한 재평가입니다. 당시 발표된 점수나 당시 시스템이 알고 있던 결과가 아닙니다.',
          '다섯 요건의 배점은 단계별 모형 가정입니다. 실제 허가 취득·공정률·단계 전환일을 직접 확인한 값이 아닙니다.',
          '점 사이의 상태·점수는 보간하지 않습니다. 원문에서 사라진 ID를 운영 완료 0점이나 미진행 100점으로 바꾸지 않습니다.',
          ...(seriesId === 'nyiso-load-fixed-cohort' ? ['모든 확보 시점에 활성·평가 가능한 7건만 남긴 생존 표본입니다. 완료·철회된 프로젝트를 포함한 전체 생애주기나 권역 성과를 대표하지 않습니다.'] : []),
          ...(seriesId === 'bpa-explicit-mainland-loads' ? ['용도와 본토 주가 확인된 BPA 활성 수용가 부분집합입니다. 선별표에서 빠진 행의 이후 상태는 미확인입니다.'] : []),
          ...(seriesId === 'miso-dte-selected-load-projects' ? ['공개 계약 근거가 확인되는 두 사례입니다. 데이터센터 건물 착공을 계통보강 착공으로 바꾸지 않습니다.'] : []),
        ], points,
      };
    });
  });
}

export function lifecyclePeriod(point: Pick<ProjectLifecyclePoint, 'date' | 'datePrecision'>): string {
  if (point.datePrecision === 'year') return point.date.slice(0, 4);
  if (point.datePrecision === 'month') return point.date.slice(0, 7);
  if (point.datePrecision === 'quarter') return `${point.date.slice(0, 4)} Q${Math.floor((Number(point.date.slice(5, 7)) - 1) / 3) + 1}`;
  return point.date;
}

/** Visual guides only. Missing records, reused evidence and disclosed breaks interrupt a segment. */
export function lifecycleSegments(project: ProjectLifecycle): [ProjectLifecyclePoint, ProjectLifecyclePoint][] {
  return project.points.flatMap((point, i) => {
    const previous = project.points[i - 1];
    return previous && previous.point !== null && point.point !== null && !previous.reusedEvidence && !point.reusedEvidence && !point.breakBefore ? [[previous, point] as [ProjectLifecyclePoint, ProjectLifecyclePoint]] : [];
  });
}

export function projectLifecycleCsv(project: ProjectLifecycle): string {
  const headers = ['series_id', 'project_id', 'project_name', 'region', 'period', 'date_precision', 'date_basis', 'observed', 'reused_evidence', 'raw_stage', 'membership', 'model_score', 'technical_points', 'commercial_points', 'permitting_points', 'construction_points', 'energization_points', 'model_version', 'source_as_of', 'published_at', 'archive_captured_at', 'observed_at', 'source_url', 'source_retrieved_at', 'source_sha256', 'notes'];
  const quote = (value: unknown) => {
    const raw = value === null || value === undefined ? '' : String(value);
    const safe = typeof value === 'string' && /^[\s]*[=+\-@]|^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = project.points.map(point => [project.seriesId, project.projectId, project.name, project.region, lifecyclePeriod(point), point.datePrecision, point.dateBasis, point.observed, point.reusedEvidence, point.rawStage, point.membership, point.point,
    ...['technical', 'commercial', 'permitting', 'construction', 'energization'].map(gate => point.definition?.gates.find(item => item.gate === gate)?.points ?? null),
    'load-stage-v1', point.sourceAsOf, point.publishedAt, point.archiveCapturedAt, point.observedAt, point.source.url, point.source.retrievedAt, point.source.sha256, [...project.limitations, ...point.notes].join(' | ')].map(quote).join(','));
  return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
}
