/** Publish reviewed load-stage evidence without changing the project database. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calendarDayKst } from '../shared/time.ts';
import { LOAD_STAGE_MODEL_VERSION, rateLoadObservation, validateLoadBottleneckDataset,
  type LoadBottleneckDataset, type LoadBottleneckSeries, type LoadBottleneckObservation,
  type LoadBottleneckSource, type LoadStage } from '../shared/load-bottleneck.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NYISO_STAGES: Record<string, LoadStage> = {
  'Scoping Meeting Pending': 'application', 'SRIS/SIS Pending': 'technical_pending',
  'SRIS/SIS in Progress': 'technical_study', 'SRIS/SIS Approved': 'technical_approved',
  'FS Pending': 'technical_approved', 'FS in Progress': 'design',
  'Accepted Cost Allocation/IA in Progress': 'agreement_pending', 'Under Construction': 'construction',
  'Rejected Cost Allocation/Next FS Pending': 'unknown',
};
interface NyisoVintage {
  id: string; dateBasis: 'archive_capture' | 'observation'; archiveCapturedAt?: string | null; observedAt?: string | null;
  sourceAsOf: string | null; publishedAt: string | null; source: LoadBottleneckSource; notes: string;
  statusCounts: Record<string, number>;
  summaries: { eligibleCount: number; ratedCount: number; ratingMean: number | null }[];
}
interface CohortVintage {
  date: string; source: LoadBottleneckSource; projectCount: number; mean: number;
  queueIds: string[]; rawStatusCounts: Record<string, number>;
  projects: { queueId: string; linkedQueueId: string; name: string; eligible: boolean; status: string; rawStatus: string; point: number }[];
}
interface Reviewed extends Pick<LoadBottleneckDataset, 'regions' | 'series' | 'limitations'> { schemaVersion: 1; }
const source = (value: LoadBottleneckSource): LoadBottleneckSource => ({
  name: value.name, url: value.url, retrievedAt: new Date(value.retrievedAt).toISOString(), sha256: value.sha256,
  ...(value.originalUrl ? { originalUrl: value.originalUrl } : {}),
});
const mapped = (raw: string) => {
  if (!Object.hasOwn(NYISO_STAGES, raw)) throw new Error(`Unreviewed historical NYISO stage: ${raw}`);
  return NYISO_STAGES[raw];
};
function nyisoSeries(id: string, fixed: boolean): LoadBottleneckSeries {
  return { id, region: 'NYISO', name: fixed ? 'NYISO · 동일 7건 추적' : 'NYISO · 공개 활성 수용가 원장',
    scopeType: fixed ? 'selected_projects' : 'operator_register', population: 'active_queue', weightBasis: 'project_count',
    scope: fixed ? '다섯 과거 원장 모두에서 활성·평가 가능했던 동일 신청 ID 7건. 완료·철회·미산출을 제외한 생존 표본이며 NYISO 전체가 아닙니다.'
      : '각 시점 NYISO 공개 원장에 남아 있는 활성 수용가 신청. 데이터센터 외 부하도 포함하며 배전·소매 고객 전수나 전국 수용가 평균이 아닙니다.',
    comparability: fixed ? '고정 7건은 신규 유입·이탈 효과를 없앤 선택 표본입니다. 모든 시점에 남아 있는 사업을 선택한 생존편향이 있으며, 점수 변화가 대기시간 변화나 권역 전체 병목 개선을 증명하지 않습니다.'
      : '전체 평균은 신규 유입·완료·철회·미산출 변화와 기존 사업의 단계 변화를 함께 반영합니다. 별도 동일 7건 계열과 비교할 수 있으나 둘을 합산하지 않습니다. 과거 포착일은 원장 전체 기준일이 아닙니다.',
    stageMappings: Object.entries(NYISO_STAGES).map(([rawStage, stage]) => ({ rawStage, stage,
      rationale: stage === 'unknown' ? '비용배분 거부 후 재검토는 확정된 진행단계가 아니므로 100점이나 기존 단계로 대체하지 않습니다.'
        : `검토된 NYISO 원문 상태를 기존 stage-proxy-v1과 같은 배점으로 재평가합니다. “${rawStage}”가 다섯 요건의 실제 진행률을 직접 증명하지는 않습니다.` })), points: [] };
}
function observation(vintage: NyisoVintage, id: string): LoadBottleneckObservation {
  const timestamp = vintage.archiveCapturedAt ?? vintage.observedAt;
  if (!timestamp) throw new Error('A real NYISO capture or observation is required.');
  return { id, date: calendarDayKst(timestamp), datePrecision: 'day', dateBasis: vintage.dateBasis,
    sourceAsOf: vintage.sourceAsOf, publishedAt: vintage.publishedAt,
    ...(vintage.dateBasis === 'archive_capture' ? { archiveCapturedAt: timestamp } : { observedAt: timestamp }),
    source: source(vintage.source), totalWeight: vintage.summaries[0].eligibleCount, completePartition: true,
    notes: [vintage.notes, '점수는 당시 저장된 원문 상태의 현재 모형 재평가이며 당시 공식 발표 점수가 아닙니다.'],
    bins: Object.entries(vintage.statusCounts).map(([rawStage, weight], index) => ({
      id: `${id}-stage-${index}`, rawStage, stage: mapped(rawStage), membership: 'active', weight, notes: [],
    })),
  };
}

export function assembleLoadBottleneck(reviewed: Reviewed, nyiso: { vintages: NyisoVintage[] },
  cohort: { vintages: CohortVintage[] }, generatedAt: string): LoadBottleneckDataset {
  if (reviewed.schemaVersion !== 1) throw new Error('Unsupported reviewed evidence format.');
  const all = nyisoSeries('nyiso-load-register', false), fixed = nyisoSeries('nyiso-load-fixed-cohort', true);
  const fixedIds = cohort.vintages[0]?.queueIds.toSorted();
  if (!fixedIds?.length || cohort.vintages.length !== nyiso.vintages.length) throw new Error('A complete fixed cohort is required.');
  for (const vintage of nyiso.vintages) {
    const point = observation(vintage, `load-${vintage.id}`);
    const rating = rateLoadObservation(all, point), expected = vintage.summaries[0];
    if (rating.ratedWeight !== expected.ratedCount || rating.point === null || expected.ratingMean === null
      || Math.abs(rating.point - expected.ratingMean) > 1e-9) throw new Error('NYISO stage bins disagree with verified original historical score.');
    all.points.push(point);
    const stamp = vintage.archiveCapturedAt ?? vintage.observedAt;
    const evidence = cohort.vintages.find(row => row.date === stamp);
    if (!evidence || JSON.stringify(evidence.queueIds.toSorted()) !== JSON.stringify(fixedIds)
      || evidence.projects.length !== fixedIds.length || evidence.projectCount !== fixedIds.length
      || new Set(evidence.projects.map(row => row.linkedQueueId)).size !== fixedIds.length
      || JSON.stringify(evidence.projects.map(row => row.linkedQueueId).toSorted()) !== JSON.stringify(fixedIds)
      || evidence.source.sha256 !== vintage.source.sha256 || evidence.projects.some(row => !row.eligible || row.status !== 'active')) {
      throw new Error('Fixed cohort IDs, source hash, or contemporaneous membership differ.');
    }
    const counts: Record<string, number> = {};
    const fixedPoint: LoadBottleneckObservation = { ...point, id: `fixed-${vintage.id}`, totalWeight: fixedIds.length,
      notes: [...point.notes, '모든 다섯 시점에서 활성·평가 가능한 신청만 선택했습니다. 생존편향이 있어 전체 신청의 평균으로 사용할 수 없습니다.',
        `동일 원장 ID: ${fixedIds.join(', ')}. 숫자 ID의 선행 0만 정규화했으며 이름 유사도로 합치지 않았습니다.`],
      bins: evidence.projects.map(row => {
        counts[row.rawStatus] = (counts[row.rawStatus] ?? 0) + 1;
        return { id: row.linkedQueueId, rawStage: row.rawStatus, stage: mapped(row.rawStatus), membership: 'active', weight: 1,
          notes: [`${row.name} · 원문 ID ${row.queueId} · 연결 ID ${row.linkedQueueId}`] };
      }),
    };
    if (Object.keys(counts).length !== Object.keys(evidence.rawStatusCounts).length
      || Object.entries(counts).some(([status, count]) => evidence.rawStatusCounts[status] !== count)
      || Math.abs(rateLoadObservation(fixed, fixedPoint).point! - evidence.mean) > 1e-9) throw new Error('Fixed cohort states or mean do not reproduce.');
    fixed.points.push(fixedPoint);
  }
  const dataset: LoadBottleneckDataset = { schemaVersion: 1, modelVersion: LOAD_STAGE_MODEL_VERSION, generatedAt,
    limitations: reviewed.limitations, regions: reviewed.regions,
    series: [...reviewed.series, all, fixed] };
  validateLoadBottleneckDataset(dataset);
  return dataset;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const read = async (name: string) => JSON.parse(await readFile(resolve(root, 'data', name), 'utf8'));
  const [reviewed, nyiso, cohort] = await Promise.all(['load-bottleneck-reviewed.json', 'history-nyiso.json', 'load-cohort-nyiso.json'].map(read));
  const existing = check ? await read('load-bottleneck.json') : null;
  const dataset = assembleLoadBottleneck(reviewed, nyiso, cohort, existing?.generatedAt ?? new Date().toISOString());
  if (check) {
    if (JSON.stringify(dataset) !== JSON.stringify(existing)) throw new Error('Published load evidence differs from reviewed inputs.');
  } else await writeFile(resolve(root, 'data/load-bottleneck.json'), JSON.stringify(dataset, null, 2) + '\n');
  console.log(JSON.stringify({ checked: check, regions: dataset.regions.length, series: dataset.series.length,
    points: dataset.series.reduce((sum, series) => sum + series.points.length, 0) }));
}
