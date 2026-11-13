/**
 * WFH policy engine (pure functions — no database access).
 *
 * Every limit comes from the resolved 'wfh.policy' value passed in via
 * `policyFor(date)`, so changing a published setting changes the outcome
 * without touching this code. Reasons are returned as { code, params } and
 * rendered through the translations table ("2 of 2 WFH days used this week").
 */
import { addDays, dayName, diffDays, eachDay, fullMonthsBetween, monthEnd, monthStart, startOfWeek, weekday } from '../lib/dates.js';

const reason = (code, params = {}) => ({ code, params });

const coveredByOverride = (overrides, date) =>
  overrides.find((o) => o.status === 'active' && o.start_date <= date && date <= o.end_date) ?? null;

/** Days that count against the quota: approved (+ pending if configured), not covered by an override. */
function countedDays(existing, overrides, policy) {
  return existing.filter((r) =>
    (r.status === 'approved' || (r.status === 'pending' && policy.requests.countPendingInQuota)) &&
    !coveredByOverride(overrides, r.date)?.bypass_limits).map((r) => r.date);
}

function windowFor(date, kind, calendar) {
  if (kind === 'week') {
    const start = startOfWeek(date, calendar.weekStartsOn(date));
    return { start, end: addDays(start, 6) };
  }
  return { start: monthStart(date), end: monthEnd(date) };
}

/** Quota for the week and month containing `date`. */
export function wfhQuota({ date, policy, existing, overrides = [], calendar, extraDates = [] }) {
  const days = [...countedDays(existing, overrides, policy), ...extraDates];
  const out = {};
  for (const [kind, max] of [['week', policy.maxPerWeek], ['month', policy.maxPerMonth]]) {
    const { start, end } = windowFor(date, kind, calendar);
    const used = days.filter((d) => d >= start && d <= end).length;
    out[kind] = { start, end, used, max, remaining: Math.max(0, max - used) };
  }
  return out;
}

/** Expands a recurring weekly pattern into concrete dates. */
export function expandRecurrence({ startDate, endDate, weekdays }) {
  const set = new Set(weekdays);
  return [...eachDay(startDate, endDate)].filter((d) => set.has(weekday(d)));
}

/**
 * Evaluates requested WFH dates.
 * @param {object} a
 * @param {string[]} a.dates            requested dates
 * @param {string} a.today              today in tenant timezone
 * @param {object} a.employee           employee row
 * @param {(date: string) => {value: object, versionIds: string[]}} a.policyFor
 * @param {object} a.calendar           from buildCalendar()
 * @param {Array} a.existing            employee's pending/approved WFH requests [{date, status}]
 * @param {Array} a.overrides           employee's wfh_overrides rows
 * @param {Set<string>} a.leaveDates    dates the employee is on approved/pending leave
 */
export function evaluateWfhDates({ dates, today, employee, policyFor, calendar, existing, overrides, leaveDates = new Set() }) {
  const accepted = [];
  const results = [];
  const sorted = [...new Set(dates)].sort();

  for (const date of sorted) {
    const { value: policy, versionIds } = policyFor(date);
    const reasons = [];
    const override = coveredByOverride(overrides, date);
    const day = calendar.day(date);

    if (date < today) reasons.push(reason('wfh.date_in_past', { date }));
    if (day.holiday) reasons.push(reason('wfh.holiday', { date, name: day.holiday }));
    else if (day.weekend) reasons.push(reason('wfh.weekend', { date }));
    if (existing.some((r) => r.date === date && (r.status === 'pending' || r.status === 'approved'))) {
      reasons.push(reason('wfh.already_requested', { date }));
    }
    if (leaveDates.has(date)) reasons.push(reason('wfh.on_leave', { date }));

    const bypass = override?.bypass_limits === true;
    if (!bypass) {
      if (!policy.enabled) reasons.push(reason('wfh.disabled'));
      const notice = diffDays(today, date);
      if (date >= today && notice < policy.requests.minNoticeDays) {
        reasons.push(reason('wfh.min_notice', { days: policy.requests.minNoticeDays, date }));
      }
      if (!policy.allowedWeekdays.includes(weekday(date))) {
        reasons.push(reason('wfh.weekday_not_allowed', {
          date, day: dayName(weekday(date)), allowed: policy.allowedWeekdays.map(dayName).join(', ') || 'none',
        }));
      }
      const blackout = policy.blackoutDates.find((b) => b.date === date);
      if (blackout) reasons.push(reason('wfh.blackout', { date, reason: blackout.reason }));

      const elig = policy.eligibility;
      if (elig.blockDuringProbation && employee.probation_end_date && date <= employee.probation_end_date) {
        reasons.push(reason('wfh.probation', { until: employee.probation_end_date }));
      }
      const months = fullMonthsBetween(employee.joining_date, date);
      if (months < elig.minServiceMonths) reasons.push(reason('wfh.min_service', { months, required: elig.minServiceMonths }));
      if (elig.allowedRoleIds.length && !elig.allowedRoleIds.includes(employee.role_id)) reasons.push(reason('wfh.role_not_allowed'));
    }

    const quota = wfhQuota({ date, policy, existing, overrides, calendar, extraDates: accepted });
    if (!bypass) {
      if (quota.week.used >= policy.maxPerWeek) reasons.push(reason('wfh.weekly_limit', { used: quota.week.used, max: policy.maxPerWeek }));
      if (quota.month.used >= policy.maxPerMonth) reasons.push(reason('wfh.monthly_limit', { used: quota.month.used, max: policy.maxPerMonth }));
    }

    const allowed = reasons.length === 0;
    if (allowed && !bypass) accepted.push(date);
    const consumed = allowed && !bypass ? 1 : 0;
    results.push({
      date,
      allowed,
      reasons,
      coveredByOverride: override ? { id: override.id, reason: override.reason, bypassLimits: bypass } : null,
      autoApprove: allowed && (bypass || policy.requests.approval === 'auto_within_limits'),
      quota: {
        week: { ...quota.week, remaining: Math.max(0, quota.week.max - quota.week.used - consumed) },
        month: { ...quota.month, remaining: Math.max(0, quota.month.max - quota.month.used - consumed) },
      },
      policyVersionIds: versionIds,
    });
  }
  return { ok: results.length > 0 && results.every((r) => r.allowed), results };
}
