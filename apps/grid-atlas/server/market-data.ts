import demand from '../data/grid-demand.json' with { type: 'json' };
import pipeline from '../public/data/load-pipeline.json' with { type: 'json' };
import historical from '../data/history.json' with { type: 'json' };
import type { LoadPipelineDataset } from '../shared/market-types.ts';
import { isDemandDataset } from '../shared/market.ts';
import { validateHistoricalDataset, type HistoricalDataset } from '../shared/history.ts';

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
