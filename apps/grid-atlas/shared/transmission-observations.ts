import data from '../data/transmission-observations.json' with { type: 'json' };

export const TRANSMISSION_REGIONS = ['CAISO', 'ERCOT', 'PJM', 'MISO', 'SPP', 'NYISO', 'ISO-NE'] as const;
export type TransmissionRegion = typeof TRANSMISSION_REGIONS[number];
export type OperationalMetric = 'price_spread' | 'binding_duration' | 'utilization' | 'curtailment' | 'load';
export type PricePopulation = 'physical_nodes' | 'load_zones' | 'hubs' | 'native_locations' | 'electrical_buses';
export interface OperationalSource { id: string; title: string; publisher: string; url: string; retrievedAt: string; sha256: string; sourceAsOf?: string | null; }
export interface PriceHour { region: string; market: string; population: PricePopulation; populationLabel: string; start: string; end: string; value: number; p10: number; p90: number; nodeCount: number; candidateNodeCount: number; resolutionMinutes: number; quantileMethod: string; sourceIds: string[]; }
export interface PriceSnapshot { region: string; market: string; population: PricePopulation; populationLabel?: string; sourceObservedAt: string | null; capturedAt: string; value: number; p10: number; p90: number; min?: number; max?: number; nodeCount: number; sourceIds: string[]; }
export interface PriceDay { id: string; region: string; date: string; market: string; population: PricePopulation; populationLabel: string; value: number; observedHours: number; expectedHours: number; nodeCountMin: number; nodeCountMax: number; candidateNodeCountMax: number; loadMwh: number | null; matchedLoadHours: number; sourceIds: string[]; }
export interface NationalPriceDay { id: string; date: string; market: string; population: PricePopulation; value: number; loadMwh: number; regions: string[]; excludedRegions: string[]; nationalComplete: boolean; sourceIds: string[]; }
export interface ConstraintDay { id: string; region: string; date: string; assetId: string; contingency: string; bindingMinutes: number; observedMinutes: number; expectedMinutes: number; value: number; sourceIds: string[]; }
export interface ConstraintCoverageDay { region: string; date: string; observedMinutes: number; expectedMinutes: number; anyBindingMinutes: number; value: number; sourceIds: string[]; }
export interface UtilizationDay { id: string; region: string; date: string; assetId: string; contingency: string; value: number; maximum: number; observedHours: number; sampleCount: number; aggregationBasis: 'instantaneous_samples' | 'dispatch_duration'; sourceUnit: string; sourceIds: string[]; }
export interface CurtailmentDay { id: string; region: string; date: string; value: number; observedHours: number; reason: string; sourceIds: string[]; }
export interface OperationalCoverage { region: string; metric: OperationalMetric; status: 'observed' | 'partial' | 'unavailable' | 'auth_required' | 'access_blocked'; reason: string; sourceUrls: string[]; firstDate: string | null; lastDate: string | null; observationCount: number; dayCount: number; lastAttemptAt?: string; }
export interface TransmissionDataset { schemaVersion: 1; methodologyVersion: string; generatedAt: string; requestedStart: string; requestedEnd: string; sources: OperationalSource[]; priceHours: PriceHour[]; priceSnapshots?: PriceSnapshot[]; priceDays: PriceDay[]; nationalDays: NationalPriceDay[]; constraintDays: ConstraintDay[]; constraintCoverageDays: ConstraintCoverageDay[]; utilizationDays: UtilizationDay[]; curtailmentDays: CurtailmentDay[]; coverage: OperationalCoverage[]; notes: string[]; }
export const TRANSMISSION_OBSERVATIONS = data as unknown as TransmissionDataset;

/** Count coverage separately from points: an annual report is never an operational observation. */
export function operationalCoverage(region: string, metric: OperationalMetric, dataset = TRANSMISSION_OBSERVATIONS): OperationalCoverage | undefined {
  return dataset.coverage.find(row => row.region === region && row.metric === metric);
}

/** An asset absent from a successfully complete event feed means no reported binding;
 * absent feeds stay absent. Denominator is the union of verified monitoring windows. */
export function constraintSeries(region: string, assetId: string, contingency: string, dataset = TRANSMISSION_OBSERVATIONS): ConstraintDay[] {
  const actual = new Map(dataset.constraintDays.filter(row => row.region === region && row.assetId === assetId && row.contingency === contingency).map(row => [row.date, row]));
  if (!actual.size) return [];
  return dataset.constraintCoverageDays.filter(row => row.region === region).map(day => actual.get(day.date) ?? {
    id: `${region}|${assetId}|${contingency}|${day.date}`, region, date: day.date, assetId, contingency,
    bindingMinutes: 0, observedMinutes: day.observedMinutes, expectedMinutes: day.expectedMinutes, value: 0, sourceIds: day.sourceIds,
  });
}

export function constraintRanking(region?: string, dataset = TRANSMISSION_OBSERVATIONS) {
  const groups = new Map<string, { region: string; assetId: string; contingency: string; bindingMinutes: number; observedMinutes: number; value: number; days: number; sourceIds: string[] }>();
  const denominators = new Map<string, { minutes: number; days: number; sourceIds: string[] }>();
  for (const day of dataset.constraintCoverageDays) { const previous = denominators.get(day.region) ?? { minutes: 0, days: 0, sourceIds: [] }; previous.minutes += day.observedMinutes; previous.days++; previous.sourceIds = [...new Set([...previous.sourceIds,...day.sourceIds])]; denominators.set(day.region, previous); }
  for (const row of dataset.constraintDays) {
    if (region && row.region !== region) continue;
    const key = JSON.stringify([row.region, row.assetId, row.contingency]);
    const group = groups.get(key) ?? { region: row.region, assetId: row.assetId, contingency: row.contingency, bindingMinutes: 0, observedMinutes: denominators.get(row.region)?.minutes ?? 0, value: 0, days: denominators.get(row.region)?.days ?? 0, sourceIds: denominators.get(row.region)?.sourceIds ?? [] };
    group.bindingMinutes += row.bindingMinutes;
    group.value = group.observedMinutes ? group.bindingMinutes / group.observedMinutes * 100 : 0;
    group.sourceIds = [...new Set([...group.sourceIds, ...row.sourceIds])]; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}
