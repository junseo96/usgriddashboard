/** Analysis calendar: KST (UTC+09:00). Exact instants remain RFC3339 timestamps. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

export function calendarDayKst(value: Date | string | number = new Date()): string {
  const instant = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(instant)) throw new RangeError('A valid instant is required for the KST calendar.');
  return new Date(instant + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Boundary used for comparisons only; it does not invent a source event time. */
export function startOfKstDay(day: string): string {
  if (!isCalendarDay(day)) throw new RangeError('A valid YYYY-MM-DD calendar date is required.');
  return new Date(Date.parse(`${day}T00:00:00Z`) - KST_OFFSET_MS).toISOString();
}

export function endOfKstDay(day: string): string {
  return new Date(Date.parse(startOfKstDay(day)) + DAY_MS - 1).toISOString();
}
