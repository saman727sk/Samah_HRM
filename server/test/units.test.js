/** Pure helpers: dates, merging, leave year and pro-rating maths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, fullMonthsBetween, startOfWeek, todayIn } from '../src/lib/dates.js';
import { deepMerge, diffValues } from '../src/lib/util.js';
import { entitlementFor, leaveYearOf } from '../src/engines/leave.js';

test('dates', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(fullMonthsBetween('2026-02-02', '2026-03-01'), 0);
  assert.equal(fullMonthsBetween('2026-02-02', '2026-03-02'), 1);
  assert.equal(startOfWeek('2026-03-04', 1), '2026-03-02');
  assert.equal(startOfWeek('2026-03-04', 6), '2026-02-28');
  // 23:30 UTC on 3 March is already 4 March in Karachi (UTC+5).
  assert.equal(todayIn('Asia/Karachi', new Date('2026-03-03T23:30:00Z')), '2026-03-04');
});

test('deepMerge: objects merge, arrays replace', () => {
  assert.deepEqual(deepMerge({ a: 1, n: { x: 1, y: 2 }, l: [1, 2] }, { n: { y: 3 }, l: [9] }), { a: 1, n: { x: 1, y: 3 }, l: [9] });
  assert.deepEqual(diffValues({ a: 1, b: 2 }, { a: 1, c: 3 }).map((c) => [c.path, c.change]), [['b', 'removed'], ['c', 'added']]);
});

test('custom fiscal leave year (1 July)', () => {
  assert.deepEqual(leaveYearOf('2026-03-04', { startMonth: 7, startDay: 1 }), { year: 2025, start: '2025-07-01', end: '2026-06-30' });
  assert.deepEqual(leaveYearOf('2026-07-01', { startMonth: 7, startDay: 1 }), { year: 2026, start: '2026-07-01', end: '2027-06-30' });
});

test('leaver pro-rating', () => {
  const rule = { entitlementDays: 20, proRate: { joiners: true, leavers: true, roundingStep: 0.5 } };
  const year = { start: '2026-01-01', end: '2026-12-31' };
  const e = entitlementFor({ rule, employee: { joining_date: '2020-01-01', exit_date: '2026-06-30' }, year, asOf: '2026-06-30' });
  assert.equal(e.days, 10); // 181/365 x 20 = 9.9
});
