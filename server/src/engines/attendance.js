/**
 * Attendance engine (pure functions — no database access).
 *
 * Turns a day's append-only events into a status using the resolved
 * 'shift.rules' for that date. It reports facts and flags only (late,
 * half_day, short_hours, overtime, missed_checkout...); money consequences
 * are decided by the payroll rules in Phase 4.
 */
import { addDays, todayIn, zonedInstant } from '../lib/dates.js';

const EARTH_RADIUS_M = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Closest geofenced office to a point. */
export function nearestOffice(locations, lat, lng) {
  let best = null;
  for (const loc of locations) {
    if (loc.lat == null || loc.lng == null || !loc.radius_m) continue;
    const distance = distanceMeters(lat, lng, loc.lat, loc.lng);
    if (!best || distance < best.distance) best = { location: loc, distance, inside: distance <= loc.radius_m };
  }
  return best;
}

/** Pairs in/out events (sorted by punch_time) into sessions. */
export function pairSessions(events) {
  const sessions = [];
  let open = null;
  let strayOuts = 0;
  for (const e of events) {
    if (e.event_type === 'in') {
      if (open) sessions.push({ in: open, out: null }); // duplicate in: keep the earlier one open-ended
      open = e;
    } else if (open) {
      sessions.push({ in: open, out: e });
      open = null;
    } else {
      strayOuts += 1;
    }
  }
  if (open) sessions.push({ in: open, out: null });
  return { sessions, strayOuts };
}

/** Expected shift window for a business date (handles shifts crossing midnight). */
export function shiftWindow(date, shift, timeZone) {
  const start = zonedInstant(date, shift.start, timeZone);
  const end = zonedInstant(shift.end <= shift.start ? addDays(date, 1) : date, shift.end, timeZone);
  return { start, end, expectedMinutes: Math.round((end - start) / 60000) };
}

/**
 * @param {object} a
 * @param {string} a.date
 * @param {Array}  a.events      the day's effective events, sorted by punch_time
 * @param {object|null} a.shift  resolved 'shift.rules' value
 * @param {string} a.timeZone
 * @param {{weekend: boolean, holiday: string|null}} a.day
 * @param {object|null} a.leave  approved leave covering the day: { name, unit, requestId }
 * @param {boolean} a.wfhPlanned approved WFH (or override) for the day
 * @param {Date} a.now
 */
export function summarizeDay({ date, events, shift, timeZone, day, leave = null, wfhPlanned = false, now }) {
  const flags = new Set();
  const { sessions, strayOuts } = pairSessions(events);
  const today = todayIn(timeZone, now);
  const win = shift ? shiftWindow(date, shift, timeZone) : null;
  let workedMs = 0;
  let open = null;
  for (const s of sessions) {
    if (!s.out) { open = s; continue; }
    // A forgotten (auto-closed) session counts until shift end at most, never as overtime.
    const end = s.out.method === 'system_autoclose' && win ? new Date(Math.max(s.in.punch_time, Math.min(s.out.punch_time, win.end))) : s.out.punch_time;
    workedMs += end - s.in.punch_time;
  }
  if (open) {
    if (date < today) flags.add('open_session');
    else workedMs += Math.max(0, now - open.in.punch_time); // live count for today
  }
  if (strayOuts) flags.add('check_out_without_check_in');
  if (events.some((e) => !e.time_verified)) flags.add('unverified_time');
  if (events.some((e) => e.method === 'system_autoclose')) flags.add('missed_checkout');
  if (events.some((e) => e.method === 'correction')) flags.add('corrected');
  if (events.some((e) => e.method === 'manual')) flags.add('manual_entry');

  const workedMinutes = Math.round(workedMs / 60000);
  const firstIn = sessions[0]?.in.punch_time ?? null;
  const lastOut = sessions.filter((s) => s.out).at(-1)?.out.punch_time ?? null;
  const location = !firstIn ? null : events.some((e) => e.event_type === 'in' && e.method === 'wfh') ? 'wfh' : 'office';
  const result = (status, extra = {}) => ({
    date, status, location, firstIn, lastOut, workedMinutes, lateMinutes: 0, overtimeMinutes: 0, dayFraction: 0,
    openSession: !!open, wfhPlanned, leave, holiday: day.holiday, shift: shift ? { start: shift.start, end: shift.end } : null,
    ...extra, flags: [...flags],
  });

  if (day.holiday || day.weekend) {
    if (!firstIn) return result(day.holiday ? 'holiday' : 'weekend');
    flags.add('worked_on_off_day');
    return result('present', { overtimeMinutes: workedMinutes });
  }
  const partLeave = leave && leave.unit !== 'day';
  if (leave && !partLeave) {
    if (firstIn) flags.add('worked_on_leave');
    return result('on_leave');
  }
  if (!firstIn) {
    const stillOpen = date > today || (date === today && (!win || now < win.end));
    if (stillOpen) return result('not_yet');
    return result(partLeave ? 'on_leave' : 'absent', { dayFraction: 0 });
  }

  const status = location === 'wfh' ? 'wfh' : 'present';
  if (!shift) return result(status, { dayFraction: partLeave ? 0.5 : 1 });

  const lateMinutes = Math.max(0, Math.round((firstIn - win.start) / 60000));
  if (lateMinutes > shift.graceMinutes) flags.add('late');
  const halfDayLate = shift.halfDayLateMinutes > 0 && lateMinutes > shift.halfDayLateMinutes;
  if (halfDayLate) flags.add('half_day');

  const complete = !open || date < today;
  let dayFraction = partLeave ? 0.5 : halfDayLate ? 0.5 : 1;
  let overtimeMinutes = 0;
  if (complete) {
    const hours = workedMinutes / 60;
    const required = partLeave ? shift.halfDayMinHours : shift.fullDayMinHours;
    if (!partLeave && hours < shift.halfDayMinHours) {
      flags.add('insufficient_hours');
      return result('absent', { lateMinutes, dayFraction: 0 });
    }
    if (hours < required) {
      flags.add('short_hours');
      if (!partLeave) { flags.add('half_day'); dayFraction = 0.5; }
    }
    if (!partLeave) overtimeMinutes = Math.max(0, workedMinutes - win.expectedMinutes);
    if (overtimeMinutes > 0) flags.add('overtime');
  }
  return result(status, { lateMinutes, overtimeMinutes, dayFraction });
}
