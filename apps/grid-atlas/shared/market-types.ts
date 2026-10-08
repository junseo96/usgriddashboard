/** Public demand observations and explicitly classified large-load evidence. */
export const MARKET_REGIONS = ['CAISO', 'ERCOT', 'ISO-NE', 'MISO', 'NYISO', 'PJM', 'SPP'] as const;
export type MarketRegion = typeof MARKET_REGIONS[number];
export interface DemandPoint { observedAt: string; mw: number; quality: string | null; }
export interface DailyPeak {
  date: string; peakMw: number; peakAt: string; observations: number;
  expectedObservations: number; complete: boolean;
  intervalMinutes?: number; sourceName?: string; sourceUrl?: string;
}
export interface RegionDemand {
  region: MarketRegion; name: string; timezone: string;
  sourceName: string; sourceUrl: string; retrievedAt: string | null;
  observedAt: string | null; intervalMinutes: number | null; latestMw: number | null;
  status: 'available' | 'stale' | 'unavailable';
  series: DemandPoint[]; dailyPeaks: DailyPeak[]; warnings: string[];
}
export interface DemandDataset {
  schemaVersion: 1; generatedAt: string; lastAttemptAt: string;
  refreshMinutes: number; regions: RegionDemand[];
}
export type PipelineClass = 'application' | 'utility_register' | 'contract' | 'announced' | 'grid_support' | 'historical';
export type CapacityBasis = 'requested_grid_mw' | 'contracted_grid_mw' | 'site_power_mw' | 'it_mw' | 'generation_mw' | 'mixed_mw' | 'unknown';
export interface PipelineProject {
  id: string; name: string; region: string; state: string | null;
  sector: 'data_center' | 'manufacturing' | 'crypto' | 'other' | 'undisclosed';
  classification: PipelineClass; status: 'planned' | 'active' | 'construction' | 'operating' | 'withdrawn' | 'unknown';
  capacityMw: number | null; capacityBasis: CapacityBasis;
  sourceName: string; sourceUrl: string; sourceAsOf: string | null; checkedAt: string | null;
  evidence: string; caveats: string[]; linkedProjectId: string | null;
}
export interface PipelineAggregate {
  id: string; region: string; name: string; capacityMw: number | null; projectCount: number | null;
  capacityBasis: CapacityBasis; sourceName: string; sourceUrl: string; sourceAsOf: string | null;
  checkedAt: string | null; scope: string; caveats: string[];
  capacityQualifier?: 'exact' | 'approximate' | 'greater_than' | 'at_least';
}
export interface RegionalPipelineCoverage {
  region: MarketRegion; coverage: 'operator_requests' | 'partial_pipeline' | 'register_only' | 'unavailable';
  headlineAggregateId: string | null; additionalAggregateIds: string[];
  scopeLabel: string; metricLabel: string; explanation: string;
}
export interface LoadPipelineDataset {
  schemaVersion: 1; generatedAt: string; projects: PipelineProject[];
  aggregates: PipelineAggregate[]; limitations: string[];
  regionalCoverage?: RegionalPipelineCoverage[];
}
