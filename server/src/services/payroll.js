/**
 * Payroll: prepares each employee's inputs from attendance, leave, overtime,
 * loans and their salary structure, runs the formula engine, and moves a
 * month's run through Draft > Review > Approved > Locked.
 *
 *  - Draft runs can be recalculated as often as needed (they read the live
 *    data and the rules in force on the period's rule date).
 *  - From "approved", payslips are frozen by database triggers; attendance,
 *    leave, overtime, salary revisions and rule changes for that month are
 *    refused. "Locked" can never change; corrections go in the next month.
 *  - Every payslip line keeps the formula, the values it used and the
 *    setting versions it came from.
 */
import { resolve } from '../config/resolver.js';
import { setCheck } from '../config/registry.js';
import { buildCalendar } from '../engines/calendar.js';
import { FormulaError, evaluate, parse, variablesOf } from '../engines/formula.js';
import { INPUTS, TOTALS, computePayslip, payrollFunctions, plan, structVar } from '../engines/payroll.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { toCsv } from '../lib/csv.js';
import { eachDay, fullMonthsBetween, maxDate, minDate, monthEnd } from '../lib/dates.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { round2 } from '../lib/util.js';
import { isHr, requireHr } from './access.js';
import { daySummaries, shiftRule } from './attendance.js';
import { isEnabled, requireModule } from './features.js';
import { logoUrl } from './company.js';
import { notify, userOfEmployee } from './notifications.js';
import { approvedOvertime } from './overtime.js';
import { PERIOD_RE, installmentsDue, markInstallmentsDeducted, structuresBetween } from './salary.js';

export const DEFAULT_COMPONENT_RULE = { enabled: true, calculation: 'structure', formula: null, proRate: true, taxable: true, showIfZero: false };

export function periodBounds(key) {
  if (!PERIOD_RE.test(key ?? '')) throw badRequest('period_invalid', 'Choose a payroll month like 2026-10.');
  const start = `${key}-01`;
  return { key, start, end: monthEnd(start) };
}

export const money = (n, currency = 'PKR') =>
  `${currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** A simulation only applies to resolves of the setting it simulates. */
const resolveFor = (ctx, key, subjectId, employee, date, simulate) =>
  resolve(ctx.db, {
    tenantId: ctx.tenant.id, key, subjectId, employee, date,
    simulate: simulate && simulate.key === key && (simulate.subjectId ?? null) === (subjectId ?? null) ? simulate : null,
  });

/** All components; disabled ones stay in the graph as 0 so formulas naming them still work. */
async function loadComponents(ctx) {
  const { rows } = await ctx.db.query(
    'select id, code, name, kind, is_active, sort_order from salary_components where tenant_id = $1 order by sort_order, code', [ctx.tenant.id]);
  return rows;
}

async function employeeRow(ctx, id) {
  const e = await ctx.db.one(
    `select e.*, d.name as department_name, r.name as role_name from employees e
       left join departments d on d.id = e.department_id left join roles r on r.id = e.role_id
      where e.id = $1 and e.tenant_id = $2`, [id, ctx.tenant.id]);
  if (!e) throw notFound('Employee');
  return e;
}

const shiftHours = (shift) => {
  if (!shift) return 8;
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const minutes = (m(shift.end) - m(shift.start) + 1440) % 1440 || 1440;
  return round2(minutes / 60);
};

/**
 * Paid / unpaid leave days per date. Excess converted to unpaid is the last
 * counted days of the request.
 */
function leaveDays(leaves, from, to, isWorkingDay) {
  let paid = 0;
  let unpaid = 0;
  for (const l of leaves) {
    const dates = l.policy_snapshot?.dates?.filter((d) => d.counted).map((d) => d.date);
    if (dates?.length) {
      const perDay = l.days / dates.length;
      let unpaidLeft = l.unpaid_days;
      for (const d of [...dates].sort().reverse()) {
        const u = Math.min(perDay, unpaidLeft);
        unpaidLeft = round2(unpaidLeft - u);
        if (d >= from && d <= to) { unpaid += u; paid += perDay - u; }
      }
    } else {
      const ratio = l.days ? l.unpaid_days / l.days : 0;
      for (const d of eachDay(maxDate(l.start_date, from), minDate(l.end_date, to))) {
        if (!isWorkingDay(d)) continue;
        unpaid += ratio;
        paid += 1 - ratio;
      }
    }
  }
  return { paid: round2(paid), unpaid: round2(unpaid) };
}

/**
 * Computes one employee's payslip for a period without saving anything.
 * `simulate` (from a settings preview) swaps in an unpublished version.
 */
export async function computeEmployee(ctx, employee, period, { simulate = null, components = null } = {}) {
  const from = maxDate(period.start, employee.joining_date);
  const to = minDate(period.end, employee.exit_date ?? period.end);
  if (from > to) return { skipped: 'not_employed' };
  const structures = await structuresBetween(ctx, employee.id, from, to);
  if (!structures.length) return { skipped: 'no_salary_structure' };

  // The rules in force on the rule date apply to the whole month.
  const atEnd = await resolveFor(ctx, 'payroll.rules', null, employee, period.end, simulate);
  if (!atEnd.found) throw new AppError(422, 'setting_missing', `No published payroll rules apply on ${period.end}. Ask HR to publish them.`);
  const ruleDate = atEnd.value.ruleDate === 'period_start' ? maxDate(period.start, ctx.tenant.go_live_date) : period.end;
  const rulesR = ruleDate === period.end ? atEnd : await resolveFor(ctx, 'payroll.rules', null, employee, ruleDate, simulate);
  const rules = rulesR.value;
  const versionIds = new Set(rulesR.versionIds);

  // Attendance facts.
  const calendar = await buildCalendar(ctx, employee, period.start, period.end);
  const days = await daySummaries(ctx, employee.id, { from: period.start, to: period.end });
  const s = {
    CALENDAR_DAYS: 0, WORKING_DAYS: 0, EMPLOYED_DAYS: 0, EMPLOYED_WORKING_DAYS: 0, PRESENT_DAYS: 0, WFH_DAYS: 0, ABSENT_DAYS: 0,
    HALF_DAYS: 0, LATE_COUNT: 0, LATE_MINUTES: 0, MISSED_CHECKOUTS: 0,
  };
  let notFinished = 0;
  let openSessions = 0;
  let unverified = 0;
  const attendanceOt = { working: 0, offDay: 0 };
  for (const d of days) {
    const working = calendar.isWorkingDay(d.date);
    s.CALENDAR_DAYS += 1;
    if (working) s.WORKING_DAYS += 1;
    if (d.status === 'not_employed') continue;
    s.EMPLOYED_DAYS += 1;
    if (working) s.EMPLOYED_WORKING_DAYS += 1;
    const flags = new Set(d.flags);
    const partLeave = d.leave && d.leave.unit !== 'day';
    if (d.status === 'present' || d.status === 'wfh') {
      if (working) s.PRESENT_DAYS += d.dayFraction;
      if (d.status === 'wfh') s.WFH_DAYS += 1;
      if (flags.has('half_day') && !partLeave && working) s.HALF_DAYS += 1;
    }
    if (d.status === 'absent' && working) s.ABSENT_DAYS += 1;
    if (d.status === 'not_yet' && working) notFinished += 1;
    if (flags.has('late')) { s.LATE_COUNT += 1; s.LATE_MINUTES += d.lateMinutes; }
    if (flags.has('missed_checkout')) s.MISSED_CHECKOUTS += 1;
    if (flags.has('open_session')) openSessions += 1;
    if (flags.has('unverified_time')) unverified += 1;
    if (d.overtimeMinutes >= (rules.overtime?.minMinutes ?? 0) && d.overtimeMinutes > 0) {
      attendanceOt[flags.has('worked_on_off_day') ? 'offDay' : 'working'] += d.overtimeMinutes;
    }
  }

  const { rows: leaves } = await ctx.db.query(
    `select start_date, end_date, days, unpaid_days, policy_snapshot from leave_requests
      where tenant_id = $1 and employee_id = $2 and status = 'approved' and start_date <= $4 and end_date >= $3`,
    [ctx.tenant.id, employee.id, from, to]);
  const leave = leaveDays(leaves, from, to, calendar.isWorkingDay);

  let ot = { working: 0, offDay: 0 };
  if (await isEnabled(ctx, 'overtime')) ot = rules.overtime?.requireApproval ? await approvedOvertime(ctx, employee.id, from, to) : attendanceOt;
  const loans = await installmentsDue(ctx, employee.id, period.key);

  // Salary structure: pro-rated amounts weight each revision by the days it ran.
  const workingBasis = rules.proRateBasis === 'working_days';
  const weight = (a, b) => (a > b ? 0 : [...eachDay(a, b)].filter((d) => !workingBasis || calendar.isWorkingDay(d)).length);
  const denominator = workingBasis ? s.WORKING_DAYS : s.CALENDAR_DAYS;
  const amounts = {};
  for (const st of structures) {
    const w = denominator ? weight(maxDate(st.effective_from, from), minDate(st.effective_to ?? to, to)) / denominator : 0;
    for (const l of st.lines) {
      amounts[l.code] ??= { full: 0, proRated: 0, kind: l.kind };
      amounts[l.code].proRated += l.amount * w;
    }
  }
  const latest = structures.at(-1);
  for (const l of latest.lines) amounts[l.code].full = l.amount;

  const inputs = {
    ...s,
    PRORATE: denominator ? round2(weight(from, to) / denominator) : 0,
    PRESENT_DAYS: round2(s.PRESENT_DAYS),
    PAID_LEAVE_DAYS: leave.paid,
    UNPAID_LEAVE_DAYS: leave.unpaid,
    OT_HOURS: round2(ot.working / 60),
    OT_OFFDAY_HOURS: round2(ot.offDay / 60),
    SHIFT_HOURS: shiftHours(await shiftRule(ctx, employee, ruleDate)),
    MONTHLY_SALARY: round2(latest.lines.filter((l) => l.kind === 'earning').reduce((t, l) => t + l.amount, 0)),
    MONTHS_OF_SERVICE: fullMonthsBetween(employee.joining_date, period.end),
    LOAN_INSTALLMENT: loans.total,
  };

  const comps = components ?? await loadComponents(ctx);
  const list = [];
  for (const c of comps) {
    inputs[structVar(c.code)] = amounts[c.code]?.full ?? 0;
    const r = await resolveFor(ctx, 'payroll.component', c.id, employee, ruleDate, simulate);
    for (const v of r.versionIds) versionIds.add(v);
    const rule = { ...DEFAULT_COMPONENT_RULE, ...(r.found ? r.value : {}), ...(c.is_active ? {} : { enabled: false }) };
    const a = amounts[c.code];
    list.push({
      id: c.id, code: c.code, name: c.name, kind: c.kind, sortOrder: c.sort_order, rule, versionIds: r.versionIds,
      structure: a ? { full: a.full, amount: rule.proRate === false ? a.full : a.proRated } : null,
    });
  }
  const taxR = await resolveFor(ctx, 'payroll.tax', null, null, ruleDate, simulate);
  for (const v of taxR.versionIds) versionIds.add(v);
  const taxSlabs = taxR.value?.annualSlabs ?? [];

  const result = computePayslip({ components: list, inputs, variables: rules.variables ?? {}, taxSlabs });
  const warnings = [...(result.warnings ?? [])];
  if (notFinished) warnings.push({ code: 'days_not_finished', params: { days: notFinished } });
  if (openSessions) warnings.push({ code: 'open_sessions', params: { days: openSessions } });
  if (unverified) warnings.push({ code: 'unverified_time', params: { days: unverified } });
  return {
    ...result, warnings, employee, period, from, to, ruleDate, inputs, taxSlabs, loanInstallments: loans.items, versionIds: [...versionIds],
  };
}

// ---------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------
const WARNING_TEXT = {
  no_salary_structure: (p) => `${p.employee} (${p.code}) has no salary for this month and was left out.`,
  calculation_error: (p) => `${p.employee}: ${p.message}`,
  no_bank_details: (p) => `${p.employee} has no IBAN, so the bank file will have no account for them.`,
  days_not_finished: (p) => `${p.employee}: ${p.days} working day(s) of this month haven't happened yet and were counted as worked.`,
  open_sessions: (p) => `${p.employee}: ${p.days} day(s) still have an open check-in.`,
  unverified_time: (p) => `${p.employee}: ${p.days} day(s) have punches with unverified time.`,
  negative_component: (p) => `${p.employee}: ${p.component} worked out below zero (${p.amount}) and was set to 0.`,
  net_negative: (p) => `${p.employee}: deductions are more than earnings (net ${p.net}).`,
};
const withText = (w) => ({ ...w, message: WARNING_TEXT[w.code]?.(w.params) ?? w.code });

async function loadRun(ctx, id, db = ctx.db) {
  const run = await db.one('select * from payroll_runs where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!run) throw notFound('Payroll run');
  return run;
}

/** Recomputes every payslip of a draft run. */
async function calculateRun(ctx, run) {
  const period = { key: run.period_key, start: run.period_start, end: run.period_end };
  const { rows: employees } = await ctx.db.query(
    `select e.*, d.name as department_name, r.name as role_name, pd.iban
       from employees e left join departments d on d.id = e.department_id left join roles r on r.id = e.role_id
       left join employee_payment_details pd on pd.employee_id = e.id
      where e.tenant_id = $1 and e.status <> 'inactive' and e.joining_date <= $3 and (e.exit_date is null or e.exit_date >= $2)
      order by e.employee_code`, [ctx.tenant.id, period.start, period.end]);
  const components = await loadComponents(ctx);
  const results = [];
  const warnings = [];
  for (const e of employees) {
    const r = await computeEmployee(ctx, e, period, { components });
    const who = { employee: e.full_name, code: e.employee_code };
    if (r.skipped === 'no_salary_structure') { warnings.push(withText({ code: 'no_salary_structure', params: who })); continue; }
    if (r.skipped) continue;
    if (!r.ok) { warnings.push(withText({ code: 'calculation_error', params: { ...who, message: r.errors.map((x) => x.message).join(' ') } })); continue; }
    for (const w of r.warnings) warnings.push(withText({ ...w, params: { ...w.params, ...who } }));
    if (!e.iban && r.net > 0) warnings.push(withText({ code: 'no_bank_details', params: who }));
    results.push(r);
  }

  const totals = { employees: results.length, gross: 0, deductions: 0, net: 0, employerCost: 0, byComponent: {} };
  await ctx.db.tx(async (db) => {
    const fresh = await db.one('select status from payroll_runs where id = $1 for update', [run.id]);
    if (fresh.status !== 'draft') throw conflict('run_not_draft', 'Only a draft payroll can be recalculated. Reopen it first.');
    await db.query('delete from payroll_items where payroll_run_id = $1', [run.id]);
    await db.query('delete from payslips where payroll_run_id = $1', [run.id]);
    for (const r of results) {
      const e = r.employee;
      for (const l of r.lines) {
        await db.query(
          `insert into payroll_items (tenant_id, payroll_run_id, employee_id, component_id, label, kind, amount, inputs, setting_version_ids)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [ctx.tenant.id, run.id, e.id, l.componentId, l.name, l.kind, l.amount,
            { code: l.code, calculation: l.calculation, formula: l.formula, values: l.inputs, taxable: l.taxable }, JSON.stringify(l.versionIds)]);
        totals.byComponent[l.code] = round2((totals.byComponent[l.code] ?? 0) + l.amount);
      }
      const summary = {
        employee: { code: e.employee_code, name: e.full_name, department: e.department_name, role: e.role_name, joiningDate: e.joining_date, exitDate: e.exit_date },
        period: { key: period.key, start: period.start, end: period.end, from: r.from, to: r.to }, ruleDate: r.ruleDate,
        lines: r.lines.map(({ versionIds, ...l }) => l), inputs: r.inputs,
        warnings: r.warnings.map((w) => withText({ ...w, params: { ...w.params, employee: e.full_name, code: e.employee_code } })).map(({ message, code }) => ({ code, message })),
        loanInstallments: r.loanInstallments, versionIds: r.versionIds,
      };
      await db.query(
        `insert into payslips (tenant_id, payroll_run_id, employee_id, gross, deductions, net, employer_cost, summary)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`, [ctx.tenant.id, run.id, e.id, r.gross, r.deductions, r.net, r.employerCost, summary]);
      totals.gross += r.gross;
      totals.deductions += r.deductions;
      totals.net += r.net;
      totals.employerCost += r.employerCost;
    }
    for (const k of ['gross', 'deductions', 'net', 'employerCost']) totals[k] = round2(totals[k]);
    await db.query(`update payroll_runs set totals = $2, warnings = $3, calculated_at = now() where id = $1`,
      [run.id, totals, JSON.stringify(warnings)]);
  });
}

export async function listRuns(ctx) {
  requireHr(ctx);
  return (await ctx.db.query(
    `select id, period_key, period_start, period_end, status, totals, jsonb_array_length(warnings) as warning_count,
            calculated_at, created_at, approved_at, locked_at
       from payroll_runs where tenant_id = $1 order by period_start desc`, [ctx.tenant.id])).rows;
}

const NEXT_ACTIONS = { draft: ['recalculate', 'submit', 'delete'], review: ['approve', 'reopen', 'delete'], approved: ['lock', 'reopen'], locked: [] };

export async function getRun(ctx, id) {
  requireHr(ctx);
  const run = await loadRun(ctx, id);
  const { rows: payslips } = await ctx.db.query(
    `select p.id, p.employee_id, p.gross, p.deductions, p.net, p.employer_cost, e.employee_code, e.full_name, d.name as department,
            jsonb_array_length(p.summary->'warnings') as warning_count, p.summary->'inputs' as inputs
       from payslips p join employees e on e.id = p.employee_id left join departments d on d.id = e.department_id
      where p.payroll_run_id = $1 order by e.employee_code`, [run.id]);
  const users = await ctx.db.query('select id, email from users where id = any($1)', [[run.created_by, run.approved_by, run.locked_by].filter(Boolean)]);
  const email = (uid) => users.rows.find((u) => u.id === uid)?.email ?? null;
  return { ...run, createdBy: email(run.created_by), approvedBy: email(run.approved_by), lockedBy: email(run.locked_by), actions: NEXT_ACTIONS[run.status], payslips };
}

export async function createRun(ctx, { period }) {
  requireHr(ctx);
  await requireModule(ctx, 'payroll');
  const p = periodBounds(period);
  if (p.start > tenantToday(ctx)) throw badRequest('period_in_future', `Payroll for ${p.key} can't be run before the month starts.`);
  if (p.end < ctx.tenant.go_live_date) throw badRequest('before_go_live', `The company went live on ${ctx.tenant.go_live_date}; there is no data for ${p.key}.`);
  const existing = await ctx.db.one('select id from payroll_runs where tenant_id = $1 and period_key = $2', [ctx.tenant.id, p.key]);
  if (existing) throw conflict('run_exists', `A payroll for ${p.key} already exists.`, { details: { runId: existing.id } });
  const run = await ctx.db.one(
    `insert into payroll_runs (tenant_id, period_key, period_start, period_end, status, created_by) values ($1, $2, $3, $4, 'draft', $5) returning *`,
    [ctx.tenant.id, p.key, p.start, p.end, ctx.actor?.userId ?? null]);
  await audit(ctx.db, ctx, { action: 'payroll.created', entityType: 'payroll_run', entityId: run.id, meta: { period: p.key } });
  await calculateRun(ctx, run);
  return getRun(ctx, run.id);
}

export async function recalculateRun(ctx, id) {
  requireHr(ctx);
  const run = await loadRun(ctx, id);
  if (run.status !== 'draft') throw conflict(run.status === 'locked' ? 'payroll_locked' : 'run_not_draft',
    run.status === 'locked' ? `Payroll ${run.period_key} is locked and is never recalculated. Make corrections in the next payroll.` : 'Only a draft payroll can be recalculated. Reopen it first.');
  await calculateRun(ctx, run);
  await audit(ctx.db, ctx, { action: 'payroll.recalculated', entityType: 'payroll_run', entityId: run.id, meta: { period: run.period_key } });
  return getRun(ctx, run.id);
}

const TRANSITIONS = {
  submit: { from: ['draft'], to: 'review', set: 'reviewed_by = $4, reviewed_at = now()' },
  approve: { from: ['review'], to: 'approved', set: 'approved_by = $4, approved_at = now()' },
  lock: { from: ['approved'], to: 'locked', set: 'locked_by = $4, locked_at = now()' },
  reopen: { from: ['review', 'approved'], to: 'draft', set: 'approved_by = null, approved_at = null, reviewed_by = null, reviewed_at = null' },
};

export async function transitionRun(ctx, id, action, { reason = null } = {}) {
  requireHr(ctx);
  const t = TRANSITIONS[action];
  if (!t) throw badRequest('action_invalid', 'Unknown payroll action.');
  const run = await loadRun(ctx, id);
  if (run.status === 'locked') throw conflict('payroll_locked', `Payroll ${run.period_key} is locked and can never change.`);
  if (!t.from.includes(run.status)) throw conflict('status_invalid', `A payroll that is ${run.status} can't be ${action === 'submit' ? 'sent for review' : `${action}ed`}.`);
  if (action === 'reopen' && !reason?.trim()) throw badRequest('reason_required', 'Say why the payroll is being reopened.');
  if (action === 'submit' && !run.totals?.employees) throw conflict('run_empty', 'This payroll has no payslips. Add salaries and recalculate first.');
  if (action === 'approve') {
    const { value: rules } = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'payroll.rules', date: run.period_end });
    if (rules?.approval?.requireDifferentApprover && run.created_by === ctx.actor?.userId) {
      throw forbidden('Another HR admin must approve this payroll (you prepared it).');
    }
  }
  let deducted = 0;
  await ctx.db.tx(async (db) => {
    const params = [run.id, t.to, t.from];
    if (t.set.includes('$4')) params.push(ctx.actor?.userId ?? null);
    const row = await db.one(`update payroll_runs set status = $2, ${t.set} where id = $1 and status = any($3) returning id`, params);
    if (!row) throw conflict('status_changed', 'Someone else changed this payroll. Reload and try again.');
    if (action === 'lock') deducted = await markInstallmentsDeducted(db, ctx, run);
    await audit(db, ctx, { action: `payroll.${action === 'submit' ? 'submitted' : `${action}ed`}`, entityType: 'payroll_run', entityId: run.id,
      oldValue: { status: run.status }, newValue: { status: t.to }, meta: { period: run.period_key, reason, loanInstallmentsDeducted: deducted } });
  });
  if (action === 'lock') await notifyPayslips(ctx, run);
  return getRun(ctx, run.id);
}

async function notifyPayslips(ctx, run) {
  const { rows } = await ctx.db.query('select employee_id, net from payslips where payroll_run_id = $1', [run.id]);
  for (const p of rows) {
    await notify(ctx, { userIds: [await userOfEmployee(ctx, p.employee_id)], event: 'payslip_ready', channels: ['in_app', 'email'],
      params: { period: run.period_key, net: money(p.net, ctx.tenant.currency) } });
  }
}

export async function deleteRun(ctx, id) {
  requireHr(ctx);
  const run = await loadRun(ctx, id);
  if (!['draft', 'review'].includes(run.status)) throw conflict('status_invalid', `A payroll that is ${run.status} can't be deleted.`);
  await ctx.db.tx(async (db) => {
    await db.query('delete from payroll_items where payroll_run_id = $1', [run.id]);
    await db.query('delete from payslips where payroll_run_id = $1', [run.id]);
    await db.query('delete from payroll_runs where id = $1', [run.id]);
    await audit(db, ctx, { action: 'payroll.deleted', entityType: 'payroll_run', entityId: run.id, oldValue: { period: run.period_key, status: run.status } });
  });
}

// ---------------------------------------------------------------------
// Payslips and exports
// ---------------------------------------------------------------------
export async function getPayslip(ctx, id) {
  const p = await ctx.db.one(
    `select p.*, r.period_key, r.period_start, r.period_end, r.status as run_status, r.locked_at from payslips p
       join payroll_runs r on r.id = p.payroll_run_id where p.id = $1 and p.tenant_id = $2`, [id, ctx.tenant.id]);
  // Salary data: HR, or the employee once the month is locked. Managers never.
  if (!p || (!isHr(ctx) && (ctx.actor?.employeeId !== p.employee_id || p.run_status !== 'locked'))) throw notFound('Payslip');
  if (!isHr(ctx)) await requireModule(ctx, 'payroll'); // HR can switch payslips off per employee
  // The company's own letterhead (its logo is fetched separately by the PDF route / the page).
  return { ...p, currency: ctx.tenant.currency, company: ctx.tenant.name,
    companyDetails: { name: ctx.tenant.name, address: ctx.tenant.address, phone: ctx.tenant.phone, email: ctx.tenant.contact_email, logoUrl: logoUrl(ctx.tenant) } };
}

export async function myPayslips(ctx) {
  if (!(await isEnabled(ctx, 'payroll'))) return [];
  return (await ctx.db.query(
    `select p.id, r.period_key, r.period_start, p.gross, p.deductions, p.net, r.locked_at from payslips p join payroll_runs r on r.id = p.payroll_run_id
      where p.tenant_id = $1 and p.employee_id = $2 and r.status = 'locked' order by r.period_start desc`, [ctx.tenant.id, ctx.actor.employeeId])).rows;
}

async function exportableRun(ctx, id) {
  requireHr(ctx);
  const run = await loadRun(ctx, id);
  if (!['approved', 'locked'].includes(run.status)) throw conflict('payroll_not_approved', 'Approve the payroll before exporting payment files.');
  return run;
}

/** Salary transfer file: one row per employee with a positive net. */
export async function bankCsv(ctx, id) {
  const run = await exportableRun(ctx, id);
  const { rows } = await ctx.db.query(
    `select e.employee_code, e.full_name, pd.account_title, pd.bank_name, pd.iban, p.net from payslips p
       join employees e on e.id = p.employee_id left join employee_payment_details pd on pd.employee_id = e.id
      where p.payroll_run_id = $1 and p.net > 0 order by e.employee_code`, [run.id]);
  await audit(ctx.db, ctx, { action: 'payroll.bank_file_exported', entityType: 'payroll_run', entityId: run.id, meta: { rows: rows.length } });
  return toCsv(['Employee code', 'Name', 'Account title', 'Bank', 'IBAN', 'Amount', 'Currency', 'Reference'],
    rows.map((r) => [r.employee_code, r.full_name, r.account_title ?? r.full_name, r.bank_name ?? '', r.iban ?? '', r.net.toFixed(2),
      ctx.tenant.currency, `Salary ${run.period_key}`]));
}

export async function departmentCost(ctx, id) {
  requireHr(ctx);
  const run = await loadRun(ctx, id);
  const { rows } = await ctx.db.query(
    `select coalesce(d.name, 'No department') as department, count(*)::int as headcount, sum(p.gross) as gross, sum(p.deductions) as deductions,
            sum(p.net) as net, sum(p.employer_cost) as employer_cost, sum(p.gross + p.employer_cost) as total_cost
       from payslips p join employees e on e.id = p.employee_id left join departments d on d.id = e.department_id
      where p.payroll_run_id = $1 group by d.name order by d.name nulls last`, [run.id]);
  return { run: { id: run.id, period: run.period_key, status: run.status }, departments: rows.map((r) => ({ ...r, gross: round2(r.gross), deductions: round2(r.deductions),
    net: round2(r.net), employer_cost: round2(r.employer_cost), total_cost: round2(r.total_cost) })) };
}

export async function departmentCostCsv(ctx, id) {
  const { departments } = await departmentCost(ctx, id);
  return toCsv(['Department', 'Headcount', 'Gross pay', 'Deductions', 'Net pay', 'Employer contributions', 'Total cost'],
    departments.map((d) => [d.department, d.headcount, d.gross, d.deductions, d.net, d.employer_cost, d.total_cost]));
}

// ---------------------------------------------------------------------
// Formula builder support
// ---------------------------------------------------------------------
async function companyVariables(ctx, date) {
  const r = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'payroll.rules', date });
  return r.found ? r.value.variables ?? {} : {};
}

/** Everything the formula editor offers: values, functions, components, variables. */
export async function formulaMeta(ctx) {
  requireHr(ctx);
  const components = [];
  for (const c of await loadComponents(ctx)) {
    const r = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'payroll.component', subjectId: c.id, date: tenantToday(ctx) });
    components.push({ code: c.code, name: c.name, kind: c.kind, active: c.is_active, calculation: { ...DEFAULT_COMPONENT_RULE, ...r.value }.calculation });
  }
  return {
    inputs: INPUTS, totals: TOTALS,
    functions: Object.fromEntries(Object.entries(payrollFunctions()).map(([k, f]) => [k, f.help])),
    components,
    variables: await companyVariables(ctx, tenantToday(ctx)),
  };
}

/**
 * Checks a formula and, given an employee, evaluates it with that employee's
 * real values for a month ("what would this give for Ali in October?").
 */
export async function testFormula(ctx, { formula, employeeId = null, period = null }) {
  requireHr(ctx);
  let ast;
  try { ast = parse(formula, { functions: payrollFunctions() }); } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    return { ok: false, error: err.pos == null ? `${err.message}.` : `${err.message} (at character ${err.pos + 1}).` };
  }
  const components = await loadComponents(ctx);
  const known = new Set([...Object.keys(INPUTS), ...Object.keys(TOTALS), ...components.flatMap((c) => [c.code, structVar(c.code)]),
    ...Object.keys(await companyVariables(ctx, tenantToday(ctx)))]);
  const names = [...variablesOf(ast)];
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) return { ok: false, error: `Unknown value${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, names };
  if (!employeeId) return { ok: true, names };

  const p = periodBounds(period ?? tenantToday(ctx).slice(0, 7));
  const employee = await employeeRow(ctx, employeeId);
  const r = await computeEmployee(ctx, employee, p, { components });
  if (r.skipped) return { ok: true, names, note: r.skipped === 'no_salary_structure' ? `${employee.full_name} has no salary for ${p.key}.` : `${employee.full_name} was not employed in ${p.key}.` };
  if (!r.ok) return { ok: false, names, error: r.errors.map((e) => e.message).join(' ') };
  try {
    const value = evaluate(ast, { vars: r.values, functions: payrollFunctions({ taxSlabs: r.taxSlabs }) });
    return { ok: true, names, value: round2(value), values: Object.fromEntries(names.map((n) => [n, round2(r.values[n])])), employee: employee.full_name, period: p.key };
  } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    return { ok: false, names, error: `${err.message}.` };
  }
}

/** Publish-time check: every formula's names exist and nothing loops (registry check hook). */
async function checkPayrollConfig(ctx, { merged, version, date }) {
  const components = [];
  for (const c of await loadComponents(ctx)) {
    let rule;
    if (version.key === 'payroll.component' && version.subject_id === c.id) rule = merged;
    else {
      const r = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'payroll.component', subjectId: c.id, date });
      rule = r.found ? r.value : {};
    }
    components.push({ ...c, rule: { ...DEFAULT_COMPONENT_RULE, ...rule, ...(c.is_active ? {} : { enabled: false }) } });
  }
  const variables = version.key === 'payroll.rules' ? merged.variables ?? {} : await companyVariables(ctx, date);
  const { errors } = plan({ components, variables });
  const path = version.key === 'payroll.rules' ? 'variables' : 'formula';
  return { errors: errors.map((e) => ({ path, message: e.message })), warnings: [] };
}
setCheck('payroll.component', checkPayrollConfig);
setCheck('payroll.rules', checkPayrollConfig);

/** Settings preview: an employee's net pay for the month before/after the draft. */
export async function previewNetPay(ctx, emp, date, sim, v) {
  const period = periodBounds(date.slice(0, 7));
  const employee = await employeeRow(ctx, emp.id);
  const before = await computeEmployee(ctx, employee, period);
  if (before.skipped) return [];
  const after = await computeEmployee(ctx, employee, period, { simulate: { ...sim, key: v.key, subjectId: v.subject_id } });
  return [{ key: 'net', label: `Net pay ${period.key}`, old: before.ok ? before.net : null, new: after.ok ? after.net : null }];
}
