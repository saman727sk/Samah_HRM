/**
 * Dashboard read models for employees, managers and HR, plus CSV reports.
 * Everything is computed from the same engines the rest of the app uses
 * (attendance summaries, leave ledger, WFH quota), so numbers always agree.
 */
import { tenantToday } from '../lib/clock.js';
import { addDays, isYmd, localTime, minDate, monthEnd, monthStart } from '../lib/dates.js';
import { badRequest } from '../lib/errors.js';
import { round2 } from '../lib/util.js';
import { toCsv } from '../lib/csv.js';
import { isHr, reportIds, requireHr } from './access.js';
import { daySummaries, todayStatus } from './attendance.js';
import { getEmployee, listEmployees } from './employees.js';
import { isEnabled } from './features.js';
import { getBalances, teamCalendar } from './leave.js';
import { getWfhQuota } from './wfh.js';
import { inbox } from './workflow.js';

const monthRange = (month, today) => {
  const start = month ? `${month}-01` : monthStart(today);
  if (!isYmd(start)) throw badRequest('month_invalid', 'Month must look like 2026-10.');
  return { start, end: monthEnd(start) };
};

export async function employeeDashboard(ctx, employeeId = ctx.actor.employeeId, { month } = {}) {
  const employee = await getEmployee(ctx, employeeId);
  const today = tenantToday(ctx);
  const { start, end } = monthRange(month, today);
  const [status, calendar, balances] = await Promise.all([
    todayStatus(ctx, employee.id), daySummaries(ctx, employee.id, { from: start, to: end }), getBalances(ctx, employee.id),
  ]);
  const wfhQuota = (await isEnabled(ctx, 'wfh')) ? await getWfhQuota(ctx, employee.id, { date: today }) : null;
  const { rows: leaveRequests } = await ctx.db.query(
    `select lr.id, lr.start_date, lr.end_date, lr.days, lr.status, lr.unpaid_days, lt.name as leave_type, lt.color
       from leave_requests lr join leave_types lt on lt.id = lr.leave_type_id
      where lr.employee_id = $1 order by lr.created_at desc limit 10`, [employee.id]);
  const { rows: wfhRequests } = await ctx.db.query(
    `select request_group_id as id, min(date) as start_date, max(date) as end_date, count(*)::int as days,
            case when bool_or(status = 'pending') then 'pending' else min(status) end as status
       from wfh_requests where employee_id = $1 group by request_group_id order by min(created_at) desc limit 10`, [employee.id]);
  const { rows: payslips } = await ctx.db.query(
    `select p.id, r.period_key, p.net, p.created_at from payslips p join payroll_runs r on r.id = p.payroll_run_id
      where p.employee_id = $1 and r.status = 'locked' order by r.period_start desc limit 12`, [employee.id]);
  return {
    employee: { id: employee.id, name: employee.full_name, code: employee.employee_code },
    today: status, month: { start, end, days: calendar, totals: totals(calendar) },
    wfhQuota, balances, leaveRequests, wfhRequests, payslips,
  };
}

/** Counts across day summaries. */
function totals(days) {
  const t = { present: 0, wfh: 0, onLeave: 0, absent: 0, late: 0, halfDay: 0, missedCheckout: 0, unverified: 0, overtimeMinutes: 0, workedMinutes: 0 };
  for (const d of days) {
    if (d.status === 'present') t.present += 1;
    if (d.status === 'wfh') t.wfh += 1;
    if (d.status === 'on_leave') t.onLeave += 1;
    if (d.status === 'absent') t.absent += 1;
    const f = new Set(d.flags);
    if (f.has('late')) t.late += 1;
    if (f.has('half_day')) t.halfDay += 1;
    if (f.has('missed_checkout')) t.missedCheckout += 1;
    if (f.has('unverified_time')) t.unverified += 1;
    t.overtimeMinutes += d.overtimeMinutes ?? 0;
    t.workedMinutes += d.workedMinutes ?? 0;
  }
  return t;
}

const TODAY_KEYS = ['present', 'wfh', 'on_leave', 'absent', 'not_yet', 'holiday', 'weekend'];

async function todayBoard(ctx, people) {
  const today = tenantToday(ctx);
  const rows = [];
  for (const p of people) {
    const [s] = await daySummaries(ctx, p.id, { from: today, to: today });
    rows.push({ employeeId: p.id, name: p.full_name, department: p.department_name, status: s.status, flags: s.flags, firstIn: s.firstIn,
      checkedIn: s.openSession, leave: s.leave?.name ?? null });
  }
  const counts = Object.fromEntries(TODAY_KEYS.map((k) => [k, rows.filter((r) => r.status === k).length]));
  counts.late = rows.filter((r) => r.flags.includes('late')).length;
  return { date: today, counts, people: rows };
}

export async function managerDashboard(ctx, { month } = {}) {
  const today = tenantToday(ctx);
  const ids = isHr(ctx) ? null : new Set(await reportIds(ctx, ctx.actor.employeeId));
  const people = (await listEmployees(ctx)).filter((p) => p.id !== ctx.actor.employeeId && (!ids || ids.has(p.id)));
  const { start, end } = monthRange(month, today);
  return {
    team: await todayBoard(ctx, people),
    approvals: await inbox(ctx),
    calendar: await teamCalendar(ctx, { from: start, to: end }),
  };
}

export async function hrDashboard(ctx, { month } = {}) {
  requireHr(ctx);
  const today = tenantToday(ctx);
  const { start, end } = monthRange(month, today);
  const upTo = minDate(end, today);
  const people = await listEmployees(ctx);
  const byDept = {};
  for (const p of people) {
    const d = (byDept[p.department_name ?? 'No department'] ??= { department: p.department_name ?? 'No department', headcount: 0, ...totals([]), leaveDays: {}, wfhDays: 0 });
    d.headcount += 1;
    if (upTo < start) continue;
    const t = totals(await daySummaries(ctx, p.id, { from: start, to: upTo }));
    for (const [k, v] of Object.entries(t)) d[k] += v;
  }
  const { rows: leaveUse } = await ctx.db.query(
    `select coalesce(d.name, 'No department') as department, lt.name as leave_type, sum(lr.days)::float as days
       from leave_requests lr join employees e on e.id = lr.employee_id left join departments d on d.id = e.department_id
       join leave_types lt on lt.id = lr.leave_type_id
      where lr.tenant_id = $1 and lr.status = 'approved' and lr.start_date <= $3 and lr.end_date >= $2
      group by 1, 2`, [ctx.tenant.id, start, end]);
  for (const r of leaveUse) if (byDept[r.department]) byDept[r.department].leaveDays[r.leave_type] = round2(r.days);
  const { rows: wfhUse } = await ctx.db.query(
    `select coalesce(d.name, 'No department') as department, count(*)::int as days
       from wfh_requests w join employees e on e.id = w.employee_id left join departments d on d.id = e.department_id
      where w.tenant_id = $1 and w.status = 'approved' and w.date between $2 and $3 group by 1`, [ctx.tenant.id, start, end]);
  for (const r of wfhUse) if (byDept[r.department]) byDept[r.department].wfhDays = r.days;

  const { rows: alerts } = await ctx.db.query(
    `select e.id as event_id, e.employee_id, emp.full_name as name, e.work_date, e.punch_time, e.method, e.time_verified, e.flags
       from attendance_events e join employees emp on emp.id = e.employee_id
      where e.tenant_id = $1 and e.work_date >= $2 and (not e.time_verified or e.method = 'system_autoclose')
      order by e.work_date desc, e.punch_time desc limit 50`, [ctx.tenant.id, addDays(today, -14)]);
  const { rows: payroll } = await ctx.db.query(
    `select period_key, period_start, period_end, status, locked_at from payroll_runs where tenant_id = $1 order by period_start desc limit 3`, [ctx.tenant.id]);
  const { rows: [pending] } = await ctx.db.query(
    `select count(*) filter (where request_type = 'leave')::int as leave, count(*) filter (where request_type = 'wfh')::int as wfh,
            count(*) filter (where request_type = 'attendance_correction')::int as corrections
       from approval_tasks where tenant_id = $1 and status = 'pending'`, [ctx.tenant.id]);
  return {
    month: { start, end },
    headcount: people.length,
    today: await todayBoard(ctx, people),
    departments: Object.values(byDept).sort((a, b) => a.department.localeCompare(b.department)),
    alerts: alerts.map((a) => ({ ...a, kind: a.method === 'system_autoclose' ? 'missed_checkout' : 'unverified_time',
      time: localTime(a.punch_time, ctx.tenant.timezone) })),
    pendingApprovals: pending,
    payroll,
  };
}

// ---------------------------------------------------------------------
// CSV reports (scoped to who the caller may see)
// ---------------------------------------------------------------------

export async function attendanceCsv(ctx, { month, detail = 'daily' } = {}) {
  const today = tenantToday(ctx);
  const { start, end } = monthRange(month, today);
  const tz = ctx.tenant.timezone;
  const people = await listEmployees(ctx);
  if (detail === 'summary') {
    const rows = [];
    for (const p of people) {
      const t = totals(await daySummaries(ctx, p.id, { from: start, to: end }));
      rows.push([p.employee_code, p.full_name, p.department_name, t.present, t.wfh, t.onLeave, t.absent, t.late, t.halfDay, t.missedCheckout,
        t.unverified, round2(t.workedMinutes / 60), round2(t.overtimeMinutes / 60)]);
    }
    return toCsv(['Code', 'Name', 'Department', 'Present', 'WFH', 'On leave', 'Absent', 'Late', 'Half days', 'Missed check-outs',
      'Unverified', 'Hours worked', 'Overtime hours'], rows);
  }
  const rows = [];
  for (const p of people) {
    for (const d of await daySummaries(ctx, p.id, { from: start, to: end })) {
      rows.push([p.employee_code, p.full_name, p.department_name, d.date, d.status, d.firstIn ? localTime(d.firstIn, tz) : '',
        d.lastOut ? localTime(d.lastOut, tz) : '', d.workedMinutes != null ? round2(d.workedMinutes / 60) : '', d.lateMinutes ?? '',
        d.overtimeMinutes ?? '', d.leave?.name ?? '', d.flags.join(' ')]);
    }
  }
  return toCsv(['Code', 'Name', 'Department', 'Date', 'Status', 'First in', 'Last out', 'Hours', 'Late (min)', 'Overtime (min)', 'Leave', 'Flags'], rows);
}
