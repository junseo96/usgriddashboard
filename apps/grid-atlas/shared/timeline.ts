/** Read-only alignment of existing observations. No interpolation, sums, or synthetic history. */
import type { HistoricalDataset, HistoricalPoint } from './history.ts';
import { rateLoadObservation, type LoadBottleneckDataset } from './load-bottleneck.ts';
import type { DemandDataset } from './market-types.ts';
import type { ProjectType } from './types.ts';
import { calendarDayKst, isCalendarDay } from './time.ts';

export type TimelineMetric = 'score' | 'capacity' | 'count' | 'demand' | 'peak';
export type TimelineOrigin = 'historical' | 'load_stage' | 'system';
export interface TimelinePoint {
  id: string; date: string; timestamp: number; precision: 'instant' | 'day' | 'month' | 'quarter' | 'year';
  dateBasis: string; sourceAsOf: string | null; publishedAt: string | null; observedAt: string | null;
  archiveCapturedAt: string | null; value: number | null; qualifier: HistoricalPoint['qualifier'];
  denominator: number | null; population: number | null; unknown: number | null;
  denominatorUnit: 'projects' | 'MW' | 'observations' | null;
  complete: boolean | null; breakBefore: boolean; modelVersion: string | null;
  source: { name: string; url: string; retrievedAt: string | null; sha256: string | null };
  notes: string[];
}
export interface TimelineSeries {
  id: string; originalId: string; name: string; region: string; projectTypes: ProjectType[];
  metric: TimelineMetric; unit: 'score' | 'MW' | 'projects'; origin: TimelineOrigin;
  scope: string; comparability: string; measure: string; weightBasis: string;
  intervalMinutes: number | null; timezone: string | null; points: TimelinePoint[];
}
export interface TimelineFilters {
  metric?: TimelineMetric; region?: string; type?: ProjectType | 'all' | 'system';
  origin?: TimelineOrigin | 'all'; search?: string; start?: string; end?: string;
}
/** Keep compatible scope choices when switching between project and system metrics. */
export function timelineMetricTransition(next: TimelineMetric, current: { region: string; type: NonNullable<TimelineFilters['type']>; origin: TimelineOrigin | 'all' }) {
  const system = next === 'demand' || next === 'peak';
  return { metric: next, region: system && current.region === '미국 본토' ? 'all' : current.region,
    type: system ? 'system' as const : current.type === 'system' ? 'all' as const : current.type,
    origin: system || current.origin === 'system' ? 'all' as const : current.origin };
}
const metricMap = { bottleneck_score: 'score', queue_count: 'count', queue_capacity: 'capacity', load_requests: 'capacity', load_contracts: 'capacity' } as const;
const measureMap = { bottleneck_score: '공개 원장 단계 평균', queue_count: '공개 원장 신청 건수', queue_capacity: '공개 원장 신청 용량', load_requests: '수용가 요청·파이프라인', load_contracts: '수용가 계약 용량' } as const;
const sortPoints = (points: TimelinePoint[]) => points.toSorted((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
export const timelineRegionLabel = (region: string) => region === '미국 본토' ? '전국 · 공개 원장 범위' : region === 'West' ? '서부 · 공개된 일부 범위' : region === 'Southeast' ? '남동부 · 공개된 일부 범위' : region;

export function buildTimelineSeries(input: { historical?: HistoricalDataset | null; load?: LoadBottleneckDataset | null; demand?: DemandDataset | null }): TimelineSeries[] {
  const result: TimelineSeries[] = [];
  for (const series of input.historical?.series ?? []) {
    result.push({ id: `history:${series.id}`, originalId: series.id, name: series.name, region: series.region,
      projectTypes: series.projectTypes, metric: metricMap[series.metric], unit: series.unit, origin: 'historical',
      scope: series.scope, comparability: series.comparability, measure: measureMap[series.metric],
      weightBasis: series.metric === 'bottleneck_score' ? 'project_count' : 'source_value', intervalMinutes: null, timezone: null,
      points: sortPoints(series.points.map(point => ({ id: point.id, date: point.date, timestamp: Date.parse(point.date), precision: point.datePrecision,
        dateBasis: point.dateBasis, sourceAsOf: point.sourceAsOf, publishedAt: point.publishedAt,
        observedAt: point.observedAt ?? null, archiveCapturedAt: point.archiveCapturedAt ?? null,
        value: point.value, qualifier: point.qualifier,
        denominator: series.metric === 'bottleneck_score' ? point.ratedCount : point.projectCount,
        population: point.projectCount, unknown: point.unknownCount, denominatorUnit: 'projects',
        complete: null, breakBefore: point.breakBefore ?? false, modelVersion: point.ratingModelVersion,
        source: point.source, notes: [...point.notes, ...(series.metric === 'bottleneck_score' ? ['당시 원장 상태에 현재 공통 단계 모형을 적용한 과거 재평가입니다. 그때 발표된 점수가 아닙니다.'] : [])] }))) });
  }
  for (const series of input.load?.series ?? []) {
    const ratings = series.points.map(point => ({ point, rating: rateLoadObservation(series, point) }));
    const variants: ('active' | 'tracked' | 'population')[] = ['active'];
    if (ratings.some(row => row.rating.trackedPoint !== null)) variants.push('tracked');
    if (series.points.some(point => point.totalWeight !== null)) variants.push('population');
    for (const variant of variants) {
      const consumptionProxy = series.id === 'ercot-load-stages';
      const measure = variant === 'population' ? '공개 집단 분모' : variant === 'tracked' ? '추적군 참고지수 · 운영 포함 가능'
        : consumptionProxy ? '관측 소비 MW 제외 단계지수' : '활성 범위 단계 평균';
      result.push({ id: `load:${series.id}:${variant}`, originalId: series.id, name: `${series.name} · ${measure}`,
        region: series.region, projectTypes: ['load'], metric: variant === 'population' ? series.weightBasis === 'capacity_mw' ? 'capacity' : 'count' : 'score',
        unit: variant === 'population' ? series.weightBasis === 'capacity_mw' ? 'MW' : 'projects' : 'score', origin: 'load_stage',
        scope: series.scope, comparability: series.comparability, measure, weightBasis: series.weightBasis,
        intervalMinutes: null, timezone: null,
        points: sortPoints(ratings.map(({ point, rating }) => ({ id: point.id, date: point.date, timestamp: Date.parse(point.date), precision: point.datePrecision,
          dateBasis: point.dateBasis, sourceAsOf: point.sourceAsOf, publishedAt: point.publishedAt,
          observedAt: point.observedAt ?? null, archiveCapturedAt: point.archiveCapturedAt ?? null,
          value: variant === 'population' ? point.totalWeight : variant === 'tracked' ? rating.trackedPoint : rating.point,
          qualifier: 'exact', denominator: variant === 'tracked' ? rating.trackedRatedWeight : variant === 'population' ? null : rating.ratedWeight,
          population: point.totalWeight, unknown: variant === 'tracked' ? rating.trackedUnknownWeight : rating.unknownWeight,
          denominatorUnit: series.weightBasis === 'capacity_mw' ? 'MW' : 'projects', complete: null,
          breakBefore: point.breakBefore ?? false, modelVersion: variant === 'population' ? null : input.load!.modelVersion, source: point.source,
          notes: [...point.notes, ...rating.reasons, ...point.bins.flatMap(bin => bin.source && bin.source.url !== point.source.url ? [`개별 단계 추가 근거: ${bin.source.name} — ${bin.source.url}`] : []),
            variant === 'population' ? `원문 집단: ${series.population}. 전체 현재 대기 신청과 동일한 분모인지 범위를 확인하세요.`
              : variant === 'tracked' ? '운영 또는 활성 여부 미분류를 포함할 수 있는 추적군 지수입니다. 활성 신청 평균과 구별합니다.'
                : consumptionProxy ? '공개된 비동시 최대 소비 MW만 제외합니다. 운영 프로젝트 전체 계약용량을 제외한 대기 프로젝트 평균이 아닙니다.'
                  : '다섯 요건의 진행률은 원문 단계에 적용한 모형 가정입니다. 실제 인허가·공정률의 직접 확인이 아닙니다.'] }))) });
    }
  }
  for (const region of input.demand?.regions ?? []) {
    const common = { originalId: region.region, region: region.region, projectTypes: [] as ProjectType[], unit: 'MW' as const, origin: 'system' as const,
      scope: `${region.name}의 운영기관·공식 통계 부하 관측. 접속신청·설비 명판 용량과 다른 지표입니다.`,
      comparability: '확보한 관측만 표시합니다. 누락된 구간을 채우거나 이전 값을 현재 값으로 이월하지 않습니다.',
      weightBasis: 'observed_system_mw', intervalMinutes: region.intervalMinutes, timezone: region.timezone };
    result.push({ ...common, id: `demand:${region.region}`, name: `${region.region} · 실제 계통 부하`, metric: 'demand', measure: '실측 부하 · KST 시각',
      points: sortPoints(region.series.map(point => ({ id: `${region.region}:${point.observedAt}`, date: calendarDayKst(point.observedAt), timestamp: Date.parse(point.observedAt),
        precision: 'instant', dateBasis: 'observed_instant', sourceAsOf: null, publishedAt: null, observedAt: point.observedAt, archiveCapturedAt: null,
        value: point.mw, qualifier: 'exact', denominator: null, population: null, unknown: null, denominatorUnit: null,
        complete: null, breakBefore: false, modelVersion: null,
        source: { name: region.sourceName, url: region.sourceUrl, retrievedAt: region.retrievedAt, sha256: null },
        notes: [...region.warnings, ...(point.quality ? [`원자료 품질 표기: ${point.quality}`] : []), `공개 관측 간격: ${region.intervalMinutes ?? '미공개'}분. 수집 상태: ${region.status}.`] }))) });
    result.push({ ...common, id: `peak:${region.region}`, name: `${region.region} · 일별 피크 부하`, metric: 'peak', measure: '시장 현지일 피크',
      points: sortPoints(region.dailyPeaks.map(point => ({ id: `${region.region}:peak:${point.date}`, date: point.date, timestamp: Date.parse(point.date),
        precision: 'day', dateBasis: 'market_local_day', sourceAsOf: point.date, publishedAt: null, observedAt: point.peakAt, archiveCapturedAt: null,
        value: point.peakMw, qualifier: 'exact', denominator: point.observations, population: point.expectedObservations,
        unknown: Math.max(0, point.expectedObservations - point.observations), denominatorUnit: 'observations', complete: point.complete,
        breakBefore: false, modelVersion: null,
        source: { name: point.sourceName ?? region.sourceName, url: point.sourceUrl ?? region.sourceUrl, retrievedAt: region.retrievedAt, sha256: null },
        notes: [`${region.timezone} 현지일 기준이며 피크 발생 시각은 KST로 표시합니다.`,
          point.complete ? '해당 현지일의 모든 예상 관측 구간이 확보되었습니다.' : '일부 관측 구간의 잠정 최댓값입니다. 하루 확정 피크가 아닙니다.',
          `관측 간격 ${point.intervalMinutes ?? region.intervalMinutes ?? '미공개'}분.`] }))) });
  }
  return result;
}

export function filterTimelineSeries(series: TimelineSeries[], filters: TimelineFilters = {}): TimelineSeries[] {
  if ((filters.start && !isCalendarDay(filters.start)) || (filters.end && !isCalendarDay(filters.end)) || (filters.start && filters.end && filters.start > filters.end)) throw new RangeError('Invalid timeline dates');
  const search = filters.search?.trim().toLocaleLowerCase();
  return series.filter(row => (!filters.metric || row.metric === filters.metric)
    && (!filters.region || filters.region === 'all' || row.region === filters.region)
    && (!filters.origin || filters.origin === 'all' || row.origin === filters.origin)
    && (!filters.type || filters.type === 'all' || (filters.type === 'system' ? row.origin === 'system' : row.projectTypes.includes(filters.type)))
    && (!search || [row.name, row.scope, ...row.points.map(p => p.source.name)].some(value => value.toLocaleLowerCase().includes(search))))
    .map(row => ({ ...row, points: row.points.filter(p => (!filters.start || p.date >= filters.start) && (!filters.end || p.date <= filters.end)) }));
}
/** Chart lines are guides between disclosed points; missing periods and definition changes remain disconnected. */
export function timelineCanJoin(series: TimelineSeries, previous: TimelinePoint | undefined, point: TimelinePoint): boolean {
  if (!previous || previous.value === null || point.value === null || point.breakBefore || point.timestamp <= previous.timestamp) return false;
  if (series.metric === 'demand') return series.intervalMinutes !== null && point.timestamp - previous.timestamp <= series.intervalMinutes * 60_000 * 1.5;
  if (series.metric === 'peak') return point.timestamp - previous.timestamp === 86_400_000;
  const month = (p: TimelinePoint) => Number(p.date.slice(0, 4)) * 12 + Number(p.date.slice(5, 7));
  if (previous.precision === 'year' && point.precision === 'year') return Number(point.date.slice(0, 4)) - Number(previous.date.slice(0, 4)) === 1;
  if (previous.precision === 'quarter' || point.precision === 'quarter') return month(point) - month(previous) <= 3;
  if (previous.precision === 'month' || point.precision === 'month') return month(point) - month(previous) <= 1;
  return true;
}
export function comparableTimelineSeries(a: TimelineSeries, b: TimelineSeries): boolean {
  return a.id !== b.id && a.metric === b.metric && a.unit === b.unit && (a.metric !== 'score' || a.weightBasis === b.weightBasis);
}
export function timelineCsv(series: TimelineSeries[]): string {
  const headers = ['series_id','series_name','region','project_types','metric','unit','measure','weight_basis','scope','comparability','point_id','date','precision','date_basis','source_as_of','published_at','observed_at','archive_captured_at','value','qualifier','denominator','population','unknown','denominator_unit','complete','break_before','model_version','source_name','source_url','retrieved_at','source_sha256','notes'];
  const cell = (v: unknown) => { const raw = v == null ? '' : String(v); return '"' + (/^[\s]*[=+\-@]|^[\t\r\n]/.test(raw) ? "'" + raw : raw).replaceAll('"','""') + '"'; };
  const rows = series.flatMap(s => s.points.map(p => [s.id,s.name,s.region,s.projectTypes.join('|'),s.metric,s.unit,s.measure,s.weightBasis,s.scope,s.comparability,
    p.id,p.date,p.precision,p.dateBasis,p.sourceAsOf,p.publishedAt,p.observedAt,p.archiveCapturedAt,p.value,p.qualifier,p.denominator,p.population,p.unknown,p.denominatorUnit,
    p.complete,p.breakBefore,p.modelVersion,p.source.name,p.source.url,p.source.retrievedAt,p.source.sha256,p.notes.join(' | ')].map(cell).join(',')));
  return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
}
