/**
 * Overtime claims. The attendance engine measures overtime; an employee
 * claims (up to) that much for a day and it goes through the configurable
 * 'workflow.overtime' approval. Payroll pays approved claims, or the
 * attendance figure directly when payroll.rules.overtime.requireApproval
 * is off.
 */
import { resolveRequired } from '../config/resolver.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { isYmd } from '../lib/dates.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { assertCanManage, isHr, isManager, reportIds } from './access.js';
import { daySummaries, lockedPeriodFor } from './attendance.js';
import { getEmployee } from './employees.js';
import { requireModule } from './features.js';
import { closeTasks, decideRequest, registerHandler, submit } from './workflow.js';

const reason = (code, params = {}) => ({ code, params });
const notAllowed = (reasons) => new AppError(422, 'overtime_not_allowed', 'This overtime claim is not allowed.', { details: { reasons } });
const hm = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

const loadClaim = async (ctx, id) => {
  const c = await ctx.db.one('select * from overtime_claims where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!c) throw notFound('Overtime claim');
  return c;
};

/** What the attendance engine saw for a day, plus the payroll threshold. */
export async function overtimeFor(ctx, employee, date) {
  const [day] = await daySummaries(ctx, employee.id, { from: date, to: date });
  const { value: rules } = await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'payroll.rules', employee, date });
  return { minutes: day.overtimeMinutes ?? 0, offDay: (day.flags ?? []).includes('worked_on_off_day'), minMinutes: rules.overtime.minMinutes, day };
}

export async function createOvertimeClaim(ctx, { employeeId, workDate, minutes, reason: why = null }) {
  await requireModule(ctx, 'overtime');
  const employee = await getEmployee(ctx, employeeId);
  if (ctx.actor?.employeeId !== employee.id) await assertCanManage(ctx, employee.id);
  if (!isYmd(workDate)) throw badRequest('date_invalid', 'Choose the day you worked overtime.');
  if (minutes != null && !(Number.isInteger(minutes) && minutes > 0)) throw badRequest('minutes_invalid', 'Minutes must be a whole number above 0.');
  if (workDate > tenantToday(ctx)) throw notAllowed([reason('overtime.in_future', { date: workDate })]);
  const locked = await lockedPeriodFor(ctx, workDate);
  if (locked) throw notAllowed([reason('overtime.period_locked', { date: workDate, period: locked.period_key })]);

  const seen = await overtimeFor(ctx, employee, workDate);
  const claimed = minutes ?? seen.minutes;
  const reasons = [];
  if (seen.minutes <= 0) reasons.push(reason('overtime.none_recorded', { date: workDate }));
  else if (claimed > seen.minutes) reasons.push(reason('overtime.too_many_minutes', { date: workDate, max: seen.minutes }));
  else if (claimed < seen.minMinutes) reasons.push(reason('overtime.below_minimum', { min: seen.minMinutes }));
  const existing = await ctx.db.one(`select 1 from overtime_claims where employee_id = $1 and work_date = $2 and status in ('pending', 'approved')`,
    [employee.id, workDate]);
  if (existing) reasons.push(reason('overtime.already_claimed', { date: workDate }));
  if (reasons.length) throw notAllowed(reasons);

  const row = await ctx.db.one(
    `insert into overtime_claims (tenant_id, employee_id, work_date, minutes, attendance_minutes, off_day, reason, status, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) returning *`,
    [ctx.tenant.id, employee.id, workDate, claimed, seen.minutes, seen.offDay, why, ctx.actor?.userId ?? null]);
  await audit(ctx.db, ctx, { action: 'overtime.claimed', entityType: 'overtime_claim', entityId: row.id, newValue: row });
  const flow = await submit(ctx, 'overtime', row.id);
  return { claim: await loadClaim(ctx, row.id), workflow: flow };
}

/** Own claims; managers also see their team's, HR everyone's. */
export async function listOvertimeClaims(ctx, { employeeId, status, from, to } = {}) {
  let ids = null;
  if (employeeId) { await getEmployee(ctx, employeeId); ids = [employeeId]; }
  else if (!isHr(ctx)) ids = [ctx.actor.employeeId, ...(isManager(ctx) ? await reportIds(ctx, ctx.actor.employeeId) : [])];
  const { rows } = await ctx.db.query(
    `select c.*, e.full_name as employee_name, e.employee_code from overtime_claims c join employees e on e.id = c.employee_id
      where c.tenant_id = $1 and ($2::uuid[] is null or c.employee_id = any($2)) and ($3::text is null or c.status = $3)
        and ($4::date is null or c.work_date >= $4) and ($5::date is null or c.work_date <= $5)
      order by c.work_date desc, c.created_at desc limit 300`, [ctx.tenant.id, ids, status ?? null, from ?? null, to ?? null]);
  return rows;
}

export async function cancelOvertimeClaim(ctx, id) {
  const c = await loadClaim(ctx, id);
  if (ctx.actor?.employeeId !== c.employee_id) await assertCanManage(ctx, c.employee_id);
  if (c.status !== 'pending' && !(c.status === 'approved' && isHr(ctx))) throw conflict('not_cancellable', `This claim is already ${c.status}.`);
  const locked = await lockedPeriodFor(ctx, c.work_date);
  if (locked) throw notAllowed([reason('overtime.period_locked', { date: c.work_date, period: locked.period_key })]);
  await ctx.db.tx(async (db) => {
    await db.query(`update overtime_claims set status = 'cancelled' where id = $1`, [id]);
    await closeTasks(db, ctx, 'overtime', id);
    await audit(db, ctx, { action: 'overtime.cancelled', entityType: 'overtime_claim', entityId: id, oldValue: c });
  });
}

export async function decideOvertimeClaim(ctx, id, input) {
  await loadClaim(ctx, id);
  return decideRequest(ctx, 'overtime', id, input);
}

/** Approved overtime minutes in a date range, split by working / off days. */
export async function approvedOvertime(ctx, employeeId, from, to) {
  const row = await ctx.db.one(
    `select coalesce(sum(minutes) filter (where not off_day), 0)::int as working, coalesce(sum(minutes) filter (where off_day), 0)::int as off_day
       from overtime_claims where tenant_id = $1 and employee_id = $2 and status = 'approved' and work_date between $3 and $4`,
    [ctx.tenant.id, employeeId, from, to]);
  return { working: row.working, offDay: row.off_day };
}

registerHandler('overtime', {
  async load(ctx, id) {
    const c = await loadClaim(ctx, id);
    return { employeeId: c.employee_id, status: c.status, summary: `${hm(c.minutes)} overtime on ${c.work_date}${c.off_day ? ' (day off)' : ''}` };
  },
  async beforeFinalApprove(ctx, id) {
    const c = await loadClaim(ctx, id);
    const locked = await lockedPeriodFor(ctx, c.work_date);
    if (locked) throw notAllowed([reason('overtime.period_locked', { date: c.work_date, period: locked.period_key })]);
  },
  async finalize(ctx, id, decision, { actorUserId, comment }) {
    const c = await loadClaim(ctx, id);
    await ctx.db.query(`update overtime_claims set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 where id = $1`,
      [id, decision, actorUserId, comment]);
    await audit(ctx.db, ctx, { action: `overtime.${decision}`, entityType: 'overtime_claim', entityId: id, oldValue: c, newValue: { decision, comment } });
  },
});
