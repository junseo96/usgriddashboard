/** Published historical evidence. These points are not backdated database observations. */
import type { ProjectType } from './types.ts';
import { calendarDayKst, isCalendarDay } from './time.ts';

export type HistoricalMetric = 'load_requests' | 'load_contracts' | 'queue_capacity' | 'queue_count' | 'bottleneck_score';
export interface HistoricalPoint {
  id: string; date: string; datePrecision: 'day' | 'month' | 'quarter' | 'year';
  dateBasis: 'source_as_of' | 'publication' | 'archive_capture' | 'observation'; sourceAsOf: string | null; publishedAt: string | null;
  archiveCapturedAt?: string | null;
  observedAt?: string | null; breakBefore?: boolean;
  value: number | null; qualifier: 'exact' | 'approximate' | 'greater_than' | 'at_least';
  projectCount: number | null; ratedCount: number | null; unknownCount: number | null;
  source: { name: string; url: string; retrievedAt: string; sha256: string; originalUrl?: string };
  notes: string[]; ratingModelVersion: string | null;
}
export interface HistoricalSeries {
  id: string; name: string; region: string; projectTypes: ProjectType[];
  metric: HistoricalMetric; unit: 'MW' | 'projects' | 'score';
  scope: string; description: string; comparability: string; points: HistoricalPoint[];
}
export interface HistoricalDataset {
  schemaVersion: 1; generatedAt: string; coverageStart: string; coverageEnd: string;
  limitations: string[]; series: HistoricalSeries[];
}
export interface HistoricalFilters {
  region?: string; type?: ProjectType | 'all'; metric?: HistoricalMetric | 'all';
  seriesId?: string; start?: string; end?: string;
}
const METRICS = ['load_requests', 'load_contracts', 'queue_capacity', 'queue_count', 'bottleneck_score'] as const;
const TYPES = ['generation', 'storage', 'load'] as const;
const UNIT: Record<HistoricalMetric, HistoricalSeries['unit']> = {
  load_requests: 'MW', load_contracts: 'MW', queue_capacity: 'MW', queue_count: 'projects', bottleneck_score: 'score',
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 12000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const count = (value: unknown): value is number | null => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && isCalendarDay(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24
    && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
}
function sourceDate(value: unknown): value is string {
  return typeof value === 'string' && (isCalendarDay(value) || /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    || /^\d{4}-Q[1-4]$/.test(value) || /^\d{4}$/.test(value));
}
/** An axis anchor only; the disclosed period string remains authoritative. */
function sourceDateAnchor(value: string): string {
  if (/^\d{4}-Q[1-4]$/.test(value)) return `${value.slice(0, 4)}-${String((Number(value[6]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  return value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value;
}
function https(value: unknown): boolean {
  if (!text(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname; }
  catch { return false; }
}
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid historical dataset: ${message}`);
}

export function validateHistoricalDataset(value: unknown, now: Date | string = new Date()): asserts value is HistoricalDataset {
  const nowMs = new Date(now).getTime(), today = calendarDayKst(now);
  ensure(object(value) && value.schemaVersion === 1, 'schema version');
  ensure(instant(value.generatedAt) && Date.parse(value.generatedAt) <= nowMs, 'generation timestamp');
  ensure(isCalendarDay(value.coverageStart) && isCalendarDay(value.coverageEnd)
    && value.coverageStart <= value.coverageEnd && value.coverageEnd <= today, 'coverage bounds');
  ensure(texts(value.limitations) && Array.isArray(value.series), 'series and limitations');
  const seriesIds = new Set<string>(), pointIds = new Set<string>();
  for (const series of value.series) {
    ensure(object(series) && text(series.id) && !seriesIds.has(series.id), 'unique series identity');
    seriesIds.add(series.id);
    ensure(text(series.name) && text(series.region) && text(series.scope) && text(series.description)
      && text(series.comparability), 'series scope and comparability');
    ensure(Array.isArray(series.projectTypes) && series.projectTypes.length > 0
      && new Set(series.projectTypes).size === series.projectTypes.length
      && series.projectTypes.every(type => TYPES.includes(type)), 'project types');
    ensure(METRICS.includes(series.metric as HistoricalMetric)
      && UNIT[series.metric as HistoricalMetric] === series.unit, 'metric / unit mismatch');
    ensure(!['load_requests', 'load_contracts'].includes(series.metric as string)
      || (series.projectTypes.length === 1 && series.projectTypes[0] === 'load'), 'load request / contract scope');
    ensure(Array.isArray(series.points), 'points');
    const dates = new Set<string>();
    for (const point of series.points) {
      ensure(object(point) && text(point.id) && !pointIds.has(point.id), 'unique point identity');
      pointIds.add(point.id);
      ensure(isCalendarDay(point.date) && point.date >= value.coverageStart && point.date <= value.coverageEnd
        && !dates.has(point.date), 'point date, coverage, or duplicate date');
      dates.add(point.date);
      ensure(['source_as_of', 'publication', 'archive_capture', 'observation'].includes(point.dateBasis as string), 'date basis');
      ensure(point.breakBefore === undefined || typeof point.breakBefore === 'boolean', 'series definition break');
      ensure(['day', 'month', 'quarter', 'year'].includes(point.datePrecision as string), 'date precision');
      for (const field of ['sourceAsOf', 'publishedAt']) {
        ensure(point[field] === null || (sourceDate(point[field]) && sourceDateAnchor(point[field]) <= today), field);
      }
      if (point.dateBasis === 'archive_capture' || point.dateBasis === 'observation') {
        const timestamp = point.dateBasis === 'archive_capture' ? point.archiveCapturedAt : point.observedAt;
        ensure(instant(timestamp) && point.datePrecision === 'day'
          && point.date === calendarDayKst(timestamp), 'archive capture / observation date');
      } else {
        ensure(point.archiveCapturedAt === undefined || point.archiveCapturedAt === null, 'unexpected archive capture');
        const basis = point.dateBasis === 'source_as_of' ? point.sourceAsOf : point.publishedAt;
        ensure(typeof basis === 'string', 'date basis is missing');
        const precision = basis.length === 4 ? 'year' : /^\d{4}-Q[1-4]$/.test(basis) ? 'quarter' : basis.length === 7 ? 'month' : 'day';
        ensure(point.datePrecision === precision, 'date precision differs from source');
        ensure(point.date === sourceDateAnchor(basis), 'plot date must preserve the source day or use the period start anchor');
      }
      ensure(point.value === null || (typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0), 'value');
      ensure(['exact', 'approximate', 'greater_than', 'at_least'].includes(point.qualifier as string), 'value qualifier');
      ensure(count(point.projectCount) && count(point.ratedCount) && count(point.unknownCount), 'project counts');
      if (point.projectCount !== null) {
        ensure(point.ratedCount === null || point.ratedCount <= point.projectCount, 'rated denominator');
        ensure(point.unknownCount === null || point.unknownCount <= point.projectCount, 'unknown denominator');
        if (point.ratedCount !== null && point.unknownCount !== null) ensure(point.ratedCount + point.unknownCount === point.projectCount, 'denominator reconciliation');
      }
      if (series.metric === 'bottleneck_score') {
        ensure(text(point.ratingModelVersion), 'score model version');
        ensure(point.value === null || (point.value <= 100 && point.projectCount !== null
          && point.ratedCount !== null && point.ratedCount > 0 && point.unknownCount !== null), 'score value / denominator');
        ensure(point.value !== null || point.ratedCount === null || point.ratedCount === 0, 'missing score cannot have rated projects');
      } else {
        ensure(point.ratingModelVersion === null, 'capacity/count points cannot carry a score model');
        if (series.metric === 'queue_count') ensure(point.value === null || Number.isSafeInteger(point.value), 'queue count');
      }
      ensure(texts(point.notes) && object(point.source) && text(point.source.name) && https(point.source.url)
        && instant(point.source.retrievedAt) && Date.parse(point.source.retrievedAt) <= Date.parse(value.generatedAt)
        && typeof point.source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(point.source.sha256), 'source provenance');
      ensure(point.source.originalUrl === undefined || https(point.source.originalUrl), 'original source URL');
      if (point.dateBasis === 'archive_capture') ensure(instant(point.archiveCapturedAt)
        && Date.parse(point.archiveCapturedAt) <= Date.parse(point.source.retrievedAt)
        && https(point.source.originalUrl), 'archive capture provenance');
      if (point.dateBasis === 'observation') ensure(instant(point.observedAt)
        && Date.parse(point.observedAt) <= Date.parse(point.source.retrievedAt), 'observation provenance');
      else ensure(point.observedAt === undefined || point.observedAt === null, 'unexpected observation timestamp');
      if (point.dateBasis !== 'archive_capture') ensure(point.archiveCapturedAt === undefined || point.archiveCapturedAt === null, 'unexpected archive timestamp');
      const retrievedDay = calendarDayKst(point.source.retrievedAt);
      for (const field of ['sourceAsOf', 'publishedAt']) {
        const day = point[field];
        ensure(day === null || (typeof day === 'string' && sourceDateAnchor(day) <= retrievedDay), 'source date after retrieval');
      }
    }
  }
}

export function isHistoricalDataset(value: unknown): value is HistoricalDataset {
  try { validateHistoricalDataset(value); return true; } catch { return false; }
}

/** Bounds select disclosed points only: no interpolation, carry-forward, sums, or zero filling. */
export function filterHistoricalSeries(dataset: HistoricalDataset, filters: HistoricalFilters = {}): HistoricalSeries[] {
  validateHistoricalFilters(filters);
  return dataset.series.filter(series => (!filters.region || filters.region === 'all' || series.region === filters.region)
    && (!filters.type || filters.type === 'all' || series.projectTypes.includes(filters.type))
    && (!filters.metric || filters.metric === 'all' || series.metric === filters.metric)
    && (!filters.seriesId || series.id === filters.seriesId))
    .map(series => ({ ...series, points: series.points.filter(point => (!filters.start || point.date >= filters.start)
      && (!filters.end || point.date <= filters.end)).toSorted((a, b) => a.date.localeCompare(b.date)) }));
}

function validateHistoricalFilters(filters: HistoricalFilters) {
  if ((filters.start && !isCalendarDay(filters.start)) || (filters.end && !isCalendarDay(filters.end))
    || (filters.start && filters.end && filters.start > filters.end)
    || (filters.type && filters.type !== 'all' && !TYPES.includes(filters.type))
    || (filters.metric && filters.metric !== 'all' && !METRICS.includes(filters.metric))
    || (filters.region && filters.region.length > 100) || (filters.seriesId && filters.seriesId.length > 250)) {
    throw new RangeError('Invalid historical filters or date bounds');
  }
}
export function parseHistoricalFilters(params: URLSearchParams): HistoricalFilters {
  const filters: HistoricalFilters = {
    region: params.get('region') || undefined, type: (params.get('type') || undefined) as HistoricalFilters['type'],
    metric: (params.get('metric') || undefined) as HistoricalFilters['metric'], seriesId: params.get('seriesId') || undefined,
    start: params.get('start') || undefined, end: params.get('end') || undefined,
  };
  validateHistoricalFilters(filters);
  return filters;
}

/** Export provenance and denominators alongside every historical point. */
export function historicalCsv(dataset: HistoricalDataset, filters: HistoricalFilters = {}): string {
  const headers = ['series_id', 'series_name', 'region', 'project_types', 'metric', 'unit', 'scope', 'comparability',
    'point_id', 'plot_date', 'date_precision', 'date_basis', 'source_as_of', 'published_at', 'archive_captured_at', 'observed_at', 'break_before', 'value', 'qualifier',
    'project_count', 'rated_count', 'unknown_count', 'rating_model_version', 'source_name', 'source_url', 'original_source_url', 'retrieved_at', 'source_sha256', 'notes'];
  const cell = (value: unknown) => {
    const raw = value === null || value === undefined ? '' : String(value);
    return '"' + (/^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""') + '"';
  };
  const rows = filterHistoricalSeries(dataset, filters).flatMap(series => series.points.map(point => [series.id, series.name,
    series.region, series.projectTypes.join('|'), series.metric, series.unit, series.scope, series.comparability,
    point.id, point.date, point.datePrecision, point.dateBasis, point.sourceAsOf, point.publishedAt, point.archiveCapturedAt, point.observedAt, point.breakBefore ?? false, point.value, point.qualifier,
    point.projectCount, point.ratedCount, point.unknownCount, point.ratingModelVersion, point.source.name, point.source.url,
    point.source.originalUrl, point.source.retrievedAt, point.source.sha256, point.notes.join(' | ')].map(cell).join(',')));
  return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
}
