/**
 * Attendance: punches, daily summaries, auto-close, corrections.
 *
 * - Time always comes from the server. The device time is stored next to it
 *   and a large difference flags the punch as unverified.
 * - Offline punches (mobile) carry a server-signed time anchor plus the
 *   device's monotonic elapsed time; without a valid anchor the device time
 *   is used and the punch is flagged unverified.
 * - attendance_events is append-only. A correction is a new 'correction'
 *   event; the event it replaces is ignored when summarising, never edited.
 */
import jwt from 'jsonwebtoken';
import { resolve, resolveRequired } from '../config/resolver.js';
import { buildCalendar } from '../engines/calendar.js';
import { nearestOffice, summarizeDay } from '../engines/attendance.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, diffDays, eachDay, isYmd, localTime, todayIn, zonedInstant } from '../lib/dates.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertCanManage, isSystem } from './access.js';
import { getEmployee } from './employees.js';
import { isEnabled, requireModule } from './features.js';
import { notify, userOfEmployee } from './notifications.js';
import { hasConsent, isRegisteredDevice } from './privacy.js';
import { closeTasks, registerHandler, submit } from './workflow.js';

const MAX_RANGE_DAYS = 62;
const reason = (code, params = {}) => ({ code, params });
const notAllowed = (reasons) => new AppError(422, 'attendance_not_allowed', 'This check-in/out is not allowed.', { details: { reasons } });

/** Events that an approved correction replaced are excluded everywhere. */
const EFFECTIVE = `e.id not in (select target_event_id from attendance_corrections
                    where tenant_id = e.tenant_id and status = 'approved' and target_event_id is not null)`;

export const attendanceRules = async (ctx, employee, date) =>
  (await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'attendance.rules', employee, date })).value;

/** The shift's rules on a date: the rota's shift for that day if one is set, else the person's usual shift. */
export async function shiftRule(ctx, employee, date) {
  const rota = employee.id
    ? await ctx.db.one('select shift_id, is_off from rota_entries where tenant_id = $1 and employee_id = $2 and date = $3', [ctx.tenant.id, employee.id, date])
    : null;
  const shiftId = rota?.shift_id ?? (rota?.is_off ? null : employee.shift_id);
  if (!shiftId) return null;
  const r = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: 'shift.rules', subjectId: shiftId, employee, date });
  return r.found ? r.value : null;
}

/** Approved/locked payroll period containing a date, if any. */
export async function lockedPeriodFor(ctx, date) {
  return ctx.db.one(`select period_key from payroll_runs where tenant_id = $1 and status in ('approved', 'locked')
                       and period_start <= $2 and period_end >= $2 limit 1`, [ctx.tenant.id, date]);
}

/** First approved/locked payroll period overlapping a date range, if any. */
export async function lockedPeriodOverlapping(ctx, from, to) {
  return ctx.db.one(`select period_key, greatest(period_start, $2::date) as date from payroll_runs
                      where tenant_id = $1 and status in ('approved', 'locked') and period_start <= $3 and period_end >= $2
                      order by period_start limit 1`, [ctx.tenant.id, from, to]);
}

async function lastEventAtOrBefore(ctx, employeeId, instant) {
  return ctx.db.one(
    `select e.* from attendance_events e where e.tenant_id = $1 and e.employee_id = $2 and e.punch_time <= $3 and ${EFFECTIVE}
      order by e.punch_time desc, e.created_at desc limit 1`, [ctx.tenant.id, employeeId, instant]);
}

async function hasApprovedWfh(ctx, employeeId, date) {
  return !!(await ctx.db.one(
    `select 1 where exists (select 1 from wfh_requests where tenant_id = $3 and employee_id = $1 and date = $2 and status = 'approved')
        or exists (select 1 from wfh_overrides where tenant_id = $3 and employee_id = $1 and status = 'active' and start_date <= $2 and end_date >= $2)`,
    [employeeId, date, ctx.tenant.id]));
}

/** Signed server time the mobile app stores to timestamp offline punches. */
export function timeAnchor(ctx) {
  const t = ctx.clock.now().getTime();
  return { serverTime: new Date(t).toISOString(), token: jwt.sign({ typ: 'time', t, sub: ctx.actor.userId }, ctx.jwtSecret, { expiresIn: '30d' }) };
}

function anchoredTime(ctx, offline) {
  if (!offline?.anchorToken || !Number.isFinite(offline.elapsedMs) || offline.elapsedMs < 0) return null;
  try {
    const claims = jwt.verify(offline.anchorToken, ctx.jwtSecret);
    if (claims.typ !== 'time' || claims.sub !== ctx.actor.userId) return null;
    return new Date(claims.t + offline.elapsedMs);
  } catch {
    return null;
  }
}

/** Night shifts: an early-morning check-in belongs to the previous day's shift. */
async function workDateFor(ctx, employee, punchTime) {
  const tz = ctx.tenant.timezone;
  const local = todayIn(tz, punchTime);
  const yesterday = addDays(local, -1);
  const shift = await shiftRule(ctx, employee, yesterday);
  if (shift && shift.end <= shift.start && localTime(punchTime, tz) < shift.end) return yesterday;
  return local;
}

/**
 * Check in / check out.
 * input: { employeeId, type?: 'in'|'out' (default: toggle), method: 'office_auto'|'office_manual'|'wfh',
 *          lat, lng, accuracy, deviceTime, deviceId, ip, selfieRef, clientPunchId,
 *          offline?: { anchorToken, elapsedMs } }
 */
export async function punch(ctx, input) {
  await requireModule(ctx, 'attendance');
  const employee = await getEmployee(ctx, input.employeeId);
  if (ctx.actor?.employeeId !== employee.id && !isSystem(ctx)) {
    throw forbidden('You can only check yourself in. Use an attendance correction for someone else.');
  }
  if (input.clientPunchId) {
    const existing = await ctx.db.one('select * from attendance_events where tenant_id = $1 and client_punch_id = $2', [ctx.tenant.id, input.clientPunchId]);
    if (existing) return { event: existing, duplicate: true };
  }
  const tz = ctx.tenant.timezone;
  const serverTime = ctx.clock.now();
  const rules = await attendanceRules(ctx, employee, todayIn(tz, serverTime));
  const skewMs = rules.maxClockSkewMinutes * 60_000;
  const deviceTime = input.deviceTime ? new Date(input.deviceTime) : null;
  if (deviceTime && Number.isNaN(deviceTime.getTime())) throw badRequest('device_time_invalid', 'Device time is not a valid timestamp.');

  const flags = [];
  let punchTime = serverTime;
  let timeVerified = true;
  if (input.offline) {
    const anchored = anchoredTime(ctx, input.offline);
    if (anchored) punchTime = anchored;
    else {
      if (!deviceTime) throw badRequest('device_time_required', 'Offline punches need the device time.');
      punchTime = deviceTime;
      timeVerified = false;
      flags.push('offline_unverified');
    }
    flags.push('offline');
    if (punchTime - serverTime > skewMs) throw notAllowed([reason('attendance.offline_in_future')]);
    if (punchTime > serverTime) punchTime = serverTime;
    if (serverTime - punchTime > rules.maxOfflineDays * 86_400_000) throw notAllowed([reason('attendance.offline_too_old', { days: rules.maxOfflineDays })]);
  } else if (deviceTime && Math.abs(deviceTime - serverTime) > skewMs) {
    timeVerified = false;
    flags.push('device_clock_mismatch');
  }

  const method = input.method;
  if (!rules.allowedMethods.includes(method) || (method === 'office_auto' && !(await isEnabled(ctx, 'auto_checkin')))) {
    throw notAllowed([reason('attendance.method_not_allowed', { method })]);
  }

  const last = await lastEventAtOrBefore(ctx, employee.id, punchTime);
  const openSession = last?.event_type === 'in' ? last : null;
  const type = input.type ?? (openSession ? 'out' : 'in');
  if (type === 'in' && openSession) throw notAllowed([reason('attendance.already_checked_in', { since: localTime(openSession.punch_time, tz) })]);
  if (type === 'out' && !openSession) throw notAllowed([reason('attendance.not_checked_in')]);
  const workDate = type === 'out' ? openSession.work_date : await workDateFor(ctx, employee, punchTime);
  const locked = await lockedPeriodFor(ctx, workDate);
  if (locked) throw notAllowed([reason('attendance.period_locked', { date: workDate, period: locked.period_key })]);

  const hasPoint = Number.isFinite(input.lat) && Number.isFinite(input.lng);
  let locationId = null;
  if (type === 'in' && method !== 'wfh') {
    if (rules.requireLocationConsent && !(await hasConsent(ctx, ctx.actor.userId, 'location'))) {
      throw notAllowed([reason('attendance.location_consent_required')]);
    }
    if (!hasPoint) throw notAllowed([reason('attendance.location_required')]);
    const { rows: offices } = await ctx.db.query('select * from locations where tenant_id = $1 and is_active', [ctx.tenant.id]);
    const near = nearestOffice(offices, input.lat, input.lng);
    if (!near) throw notAllowed([reason('attendance.no_office')]);
    if (!near.inside) {
      throw notAllowed([reason('attendance.outside_geofence', { distance: Math.round(near.distance), office: near.location.name, radius: near.location.radius_m })]);
    }
    locationId = near.location.id;
    if (Number.isFinite(input.accuracy) && input.accuracy > near.location.radius_m) flags.push('low_accuracy');
  }
  if (type === 'in' && method === 'wfh') {
    if (!(await hasApprovedWfh(ctx, employee.id, workDate))) throw notAllowed([reason('attendance.no_wfh_approval', { date: workDate })]);
    const { value: policy } = await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'wfh.policy', employee, date: workDate });
    const device = await isRegisteredDevice(ctx, employee.id, input);
    if (policy.verification === 'selfie') {
      const selfieOk = !!input.selfieRef && (await isEnabled(ctx, 'selfie_verification')) && (await hasConsent(ctx, ctx.actor.userId, 'selfie'));
      if (selfieOk) flags.push('selfie_verified');
      else if (device) flags.push('device_verified'); // non-biometric alternative
      else if (input.selfieRef && !(await hasConsent(ctx, ctx.actor.userId, 'selfie'))) throw notAllowed([reason('attendance.selfie_consent_required')]);
      else throw notAllowed([reason('attendance.wfh_verification_required')]);
    }
    if (policy.verification === 'ip_device') {
      if (!device) throw notAllowed([reason('attendance.device_not_registered')]);
      flags.push('device_verified');
    }
  }

  try {
    const event = await ctx.db.one(
      `insert into attendance_events (tenant_id, employee_id, event_type, server_time, punch_time, device_time, work_date, lat, lng, accuracy_m,
                                      method, location_id, selfie_ref, ip, device_id, time_verified, client_punch_id, flags)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning *`,
      [ctx.tenant.id, employee.id, type, serverTime, punchTime, deviceTime, workDate, hasPoint ? input.lat : null, hasPoint ? input.lng : null,
        Number.isFinite(input.accuracy) ? input.accuracy : null, method, locationId, input.selfieRef ?? null, input.ip ?? null,
        input.deviceId ?? null, timeVerified, input.clientPunchId ?? null, JSON.stringify(flags)]);
    return { event, duplicate: false };
  } catch (err) {
    if (err.code === '23505' && input.clientPunchId) {
      return { event: await ctx.db.one('select * from attendance_events where tenant_id = $1 and client_punch_id = $2', [ctx.tenant.id, input.clientPunchId]), duplicate: true };
    }
    throw err;
  }
}

/**
 * Closes sessions still open after the configured auto-close time and flags
 * them as missed check-outs (run by the job scheduler).
 */
export async function autoCloseSessions(ctx) {
  const now = ctx.clock.now();
  const { rows: open } = await ctx.db.query(
    `select * from (select distinct on (e.employee_id) e.* from attendance_events e where e.tenant_id = $1 and ${EFFECTIVE}
                      order by e.employee_id, e.punch_time desc, e.created_at desc) last
      where last.event_type = 'in'`, [ctx.tenant.id]);
  let closed = 0;
  for (const ev of open) {
    const employee = await getEmployee(ctx, ev.employee_id, { check: false });
    const rules = await attendanceRules(ctx, employee, ev.work_date);
    let closeAt = zonedInstant(ev.work_date, rules.autoCloseTime, ctx.tenant.timezone);
    if (closeAt <= ev.punch_time) closeAt = zonedInstant(addDays(ev.work_date, 1), rules.autoCloseTime, ctx.tenant.timezone);
    if (now < closeAt) continue;
    await ctx.db.query(
      `insert into attendance_events (tenant_id, employee_id, event_type, server_time, punch_time, work_date, method, time_verified, flags)
       values ($1, $2, 'out', $3, $4, $5, 'system_autoclose', true, '["auto_closed"]')`,
      [ctx.tenant.id, ev.employee_id, now, closeAt, ev.work_date]);
    await notify(ctx, { userIds: [await userOfEmployee(ctx, ev.employee_id)], event: 'checkout_auto_closed',
      params: { date: ev.work_date, time: localTime(closeAt, ctx.tenant.timezone) } });
    closed += 1;
  }
  return closed;
}

/** Day-by-day attendance with status and flags. */
export async function daySummaries(ctx, employeeId, { from, to }) {
  if (!isYmd(from) || !isYmd(to) || to < from) throw badRequest('date_invalid', 'Choose a valid date range.');
  if (diffDays(from, to) >= MAX_RANGE_DAYS) throw badRequest('range_too_long', `Choose at most ${MAX_RANGE_DAYS} days.`);
  const employee = await getEmployee(ctx, employeeId);
  const calendar = await buildCalendar(ctx, employee, from, to);
  const { rows: events } = await ctx.db.query(
    `select e.* from attendance_events e where e.tenant_id = $1 and e.employee_id = $2 and e.work_date between $3 and $4 and ${EFFECTIVE}
      order by e.punch_time, e.created_at`, [ctx.tenant.id, employee.id, from, to]);
  const { rows: leaves } = await ctx.db.query(
    `select lr.*, lt.name as leave_type from leave_requests lr join leave_types lt on lt.id = lr.leave_type_id
      where lr.employee_id = $1 and lr.status = 'approved' and lr.start_date <= $3 and lr.end_date >= $2`, [employee.id, from, to]);
  const leaveByDate = new Map();
  for (const l of leaves) {
    const counted = l.policy_snapshot?.dates?.filter((d) => d.counted).map((d) => d.date)
      ?? [...eachDay(l.start_date, l.end_date)].filter((d) => d >= from && d <= to && calendar.isWorkingDay(d));
    for (const d of counted) leaveByDate.set(d, { name: l.leave_type, unit: l.unit, requestId: l.id, paid: l.paid_days > 0 });
  }
  const { rows: wfh } = await ctx.db.query(
    `select date from wfh_requests where tenant_id = $4 and employee_id = $1 and status = 'approved' and date between $2 and $3
     union select d::date from wfh_overrides o, generate_series(greatest(o.start_date, $2::date), least(o.end_date, $3::date), interval '1 day') d
      where o.tenant_id = $4 and o.employee_id = $1 and o.status = 'active' and o.start_date <= $3 and o.end_date >= $2`, [employee.id, from, to, ctx.tenant.id]);
  const wfhDates = new Set(wfh.map((w) => (typeof w.date === 'string' ? w.date : w.date.toISOString().slice(0, 10))));
  const now = ctx.clock.now();
  const out = [];
  for (const date of eachDay(from, to)) {
    if (date < employee.joining_date || (employee.exit_date && date > employee.exit_date)) {
      out.push({ date, status: 'not_employed', flags: [] });
      continue;
    }
    out.push(summarizeDay({
      date, events: events.filter((e) => e.work_date === date), shift: await shiftRule(ctx, employee, date), timeZone: ctx.tenant.timezone,
      day: calendar.day(date), leave: leaveByDate.get(date) ?? null, wfhPlanned: wfhDates.has(date), now,
    }));
  }
  return out;
}

async function availableMethods(ctx, rules, wfhApproved) {
  const autoOn = await isEnabled(ctx, 'auto_checkin');
  return rules.allowedMethods.filter((m) => (m !== 'wfh' || wfhApproved) && (m !== 'office_auto' || autoOn));
}

/** Everything the Check In / Check Out button needs. */
export async function todayStatus(ctx, employeeId) {
  const employee = await getEmployee(ctx, employeeId);
  const today = tenantToday(ctx);
  const [summary] = await daySummaries(ctx, employee.id, { from: today, to: today });
  const last = await lastEventAtOrBefore(ctx, employee.id, ctx.clock.now());
  const rules = await attendanceRules(ctx, employee, today);
  const wfhApproved = await hasApprovedWfh(ctx, employee.id, today);
  const { value: policy } = await resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: 'wfh.policy', employee, date: today });
  return {
    date: today, summary, checkedIn: last?.event_type === 'in', since: last?.event_type === 'in' ? last.punch_time : null,
    nextAction: last?.event_type === 'in' ? 'out' : 'in',
    methods: await availableMethods(ctx, rules, wfhApproved),
    wfhApproved, wfhVerification: policy.verification,
  };
}

// ---------------------------------------------------------------------
// Corrections (new rows + approval; the original event is never edited)
// ---------------------------------------------------------------------
const loadCorrection = async (ctx, id) => {
  const c = await ctx.db.one('select * from attendance_corrections where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!c) throw notFound('Attendance correction');
  return c;
};

export async function requestCorrection(ctx, { employeeId, workDate, eventType, correctedTime, targetEventId, reason: why }) {
  const employee = await getEmployee(ctx, employeeId);
  if (ctx.actor?.employeeId !== employee.id) await assertCanManage(ctx, employee.id);
  if (!isYmd(workDate) || !['in', 'out'].includes(eventType)) throw badRequest('correction_invalid', 'Give the work date and whether it is a check-in or check-out.');
  if (!why?.trim()) throw badRequest('correction_invalid', 'Explain why the time needs correcting.');
  const at = new Date(correctedTime);
  if (Number.isNaN(at.getTime())) throw badRequest('correction_invalid', 'Corrected time must be a timestamp.');
  if (at > ctx.clock.now()) throw notAllowed([reason('attendance.correction_in_future')]);
  const localDate = todayIn(ctx.tenant.timezone, at);
  if (localDate !== workDate && localDate !== addDays(workDate, 1)) throw badRequest('correction_invalid', 'The corrected time must be on the work date (or the next morning for night shifts).');
  const locked = await lockedPeriodFor(ctx, workDate);
  if (locked) throw notAllowed([reason('attendance.period_locked', { date: workDate, period: locked.period_key })]);
  if (targetEventId) {
    const target = await ctx.db.one('select * from attendance_events where id = $1 and tenant_id = $2 and employee_id = $3', [targetEventId, ctx.tenant.id, employee.id]);
    if (!target) throw notFound('Attendance event');
    if (target.work_date !== workDate || target.event_type !== eventType) throw badRequest('correction_invalid', 'The event being corrected must be the same date and type.');
  }
  const row = await ctx.db.one(
    `insert into attendance_corrections (tenant_id, employee_id, work_date, event_type, corrected_time, target_event_id, reason, status, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) returning *`,
    [ctx.tenant.id, employee.id, workDate, eventType, at, targetEventId ?? null, why, ctx.actor.userId]);
  await audit(ctx.db, ctx, { action: 'attendance.correction_requested', entityType: 'attendance_correction', entityId: row.id, newValue: row });
  const flow = await submit(ctx, 'attendance_correction', row.id);
  return { correction: await loadCorrection(ctx, row.id), workflow: flow };
}

export async function listCorrections(ctx, { employeeId, status } = {}) {
  if (employeeId) await getEmployee(ctx, employeeId);
  else if (ctx.actor?.accessLevel !== 'hr_admin') employeeId = ctx.actor.employeeId;
  return (await ctx.db.query(
    `select * from attendance_corrections where tenant_id = $1 and ($2::uuid is null or employee_id = $2) and ($3::text is null or status = $3)
      order by created_at desc limit 200`, [ctx.tenant.id, employeeId ?? null, status ?? null])).rows;
}

registerHandler('attendance_correction', {
  async load(ctx, id) {
    const c = await loadCorrection(ctx, id);
    const time = localTime(c.corrected_time, ctx.tenant.timezone);
    return { employeeId: c.employee_id, status: c.status, summary: `check-${c.event_type} at ${time} on ${c.work_date}` };
  },
  async beforeFinalApprove(ctx, id) {
    const c = await loadCorrection(ctx, id);
    const locked = await lockedPeriodFor(ctx, c.work_date);
    if (locked) throw notAllowed([reason('attendance.period_locked', { date: c.work_date, period: locked.period_key })]);
  },
  async finalize(ctx, id, decision, { actorUserId, comment }) {
    const c = await loadCorrection(ctx, id);
    await ctx.db.query(`update attendance_corrections set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 where id = $1`,
      [id, decision, actorUserId, comment]);
    if (decision === 'approved') {
      await ctx.db.query(
        `insert into attendance_events (tenant_id, employee_id, event_type, server_time, punch_time, work_date, method, time_verified, correction_id, flags)
         values ($1, $2, $3, now(), $4, $5, 'correction', true, $6, '["correction"]')`,
        [ctx.tenant.id, c.employee_id, c.event_type, c.corrected_time, c.work_date, c.id]);
    }
    await audit(ctx.db, ctx, { action: `attendance.correction_${decision}`, entityType: 'attendance_correction', entityId: id, oldValue: c, newValue: { decision, comment } });
  },
});

export async function cancelCorrection(ctx, id) {
  const c = await loadCorrection(ctx, id);
  if (ctx.actor?.employeeId !== c.employee_id) await assertCanManage(ctx, c.employee_id);
  if (c.status !== 'pending') throw conflict('not_cancellable', `This correction is already ${c.status}.`);
  await ctx.db.tx(async (db) => {
    await db.query(`update attendance_corrections set status = 'cancelled' where id = $1`, [id]);
    await closeTasks(db, ctx, 'attendance_correction', id);
    await audit(db, ctx, { action: 'attendance.correction_cancelled', entityType: 'attendance_correction', entityId: id, oldValue: c });
  });
}

// ---------------------------------------------------------------------
// Manual attendance: HR (anyone) or a manager (their reports) records a
// check-in and/or check-out for someone else, e.g. a forgotten phone.
// New 'manual' events, never edits; who entered it and why are kept on
// the event and in the audit log, and the employee is notified.
// ---------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function eventsBetween(ctx, employeeId, from, to) {
  return (await ctx.db.query(
    `select e.* from attendance_events e where e.tenant_id = $1 and e.employee_id = $2 and e.punch_time > $3 and e.punch_time <= $4 and ${EFFECTIVE}
      order by e.punch_time, e.created_at`, [ctx.tenant.id, employeeId, from, to])).rows;
}

async function firstEventAfter(ctx, employeeId, instant) {
  return ctx.db.one(
    `select e.* from attendance_events e where e.tenant_id = $1 and e.employee_id = $2 and e.punch_time > $3 and ${EFFECTIVE}
      order by e.punch_time, e.created_at limit 1`, [ctx.tenant.id, employeeId, instant]);
}

/**
 * input: { employeeId, workDate: 'YYYY-MM-DD', checkIn?: 'HH:MM', checkOut?: 'HH:MM', reason }
 * A check-out earlier than the check-in is the next morning (night shift).
 * Only a check-out: closes the open check-in of that date.
 */
export async function recordManual(ctx, { employeeId, workDate, checkIn, checkOut, reason: why } = {}) {
  await requireModule(ctx, 'attendance');
  await assertCanManage(ctx, employeeId);
  const employee = await getEmployee(ctx, employeeId);
  const tz = ctx.tenant.timezone;
  if (!isYmd(workDate)) throw badRequest('manual_invalid', 'Choose the date.');
  checkIn ||= null;
  checkOut ||= null;
  if (!checkIn && !checkOut) throw badRequest('manual_invalid', 'Enter a check-in time, a check-out time, or both.');
  if ([checkIn, checkOut].some((v) => v && !HHMM.test(v))) throw badRequest('manual_invalid', 'Times must look like 09:00 (24-hour).');
  if (!why?.trim()) throw badRequest('manual_invalid', 'Give a reason. It is shown to the employee and kept in the audit log.');
  if (why.length > 500) throw badRequest('manual_invalid', 'Keep the reason under 500 characters.');
  if (workDate < employee.joining_date || (employee.exit_date && workDate > employee.exit_date)) {
    throw notAllowed([reason('attendance.manual_not_employed', { date: workDate })]);
  }
  const locked = await lockedPeriodFor(ctx, workDate);
  if (locked) throw notAllowed([reason('attendance.period_locked', { date: workDate, period: locked.period_key })]);

  const now = ctx.clock.now();
  let inAt = checkIn ? zonedInstant(workDate, checkIn, tz) : null;
  let outAt = checkOut ? zonedInstant(workDate, checkOut, tz) : null;
  let openIn = null;
  if (inAt && outAt && outAt <= inAt) outAt = zonedInstant(addDays(workDate, 1), checkOut, tz);
  if (!inAt) {
    // Closing an open check-in of that date.
    openIn = await ctx.db.one(
      `select e.* from attendance_events e where e.tenant_id = $1 and e.employee_id = $2 and e.work_date = $3 and ${EFFECTIVE}
        order by e.punch_time desc, e.created_at desc limit 1`, [ctx.tenant.id, employee.id, workDate]);
    if (openIn?.event_type !== 'in') throw notAllowed([reason('attendance.manual_no_check_in', { date: workDate })]);
    if (outAt <= openIn.punch_time) outAt = zonedInstant(addDays(workDate, 1), checkOut, tz);
  }
  if ((inAt && inAt > now) || (outAt && outAt > now)) throw notAllowed([reason('attendance.manual_in_future')]);

  // It must fit around what is already recorded.
  const overlap = (ev) => notAllowed([reason('attendance.manual_overlaps', { time: localTime(ev.punch_time, tz) })]);
  if (inAt) {
    const before = await lastEventAtOrBefore(ctx, employee.id, inAt);
    if (before?.event_type === 'in') throw overlap(before);
    if (outAt) {
      const inside = await eventsBetween(ctx, employee.id, inAt, outAt);
      if (inside.length) throw overlap(inside[0]);
    } else {
      const next = await firstEventAfter(ctx, employee.id, inAt);
      if (next?.event_type === 'in') throw notAllowed([reason('attendance.manual_open_after', { time: localTime(next.punch_time, tz) })]);
    }
  } else {
    const inside = await eventsBetween(ctx, employee.id, openIn.punch_time, outAt);
    if (inside.length) throw overlap(inside[0]);
  }

  const note = why.trim();
  const events = await ctx.db.tx(async (db) => {
    const rows = [];
    for (const [type, at] of [['in', inAt], ['out', outAt]]) {
      if (!at) continue;
      rows.push(await db.one(
        `insert into attendance_events (tenant_id, employee_id, event_type, server_time, punch_time, work_date, method, time_verified, flags, entered_by, note)
         values ($1, $2, $3, $4, $5, $6, 'manual', true, '["manual"]', $7, $8) returning *`,
        [ctx.tenant.id, employee.id, type, now, at, workDate, ctx.actor?.userId ?? null, note]));
    }
    await audit(db, ctx, { action: 'attendance.manual_entry', entityType: 'employee', entityId: employee.id,
      newValue: { workDate, checkIn, checkOut, reason: note, eventIds: rows.map((r) => r.id) } });
    return rows;
  });
  const enteredBy = ctx.actor?.employeeId
    ? (await ctx.db.one('select full_name from employees where id = $1', [ctx.actor.employeeId]))?.full_name : null;
  const times = [checkIn && `in ${checkIn}`, checkOut && `out ${checkOut}`].filter(Boolean).join(', ');
  await notify(ctx, { userIds: [await userOfEmployee(ctx, employee.id)], event: 'attendance_recorded',
    params: { date: workDate, times, reason: note, enteredBy: enteredBy ?? 'HR' } });
  const [day] = await daySummaries(ctx, employee.id, { from: workDate, to: workDate });
  return { events, day };
}
