import assert from 'node:assert/strict';
import test from 'node:test';
import { GRID_CONSTRAINTS, constraintObservations, getConstraintMetric, validateGridConstraints } from '../shared/grid-constraints.ts';

test('T&D observations have complete provenance and no fabricated national composite', () => {
  assert.deepEqual(validateGridConstraints(), []);
  assert.deepEqual(new Set(constraintObservations('transmission').map(row => row.region)), new Set(['CAISO', 'PJM', 'ERCOT', 'MISO', 'SPP', 'NYISO', 'ISO-NE']));
  assert.ok(!GRID_CONSTRAINTS.observations.some(row => row.region === 'Nationwide'));
  assert.equal(getConstraintMetric('rt_congestion_event_hours')?.unit, '제약·시간');
});

test('distribution headroom is a dated model snapshot; reliability stays separate', () => {
  const headroom = constraintObservations('distribution', 'CAISO', 'pge_load_headroom_min_mw');
  assert.ok(headroom.length > 1000);
  assert.ok(headroom.every(row => row.periodKind === 'snapshot' && row.utility === 'Pacific Gas & Electric' && row.assetId && row.sampleCount));
  const reliability = constraintObservations('distribution', 'State-level');
  assert.ok(reliability.length > 1000);
  assert.ok(reliability.every(row => row.periodKind === 'annual' && row.customerCount && row.state !== 'AK' && row.state !== 'HI'));
  assert.ok(reliability.every(row => getConstraintMetric(row.metricId)?.kind === 'reliability'));
});

test('SPP unique interval percent cannot be confused with PJM accumulated constraint-hours', () => {
  const spp = constraintObservations('transmission', 'SPP', 'rt_any_constraint_interval_percent');
  assert.equal(spp.find(row => row.periodEnd === '2025-12-31')?.value, 94.3);
  const pjm = constraintObservations('transmission', 'PJM', 'rt_congestion_event_hours');
  assert.equal(pjm.find(row => row.periodEnd === '2025-12-31')?.value, 30485);
  const isoNe = constraintObservations('transmission', 'ISO-NE');
  assert.equal(isoNe[0]?.periodKind, 'multi_year');
  assert.equal(isoNe[0]?.periodStart, '2023-01-01');
});
