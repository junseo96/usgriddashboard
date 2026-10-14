import demand from '../data/grid-demand.json' with { type: 'json' };
import pipeline from '../public/data/load-pipeline.json' with { type: 'json' };
import historical from '../data/history.json' with { type: 'json' };
import loadBottleneck from '../data/load-bottleneck.json' with { type: 'json' };
import loadCoverage from '../data/load-coverage.json' with { type: 'json' };
import loadApi from '../data/load-api-observations.json' with { type: 'json' };
import type { LoadPipelineDataset } from '../shared/market-types.ts';
import { isDemandDataset } from '../shared/market.ts';
import { validateHistoricalDataset, type HistoricalDataset } from '../shared/history.ts';
import { validateLoadBottleneckDataset, type LoadBottleneckDataset } from '../shared/load-bottleneck.ts';
import { validateLoadCoverageDataset, type LoadCoverageDataset } from '../shared/load-coverage.ts';
import { validateLoadApiDataset, type LoadApiDataset } from '../shared/load-api.ts';

export function publicDemand() {
  if (!isDemandDataset(demand)) throw new Error('Published demand dataset failed validation.');
  return demand;
}
export function publicPipeline(): LoadPipelineDataset {
  if (pipeline.schemaVersion !== 1 || !Array.isArray(pipeline.projects) || !Array.isArray(pipeline.aggregates)) {
    throw new Error('Published load pipeline failed validation.');
  }
  return pipeline as LoadPipelineDataset;
}
export function publicHistorical(): HistoricalDataset {
  validateHistoricalDataset(historical);
  return historical;
}
export function publicLoadBottleneck(): LoadBottleneckDataset {
  validateLoadBottleneckDataset(loadBottleneck);
  return loadBottleneck;
}
export function publicLoadCoverage(): LoadCoverageDataset {
  validateLoadCoverageDataset(loadCoverage, new Date(), new Set(loadBottleneck.series.map(series => series.id)));
  return loadCoverage;
}
export function publicLoadApi(): LoadApiDataset {
  validateLoadApiDataset(loadApi);
  return loadApi;
}
