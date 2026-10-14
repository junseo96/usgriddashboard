import { isCalendarDay } from './time.ts';

export interface LoadApiQualityIssue {
  code: string;
  severity: 'warning';
  detail: string;
  reportedSumMw?: number;
  expectedMw?: number;
}
export interface LoadApiRecord {
  id: string;
  region: 'ERCOT';
  scope: 'regional_aggregate';
  snapshotMonth: string;
  reportDate: string;
  totalMw: number;
  colocatedMw: number | null;
  standaloneMw: number | null;
  byStatus: Record<string, number | null> | null;
  bySizeBucket: Record<string, { mw: number | null; count: number | null }> | null;
  byType: Record<string, { mw: number | null; pct: number | null }> | null;
  byZone: Record<string, number | null> | null;
  approvedToEnergizeMw: number | null;
  planningStudiesApprovedMw: number | null;
  trailing12mo: Record<string, number | null> | null;
  sourceUrl: string;
  providerExtractedAt: string | null;
  fetchedAt: string;
  payloadSha256: string;
  receipt: { url: string; fetchedAt: string; sha256: string };
  verification: 'provider_extraction_unverified';
  qualityIssues: LoadApiQualityIssue[];
}
export interface LoadApiDataset {
  schemaVersion: 1;
  generatedAt: string;
  provider: 'kardashev';
  records: LoadApiRecord[];
  collection: {
    startedAt: string;
    completedAt: string;
    status: 'success' | 'failed';
    lastSuccessAt: string | null;
    addedCount: number;
    error: string | null;
    endpointReceipts: { url: string; fetchedAt: string; httpStatus: number | null; sha256: string | null; bytes: number; recordCount: number | null }[];
    warnings: string[];
  };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableNumber = (value: unknown): value is number | null => value === null || number(value);
const count = (value: unknown): value is number => number(value) && Number.isInteger(value);
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && isCalendarDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Only public, non-credential URLs are displayed or exported. */
export function publicLoadApiUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:api[_-]?key|access[_-]?token|token|secret|authorization|signature|password)$/i.test(key))) return undefined;
    return url.href;
  } catch { return undefined; }
}

function nullableMap(value: unknown, validate: (member: unknown) => boolean): boolean {
  return value === null || object(value) && Object.entries(value).every(([key, member]) => text(key) && validate(member));
}
function isRecord(value: unknown): value is LoadApiRecord {
  if (!object(value) || !text(value.id) || value.region !== 'ERCOT' || value.scope !== 'regional_aggregate'
    || !isCalendarDay(value.snapshotMonth) || !value.snapshotMonth.endsWith('-01') || !isCalendarDay(value.reportDate)
    || !number(value.totalMw) || !nullableNumber(value.colocatedMw) || !nullableNumber(value.standaloneMw)
    || !nullableNumber(value.approvedToEnergizeMw) || !nullableNumber(value.planningStudiesApprovedMw)
    || !nullableMap(value.byStatus, nullableNumber) || !nullableMap(value.byZone, nullableNumber)
    || !nullableMap(value.bySizeBucket, member => object(member) && nullableNumber(member.mw) && (member.count === null || count(member.count)))
    || !nullableMap(value.byType, member => object(member) && nullableNumber(member.mw) && (member.pct === null || number(member.pct) && member.pct <= 100))
    || !nullableMap(value.trailing12mo, nullableNumber)
    || (object(value.trailing12mo) && !Object.keys(value.trailing12mo).every(key => isCalendarDay(`${key}-01`)))
    || !publicLoadApiUrl(value.sourceUrl) || !(value.providerExtractedAt === null || instant(value.providerExtractedAt))
    || !instant(value.fetchedAt) || !hash(value.payloadSha256) || value.verification !== 'provider_extraction_unverified'
    || !object(value.receipt) || !publicLoadApiUrl(value.receipt.url) || !instant(value.receipt.fetchedAt)
    || value.receipt.fetchedAt !== value.fetchedAt || !hash(value.receipt.sha256)
    || !Array.isArray(value.qualityIssues)) return false;
  return value.qualityIssues.every(issue => object(issue) && text(issue.code) && issue.severity === 'warning' && text(issue.detail)
    && (issue.reportedSumMw === undefined || number(issue.reportedSumMw)) && (issue.expectedMw === undefined || number(issue.expectedMw)));
}

/** Structural failures reject the response. Published subtotal differences remain visible as quality issues. */
export function isLoadApiDataset(value: unknown): value is LoadApiDataset {
  if (!object(value) || value.schemaVersion !== 1 || value.provider !== 'kardashev' || !instant(value.generatedAt)
    || !Array.isArray(value.records) || !value.records.every(isRecord) || new Set(value.records.map(row => row.id)).size !== value.records.length
    || !object(value.collection)) return false;
  const run = value.collection;
  return instant(run.startedAt) && instant(run.completedAt) && Date.parse(run.startedAt) <= Date.parse(run.completedAt)
    && (run.status === 'success' || run.status === 'failed') && (run.lastSuccessAt === null || instant(run.lastSuccessAt))
    && (run.status !== 'success' || instant(run.lastSuccessAt)) && count(run.addedCount)
    && (run.error === null || text(run.error)) && Array.isArray(run.warnings) && run.warnings.every(text)
    && Array.isArray(run.endpointReceipts) && run.endpointReceipts.every(receipt => object(receipt) && publicLoadApiUrl(receipt.url)
      && instant(receipt.fetchedAt) && (receipt.httpStatus === null || count(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599)
      && (receipt.sha256 === null || hash(receipt.sha256)) && count(receipt.bytes) && (receipt.recordCount === null || count(receipt.recordCount)));
}

export function validateLoadApiDataset(value: unknown): asserts value is LoadApiDataset {
  if (!isLoadApiDataset(value)) throw new Error('Invalid public large-load API dataset.');
}

/** A new report can revise a past month. Keep every revision instead of summing or overwriting it. */
export function orderedLoadApiRecords(records: readonly LoadApiRecord[]): LoadApiRecord[] {
  return [...records].sort((a, b) => b.snapshotMonth.localeCompare(a.snapshotMonth) || b.reportDate.localeCompare(a.reportDate)
    || (b.providerExtractedAt ?? '').localeCompare(a.providerExtractedAt ?? '') || b.fetchedAt.localeCompare(a.fetchedAt) || a.id.localeCompare(b.id));
}

const csvCell = (value: unknown) => {
  const raw = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return '"' + (/^[\s]*[=+\-@]/.test(raw) || /^[\t\r\n]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""') + '"';
};

/** Deliberate allowlist: acquisition metadata and capacity facts, never response headers or credentials. */
export function loadApiCsv(records: readonly LoadApiRecord[]): string {
  const headers = ['id', 'region', 'scope', 'snapshot_month', 'report_date', 'total_mw', 'colocated_mw', 'standalone_mw',
    'approved_to_energize_mw', 'planning_studies_approved_mw', 'by_status', 'by_size_bucket', 'by_type', 'by_zone', 'trailing_12mo',
    'source_url', 'provider_extracted_at', 'fetched_at', 'api_receipt_url', 'api_receipt_sha256', 'payload_sha256', 'verification', 'quality_issues'];
  const rows = orderedLoadApiRecords(records).map(row => [row.id, row.region, row.scope, row.snapshotMonth, row.reportDate, row.totalMw,
    row.colocatedMw, row.standaloneMw, row.approvedToEnergizeMw, row.planningStudiesApprovedMw, row.byStatus, row.bySizeBucket, row.byType,
    row.byZone, row.trailing12mo, publicLoadApiUrl(row.sourceUrl), row.providerExtractedAt, row.fetchedAt, publicLoadApiUrl(row.receipt.url),
    row.receipt.sha256, row.payloadSha256, row.verification, row.qualityIssues].map(csvCell).join(','));
  return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
}
