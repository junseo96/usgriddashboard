/** Source-scoped load-stage indices, separate from individual project assessments. */
import { GATES, type Gate } from './types.ts';
import { MARKET_REGIONS } from './market-types.ts';
import { calendarDayKst, isCalendarDay } from './time.ts';

export const LOAD_STAGE_MODEL_VERSION = 'load-stage-v1' as const;
export const LOAD_REGIONS = [...MARKET_REGIONS, 'West', 'Southeast'] as const;
export type LoadRegion = typeof LOAD_REGIONS[number];
export type LoadStage = 'unknown' | 'application' | 'feasibility' | 'preliminary_engineering'
  | 'technical_pending' | 'technical_study' | 'technical_approved' | 'design'
  | 'agreement_pending' | 'agreement' | 'construction' | 'energization_approved' | 'partial_energization' | 'operating' | 'withdrawn';
export interface LoadStageDefinition {
  stage: LoadStage; label: string; point: number | null;
  gates: { gate: Gate; progress: number; points: number }[]; rationale: string;
}
export interface LoadBottleneckSource { name: string; url: string; retrievedAt: string; sha256: string; originalUrl?: string; }
export interface LoadBottleneckBin {
  id: string; rawStage: string; stage: LoadStage; membership: 'active' | 'operating' | 'withdrawn' | 'unresolved';
  weight: number | null; notes: string[]; source?: LoadBottleneckSource; sourceAsOf?: string | null;
}
export interface LoadBottleneckObservation {
  id: string; date: string; datePrecision: 'day' | 'month' | 'quarter' | 'year';
  dateBasis: 'source_as_of' | 'publication' | 'archive_capture' | 'observation';
  sourceAsOf: string | null; publishedAt: string | null; archiveCapturedAt?: string | null; observedAt?: string | null;
  source: LoadBottleneckSource; bins: LoadBottleneckBin[]; totalWeight: number | null; completePartition: boolean;
  breakBefore?: boolean; notes: string[];
}
export interface LoadBottleneckSeries {
  id: string; name: string; region: LoadRegion;
  scopeType: 'operator_register' | 'operator_aggregate' | 'utility_subset' | 'selected_projects';
  population: 'active_queue' | 'tracked_pool' | 'contract_subset' | 'selected_projects';
  weightBasis: 'project_count' | 'capacity_mw'; scope: string; comparability: string;
  stageMappings: { rawStage: string; stage: LoadStage; rationale: string }[];
  points: LoadBottleneckObservation[];
}
export interface LoadBottleneckDataset {
  schemaVersion: 1; modelVersion: typeof LOAD_STAGE_MODEL_VERSION; generatedAt: string; limitations: string[];
  regions: { region: LoadRegion; headlineSeriesId: string | null; gaps: string[] }[];
  series: LoadBottleneckSeries[];
}
export interface LoadBottleneckRating {
  point: number | null; trackedPoint: number | null;
  activeWeight: number | null; ratedWeight: number; unknownWeight: number | null;
  operatingWeight: number | null; withdrawnWeight: number | null; unresolvedWeight: number | null;
  totalWeight: number | null; coverage: number | null;
  trackedRatedWeight: number; trackedUnknownWeight: number | null; reasons: string[];
}
export interface LoadBottleneckFilters { region?: string; seriesId?: string; start?: string; end?: string; }
function stage(stage: LoadStage, label: string, progress: readonly number[] | null, rationale: string): LoadStageDefinition {
  const gates = progress === null ? [] : GATES.map((gate, index) => ({ gate, progress: progress[index], points: 20 * (1 - progress[index]) }));
  return { stage, label, gates, point: progress === null ? null : gates.reduce((sum, gate) => sum + gate.points, 0), rationale };
}
export const LOAD_STAGE_CATALOG: readonly LoadStageDefinition[] = [
  stage('unknown', '단계 판단 불가', null, '공개 상태로 단계 위치를 판단할 수 없어 점수를 부여하지 않습니다.'),
  stage('application', '신청·현재 검토 진입 대기', [0, 0, 0, 0, 0], '현재 검토 진입 전 구간의 대표 잔여점수 100점이라는 모형 가정입니다. 연구 미제출에는 재분류·반려가 포함될 수 있어 실제 모든 요건의 미진행을 확인한 뜻이 아닙니다.'),
  stage('feasibility', '타당성 연구', [.25, .25, 0, 0, 0], '초기 타당성 연구를 기술·상업 각각 25%의 모형 위치로 둡니다.'),
  stage('preliminary_engineering', '신청·예비설계 혼합', [.25, .25, 0, 0, 0], '신청과 예비설계가 합쳐진 공개 구간을 초기 단계 90점으로 대표합니다. 구간 내 모든 신청의 연구 착수나 실제 설계 진행률을 확인한 뜻이 아닙니다.'),
  stage('technical_pending', '계통영향 연구 대기', [.5, .25, 0, 0, 0], '계통영향 연구 대기의 상대적 위치를 85점으로 두며 연구 완료를 가정하지 않습니다.'),
  stage('technical_study', '기술·계통영향 연구', [.5, .25, .25, 0, 0], '기술 연구 구간의 모형 위치입니다. 인허가 25%는 비교를 위한 가정이며 허가 진행의 직접 근거가 아닙니다.'),
  stage('technical_approved', '기술 연구 승인', [.75, .25, .25, 0, 0], '공개된 연구 승인을 기술 75%의 모형 위치로 두며 접속계약이나 비용보증 완료로 바꾸지 않습니다.'),
  stage('design', '시설연구·상세설계', [.75, .5, .25, 0, 0], '시설연구·상세설계를 기술 75%·상업 50%의 모형 위치로 둡니다. 실제 공사·인허가 완료가 아닙니다.'),
  stage('agreement_pending', '계약·비용 협의', [1, .75, .5, 0, 0], '계약·비용 협의의 모형 위치 55점이며 기술·인허가 진행률도 직접 확인 사실이 아닌 가정입니다.'),
  stage('agreement', '계약·확약 기준 충족', [1, 1, .5, 0, 0], '공개된 접속계약 또는 해당 출처의 확약 기준 충족을 50점으로 대표합니다. 출처별 법적 계약의 동일성이나 모든 허가 완료를 뜻하지 않습니다.'),
  stage('construction', '접속 관련 공사', [1, 1, 1, .75, 0], '공사 구간의 대표 잔여점수 25점입니다. 75%는 실제 공정률이 아니며 다섯 요건별 완료 사실이 아닙니다.'),
  stage('energization_approved', '통전 허가', [1, 1, 1, 1, 0], '통전 허가 이후 실제 통전·운영 확인을 남은 최종 요건으로 두는 모형 20점입니다. 운영 포함 여부는 별도 분류하며 허가만으로 가동을 확정하지 않습니다.'),
  stage('partial_energization', '부분 통전·수요 증가 중', [1, 1, 1, 1, .5], '일부 전력공급·수요 증가 중인 공개 구간을 추적군 지수에서 10점으로 대표합니다. 최종 요건 50%는 실제 통전율·수요 증가율이 아닌 모형 가정입니다. 완전 운영 0점으로 바꾸지 않으며 순수 미통전 활성 신청으로 분류하지 않습니다.'),
  stage('operating', '실제 통전·운영 확인', [1, 1, 1, 1, 1], '운영 구간은 활성 신청 점수에서 제외합니다. 추적 집단 지표에서만 0점이며 관측 소비 MW가 전체 계약용량을 뜻하지 않을 수 있습니다.'),
  stage('withdrawn', '철회·제외 확인', null, '철회 신청은 활성 신청 및 추적 집단의 단계 점수 분모에서 제외합니다.'),
];
const CATALOG = new Map(LOAD_STAGE_CATALOG.map(definition => [definition.stage, definition]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length < 20000;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const weight = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12);
function ensure(ok: unknown, why: string): asserts ok { if (!ok) throw new TypeError(`Invalid load bottleneck dataset: ${why}`); }
function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && isCalendarDay(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60
    && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
}
function https(value: unknown): boolean { try { const u = new URL(String(value)); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; } }
function period(value: unknown): value is string { return typeof value === 'string' && (isCalendarDay(value) || /^\d{4}-(0[1-9]|1[0-2])$/.test(value) || /^\d{4}-Q[1-4]$/.test(value) || /^\d{4}$/.test(value)); }
function anchor(value: string): string {
  if (/^\d{4}-Q/.test(value)) return `${value.slice(0, 4)}-${String((Number(value[6]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  return value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value;
}
function validateSource(source: unknown, generatedAt: string): asserts source is LoadBottleneckSource {
  ensure(object(source) && text(source.name) && https(source.url) && instant(source.retrievedAt)
    && Date.parse(source.retrievedAt) <= Date.parse(generatedAt) && typeof source.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(source.sha256) && (source.originalUrl === undefined || https(source.originalUrl)), 'source provenance');
}
function reconciles(a: number, b: number) { return Math.abs(a - b) <= Math.max(1e-7, Math.max(a, b) * 1e-10); }

export function validateLoadBottleneckDataset(input: unknown, now: Date | string = new Date()): asserts input is LoadBottleneckDataset {
  const today = calendarDayKst(now);
  ensure(object(input) && input.schemaVersion === 1 && input.modelVersion === LOAD_STAGE_MODEL_VERSION, 'schema / model version');
  ensure(instant(input.generatedAt) && Date.parse(input.generatedAt) <= new Date(now).getTime() && texts(input.limitations)
    && Array.isArray(input.series) && Array.isArray(input.regions), 'dataset metadata');
  const ids = new Map<string, string>(), pointIds = new Set<string>();
  for (const series of input.series) {
    ensure(object(series) && text(series.id) && !ids.has(series.id) && text(series.name)
      && LOAD_REGIONS.includes(series.region as LoadRegion) && text(series.scope) && text(series.comparability), 'series identity / scope');
    ids.set(series.id, series.region as string);
    ensure(['operator_register', 'operator_aggregate', 'utility_subset', 'selected_projects'].includes(series.scopeType as string)
      && ['active_queue', 'tracked_pool', 'contract_subset', 'selected_projects'].includes(series.population as string)
      && ['project_count', 'capacity_mw'].includes(series.weightBasis as string), 'series population / weighting');
    ensure(Array.isArray(series.stageMappings) && Array.isArray(series.points), 'reviewed mappings / observations');
    const mappings = new Map<string, LoadStage>();
    for (const mapping of series.stageMappings) {
      ensure(object(mapping) && text(mapping.rawStage) && !mappings.has(mapping.rawStage)
        && CATALOG.has(mapping.stage as LoadStage) && text(mapping.rationale), 'exact reviewed stage mapping');
      mappings.set(mapping.rawStage, mapping.stage as LoadStage);
    }
    const dates = new Set<string>();
    for (const observation of series.points) {
      ensure(object(observation) && text(observation.id) && !pointIds.has(observation.id)
        && isCalendarDay(observation.date) && observation.date <= today && !dates.has(observation.date), 'observation identity / date');
      pointIds.add(observation.id); dates.add(observation.date);
      ensure(['source_as_of', 'publication', 'archive_capture', 'observation'].includes(observation.dateBasis as string)
        && ['day', 'month', 'quarter', 'year'].includes(observation.datePrecision as string), 'date basis / precision');
      validateSource(observation.source, input.generatedAt);
      const retrievedDay = calendarDayKst(observation.source.retrievedAt);
      for (const field of ['sourceAsOf', 'publishedAt']) ensure(observation[field] === null
        || (period(observation[field]) && anchor(observation[field]) <= retrievedDay), 'source date after acquisition');
      if (observation.dateBasis === 'source_as_of' || observation.dateBasis === 'publication') {
        const basis = observation.dateBasis === 'source_as_of' ? observation.sourceAsOf : observation.publishedAt;
        ensure(period(basis) && observation.date === anchor(basis), 'date anchor differs from disclosed period');
        const precision = basis.length === 4 ? 'year' : /^\d{4}-Q/.test(basis) ? 'quarter' : basis.length === 7 ? 'month' : 'day';
        ensure(observation.datePrecision === precision, 'source precision');
      } else {
        const timestamp = observation.dateBasis === 'archive_capture' ? observation.archiveCapturedAt : observation.observedAt;
        ensure(instant(timestamp) && Date.parse(timestamp) <= Date.parse(observation.source.retrievedAt)
          && observation.date === calendarDayKst(timestamp) && observation.datePrecision === 'day', 'capture / observation date');
        if (observation.dateBasis === 'archive_capture') ensure(https(observation.source.originalUrl), 'archive original URL');
      }
      if (observation.dateBasis !== 'archive_capture') ensure(observation.archiveCapturedAt === undefined || observation.archiveCapturedAt === null, 'unexpected archive timestamp');
      if (observation.dateBasis !== 'observation') ensure(observation.observedAt === undefined || observation.observedAt === null, 'unexpected observation timestamp');
      ensure(texts(observation.notes) && typeof observation.completePartition === 'boolean' && weight(observation.totalWeight)
        && (observation.breakBefore === undefined || typeof observation.breakBefore === 'boolean') && Array.isArray(observation.bins), 'partition metadata');
      if (series.weightBasis === 'project_count') ensure(observation.totalWeight === null || Number.isSafeInteger(observation.totalWeight), 'integer project total');
      const binIds = new Set<string>(); let knownSum = 0, allKnown = true;
      for (const bin of observation.bins) {
        ensure(object(bin) && text(bin.id) && !binIds.has(bin.id) && text(bin.rawStage) && CATALOG.has(bin.stage as LoadStage)
          && mappings.get(bin.rawStage) === bin.stage && ['active', 'operating', 'withdrawn', 'unresolved'].includes(bin.membership as string)
          && weight(bin.weight) && texts(bin.notes), 'bin identity / exact mapping / weight');
        binIds.add(bin.id);
        ensure((bin.stage !== 'operating' || bin.membership === 'operating') && (bin.membership !== 'operating' || bin.stage === 'operating')
          && (bin.stage !== 'withdrawn' || bin.membership === 'withdrawn') && (bin.membership !== 'withdrawn' || bin.stage === 'withdrawn'), 'operating / withdrawn membership');
        ensure(bin.stage !== 'partial_energization' || bin.membership === 'unresolved', 'partial energization cannot be pure active or completed operating membership');
        if (series.weightBasis === 'project_count') ensure(bin.weight === null || Number.isSafeInteger(bin.weight), 'integer project weight');
        if (bin.weight === null) allKnown = false; else knownSum += bin.weight;
        if (bin.source !== undefined) validateSource(bin.source, input.generatedAt);
        if (bin.sourceAsOf !== undefined && bin.sourceAsOf !== null) ensure(period(bin.sourceAsOf)
          && anchor(bin.sourceAsOf) <= calendarDayKst((bin.source as LoadBottleneckSource | undefined)?.retrievedAt ?? observation.source.retrievedAt), 'bin source date');
      }
      if (observation.totalWeight !== null) {
        ensure(knownSum < observation.totalWeight || reconciles(knownSum, observation.totalWeight), 'bin weights exceed total');
        if (observation.completePartition && allKnown) ensure(reconciles(knownSum, observation.totalWeight), 'exclusive partition does not reconcile');
      }
      ensure(!observation.completePartition || observation.bins.length > 0 || observation.totalWeight === 0, 'empty complete partition');
    }
  }
  const regions = new Set<string>();
  for (const region of input.regions) {
    ensure(object(region) && LOAD_REGIONS.includes(region.region as LoadRegion) && !regions.has(region.region as string)
      && texts(region.gaps) && (region.headlineSeriesId === null || (typeof region.headlineSeriesId === 'string'
        && ids.get(region.headlineSeriesId) === region.region)), 'regional coverage / headline');
    regions.add(region.region as string);
  }
  ensure(MARKET_REGIONS.every(region => regions.has(region)), 'all seven ISO/RTO regions require explicit coverage or gaps');
  ensure([...ids.values()].every(region => regions.has(region)), 'every series region requires a coverage row');
}
export function isLoadBottleneckDataset(value: unknown): value is LoadBottleneckDataset {
  try { validateLoadBottleneckDataset(value); return true; } catch { return false; }
}

/** Never combines series, regions, count weights and MW weights. */
export function rateLoadObservation(series: LoadBottleneckSeries, observation: LoadBottleneckObservation): LoadBottleneckRating {
  const sum = (bins: LoadBottleneckBin[]) => bins.some(bin => bin.weight === null) ? null : bins.reduce((value, bin) => value + bin.weight!, 0);
  const active = observation.bins.filter(bin => bin.membership === 'active');
  const scored = active.filter(bin => CATALOG.get(bin.stage)?.point !== null && CATALOG.has(bin.stage) && bin.weight !== null);
  const unknown = active.filter(bin => CATALOG.get(bin.stage)?.point == null || bin.weight === null);
  const unresolved = observation.bins.filter(bin => bin.membership === 'unresolved');
  const unresolvedWeight = sum(unresolved), activeWeight = unresolvedWeight === 0 ? sum(active) : null;
  const ratedWeight = sum(scored)!;
  const complete = observation.completePartition && observation.totalWeight !== null && observation.bins.every(bin => bin.weight !== null)
    && reconciles(sum(observation.bins)!, observation.totalWeight);
  const contractOnly = series.population === 'contract_subset';
  const reasons: string[] = [];
  if (!complete) reasons.push('전체 분포 또는 가중치가 미확인되어 평균을 산출하지 않습니다.');
  if (unresolvedWeight !== 0) reasons.push('가동 포함 여부가 분리되지 않은 구간이 있어 활성 신청 평균을 산출하지 않습니다.');
  if (contractOnly) reasons.push('계약 부분집합만으로 다섯 계통접속 요건의 병목점수를 산출하지 않습니다.');
  if (ratedWeight === 0) reasons.push('평가 가능한 활성 구간의 분모가 없습니다.');
  const point = complete && unresolvedWeight === 0 && ratedWeight > 0 && !contractOnly
    ? scored.reduce((value, bin) => value + bin.weight! * CATALOG.get(bin.stage)!.point!, 0) / ratedWeight : null;
  const tracked = observation.bins.filter(bin => bin.membership !== 'withdrawn');
  const trackedScored = tracked.filter(bin => CATALOG.get(bin.stage)?.point != null && bin.weight !== null);
  const trackedRatedWeight = sum(trackedScored)!;
  const trackedUnknownWeight = sum(tracked.filter(bin => CATALOG.get(bin.stage)?.point == null || bin.weight === null));
  const trackedPoint = series.population === 'tracked_pool' && complete && trackedRatedWeight > 0
    ? trackedScored.reduce((value, bin) => value + bin.weight! * CATALOG.get(bin.stage)!.point!, 0) / trackedRatedWeight : null;
  return { point, trackedPoint, activeWeight, ratedWeight, unknownWeight: sum(unknown),
    operatingWeight: sum(observation.bins.filter(bin => bin.membership === 'operating')),
    withdrawnWeight: sum(observation.bins.filter(bin => bin.membership === 'withdrawn')), unresolvedWeight,
    totalWeight: observation.totalWeight, coverage: activeWeight !== null && activeWeight > 0 ? ratedWeight / activeWeight : null,
    trackedRatedWeight, trackedUnknownWeight, reasons };
}

export function parseLoadBottleneckFilters(params: URLSearchParams): LoadBottleneckFilters {
  const result = { region: params.get('region') || undefined, seriesId: params.get('seriesId') || undefined,
    start: params.get('start') || undefined, end: params.get('end') || undefined };
  validateFilters(result); return result;
}
function validateFilters(filters: LoadBottleneckFilters) {
  if ((filters.region && !LOAD_REGIONS.includes(filters.region as LoadRegion)) || (filters.seriesId && filters.seriesId.length > 250)
    || (filters.start && !isCalendarDay(filters.start)) || (filters.end && !isCalendarDay(filters.end))
    || (filters.start && filters.end && filters.start > filters.end)) throw new RangeError('Invalid load bottleneck filters');
}
export function filterLoadBottleneckSeries(dataset: LoadBottleneckDataset, filters: LoadBottleneckFilters = {}): LoadBottleneckSeries[] {
  validateFilters(filters);
  return dataset.series.filter(series => (!filters.region || series.region === filters.region) && (!filters.seriesId || series.id === filters.seriesId))
    .map(series => ({ ...series, points: series.points.filter(point => (!filters.start || point.date >= filters.start)
      && (!filters.end || point.date <= filters.end)).toSorted((a, b) => a.date.localeCompare(b.date)) }));
}
export function loadBottleneckCsv(dataset: LoadBottleneckDataset, filters: LoadBottleneckFilters = {}): string {
  const headers = ['series_id', 'series_name', 'region', 'scope_type', 'population', 'weight_basis', 'scope', 'comparability',
    'observation_id', 'plot_date', 'date_precision', 'date_basis', 'source_as_of', 'published_at', 'archive_captured_at', 'observed_at',
    'active_point', 'tracked_pool_point', 'active_weight', 'rated_weight', 'unknown_weight', 'operating_weight', 'withdrawn_weight',
    'unresolved_weight', 'reported_total_weight', 'rated_fraction', 'complete_partition', 'model_version', 'tracked_rated_weight', 'tracked_unknown_weight',
    'bin_id', 'raw_stage', 'model_stage', 'membership', 'bin_weight', 'stage_model_point', 'stage_mapping_rationale',
    'source_name', 'source_url', 'source_sha256', 'retrieved_at', 'bin_source_as_of', 'notes'];
  const cell = (value: unknown) => { const raw = value === null || value === undefined ? '' : String(value);
    return '"' + (/^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""') + '"'; };
  const rows = filterLoadBottleneckSeries(dataset, filters).flatMap(series => series.points.flatMap(point => {
    const rating = rateLoadObservation(series, point);
    return point.bins.map(bin => { const source = bin.source ?? point.source;
      return [series.id, series.name, series.region, series.scopeType, series.population, series.weightBasis, series.scope, series.comparability,
        point.id, point.date, point.datePrecision, point.dateBasis, point.sourceAsOf, point.publishedAt, point.archiveCapturedAt, point.observedAt,
        rating.point, rating.trackedPoint, rating.activeWeight, rating.ratedWeight, rating.unknownWeight, rating.operatingWeight,
        rating.withdrawnWeight, rating.unresolvedWeight, rating.totalWeight, rating.coverage, point.completePartition, dataset.modelVersion,
        rating.trackedRatedWeight, rating.trackedUnknownWeight,
        bin.id, bin.rawStage, bin.stage, bin.membership, bin.weight, CATALOG.get(bin.stage)?.point,
        series.stageMappings.find(mapping => mapping.rawStage === bin.rawStage)?.rationale,
        source.name, source.url, source.sha256, source.retrievedAt, bin.sourceAsOf,
        [...point.notes, ...bin.notes, ...rating.reasons].join(' | ')].map(cell).join(',');
    });
  }));
  return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
}
