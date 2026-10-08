import type { CapacityBasis, PipelineAggregate } from '../shared/market-types';

const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
export const marketNumber = (value: number | null | undefined) => value === null || value === undefined ? '미확보' : nf.format(value);
export const formatGw = (value: number | null | undefined) => value === null || value === undefined ? '미확보' : (value / 1000).toLocaleString('ko-KR', { maximumFractionDigits: value > 0 && value < 1000 ? 3 : 2 });
export const capacityQualifier = (row: PipelineAggregate) => row.capacityMw === null ? '' : ({ approximate: '약 ', greater_than: '> ', at_least: '≥ ', exact: '' }[row.capacityQualifier ?? 'exact']);
export const qualifiedCapacity = (row: PipelineAggregate) => `${capacityQualifier(row)}${marketNumber(row.capacityMw)}`;
export const qualifiedGw = (row: PipelineAggregate) => `${capacityQualifier(row)}${formatGw(row.capacityMw)}`;
export const CAPACITY_LABELS: Record<CapacityBasis, string> = { requested_grid_mw: '계통 접속 요청', contracted_grid_mw: '계통 공급 계약', site_power_mw: '부지 전체 전력', it_mw: 'IT 설비 전력', generation_mw: '발전 용량', mixed_mw: '용량 기준 혼재', unknown: '용량 기준 미확인' };
export const marketDate = (value: string | null | undefined, time = true) => {
  if (!value) return '미공개';
  if (!value.includes('T')) return value.replaceAll('-', '.');
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '미공개' : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(parsed);
};
export const externalUrl = (url: string) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } };
