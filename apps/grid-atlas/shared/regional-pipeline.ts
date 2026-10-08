/** Curated regional evidence selection; never infer a total from overlapping rows. */
import { MARKET_REGIONS, type LoadPipelineDataset, type MarketRegion, type PipelineAggregate, type RegionalPipelineCoverage } from './market-types.ts';

export interface ResolvedRegionalPipeline extends Omit<RegionalPipelineCoverage, 'headlineAggregateId' | 'additionalAggregateIds'> {
  headline: PipelineAggregate | null;
  additional: PipelineAggregate[];
}

// Reviewed operator-wide requested-load publications. A utility's requested MW
// is not made operator-wide merely by setting metadata.coverage.
const OPERATOR_REQUEST_HEADLINES: Partial<Record<MarketRegion, string>> = {
  ERCOT: 'disclosure:ERCOT_LARGE_LOAD_REQUESTS_20260618',
};

function unavailable(region: MarketRegion): ResolvedRegionalPipeline {
  return { region, coverage: 'unavailable', headline: null, additional: [],
    scopeLabel: '권역 전체 공개 분모 미확보', metricLabel: '수용가 파이프라인 미확보',
    explanation: '검증된 권역별 표시 기준을 확인하지 못했습니다. 개별 사례나 유틸리티 집계를 추측해 합산하지 않습니다.' };
}

function officialErcotUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.ercot.com' && !url.username && !url.password; } catch { return false; }
}

function readable(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveRegionalPipelines(dataset: LoadPipelineDataset): ResolvedRegionalPipeline[] {
  const rows = Array.isArray(dataset.regionalCoverage) ? dataset.regionalCoverage : [];
  const aggregates = Array.isArray(dataset.aggregates) ? dataset.aggregates : [];
  return MARKET_REGIONS.map(region => {
    const entries = rows.filter(row => row?.region === region);
    if (entries.length !== 1) return unavailable(region);
    const entry = entries[0];
    if (!['operator_requests', 'partial_pipeline', 'register_only', 'unavailable'].includes(entry.coverage)
      || !Array.isArray(entry.additionalAggregateIds)
      || ![entry.scopeLabel, entry.metricLabel, entry.explanation].every(readable)) return unavailable(region);
    if (entry.coverage === 'unavailable') {
      if (entry.headlineAggregateId !== null || entry.additionalAggregateIds.length) return unavailable(region);
      const { headlineAggregateId: _headline, additionalAggregateIds: _additional, ...metadata } = entry;
      return { ...metadata, headline: null, additional: [] };
    }
    if (!readable(entry.headlineAggregateId) || !entry.additionalAggregateIds.every(readable)) return unavailable(region);
    const ids = [entry.headlineAggregateId, ...entry.additionalAggregateIds];
    if (new Set(ids).size !== ids.length) return unavailable(region);
    const resolved = ids.map(id => aggregates.filter(aggregate => aggregate?.id === id));
    if (resolved.some(matches => matches.length !== 1 || matches[0].region !== region)) return unavailable(region);
    const [headline, ...additional] = resolved.map(matches => matches[0]);
    if (entry.coverage === 'operator_requests' && (OPERATOR_REQUEST_HEADLINES[region] !== headline.id
      || headline.capacityBasis !== 'requested_grid_mw' || headline.capacityMw === null
      || !officialErcotUrl(headline.sourceUrl))) return unavailable(region);
    if (entry.coverage === 'register_only' && (region !== 'NYISO' || headline.id !== 'register-summary:nyiso-active-load')) return unavailable(region);
    const { headlineAggregateId: _headline, additionalAggregateIds: _additional, ...metadata } = entry;
    // Return original evidence unchanged: lower bounds, unknown dates, units and
    // exclusions remain attached. Additional rows are alternatives, not addends.
    return { ...metadata, headline, additional };
  });
}
