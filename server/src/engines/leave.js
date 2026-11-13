/**
 * Leave policy engine (pure functions — no database access).
 *
 * Inputs are resolved rule values ('leave.year', 'leave.type', 'leave.rules');
 * nothing here knows what "Annual" or "20 days" means.
 */
import { addDays, addMonths, diffDays, eachDay, fullMonthsBetween, maxDate, minDate } from '../lib/dates.js';
import { round2, roundToStep } from '../lib/util.js';

const reason = (code, params = {}) => ({ code, params });
const pad = (n) => String(n).padStart(2, '0');

/** The leave year containing `date`. `year` is the calendar year it starts in. */
export function leaveYearOf(date, { startMonth, startDay }) {
  let y = Number(date.slice(0, 4));
  if (date < `${y}-${pad(startMonth)}-${pad(startDay)}`) y -= 1;
  const start = `${y}-${pad(startMonth)}-${pad(startDay)}`;
  return { year: y, start, end: addDays(addMonths(start, 12), -1) };
}

export const isLimited = (rule) => rule.entitlementDays != null;

/**
 * Yearly entitlement for an employee as of a date, with an explanation.
 * Priority: probation quota (if set and still on probation) > tenure band > standard.
 * Joiners / leavers are pro-rated by days employed within the leave year.
 */
export function entitlementFor({ rule, employee, year, asOf }) {
  if (!isLimited(rule)) return { unlimited: true, days: null, basis: 'unlimited' };
  let base = rule.entitlementDays;
  let basis = 'standard';
  const months = fullMonthsBetween(employee.joining_date, asOf);
  const band = [...(rule.tenureBands ?? [])].sort((a, b) => b.minMonths - a.minMonths).find((b) => months >= b.minMonths);
  if (band) { base = band.entitlementDays; basis = `tenure ${band.minMonths}+ months`; }
  if (rule.probationEntitlementDays != null && employee.probation_end_date && asOf <= employee.probation_end_date) {
    base = rule.probationEntitlementDays;
    basis = 'probation';
  }
  const from = rule.proRate?.joiners ? maxDate(year.start, employee.joining_date) : year.start;
  const to = rule.proRate?.leavers && employee.exit_date ? minDate(year.end, employee.exit_date) : year.end;
  const yearDays = diffDays(year.start, year.end) + 1;
  const employedDays = Math.max(0, diffDays(from, to) + 1);
  if (employedDays < yearDays) {
    const days = round2(roundToStep((base * employedDays) / yearDays, rule.proRate?.roundingStep ?? 0));
    return { unlimited: false, days, base, basis, proRated: { from, to, employedDays, yearDays } };
  }
  return { unlimited: false, days: base, base, basis, proRated: null };
}

/**
 * Monthly accrual postings due up to `today`. Months are counted from the
 * leave-year start; a month is credited when its posting day falls inside
 * employment.
 */
export function accrualSchedule({ year, employee, today, postOn }) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const start = addMonths(year.start, i);
    const end = addDays(addMonths(year.start, i + 1), -1);
    const postDate = postOn === 'month_end' ? end : start;
    if (postDate > today) break;
    if (postDate < employee.joining_date) continue;
    if (employee.exit_date && postDate > employee.exit_date) break;
    out.push({ periodKey: start.slice(0, 7), date: postDate });
  }
  return out;
}

/**
 * Counts leave days between start and end according to the type's rule.
 * @returns {{ days: number, dates: Array<{date, counted, why}> }}
 */
export function countLeaveDays({ start, end, unit = 'day', hours, rule, calendar, hoursPerDay }) {
  const dates = [];
  for (const date of eachDay(start, end)) {
    const d = calendar.day(date);
    let why = null;
    if (d.holiday && !rule.countHolidays) why = 'holiday';
    else if (d.weekend && !rule.countWeekends) why = 'weekend';
    dates.push({ date, counted: !why, why, holiday: d.holiday });
  }
  const countedDays = dates.filter((d) => d.counted).length;
  let days = countedDays;
  if (unit === 'half_day') days = countedDays * 0.5;
  if (unit === 'hour') days = countedDays ? round2((hours ?? 0) / hoursPerDay) : 0;
  return { days, dates };
}

/**
 * Validates a leave request against the type's rule and the balance.
 * @param {object} a
 * @param {object} a.rule         resolved 'leave.type' value
 * @param {object} a.request      { start, end, unit, hours, attachmentRef }
 * @param {object} a.counted      result of countLeaveDays()
 * @param {object|null} a.balance { available } for limited types
 * @param {string} a.today
 * @param {object} a.employee
 * @param {Array}  a.overlapping  other pending/approved leave requests overlapping the dates
 * @param {object} a.year         leave year of the start date
 */
export function evaluateLeaveRequest({ rule, request, counted, balance, today, employee, overlapping = [], year }) {
  const reasons = [];
  const warnings = [];
  const { start, end, unit = 'day' } = request;

  if (end < start) reasons.push(reason('leave.dates_invalid'));
  if (end > year.end) reasons.push(reason('leave.crosses_year', { yearEnd: year.end }));
  if (unit === 'half_day' && !rule.allowHalfDay) reasons.push(reason('leave.half_day_not_allowed'));
  if (unit === 'hour' && !rule.allowHourly) reasons.push(reason('leave.hourly_not_allowed'));
  if (unit !== 'day' && start !== end) reasons.push(reason('leave.partial_day_single_date'));

  if (start >= today) {
    if (diffDays(today, start) < rule.minNoticeDays) reasons.push(reason('leave.min_notice', { days: rule.minNoticeDays }));
  } else if (diffDays(start, today) > rule.maxBackdatedDays) {
    reasons.push(reason('leave.backdated_limit', { days: rule.maxBackdatedDays }));
  }
  if (rule.maxConsecutiveDays != null && counted.days > rule.maxConsecutiveDays) {
    reasons.push(reason('leave.max_consecutive', { max: rule.maxConsecutiveDays, requested: counted.days }));
  }
  if (!rule.allowDuringProbation && employee.probation_end_date && start <= employee.probation_end_date) {
    reasons.push(reason('leave.probation', { until: employee.probation_end_date }));
  }
  if (overlapping.length) reasons.push(reason('leave.overlap', { start: overlapping[0].start_date, end: overlapping[0].end_date }));
  if (counted.days <= 0) reasons.push(reason('leave.no_working_days'));

  const requiresCertificate = rule.medicalCertificateAfterDays != null && counted.days > rule.medicalCertificateAfterDays;
  if (requiresCertificate && !request.attachmentRef) {
    reasons.push(reason('leave.certificate_required', { days: rule.medicalCertificateAfterDays }));
  }

  let paidDays = rule.paid ? counted.days : 0;
  let unpaidDays = rule.paid ? 0 : counted.days;
  let usageDays = isLimited(rule) ? counted.days : 0; // what comes off the balance
  if (isLimited(rule) && balance && counted.days > balance.available) {
    const available = Math.max(0, balance.available);
    if (rule.paid && rule.insufficientBalance === 'convert_to_unpaid') {
      paidDays = available;
      unpaidDays = round2(counted.days - available);
      usageDays = available;
      warnings.push(reason('leave.converted_to_unpaid', { paid: paidDays, unpaid: unpaidDays }));
    } else {
      reasons.push(reason('leave.insufficient_balance', { requested: counted.days, available }));
    }
  }

  return { allowed: reasons.length === 0, reasons, warnings, days: counted.days, paidDays, unpaidDays, usageDays, requiresCertificate };
}
