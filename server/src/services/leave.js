/**
 * Leave service: ledger-backed balances and leave requests.
 *
 * The ledger is append-only. syncLedger() is idempotent and posts only the
 * entries that are due:
 *   grant              yearly entitlement (non-accrual types), once per year
 *   policy_adjustment  difference when the effective entitlement changes
 *                      (published policy change, probation ended, tenure band)
 *   accrual            monthly credit for accrual types (rule as of that month)
 *   carry_forward      unused days brought into the new year (up to the limit)
 *   lapse              unused days beyond the carry-forward limit
 *   expiry             carried-forward days not used before they expire
 * Past leave years are frozen: they only receive missing entries, never
 * adjustments, so a policy change cannot rewrite history.
 */
import { resolve, resolveRequired } from '../config/resolver.js';
import { buildCalendar } from '../engines/calendar.js';
import { accrualSchedule, countLeaveDays, entitlementFor, evaluateLeaveRequest, isLimited, leaveYearOf } from '../engines/leave.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, addMonths, eachDay, isYmd, maxDate, minDate, monthEnd, monthStart } from '../lib/dates.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { round2 } from '../lib/util.js';
import { assertCanManage, assertInTenant } from './access.js';
import { lockedPeriodOverlapping } from './attendance.js';
import { validateCustomFields } from './customFields.js';
import { getEmployee, listEmployees } from './employees.js';
import { notify, userOfEmployee } from './notifications.js';
import { closeTasks, decideRequest, registerHandler, resolveWorkflow, submit } from './workflow.js';
import { requireModule } from './features.js';

const sum = (rows, kinds) => round2(rows.filter((r) => !kinds || kinds.includes(r.kind)).reduce((s, r) => s + r.days, 0));
const negate = (n) => (n === 0 ? 0 : -n); // avoid -0 in API output

export async function leaveYearConfig(ctx, date) {
  return (await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'leave.year', date })).value;
}

export async function leaveYear(ctx, date) {
  return leaveYearOf(date, await leaveYearConfig(ctx, date));
}

export function resolveRule(ctx, employee, leaveTypeId, date, simulate) {
  return resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'leave.type', subjectId: leaveTypeId, employee, date, simulate });
}

export async function leaveTypes(ctx, { activeOnly = true } = {}) {
  return (await ctx.db.query(`select * from leave_types where tenant_id = $1 ${activeOnly ? 'and is_active' : ''} order by sort_order, name`,
    [ctx.tenant.id])).rows;
}

async function ledgerRows(db, employeeId, leaveTypeId, year) {
  return (await db.query(
    `select * from leave_ledger where employee_id = $1 and leave_type_id = $2 and leave_year = $3
        and tenant_id = (select tenant_id from employees where id = $1) order by entry_date, created_at`,
    [employeeId, leaveTypeId, year])).rows;
}

async function post(db, ctx, e) {
  const { rows } = await db.query(
    `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_date, kind, days, period_key,
                               ref_type, ref_id, setting_version_ids, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (employee_id, leave_type_id, kind, period_key) where period_key is not null do nothing returning id`,
    [ctx.tenant.id, e.employeeId, e.leaveTypeId, e.year, e.date, e.kind, round2(e.days), e.periodKey ?? null,
      e.refType ?? null, e.refId ?? null, JSON.stringify(e.versionIds ?? []), e.note ?? null, ctx.actor?.userId ?? null]);
  return rows[0] ?? null;
}

const versionLabel = (r) => r.sources.map((s) => `${s.scopeType} v${s.version}`).join(' + ');

/** The date entitlement rules are evaluated on for a leave year. */
function asOfFor(year, employee, today) {
  return maxDate(year.start, employee.joining_date, minDate(today, year.end, employee.exit_date));
}

/**
 * Brings one employee's ledger for one leave type and year up to date.
 * Runs in its own transaction with a per-employee advisory lock so two
 * concurrent syncs can't double-post adjustments.
 */
export async function syncLedger(ctx, employee, leaveTypeId, year, depth = 0) {
  const today = tenantToday(ctx);
  const goLive = ctx.tenant.go_live_date;
  if (year.start > today || year.end < goLive || employee.joining_date > year.end) return;
  if (employee.exit_date && employee.exit_date < year.start) return;

  // Close out the previous year first so carry-forward sees its final balance.
  const prevEnd = addDays(year.start, -1);
  const hasPrev = prevEnd >= goLive && employee.joining_date <= prevEnd && depth < 50;
  const prev = hasPrev ? leaveYearOf(prevEnd, await leaveYearConfig(ctx, prevEnd)) : null;
  if (hasPrev) await syncLedger(ctx, employee, leaveTypeId, prev, depth + 1);

  await ctx.db.tx(async (db) => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`leave:${employee.id}:${leaveTypeId}`]);
    const tctx = { ...ctx, db };
    const asOf = asOfFor(year, employee, today);
    const r = await resolveRule(tctx, employee, leaveTypeId, asOf);
    if (!r.found || !isLimited(r.value)) return;
    const rule = r.value;
    const rows = await ledgerRows(db, employee.id, leaveTypeId, year.year);
    const frozen = year.end < today;
    const base = { employeeId: employee.id, leaveTypeId, year: year.year };

    if (!rule.accrual?.enabled) {
      const ent = entitlementFor({ rule, employee, year, asOf });
      const granted = sum(rows, ['grant', 'policy_adjustment']);
      const explain = `${ent.days} days (${ent.basis}${ent.proRated ? `, pro-rated ${ent.proRated.employedDays}/${ent.proRated.yearDays} days` : ''}; rule ${versionLabel(r)})`;
      if (!rows.some((x) => x.kind === 'grant')) {
        await post(db, tctx, { ...base, date: maxDate(year.start, employee.joining_date), kind: 'grant', days: ent.days,
          periodKey: `G-${year.year}`, versionIds: r.versionIds, note: `Yearly entitlement: ${explain}` });
      } else if (!frozen && round2(ent.days - granted) !== 0) {
        await post(db, tctx, { ...base, date: today, kind: 'policy_adjustment', days: ent.days - granted, versionIds: r.versionIds,
          note: `Entitlement changed from ${granted} to ${explain}` });
      }
    } else {
      const cap = entitlementFor({ rule, employee, year, asOf }).days;
      let accrued = sum(rows, ['accrual']);
      const done = new Set(rows.filter((x) => x.kind === 'accrual').map((x) => x.period_key));
      for (const p of accrualSchedule({ year, employee, today, postOn: rule.accrual.postOn })) {
        if (done.has(`A-${p.periodKey}`)) continue;
        const pr = await resolveRule(tctx, employee, leaveTypeId, p.date);
        if (!pr.found || !pr.value.accrual?.enabled) continue;
        const days = cap == null ? pr.value.accrual.daysPerMonth : Math.min(pr.value.accrual.daysPerMonth, round2(cap - accrued));
        if (days <= 0) continue;
        await post(db, tctx, { ...base, date: p.date, kind: 'accrual', days, periodKey: `A-${p.periodKey}`, versionIds: pr.versionIds,
          note: `Monthly accrual ${pr.value.accrual.daysPerMonth} days (rule ${versionLabel(pr)})` });
        accrued = round2(accrued + days);
      }
    }

    // Carry forward from the previous year (once) and lapse the rest there.
    if (hasPrev && !rows.some((x) => x.kind === 'carry_forward')) {
      const prevRows = await ledgerRows(db, employee.id, leaveTypeId, prev.year);
      const pr = await resolveRule(tctx, employee, leaveTypeId, asOfFor(prev, employee, prev.end));
      if (pr.found && isLimited(pr.value) && prevRows.length) {
        const prevBalance = sum(prevRows);
        const limit = pr.value.carryForward?.maxDays ?? 0;
        const carry = round2(Math.min(Math.max(prevBalance, 0), limit));
        await post(db, tctx, { ...base, date: year.start, kind: 'carry_forward', days: carry, periodKey: `CF-${year.year}`,
          versionIds: pr.versionIds, note: `Carried forward ${carry} of ${prevBalance} unused days from ${prev.year} (limit ${limit})` });
        if (prevBalance - carry > 0) {
          await post(db, tctx, { employeeId: employee.id, leaveTypeId, year: prev.year, date: prev.end, kind: 'lapse',
            days: -(prevBalance - carry), periodKey: `LAPSE-${prev.year}`, versionIds: pr.versionIds,
            note: `${round2(prevBalance - carry)} unused days lapsed (above carry-forward limit ${limit})` });
        }
      }
    }

    // Expire carried-forward days not used in time (usage consumes carried days first).
    const carried = sum(rows, ['carry_forward']);
    const months = rule.carryForward?.expiryMonths;
    if (carried > 0 && months && !rows.some((x) => x.kind === 'expiry')) {
      const expiresOn = addDays(addMonths(year.start, months), -1);
      if (today > expiresOn) {
        const usedBefore = -sum(rows.filter((x) => x.entry_date <= expiresOn), ['usage', 'usage_reversal']);
        const unused = round2(Math.max(0, carried - usedBefore));
        if (unused > 0) {
          await post(db, tctx, { ...base, date: addDays(expiresOn, 1), kind: 'expiry', days: -unused, periodKey: `EXP-${year.year}`,
            versionIds: r.versionIds, note: `${unused} carried-forward days expired on ${expiresOn}` });
        }
      }
    }
  });
}

/** Sum of usage still awaiting approval (counts against "available"). */
async function pendingDays(db, employeeId, leaveTypeId, year) {
  const row = await db.one(
    `select coalesce(sum((policy_snapshot->>'usageDays')::numeric), 0) as days from leave_requests
      where employee_id = $1 and leave_type_id = $2 and status = 'pending' and start_date between $3 and $4
        and tenant_id = (select tenant_id from employees where id = $1)`,
    [employeeId, leaveTypeId, year.start, year.end]);
  return round2(row.days);
}

/** Balance for one type, explained by its ledger. */
export async function typeBalance(ctx, employee, leaveType, { date, sync = true } = {}) {
  const on = date ?? tenantToday(ctx);
  const year = await leaveYear(ctx, on);
  if (sync) await syncLedger(ctx, employee, leaveType.id, year);
  const r = await resolveRule(ctx, employee, leaveType.id, maxDate(on, employee.joining_date));
  const rule = r.found ? r.value : null;
  const rows = await ledgerRows(ctx.db, employee.id, leaveType.id, year.year);
  const pending = await pendingDays(ctx.db, employee.id, leaveType.id, year);
  const usedThisMonth = negate(sum(rows.filter((x) => x.entry_date >= monthStart(on) && x.entry_date <= monthEnd(on)), ['usage', 'usage_reversal']));
  const unlimited = !rule || !isLimited(rule);
  const balance = sum(rows);
  return {
    leaveType: { id: leaveType.id, code: leaveType.code, name: leaveType.name, color: leaveType.color },
    year,
    paid: rule?.paid ?? null,
    unlimited,
    entitled: unlimited ? null : rule.accrual?.enabled ? entitlementFor({ rule, employee, year, asOf: asOfFor(year, employee, on) }).days : sum(rows, ['grant', 'policy_adjustment']),
    accrued: sum(rows, ['accrual']),
    carriedForward: sum(rows, ['carry_forward']),
    used: negate(sum(rows, ['usage', 'usage_reversal'])),
    adjustments: sum(rows, ['adjustment', 'lapse', 'expiry', 'encashment']),
    usedThisMonth,
    pending,
    balance: unlimited ? null : balance,
    available: unlimited ? null : round2(balance - pending),
    ruleVersionIds: r.versionIds,
  };
}

export async function getBalances(ctx, employeeId, { date } = {}) {
  await requireModule(ctx, 'leave');
  const employee = await getEmployee(ctx, employeeId);
  const out = [];
  for (const lt of await leaveTypes(ctx)) out.push(await typeBalance(ctx, employee, lt, { date }));
  return out;
}

export async function getLedger(ctx, employeeId, leaveTypeId, { year } = {}) {
  const employee = await getEmployee(ctx, employeeId);
  const y = year ?? (await leaveYear(ctx, tenantToday(ctx))).year;
  return ledgerRows(ctx.db, employee.id, leaveTypeId, Number(y));
}

/** HR manual adjustment (opening balances, corrections). */
export async function adjustBalance(ctx, employeeId, leaveTypeId, { days, note, date }) {
  await assertCanManage(ctx, employeeId);
  if (ctx.actor?.accessLevel !== 'hr_admin' && !ctx.actor?.system) throw new AppError(403, 'forbidden', 'Only HR can adjust balances.');
  if (!leaveTypeId) throw badRequest('adjustment_invalid', 'Choose a leave type.');
  await assertInTenant(ctx, 'leave_types', leaveTypeId, 'leave type');
  if (typeof days !== 'number' || days === 0) throw badRequest('adjustment_invalid', 'Enter a non-zero number of days.');
  if (!note?.trim()) throw badRequest('adjustment_invalid', 'A reason is required for every balance adjustment.');
  const on = date ?? tenantToday(ctx);
  const year = await leaveYear(ctx, on);
  const row = await post(ctx.db, ctx, { employeeId, leaveTypeId, year: year.year, date: on, kind: 'adjustment', days, note });
  await audit(ctx.db, ctx, { action: 'leave.balance_adjusted', entityType: 'leave_ledger', entityId: row.id, newValue: { employeeId, leaveTypeId, days, note } });
  return row;
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

async function evaluate(ctx, employee, input) {
  const { leaveTypeId, startDate, endDate = startDate, unit = 'day', hours, attachmentRef, excludeRequestId } = input;
  if (!isYmd(startDate) || !isYmd(endDate)) throw badRequest('date_invalid', 'Start and end must be dates like 2026-03-23.');
  const lt = await ctx.db.one('select * from leave_types where id = $1 and tenant_id = $2', [leaveTypeId, ctx.tenant.id]);
  if (!lt) throw notFound('Leave type');
  if (!lt.is_active) throw badRequest('leave_type_inactive', `${lt.name} is no longer available.`);
  const today = tenantToday(ctx);
  const r = await resolveRule(ctx, employee, lt.id, startDate);
  if (!r.found) throw new AppError(422, 'setting_missing', `No published rules for ${lt.name} apply on ${startDate}.`);
  const rules = (await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'leave.rules', employee, date: startDate })).value;
  const year = await leaveYear(ctx, startDate);
  const calendar = await buildCalendar(ctx, employee, startDate, endDate < startDate ? startDate : endDate);
  const counted = countLeaveDays({ start: startDate, end: endDate, unit, hours, rule: r.value, calendar, hoursPerDay: rules.hoursPerDay });
  const { rows: overlapping } = await ctx.db.query(
    `select id, start_date, end_date from leave_requests where employee_id = $1 and status in ('pending', 'approved')
        and start_date <= $3 and end_date >= $2 and id is distinct from $4`, [employee.id, startDate, endDate, excludeRequestId ?? null]);
  const balance = isLimited(r.value) ? await typeBalance(ctx, employee, lt, { date: startDate }) : null;
  // A request being re-evaluated (approval) must not count against itself.
  if (balance && excludeRequestId) {
    const self = await ctx.db.one(`select policy_snapshot from leave_requests where id = $1 and status = 'pending'`, [excludeRequestId]);
    if (self) balance.available = round2(balance.available + Number(self.policy_snapshot?.usageDays ?? 0));
  }
  const result = evaluateLeaveRequest({
    rule: r.value, request: { start: startDate, end: endDate, unit, hours, attachmentRef }, counted, balance, today, employee, overlapping, year,
  });
  const clash = await teamClash(ctx, employee, counted.dates.filter((d) => d.counted).map((d) => d.date), rules.teamClashMaxOff, excludeRequestId);
  if (clash) result.warnings.push({ code: 'leave.team_clash', params: clash });
  return { ...result, leaveType: lt, counted, balance, year, ruleVersionIds: r.versionIds, rule: r.value };
}

/** Busiest date where teammates (same manager) are already off, if at/over the threshold. */
async function teamClash(ctx, employee, dates, max, excludeRequestId) {
  if (!employee.manager_id || !dates.length) return null;
  const { rows } = await ctx.db.query(
    `select d::date::text as date, count(distinct lr.employee_id)::int as count
       from unnest($3::date[]) as d
       join leave_requests lr on lr.start_date <= d and lr.end_date >= d
       join employees e on e.id = lr.employee_id
      where lr.tenant_id = $1 and e.manager_id = $2 and lr.employee_id <> $4 and lr.status in ('pending', 'approved')
        and lr.id is distinct from $5
      group by d order by count desc, d limit 1`,
    [ctx.tenant.id, employee.manager_id, dates, employee.id, excludeRequestId ?? null]);
  const top = rows[0];
  return top && top.count >= max ? { date: top.date, count: top.count, max } : null;
}

export async function checkLeave(ctx, input) {
  await requireModule(ctx, 'leave');
  const employee = await getEmployee(ctx, input.employeeId);
  const e = await evaluate(ctx, employee, input);
  return { allowed: e.allowed, reasons: e.reasons, warnings: e.warnings, days: e.days, paidDays: e.paidDays, unpaidDays: e.unpaidDays,
    requiresCertificate: e.requiresCertificate, dates: e.counted.dates, balance: e.balance && { available: e.balance.available, balance: e.balance.balance } };
}

export async function createLeaveRequest(ctx, input) {
  await requireModule(ctx, 'leave');
  const employee = await getEmployee(ctx, input.employeeId);
  if (ctx.actor?.employeeId !== employee.id) await assertCanManage(ctx, employee.id);
  await validateCustomFields(ctx, 'leave_request', input.customFields);
  const e = await evaluate(ctx, employee, input);
  if (!e.allowed) throw new AppError(422, 'leave_not_allowed', 'This leave request breaks the leave policy.', { details: { reasons: e.reasons } });
  await assertPayrollOpen(ctx, input.startDate, input.endDate ?? input.startDate);
  const row = await ctx.db.one(
    `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, unit, half_day_part, hours, days,
                                 paid_days, unpaid_days, status, reason, attachment_ref, policy_snapshot, custom_fields, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $16) returning *`,
    [ctx.tenant.id, employee.id, e.leaveType.id, input.startDate, input.endDate ?? input.startDate, input.unit ?? 'day',
      input.halfDayPart ?? null, input.hours ?? null, e.days, e.paidDays, e.unpaidDays, input.reason ?? null, input.attachmentRef ?? null,
      { ruleVersionIds: e.ruleVersionIds, usageDays: e.usageDays, warnings: e.warnings, dates: e.counted.dates },
      input.customFields ?? {}, ctx.actor?.userId ?? null]);
  await audit(ctx.db, ctx, { action: 'leave.requested', entityType: 'leave_request', entityId: row.id, newValue: row });
  const flow = await submit(ctx, 'leave', row.id);
  const request = await ctx.db.one('select * from leave_requests where id = $1', [row.id]);
  return { request, warnings: e.warnings, workflow: flow };
}

/** Paid/unpaid leave feeds payroll, so it can't change inside an approved or locked payroll month. */
async function assertPayrollOpen(ctx, from, to) {
  const locked = await lockedPeriodOverlapping(ctx, from, to);
  if (locked) {
    throw new AppError(422, 'leave_not_allowed', 'This leave falls in a payroll month that is already approved or locked.',
      { details: { reasons: [{ code: 'leave.period_locked', params: { date: locked.date, period: locked.period_key } }] } });
  }
}

const loadRequest = async (ctx, id) => {
  const req = await ctx.db.one('select * from leave_requests where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!req) throw notFound('Leave request');
  return req;
};

/** Re-checks the policy at approval time (balances may have changed since the request). */
async function approvalCheck(ctx, req) {
  const employee = await getEmployee(ctx, req.employee_id, { check: false });
  const e = await evaluate(ctx, employee, {
    leaveTypeId: req.leave_type_id, startDate: req.start_date, endDate: req.end_date, unit: req.unit, hours: req.hours,
    attachmentRef: req.attachment_ref, excludeRequestId: req.id,
  });
  // Notice/backdating were checked when the employee applied; time passing must not block approval.
  const blocking = e.reasons.filter((x) => x.code !== 'leave.min_notice' && x.code !== 'leave.backdated_limit');
  if (blocking.length) throw new AppError(422, 'leave_not_allowed', 'This request can no longer be approved.', { details: { reasons: blocking } });
  return e;
}

const describeLeave = (req, typeName) =>
  `${typeName} ${req.start_date}${req.end_date !== req.start_date ? ` to ${req.end_date}` : ''} (${req.days} day${req.days === 1 ? '' : 's'})`;

registerHandler('leave', {
  async load(ctx, id) {
    const req = await loadRequest(ctx, id);
    const lt = await ctx.db.one('select name from leave_types where id = $1', [req.leave_type_id]);
    return { employeeId: req.employee_id, status: req.status, summary: describeLeave(req, lt.name), days: req.days, leaveTypeId: req.leave_type_id };
  },
  autoApprove(req, wf) {
    const a = wf.autoApprove;
    return a.enabled && (a.maxDays == null || req.days <= a.maxDays) && (!a.leaveTypeIds.length || a.leaveTypeIds.includes(req.leaveTypeId));
  },
  async beforeFinalApprove(ctx, id) {
    const req = await loadRequest(ctx, id);
    await assertPayrollOpen(ctx, req.start_date, req.end_date);
    await approvalCheck(ctx, req);
  },
  async finalize(ctx, id, decision, { actorUserId, comment }) {
    const req = await loadRequest(ctx, id);
    let snapshot = req.policy_snapshot;
    let usageDays = 0;
    if (decision === 'approved') {
      const e = await approvalCheck(ctx, req);
      usageDays = e.usageDays;
      snapshot = { ...snapshot, ruleVersionIds: e.ruleVersionIds, usageDays, approvedWith: { paidDays: e.paidDays, unpaidDays: e.unpaidDays } };
    }
    const row = await ctx.db.one(
      `update leave_requests set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4, policy_snapshot = $5,
              paid_days = coalesce(($5::jsonb->'approvedWith'->>'paidDays')::numeric, paid_days),
              unpaid_days = coalesce(($5::jsonb->'approvedWith'->>'unpaidDays')::numeric, unpaid_days)
        where id = $1 returning *`, [req.id, decision, actorUserId, comment, snapshot]);
    if (decision === 'approved' && usageDays > 0) {
      const year = await leaveYear(ctx, req.start_date);
      await post(ctx.db, ctx, { employeeId: req.employee_id, leaveTypeId: req.leave_type_id, year: year.year, date: req.start_date,
        kind: 'usage', days: -usageDays, refType: 'leave_request', refId: req.id, versionIds: snapshot.ruleVersionIds,
        note: `Leave ${req.start_date}${req.end_date !== req.start_date ? ` to ${req.end_date}` : ''}` });
    }
    await audit(ctx.db, ctx, { action: `leave.${decision}`, entityType: 'leave_request', entityId: req.id, oldValue: req, newValue: row });
  },
});

/** Approve / reject the current step (see services/workflow.js). */
export async function decideLeave(ctx, requestId, input) {
  await loadRequest(ctx, requestId);
  return decideRequest(ctx, 'leave', requestId, input);
}

/**
 * Cancel a pending request (employee, their managers or HR), or an approved
 * one that has not started yet: the used days go back to the balance as a
 * 'usage_reversal' ledger entry. Cancelling leave that already started is HR-only.
 */
export async function cancelLeave(ctx, requestId, { reason } = {}) {
  const req = await loadRequest(ctx, requestId);
  if (ctx.actor?.employeeId !== req.employee_id) await assertCanManage(ctx, req.employee_id);
  if (!['pending', 'approved'].includes(req.status)) throw conflict('not_cancellable', `This request is already ${req.status}.`);
  const today = tenantToday(ctx);
  if (req.status === 'approved' && req.start_date <= today && ctx.actor?.accessLevel !== 'hr_admin') {
    throw conflict('not_cancellable', 'This leave has already started. Ask HR to cancel it.');
  }
  if (req.status === 'approved') await assertPayrollOpen(ctx, req.start_date, req.end_date);
  const employee = await getEmployee(ctx, req.employee_id, { check: false });
  await ctx.db.tx(async (db) => {
    await db.query(`update leave_requests set status = 'cancelled', decision_comment = coalesce($2, decision_comment) where id = $1`, [req.id, reason ?? null]);
    await closeTasks(db, ctx, 'leave', req.id);
    if (req.status === 'approved') {
      const usage = await db.one(`select coalesce(sum(days), 0) as days, max(leave_year) as year from leave_ledger
                                   where ref_type = 'leave_request' and ref_id = $1`, [req.id]);
      if (usage.days < 0) {
        // Dated like the usage it reverses, so per-month "used" figures net out.
        await post(db, ctx, { employeeId: req.employee_id, leaveTypeId: req.leave_type_id, year: usage.year, date: req.start_date,
          kind: 'usage_reversal', days: -usage.days, refType: 'leave_request', refId: req.id, periodKey: `REV-${req.id}`,
          note: `Cancelled leave ${req.start_date}${req.end_date !== req.start_date ? ` to ${req.end_date}` : ''}` });
      }
    }
    await audit(db, ctx, { action: 'leave.cancelled', entityType: 'leave_request', entityId: req.id, oldValue: req, newValue: { reason } });
  });
  const lt = await ctx.db.one('select name from leave_types where id = $1', [req.leave_type_id]);
  const { value: wf } = await resolveWorkflow(ctx, 'leave', employee);
  const userIds = [await userOfEmployee(ctx, employee.manager_id), await userOfEmployee(ctx, employee.id)];
  await notify(ctx, { userIds, event: 'request_cancelled', channels: wf.notify.channels,
    params: { requestType: 'leave', requestId: req.id, employeeName: employee.full_name, summary: describeLeave(req, lt.name) } });
}

/** Leave and WFH of the people the actor can see, for the team calendar. */
export async function teamCalendar(ctx, { from, to, departmentId } = {}) {
  if (!isYmd(from) || !isYmd(to) || to < from) throw badRequest('date_invalid', 'Choose a valid date range.');
  const people = await listEmployees(ctx, { departmentId });
  const ids = people.map((p) => p.id);
  const { rows: leaves } = await ctx.db.query(
    `select lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.status, lr.unit, lt.name as leave_type, lt.color
       from leave_requests lr join leave_types lt on lt.id = lr.leave_type_id
      where lr.tenant_id = $1 and lr.employee_id = any($2) and lr.status in ('pending', 'approved') and lr.start_date <= $4 and lr.end_date >= $3`,
    [ctx.tenant.id, ids, from, to]);
  const { rows: wfh } = await ctx.db.query(
    `select employee_id, date, status from wfh_requests where tenant_id = $1 and employee_id = any($2) and status in ('pending', 'approved')
        and date between $3 and $4`, [ctx.tenant.id, ids, from, to]);
  const { value: rules } = await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'leave.rules', date: from });
  const offByDate = {};
  for (const l of leaves.filter((x) => x.status === 'approved')) {
    for (const d of eachDay(maxDate(l.start_date, from), minDate(l.end_date, to))) offByDate[d] = (offByDate[d] ?? 0) + 1;
  }
  return {
    from, to, clashThreshold: rules.teamClashMaxOff,
    clashDates: Object.entries(offByDate).filter(([, n]) => n >= rules.teamClashMaxOff).map(([date, count]) => ({ date, count })),
    employees: people.map((p) => ({
      id: p.id, name: p.full_name, department: p.department_name,
      leave: leaves.filter((l) => l.employee_id === p.id),
      wfh: wfh.filter((w) => w.employee_id === p.id),
    })),
  };
}
