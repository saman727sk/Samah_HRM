/**
 * Demo activity: attendance from the start of the previous month up to the
 * seeding date (so last month can be run through payroll), plus a few
 * pending requests so the approval inboxes are not empty.
 * Deterministic: the same seeding date always produces the same data.
 */
import { addDays, addMonths, eachDay, localTime, monthStart, todayIn, weekday, zonedInstant } from '../src/lib/dates.js';
import { systemClock } from '../src/lib/clock.js';
import { createLeaveRequest } from '../src/services/leave.js';
import { createWfhRequest } from '../src/services/wfh.js';
import { createOvertimeClaim } from '../src/services/overtime.js';
import '../src/services/jobs.js';

/** Small seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const plusMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

export async function seedActivity(db, tenant, { employees, users, leaveTypes }, { clock = systemClock() } = {}) {
  const tz = tenant.timezone;
  const now = clock.now();
  const today = todayIn(tz, now);
  const from = monthStart(addMonths(today, -1));
  const random = rng(Number(today.replaceAll('-', '')));
  const { rows: staff } = await db.query(
    `select e.*, l.lat, l.lng from employees e left join locations l on l.id = e.location_id where e.tenant_id = $1`, [tenant.id]);
  const holidays = new Set((await db.query('select date from holidays where tenant_id = $1', [tenant.id])).rows.map((h) => h.date));
  const { rows: leaves } = await db.query(`select employee_id, start_date, end_date from leave_requests where tenant_id = $1 and status = 'approved'`, [tenant.id]);
  const onLeave = (empId, d) => leaves.some((l) => l.employee_id === empId && l.start_date <= d && l.end_date >= d);

  const insertEvent = (e, type, punchTime, workDate, method, extra = {}) => db.query(
    `insert into attendance_events (tenant_id, employee_id, event_type, server_time, punch_time, device_time, work_date, lat, lng, method,
                                    location_id, time_verified, flags)
     values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [tenant.id, e.id, type, punchTime, extra.deviceTime ?? punchTime, workDate, method === 'wfh' ? null : e.lat, method === 'wfh' ? null : e.lng,
      method, method === 'wfh' ? null : e.location_id, extra.verified ?? true, JSON.stringify(extra.flags ?? [])]);

  let lastWorkday = addDays(today, -1);
  while ([0, 6].includes(weekday(lastWorkday)) || holidays.has(lastWorkday)) lastWorkday = addDays(lastWorkday, -1);
  let events = 0;
  for (const e of staff) {
    await db.query(`insert into consents (tenant_id, user_id, kind, granted, text_version) values ($1, $2, 'location', true, 'v1')`, [tenant.id, e.user_id]);
    for (const d of eachDay(from, addDays(today, -1))) {
      if ([0, 6].includes(weekday(d)) || holidays.has(d) || d < e.joining_date || onLeave(e.id, d)) continue;
      const r = random();
      if (r < 0.04) continue; // absent
      const isWfh = r < 0.12 && weekday(d) !== 3;
      if (isWfh) {
        const { id: groupId } = await db.one('select gen_random_uuid() as id');
        await db.query(`insert into wfh_requests (tenant_id, employee_id, request_group_id, date, status, created_by, decided_by, decided_at, policy_snapshot)
                        values ($1, $2, $3, $4, 'approved', $5, $6, now(), '{"seeded": true}')`, [tenant.id, e.id, groupId, d, e.user_id, users.E001]);
      }
      const method = isWfh ? 'wfh' : 'office_manual';
      const late = random() < 0.08 ? 35 + Math.floor(random() * 100) : Math.floor(random() * 28); // grace ends 09:15
      const inAt = plusMinutes(zonedInstant(d, '08:45', tz), late);
      const unverified = random() < 0.04;
      await insertEvent(e, 'in', inAt, d, method, unverified
        ? { verified: false, deviceTime: plusMinutes(inAt, -25), flags: ['device_clock_mismatch'] } : {});
      if (e.id === employees.E003 && d === lastWorkday) {
        await insertEvent(e, 'out', plusMinutes(inAt, 640), d, method); // a long day, claimed as overtime below
      } else if (random() < 0.05) {
        await insertEvent(e, 'out', zonedInstant(d, '23:30', tz), d, 'system_autoclose', { flags: ['auto_closed'] });
      } else {
        // 8h05 to 9h20 at work: mostly a normal day, sometimes overtime or short hours with lateness.
        await insertEvent(e, 'out', plusMinutes(inAt, 485 + Math.floor(random() * 75)), d, method);
      }
      events += 2;
    }
    // Today: most people already checked in if the working day has started.
    if (localTime(now, tz) >= '09:30' && ![0, 6].includes(weekday(today)) && !holidays.has(today) && random() < 0.75) {
      await insertEvent(e, 'in', plusMinutes(zonedInstant(today, '08:45', tz), Math.floor(random() * 45)), today, 'office_manual');
      events += 1;
    }
  }

  // Pending requests waiting for Bilal (Sales manager).
  const system = { db, tenant, clock, actor: { system: true }, locale: 'en' };
  const nextWeekday = (start, wanted) => { let d = addDays(start, 1); while (!wanted.includes(weekday(d)) || holidays.has(d)) d = addDays(d, 1); return d; };
  const pending = [];
  try {
    pending.push(await createWfhRequest(system, { employeeId: employees.E003, dates: [nextWeekday(addDays(today, 1), [1, 5])], reason: 'Client calls from home' }));
    pending.push(await createLeaveRequest(system, { employeeId: employees.E004, leaveTypeId: leaveTypes.CASUAL,
      startDate: nextWeekday(addDays(today, 2), [1, 2, 3, 4, 5]), reason: 'Family event' }));
    pending.push(await createOvertimeClaim(system, { employeeId: employees.E003, workDate: lastWorkday, reason: 'Quarter-end client report' }));
  } catch (err) {
    console.warn(`Could not create demo pending requests: ${err.message}`);
  }
  return { events, pending: pending.length };
}
