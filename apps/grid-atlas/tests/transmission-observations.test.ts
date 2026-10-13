import test from 'node:test';
import assert from 'node:assert/strict';
import { constraintRanking, constraintSeries, type TransmissionDataset } from '../shared/transmission-observations.ts';

const fixture = {
  constraintDays: [{ id: 'event', region: 'MISO', date: '2026-10-01', assetId: 'A', contingency: 'B', bindingMinutes: 60, observedMinutes: 1440, expectedMinutes: 1440, value: 100 / 24, sourceIds: ['events', 'day1'] }],
  constraintCoverageDays: [
    { region: 'MISO', date: '2026-10-01', observedMinutes: 1440, expectedMinutes: 1440, anyBindingMinutes: 60, value: 100 / 24, sourceIds: ['events', 'day1'] },
    { region: 'MISO', date: '2026-10-03', observedMinutes: 720, expectedMinutes: 1440, anyBindingMinutes: 0, value: 0, sourceIds: ['day3'] },
  ],
} as TransmissionDataset;

test('constraint history fills zero only in verified monitoring windows, leaving a missing day absent', () => {
  const rows = constraintSeries('MISO', 'A', 'B', fixture);
  assert.deepEqual(rows.map(row => [row.date, row.bindingMinutes, row.observedMinutes]), [
    ['2026-10-01', 60, 1440], ['2026-10-03', 0, 720],
  ]);
  assert.deepEqual(rows[1].sourceIds, ['day3']);
  assert.deepEqual(constraintSeries('MISO', 'unknown', 'B', fixture), []);
});

test('constraint period ranking includes monitored days without binding in its denominator and provenance', () => {
  const [row] = constraintRanking('MISO', fixture);
  assert.equal(row.bindingMinutes, 60);
  assert.equal(row.observedMinutes, 2160);
  assert.equal(row.value, 60 / 2160 * 100);
  assert.deepEqual([...row.sourceIds].sort(), ['day1', 'day3', 'events']);
});
