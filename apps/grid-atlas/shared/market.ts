import { MARKET_REGIONS, type DemandDataset, type MarketRegion } from './market-types.ts';
import type { Project } from './types.ts';
import { isCalendarDay } from './time.ts';

export interface MarketComparisonRow {
  region: MarketRegion; generationMw: number | null; storageMw: number | null; loadMw: number | null;
  generationCount: number; storageCount: number; loadCount: number; capacityUnknownCount: number;
  sourceAsOf: string[];
}
export interface MarketComparison { regions: MarketComparisonRow[]; snapshotAsOf: string | null; }

/** Counts only active, eligible source records; a hybrid is counted per type. */
export function compareMarkets(projects: readonly Project[], snapshotAsOf: string | null): MarketComparison {
  return { snapshotAsOf, regions: MARKET_REGIONS.map(region => {
    const scoped = projects.filter(p => p.eligible && p.status === 'active' && p.region === region);
    const result: MarketComparisonRow = {
      region, generationMw: null, storageMw: null, loadMw: null,
      generationCount: 0, storageCount: 0, loadCount: 0,
      capacityUnknownCount: scoped.filter(p => p.capacityStatus !== 'known').length,
      sourceAsOf: [...new Set(scoped.flatMap(p => p.sourceAsOf ? [p.sourceAsOf] : []))].sort(),
    };
    for (const type of ['generation', 'storage', 'load'] as const) {
      const rows = scoped.filter(p => p.types.includes(type));
      result[`${type}Count`] = rows.length;
      const disclosed = rows.map(p => p[`${type}Mw`]).filter((mw): mw is number => mw !== null);
      // An absent scope or entirely undisclosed capacity is not zero demand.
      result[`${type}Mw`] = disclosed.length ? disclosed.reduce((sum, mw) => sum + mw, 0) : null;
    }
    return result;
  }) };
}

const instant = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) &&
  isCalendarDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const https = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
};
const marketTimezones: Record<MarketRegion, string> = {
  CAISO: 'America/Los_Angeles', ERCOT: 'America/Chicago', 'ISO-NE': 'America/New_York',
  MISO: 'America/Chicago', NYISO: 'America/New_York', PJM: 'America/New_York', SPP: 'America/Chicago',
};

/** Reject malformed public refresh files before replacing the embedded snapshot. */
export function isDemandDataset(value: unknown): value is DemandDataset {
  if (!value || typeof value !== 'object') return false;
  const d = value as DemandDataset;
  if (d.schemaVersion !== 1 || !instant(d.generatedAt) || !instant(d.lastAttemptAt) ||
    Date.parse(d.lastAttemptAt) > Date.parse(d.generatedAt) ||
    !positive(d.refreshMinutes) || !Array.isArray(d.regions) || d.regions.length !== MARKET_REGIONS.length) return false;
  const regions = new Set<string>();
  for (const r of d.regions) {
    if (!r || !MARKET_REGIONS.includes(r.region) || regions.has(r.region) || typeof r.name !== 'string' ||
      r.timezone !== marketTimezones[r.region] || !https(r.sourceUrl) || typeof r.sourceName !== 'string' ||
      !['available', 'stale', 'unavailable'].includes(r.status) || !Array.isArray(r.warnings) ||
      r.warnings.some(w => typeof w !== 'string') || (r.retrievedAt !== null && !instant(r.retrievedAt)) ||
      (r.observedAt !== null && !instant(r.observedAt)) || (r.intervalMinutes !== null && !positive(r.intervalMinutes)) ||
      (r.latestMw !== null && !positive(r.latestMw)) || (r.latestMw !== null && r.observedAt === null) ||
      !Array.isArray(r.series) || r.series.length > 10_000 || !Array.isArray(r.dailyPeaks) || r.dailyPeaks.length > 32) return false;
    regions.add(r.region);
    try { new Intl.DateTimeFormat('en', { timeZone: r.timezone }); } catch { return false; }
    if (r.status === 'unavailable' ? r.latestMw !== null || r.observedAt !== null || r.series.length !== 0 || r.dailyPeaks.length !== 0
      : r.latestMw === null || r.observedAt === null || r.retrievedAt === null || r.intervalMinutes === null || !r.series.length) return false;
    if (r.retrievedAt !== null && (Date.parse(r.retrievedAt) > Date.parse(d.generatedAt) ||
      (r.observedAt !== null && Date.parse(r.observedAt) > Date.parse(r.retrievedAt)))) return false;
    let previousAt = -Infinity;
    for (const p of r.series) {
      if (!p || !instant(p.observedAt) || !positive(p.mw) || (p.quality !== null && typeof p.quality !== 'string') ||
        Date.parse(p.observedAt) <= previousAt) return false;
      previousAt = Date.parse(p.observedAt);
    }
    if (r.series.length && (r.series.at(-1)!.observedAt !== r.observedAt || r.series.at(-1)!.mw !== r.latestMw)) return false;
    const peakDays = new Set<string>();
    for (const p of r.dailyPeaks) {
      if (!p || !isCalendarDay(p.date) || peakDays.has(p.date) || !positive(p.peakMw) || !instant(p.peakAt) ||
      !Number.isInteger(p.observations) || p.observations < 1 || !Number.isInteger(p.expectedObservations) || p.expectedObservations < p.observations ||
      (p.complete && p.observations !== p.expectedObservations) ||
      typeof p.complete !== 'boolean' || (p.intervalMinutes !== undefined && !positive(p.intervalMinutes)) ||
      (p.sourceName !== undefined && typeof p.sourceName !== 'string') || (p.sourceUrl !== undefined && !https(p.sourceUrl))) return false;
      peakDays.add(p.date);
    }
  }
  return true;
}
