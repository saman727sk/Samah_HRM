/**
 * WFH service: loads the data the pure engine needs, persists requests.
 * Approvals run through services/workflow.js.
 */
import { resolveRequired } from '../config/resolver.js';
import { buildCalendar } from '../engines/calendar.js';
import { evaluateWfhDates, expandRecurrence, wfhQuota } from '../engines/wfh.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, eachDay, isYmd, maxDate, minDate, monthEnd, monthStart } from '../lib/dates.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { assertCanManage } from './access.js';
import { validateCustomFields } from './customFields.js';
import { getEmployee } from './employees.js';
import { notify, userOfEmployee } from './notifications.js';
import { closeTasks, decideRequest, registerHandler, resolveWorkflow, submit } from './workflow.js';
import { requireModule } from './features.js';

const MAX_DATES_PER_REQUEST = 366;

export function resolvePolicy(ctx, employee, date, simulate) {
  return resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'wfh.policy', employee, date, simulate });
}

/** Loads everything the engine needs for dates within [start, end]. */
async function loadContext(ctx, employee, start, end, { simulate } = {}) {
  // Quota windows (week / month) can reach beyond the requested dates.
  const from = minDate(addDays(start, -6), monthStart(start));
  const to = maxDate(addDays(end, 6), monthEnd(end));
  const calendar = await buildCalendar(ctx, employee, from, to);
  const { rows: existing } = await ctx.db.query(
    `select id, date, status from wfh_requests where tenant_id = $4 and employee_id = $1 and status in ('pending', 'approved') and date between $2 and $3`,
    [employee.id, from, to, ctx.tenant.id]);
  const { rows: overrides } = await ctx.db.query(
    `select * from wfh_overrides where tenant_id = $4 and employee_id = $1 and status = 'active' and start_date <= $3 and end_date >= $2`,
    [employee.id, from, to, ctx.tenant.id]);
  const { rows: leaves } = await ctx.db.query(
    `select start_date, end_date from leave_requests where tenant_id = $4 and employee_id = $1 and status in ('pending', 'approved')
        and start_date <= $3 and end_date >= $2`, [employee.id, from, to, ctx.tenant.id]);
  const leaveDates = new Set(leaves.flatMap((l) => [...eachDay(l.start_date, l.end_date)]));
  const policies = new Map();
  for (const d of eachDay(from, to)) policies.set(d, await resolvePolicy(ctx, employee, d, simulate));
  return { calendar, existing, overrides, leaveDates, policyFor: (d) => policies.get(d) };
}

async function datesFromInput(ctx, employee, { dates, recurrence }) {
  if (recurrence) {
    const { startDate, endDate, weekdays } = recurrence;
    if (!isYmd(startDate) || !isYmd(endDate) || endDate < startDate || !Array.isArray(weekdays) || !weekdays.length) {
      throw badRequest('recurrence_invalid', 'A recurring request needs a start date, an end date and at least one weekday.');
    }
    const policy = (await resolvePolicy(ctx, employee, startDate)).value;
    if (!policy.requests.allowRecurring) throw new AppError(422, 'wfh_not_allowed', 'Recurring WFH requests are not allowed by your policy.', { details: { reasons: [{ code: 'wfh.recurring_not_allowed', params: {} }] } });
    const weeks = Math.ceil((new Date(endDate) - new Date(startDate)) / (7 * 86_400_000));
    if (weeks > policy.requests.maxRecurringWeeks) {
      throw new AppError(422, 'wfh_not_allowed', 'This recurring request is too long.', { details: { reasons: [{ code: 'wfh.recurring_too_long', params: { max: policy.requests.maxRecurringWeeks } }] } });
    }
    return expandRecurrence({ startDate, endDate, weekdays });
  }
  if (!Array.isArray(dates) || !dates.length || !dates.every(isYmd)) throw badRequest('dates_invalid', 'Choose at least one valid date.');
  if (dates.length > MAX_DATES_PER_REQUEST) throw badRequest('dates_invalid', `A request can contain at most ${MAX_DATES_PER_REQUEST} dates.`);
  if (dates.length > 1) {
    const policy = (await resolvePolicy(ctx, employee, [...dates].sort()[0])).value;
    if (!policy.requests.allowMultipleDates) {
      throw new AppError(422, 'wfh_not_allowed', 'Only one date per request is allowed.', { details: { reasons: [{ code: 'wfh.multiple_dates_not_allowed', params: {} }] } });
    }
  }
  return dates;
}

/** Dry run: would these dates be allowed? Returns per-date reasons and quota. */
export async function checkWfh(ctx, input) {
  await requireModule(ctx, 'wfh');
  const employee = await getEmployee(ctx, input.employeeId);
  const dates = await datesFromInput(ctx, employee, input);
  if (!dates.length) return { ok: false, results: [], reasons: [{ code: 'wfh.no_dates', params: {} }] };
  const sorted = [...dates].sort();
  const data = await loadContext(ctx, employee, sorted[0], sorted.at(-1));
  return evaluateWfhDates({ dates, today: tenantToday(ctx), employee, ...data });
}

export async function createWfhRequest(ctx, input) {
  const employee = await getEmployee(ctx, input.employeeId);
  if (ctx.actor?.employeeId !== employee.id) await assertCanManage(ctx, employee.id);
  await validateCustomFields(ctx, 'wfh_request', input.customFields);
  const evaluation = await checkWfh(ctx, input);
  if (!evaluation.ok) {
    throw new AppError(422, 'wfh_not_allowed', 'This WFH request breaks the WFH policy.', { details: evaluation });
  }
  const auto = evaluation.results.every((r) => r.autoApprove);
  const groupId = await ctx.db.tx(async (db) => {
    const { id } = await db.one('select gen_random_uuid() as id');
    for (const r of evaluation.results) {
      await db.query(
        `insert into wfh_requests (tenant_id, employee_id, request_group_id, date, status, reason, recurrence, auto_approved,
                                   policy_snapshot, custom_fields, created_by)
         values ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10)`,
        [ctx.tenant.id, employee.id, id, r.date, input.reason ?? null, input.recurrence ?? null, auto,
          { policyVersionIds: r.policyVersionIds, overrideId: r.coveredByOverride?.id ?? null }, input.customFields ?? {}, ctx.actor?.userId ?? null]);
    }
    await audit(db, ctx, { action: 'wfh.requested', entityType: 'wfh_request_group', entityId: id,
      newValue: { employeeId: employee.id, dates: evaluation.results.map((x) => x.date) } });
    return id;
  });
  // Auto-approval for WFH is decided by the WFH policy (or an override), not the workflow.
  const flow = await submit(ctx, 'wfh', groupId, { autoApprove: auto });
  const { rows } = await ctx.db.query('select * from wfh_requests where request_group_id = $1 order by date', [groupId]);
  return { requestGroupId: groupId, status: rows[0].status, autoApproved: auto, requests: rows, evaluation, workflow: flow };
}

const loadGroup = async (ctx, groupId) => {
  const { rows } = await ctx.db.query(`select * from wfh_requests where request_group_id = $1 and tenant_id = $2 order by date`, [groupId, ctx.tenant.id]);
  if (!rows.length) throw notFound('WFH request');
  return rows;
};

const describeWfh = (rows) => `WFH on ${rows.map((r) => r.date).join(', ')}`;

registerHandler('wfh', {
  async load(ctx, groupId) {
    const rows = await loadGroup(ctx, groupId);
    const status = rows.some((r) => r.status === 'pending') ? 'pending' : rows[0].status;
    return { employeeId: rows[0].employee_id, status, summary: describeWfh(rows), days: rows.length };
  },
  async finalize(ctx, groupId, decision, { actorUserId, comment }) {
    const { rows } = await ctx.db.query(
      `update wfh_requests set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4
        where request_group_id = $1 and status = 'pending' returning date`, [groupId, decision, actorUserId, comment]);
    await audit(ctx.db, ctx, { action: `wfh.${decision}`, entityType: 'wfh_request_group', entityId: groupId,
      newValue: { dates: rows.map((r) => r.date), comment } });
  },
});

/** Approve / reject the current step (see services/workflow.js). */
export async function decideWfh(ctx, requestGroupId, input) {
  await loadGroup(ctx, requestGroupId);
  return decideRequest(ctx, 'wfh', requestGroupId, input);
}

/** Cancels the pending dates and any approved dates that haven't happened yet. */
export async function cancelWfh(ctx, requestGroupId, { reason } = {}) {
  const rows = await loadGroup(ctx, requestGroupId);
  const employee = await getEmployee(ctx, rows[0].employee_id, { check: false });
  if (ctx.actor?.employeeId !== employee.id) await assertCanManage(ctx, employee.id);
  const today = tenantToday(ctx);
  const cancellable = rows.filter((r) => r.status === 'pending' || (r.status === 'approved' && r.date > today));
  if (!cancellable.length) throw conflict('not_cancellable', 'Nothing left to cancel in this request.');
  await ctx.db.tx(async (db) => {
    await db.query(`update wfh_requests set status = 'cancelled', decision_comment = coalesce($2, decision_comment) where id = any($1)`,
      [cancellable.map((r) => r.id), reason ?? null]);
    await closeTasks(db, ctx, 'wfh', requestGroupId);
    await audit(db, ctx, { action: 'wfh.cancelled', entityType: 'wfh_request_group', entityId: requestGroupId,
      newValue: { dates: cancellable.map((r) => r.date), reason } });
  });
  const { value: wf } = await resolveWorkflow(ctx, 'wfh', employee);
  await notify(ctx, { userIds: [await userOfEmployee(ctx, employee.manager_id)], event: 'request_cancelled', channels: wf.notify.channels,
    params: { requestType: 'wfh', requestId: requestGroupId, employeeName: employee.full_name, summary: describeWfh(cancellable) } });
  return cancellable.length;
}

/** Remaining WFH quota for the week and month containing `date`. */
export async function getWfhQuota(ctx, employeeId, { date, simulate } = {}) {
  const employee = await getEmployee(ctx, employeeId);
  return quotaFor(ctx, employee, date ?? tenantToday(ctx), { simulate });
}

export async function quotaFor(ctx, employee, date, { simulate } = {}) {
  const data = await loadContext(ctx, employee, date, date, { simulate });
  const { value: policy, versionIds } = data.policyFor(date);
  return { date, ...wfhQuota({ date, policy, existing: data.existing, overrides: data.overrides, calendar: data.calendar }), policyVersionIds: versionIds };
}

/** Temporary exception (e.g. 2 weeks WFH for medical reasons). */
export async function createOverride(ctx, { employeeId, startDate, endDate, reason, bypassLimits = true }) {
  await assertCanManage(ctx, employeeId);
  if (!isYmd(startDate) || !isYmd(endDate) || endDate < startDate) throw badRequest('dates_invalid', 'Choose a valid date range.');
  if (!reason?.trim()) throw badRequest('reason_required', 'A reason is required for a WFH override.');
  const row = await ctx.db.one(
    `insert into wfh_overrides (tenant_id, employee_id, start_date, end_date, reason, bypass_limits, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [ctx.tenant.id, employeeId, startDate, endDate, reason, bypassLimits, ctx.actor?.userId ?? null]);
  await audit(ctx.db, ctx, { action: 'wfh.override_created', entityType: 'wfh_override', entityId: row.id, newValue: row });
  return row;
}
