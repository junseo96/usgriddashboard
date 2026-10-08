import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDayKst, endOfKstDay, isCalendarDay, startOfKstDay } from '../shared/time.ts';

test('KST calendar flips at 15:00 UTC and day-end excludes the next local day', () => {
  assert.equal(calendarDayKst('2026-10-08T14:59:59.999Z'), '2026-10-08');
  assert.equal(calendarDayKst('2026-10-08T15:00:00.000Z'), '2026-10-09');
  assert.equal(calendarDayKst('2026-10-09T00:00:00+09:00'), '2026-10-09');
  assert.equal(startOfKstDay('2026-10-09'), '2026-10-08T15:00:00.000Z');
  assert.equal(endOfKstDay('2026-10-08'), '2026-10-08T14:59:59.999Z');
  assert.equal(Date.parse(startOfKstDay('2026-10-09')) - Date.parse(endOfKstDay('2026-10-08')), 1);
});

test('KST boundaries retain leap days and reject malformed calendar dates', () => {
  assert.equal(isCalendarDay('2024-02-29'), true);
  assert.equal(calendarDayKst(startOfKstDay('2024-02-29')), '2024-02-29');
  for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', 'invalid']) {
    assert.equal(isCalendarDay(invalid), false);
    assert.throws(() => startOfKstDay(invalid), /calendar date/);
    assert.throws(() => endOfKstDay(invalid), /calendar date/);
  }
  assert.throws(() => calendarDayKst('invalid'), /valid instant/);
});
