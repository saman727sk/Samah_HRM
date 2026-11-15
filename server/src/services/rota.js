/**
 * Rota: which shift each person works on each day of a week.
 *
 *   manager  plans the rota of everyone who reports to them (directly or further down)
 *   hr_admin plans anyone's rota
 *   everyone sees their own upcoming days
 *
 * A rota entry wins over the person's usual shift for that day (attendance judges late / half day
 * against it), and an "Off" entry makes the day a rest day like a weekend (attendance, leave and
 * payroll all read days through engines/calendar.js, which asks rotaFor()). Days in an approved or
 * locked payroll period can't be changed. Part of the attendance module.
 */
import { resolve } from '../config/resolver.js';
import { buildCalendar } from '../engines/calendar.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, eachDay, isYmd, startOfWeek } from '../lib/dates.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { isHr, isManager, isSystem, reportIds, requirePermission } from './access.js';
import { requireModule } from './features.js';
import { notify, userOfEmployee } from './notifications.js';

const MAX_CHANGES = 2000;

/** Rota entries of one person between two dates, by date. Used by the calendar and the shift lookup. */
export async function rotaFor(db, tenantId, employeeId, from, to) {
  if (!employeeId) return new Map();
  const { rows } = await db.query(
    'select date, shift_id, is_off from rota_entries where tenant_id = $1 and employee_id = $2 and date between $3 and $4',
    [tenantId, employeeId, from, to]);
  return new Map(rows.map((r) => [r.date, r]));
}

/** Who the signed-in person may plan: null = anyone (HR); otherwise a list of employee ids. */
async function plannable(ctx) {
  if (isHr(ctx) || isSystem(ctx)) return null;
  if (isManager(ctx) && ctx.actor.employeeId) { requirePermission(ctx, 'team.rota'); return reportIds(ctx, ctx.actor.employeeId); }
  throw forbidden('Only managers and HR plan rotas.');
}

const monday = (date) => startOfWeek(date, 1);

/** Shifts with their timings on a date, for the planner's choices and labels. */
async function shiftsOn(ctx, date) {
  const { rows } = await ctx.db.query(
    'select id, code, name, is_active from shifts where tenant_id = $1 order by sort_order, name', [ctx.tenant.id]);
  for (const s of rows) {
    const r = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'shift.rules', subjectId: s.id, date });
    s.start = r.found ? r.value.start : null;
    s.end = r.found ? r.value.end : null;
  }
  return rows;
}

/** The planner: people (rows), the 7 days of the week (columns), the entries, and the shifts to choose from. */
export async function getRota(ctx, { week, departmentId = null } = {}) {
  await requireModule(ctx, 'attendance');
  const scope = await plannable(ctx);
  const start = monday(isYmd(week) ? week : tenantToday(ctx));
  const end = addDays(start, 6);
  const { rows: people } = await ctx.db.query(
    `select e.id, e.employee_code, e.full_name, e.shift_id, d.name as department, r.name as role, m.full_name as manager
       from employees e left join departments d on d.id = e.department_id left join roles r on r.id = e.role_id
       left join employees m on m.id = e.manager_id
      where e.tenant_id = $1 and e.status = 'active' and e.joining_date <= $2 and (e.exit_date is null or e.exit_date >= $3)
        and ($4::uuid[] is null or e.id = any($4)) and ($5::uuid is null or e.department_id = $5)
      order by d.name nulls last, e.full_name`, [ctx.tenant.id, end, start, scope, departmentId]);
  const { rows: entries } = await ctx.db.query(
    `select employee_id, date, shift_id, is_off, note from rota_entries
      where tenant_id = $1 and date between $2 and $3 and employee_id = any($4)`, [ctx.tenant.id, start, end, people.map((p) => p.id)]);
  const { rows: holidays } = await ctx.db.query(
    `select h.date, h.name from holidays h join holiday_calendars c on c.id = h.calendar_id
      where h.tenant_id = $1 and c.is_default and h.is_active and not h.is_optional and h.date between $2 and $3`, [ctx.tenant.id, start, end]);
  const cal = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'attendance.calendar', date: start });
  const weekendDays = cal.found ? cal.value.weekendDays : [0, 6];
  const locked = await ctx.db.query(
    `select period_start, period_end from payroll_runs where tenant_id = $1 and status in ('approved', 'locked')
      and period_start <= $3 and period_end >= $2`, [ctx.tenant.id, start, end]);
  const days = [...eachDay(start, end)].map((date) => ({
    date, weekend: weekendDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
    holiday: holidays.find((h) => h.date === date)?.name ?? null,
    locked: locked.rows.some((p) => p.period_start <= date && p.period_end >= date),
  }));
  return { weekStart: start, weekEnd: end, days, people, entries, shifts: await shiftsOn(ctx, start), canPlanEveryone: scope === null };
}

/**
 * Saves cells of the planner. changes: [{ employeeId, date, shiftId?, off?, note? }]
 *   shiftId -> works that shift; off: true -> rest day; neither -> back to the usual shift (entry removed).
 * Everyone whose rota changed is notified once.
 */
export async function saveRota(ctx, { changes } = {}) {
  await requireModule(ctx, 'attendance');
  const scope = await plannable(ctx);
  if (!Array.isArray(changes) || !changes.length) throw badRequest('rota_empty', 'Nothing to save.');
  if (changes.length > MAX_CHANGES) throw badRequest('rota_too_big', `Save at most ${MAX_CHANGES} cells at a time.`);
  const errors = [];
  const { rows: emps } = await ctx.db.query(`select id, full_name, status from employees where tenant_id = $1 and id = any($2)`,
    [ctx.tenant.id, [...new Set(changes.map((c) => c.employeeId))]]);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const { rows: shifts } = await ctx.db.query('select id, name, is_active from shifts where tenant_id = $1', [ctx.tenant.id]);
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  for (const c of changes) {
    const who = byId.get(c.employeeId);
    if (!who) { errors.push('An employee in the rota was not found.'); continue; }
    if (scope && !scope.includes(c.employeeId)) errors.push(`${who.full_name} doesn't report to you.`);
    if (!isYmd(c.date)) errors.push(`"${c.date}" is not a date.`);
    if (c.shiftId && !shiftById.has(c.shiftId)) errors.push('A chosen shift was not found.');
    if (c.shiftId && c.off) errors.push(`${who.full_name} on ${c.date}: choose a shift or Off, not both.`);
    if (c.note && String(c.note).length > 200) errors.push('A note can be at most 200 characters.');
  }
  if (errors.length) throw badRequest('rota_invalid', [...new Set(errors)].join(' '), { details: { errors: [...new Set(errors)] } });
  const dates = changes.map((c) => c.date).sort();
  const { rows: locked } = await ctx.db.query(
    `select period_key, period_start, period_end from payroll_runs where tenant_id = $1 and status in ('approved', 'locked')
      and period_start <= $3 and period_end >= $2`, [ctx.tenant.id, dates[0], dates.at(-1)]);
  const lockedDay = changes.find((c) => locked.some((p) => p.period_start <= c.date && p.period_end >= c.date));
  if (lockedDay) throw badRequest('rota_locked', `${lockedDay.date} is in an approved payroll period, so its rota can't change any more.`);

  const changedWeeks = new Map(); // employeeId -> earliest week changed
  await ctx.db.tx(async (db) => {
    for (const c of changes) {
      const before = await db.one('select shift_id, is_off from rota_entries where tenant_id = $1 and employee_id = $2 and date = $3',
        [ctx.tenant.id, c.employeeId, c.date]);
      const want = c.off ? { shift_id: null, is_off: true } : c.shiftId ? { shift_id: c.shiftId, is_off: false } : null;
      const same = (!before && !want) || (before && want && before.shift_id === want.shift_id && before.is_off === want.is_off);
      if (want) {
        await db.query(
          `insert into rota_entries (tenant_id, employee_id, date, shift_id, is_off, note, updated_by) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (employee_id, date) do update set shift_id = excluded.shift_id, is_off = excluded.is_off, note = excluded.note,
             updated_by = excluded.updated_by, updated_at = now()`,
          [ctx.tenant.id, c.employeeId, c.date, want.shift_id, want.is_off, c.note?.trim() || null, ctx.actor?.userId ?? null]);
      } else if (before) {
        await db.query('delete from rota_entries where tenant_id = $1 and employee_id = $2 and date = $3', [ctx.tenant.id, c.employeeId, c.date]);
      }
      if (!same) {
        const wk = monday(c.date);
        if (!changedWeeks.has(c.employeeId) || wk < changedWeeks.get(c.employeeId)) changedWeeks.set(c.employeeId, wk);
      }
    }
    await audit(db, ctx, { action: 'rota.updated', entityType: 'rota', entityId: null,
      meta: { cells: changes.length, changedPeople: changedWeeks.size, from: dates[0], to: dates.at(-1) } });
  });
  const by = ctx.actor?.employeeId
    ? (await ctx.db.one('select full_name from employees where id = $1', [ctx.actor.employeeId]))?.full_name ?? 'Your manager' : 'HR';
  for (const [employeeId, week] of changedWeeks) {
    if (employeeId === ctx.actor?.employeeId) continue;
    const userId = await userOfEmployee(ctx, employeeId);
    if (userId) await notify(ctx, { userIds: [userId], event: 'rota_changed', params: { by, week } });
  }
  return { saved: changes.length, changedPeople: changedWeeks.size };
}

/** Copies one week's rota onto another for everyone the planner may plan (the target week is replaced). */
export async function copyWeek(ctx, { fromWeek, toWeek, departmentId = null } = {}) {
  if (!isYmd(fromWeek) || !isYmd(toWeek)) throw badRequest('rota_invalid', 'Choose the weeks to copy from and to.');
  const src = await getRota(ctx, { week: fromWeek, departmentId });
  const dst = await getRota(ctx, { week: toWeek, departmentId });
  if (src.weekStart === dst.weekStart) throw badRequest('rota_invalid', 'Choose a different week to copy to.');
  const people = new Set(dst.people.map((p) => p.id));
  const shift = (date) => addDays(dst.weekStart, Math.round((Date.parse(date) - Date.parse(src.weekStart)) / 864e5));
  const changes = [];
  for (const p of dst.people) for (const d of dst.days) changes.push({ employeeId: p.id, date: d.date }); // clear the target...
  const index = new Map(changes.map((c, i) => [`${c.employeeId}|${c.date}`, i]));
  for (const e of src.entries) { // ...then fill it from the source
    if (!people.has(e.employee_id)) continue;
    const i = index.get(`${e.employee_id}|${shift(e.date)}`);
    changes[i] = { ...changes[i], shiftId: e.shift_id, off: e.is_off, note: e.note };
  }
  if (!changes.length) return { saved: 0, changedPeople: 0 };
  return saveRota(ctx, { changes });
}

/** The signed-in person's next days: the rota shift, Off, or their usual shift. */
export async function myRota(ctx, { from = null, days = 14 } = {}) {
  await requireModule(ctx, 'attendance');
  const employeeId = ctx.actor?.employeeId;
  if (!employeeId) return { days: [] };
  const start = isYmd(from) ? from : tenantToday(ctx);
  const end = addDays(start, Math.min(Math.max(Number(days) || 14, 1), 31) - 1);
  const emp = await ctx.db.one('select id, shift_id, holiday_calendar_id, department_id, role_id, employment_type_id from employees where id = $1', [employeeId]);
  const entries = await rotaFor(ctx.db, ctx.tenant.id, employeeId, start, end);
  const shifts = new Map((await shiftsOn(ctx, start)).map((s) => [s.id, s]));
  const calendar = await buildCalendar(ctx, emp, start, end);
  return {
    days: [...eachDay(start, end)].map((date) => {
      const e = entries.get(date);
      const day = calendar.day(date);
      const shiftId = e?.shift_id ?? (e?.is_off ? null : emp.shift_id);
      const s = shifts.get(shiftId);
      return { date, source: e ? 'rota' : 'usual', off: !!e?.is_off || (!e && day.weekend), holiday: day.holiday,
        shift: s && !day.weekend ? { name: s.name, start: s.start, end: s.end } : null };
    }),
  };
}
