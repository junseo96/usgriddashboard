import dataset from '../data/grid-constraints.json' with { type: 'json' };

export type ConstraintPart = 'transmission' | 'distribution';
export interface ConstraintSource { id: string; title: string; publisher: string; url: string; retrievedAt: string; sha256: string; sourceAsOf: string | null; retrievalNote?: string; }
export interface ConstraintMetric { id: string; label: string; part: ConstraintPart; kind: 'constraint' | 'economic' | 'hosting_capacity' | 'reliability'; unit: string; definition: string; caveat: string; aggregation: 'none' | 'customer_weighted'; higherIsWorse: boolean | null; }
export interface ConstraintObservation { id: string; metricId: string; region: string; scope: string; utility: string | null; state: string | null; periodStart: string; periodEnd: string; periodKind: 'annual' | 'snapshot' | 'multi_year' | 'forecast'; value: number; sourceIds: string[]; locator: string; note: string; customerCount?: number; assetId?: string; sampleCount?: number; numerator?: number; denominator?: number; }
export interface ConstraintCoverage { region: string; part: ConstraintPart; status: 'observed' | 'reference_only' | 'missing'; sourceIds: string[]; detail: string; }
export interface GridConstraintDataset { schemaVersion: 1; generatedAt: string; sources: ConstraintSource[]; metrics: ConstraintMetric[]; observations: ConstraintObservation[]; coverage: ConstraintCoverage[]; notes: string[]; }
export const GRID_CONSTRAINTS = dataset as GridConstraintDataset;
export function getConstraintMetric(id: string): ConstraintMetric | undefined { return GRID_CONSTRAINTS.metrics.find(metric => metric.id === id); }
export function constraintObservations(part: ConstraintPart, region?: string, metricId?: string): ConstraintObservation[] {
  const ids = new Set(GRID_CONSTRAINTS.metrics.filter(metric => metric.part === part).map(metric => metric.id));
  return GRID_CONSTRAINTS.observations.filter(observation => ids.has(observation.metricId) && (!region || region === 'all' || observation.region === region) && (!metricId || observation.metricId === metricId));
}
export function formatConstraintValue(value: number, unit: string): string { return `${value.toLocaleString('ko-KR', { maximumFractionDigits: unit === '%' ? 2 : 3 })} ${unit}`; }
/** Deliberately no universal congestion average: settlement rents, constraint-hours,
 * hosting capacities, and outage statistics have incompatible denominators. */
export function validateGridConstraints(data: GridConstraintDataset = GRID_CONSTRAINTS): string[] {
  const errors: string[] = [];
  const metrics = new Map(data.metrics.map(metric => [metric.id, metric]));
  const sources = new Map(data.sources.map(source => [source.id, source]));
  const ids = new Set<string>();
  for (const source of data.sources) if (!/^[a-f0-9]{64}$/.test(source.sha256) || !source.url.startsWith('https://') || !Number.isFinite(Date.parse(source.retrievedAt))) errors.push(`Invalid source ${source.id}`);
  for (const row of data.observations) {
    const metric = metrics.get(row.metricId);
    if (ids.has(row.id)) errors.push(`Duplicate observation ${row.id}`);
    ids.add(row.id);
    if (!metric || !Number.isFinite(row.value) || row.value < 0) errors.push(`Invalid value ${row.id}`);
    if (!row.sourceIds.length || row.sourceIds.some(id => !sources.has(id))) errors.push(`Missing provenance ${row.id}`);
    if (row.periodEnd < row.periodStart) errors.push(`Reversed period ${row.id}`);
    if (metric?.unit === '%' && row.value > 100) errors.push(`Invalid percentage ${row.id}`);
    if (metric?.kind === 'reliability' && (!row.customerCount || row.customerCount <= 0)) errors.push(`Missing reliability denominator ${row.id}`);
    if (row.denominator !== undefined && (row.denominator <= 0 || row.numerator === undefined || row.numerator < 0 || row.numerator > row.denominator)) errors.push(`Invalid ratio denominator ${row.id}`);
  }
  return errors;
}
