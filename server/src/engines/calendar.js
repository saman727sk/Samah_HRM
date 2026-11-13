/**
 * Working-day calendar for one employee over a date range: weekend days come
 * from the effective-dated 'attendance.calendar' setting, holidays from the
 * employee's holiday calendar (or the tenant default).
 */
import { resolveRequired } from '../config/resolver.js';
import { eachDay, weekday } from '../lib/dates.js';

export async function buildCalendar(ctx, employee, start, end) {
  const { rows: holidays } = await ctx.db.query(
    `select h.date, h.name from holidays h
       join holiday_calendars c on c.id = h.calendar_id
      where h.tenant_id = $1 and h.is_active and not h.is_optional and h.date between $2 and $3
        and c.id = coalesce($4, (select id from holiday_calendars where tenant_id = $1 and is_default))`,
    [ctx.tenant.id, start, end, employee?.holiday_calendar_id ?? null]);
  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));

  const days = new Map();
  for (const date of eachDay(start, end)) {
    const { value, versionIds } = await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'attendance.calendar', employee, date });
    days.set(date, {
      weekend: value.weekendDays.includes(weekday(date)),
      holiday: holidayByDate.get(date) ?? null,
      weekStartsOn: value.weekStartsOn,
      versionIds,
    });
  }
  const day = (date) => {
    const d = days.get(date);
    if (!d) throw new Error(`Calendar was not built for ${date}`);
    return d;
  };
  return {
    day,
    isWeekend: (date) => day(date).weekend,
    holiday: (date) => day(date).holiday,
    isWorkingDay: (date) => !day(date).weekend && !day(date).holiday,
    weekStartsOn: (date) => day(date).weekStartsOn,
  };
}
