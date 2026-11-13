/**
 * Attendance: server-time punches, geofence, WFH verification, offline sync,
 * auto-close, shift-driven status and append-only corrections.
 * Times are Asia/Karachi local (UTC+5). Shift GENERAL: 09:00-18:00,
 * 15 grace minutes, half day if > 120 min late, 8h full / 4h half day.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codes } from './helpers.js';
import * as att from '../src/services/attendance.js';
import * as wfh from '../src/services/wfh.js';
import * as leave from '../src/services/leave.js';
import { recordConsent, registerDevice } from '../src/services/privacy.js';
import { setFlag } from '../src/services/features.js';
import { listNotifications } from '../src/services/notifications.js';
import { decideRequest } from '../src/services/workflow.js';

const LHR = { lat: 31.5205, lng: 74.3588 }; // ~15 m from Lahore HQ
const KHI = { lat: 24.8608, lng: 67.0012 };
const ISB = { lat: 33.6844, lng: 73.0479 };

const reasonsOf = async (promise) => {
  try { await promise; } catch (err) { return codes(err.details?.reasons ?? [{ code: err.code }]); }
  throw new Error('expected the punch to be refused');
};
const day = async (t, code, date) => (await att.daySummaries(t.hr, t.emp(code), { from: date, to: date }))[0];

async function consented(t, code) {
  const ctx = await t.as(code);
  await recordConsent(ctx, { kind: 'location', granted: true, textVersion: 'v1' });
  return ctx;
}

describe('check in / check out', () => {
  let t, ali, ayesha;
  before(async () => {
    t = await setup();
    ali = await t.as('E003');
    ayesha = await consented(t, 'E004');
  });
  after(() => t.close());

  test('office check-in needs location consent first', async () => {
    t.at('2026-03-04 08:55');
    assert.deepEqual(await reasonsOf(att.punch(ali, { employeeId: t.emp('E003'), method: 'office_manual', ...LHR })), ['attendance.location_consent_required']);
  });

  test('time comes from the server; device time is stored separately', async () => {
    await recordConsent(ali, { kind: 'location', granted: true });
    t.at('2026-03-04 08:55');
    const { event } = await att.punch(ali, { employeeId: t.emp('E003'), method: 'office_manual', ...LHR, deviceTime: '2026-03-04T03:56:00Z' });
    assert.equal(event.event_type, 'in');
    assert.equal(event.punch_time.toISOString(), '2026-03-04T03:55:00.000Z');
    assert.equal(event.time_verified, true);
    assert.equal(event.work_date, '2026-03-04');
    assert.equal(event.location_id, t.demo.locations.LHR);
  });

  test('no duplicate check-in; no check-out without check-in', async () => {
    t.at('2026-03-04 09:10');
    const r = await att.punch(ali, { employeeId: t.emp('E003'), method: 'office_manual', type: 'in', ...LHR }).catch((e) => e);
    assert.deepEqual(codes(r.details.reasons), ['attendance.already_checked_in']);
    assert.equal(r.details.reasons[0].params.since, '08:55');
    const fatima = await consented(t, 'E006');
    assert.deepEqual(await reasonsOf(att.punch(fatima, { employeeId: t.emp('E006'), method: 'office_manual', type: 'out' })), ['attendance.not_checked_in']);
  });

  test('outside every geofence is refused with the distance', async () => {
    const err = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', ...ISB }).catch((e) => e);
    assert.deepEqual(codes(err.details.reasons), ['attendance.outside_geofence']);
    assert.equal(err.details.reasons[0].params.office, 'Lahore HQ');
    assert.ok(err.details.reasons[0].params.distance > 250_000);
  });

  test('a device clock far from server time is flagged "unverified"', async () => {
    t.at('2026-03-04 09:05');
    const { event } = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', ...LHR, deviceTime: '2026-03-04T03:30:00Z' });
    assert.equal(event.time_verified, false);
    assert.deepEqual(event.flags, ['device_clock_mismatch']);
    assert.equal(event.punch_time.toISOString(), '2026-03-04T04:05:00.000Z', 'server time still used');
  });

  test('a repeated sync with the same client punch id never duplicates', async () => {
    t.at('2026-03-04 18:10');
    const a = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', clientPunchId: 'phone-1:42' });
    const b = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', clientPunchId: 'phone-1:42' });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(a.event.id, b.event.id);
    assert.equal(a.event.event_type, 'out');
  });

  test("auto check-in is refused while the company's auto_checkin module is off", async () => {
    const fatima = await t.as('E006');
    assert.deepEqual(await reasonsOf(att.punch(fatima, { employeeId: t.emp('E006'), method: 'office_auto', ...LHR })), ['attendance.method_not_allowed']);
    await setFlag(t.hr, 'auto_checkin', { enabled: true });
    const { event } = await att.punch(fatima, { employeeId: t.emp('E006'), method: 'office_auto', ...LHR });
    assert.equal(event.method, 'office_auto');
  });

  test('nobody can punch for someone else', async () => {
    await assert.rejects(att.punch(t.hr, { employeeId: t.emp('E010'), method: 'office_manual', ...LHR }), { code: 'forbidden' });
  });

  test('day summary: present, worked minutes, overtime', async () => {
    t.at('2026-03-04 18:05');
    await att.punch(ali, { employeeId: t.emp('E003'), method: 'office_manual' });
    const s = await day(t, 'E003', '2026-03-04');
    assert.deepEqual([s.status, s.workedMinutes, s.lateMinutes, s.overtimeMinutes, s.dayFraction], ['present', 550, 0, 10, 1]);
    assert.deepEqual(s.flags, ['overtime']);
    const ay = await day(t, 'E004', '2026-03-04');
    assert.ok(ay.flags.includes('unverified_time'));
  });
});

describe('shift rules drive late / half-day / short hours (no code change)', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  const workDay = async (code, place, inAt, outAt) => {
    const ctx = await consented(t, code);
    t.at(inAt);
    await att.punch(ctx, { employeeId: t.emp(code), method: 'office_manual', ...place });
    t.at(outAt);
    await att.punch(ctx, { employeeId: t.emp(code), method: 'office_manual' });
  };

  test('late beyond grace, half day when very late, absent below half-day hours', async () => {
    await workDay('E006', LHR, '2026-03-04 09:20', '2026-03-04 17:30');
    await workDay('E008', KHI, '2026-03-04 11:30', '2026-03-04 18:00');
    await workDay('E011', KHI, '2026-03-04 09:00', '2026-03-04 12:00');
    const f = await day(t, 'E006', '2026-03-04');
    assert.deepEqual([f.status, f.lateMinutes, f.flags], ['present', 20, ['late']]);
    const z = await day(t, 'E008', '2026-03-04');
    assert.deepEqual([z.status, z.dayFraction, z.flags.sort()], ['present', 0.5, ['half_day', 'late', 'short_hours']]);
    const k = await day(t, 'E011', '2026-03-04');
    assert.deepEqual([k.status, k.flags], ['absent', ['insufficient_hours']]);
  });

  test('changing grace minutes applies from its effective date only', async () => {
    const shiftId = t.demo.shifts.GENERAL;
    await t.publishSetting({ key: 'shift.rules', subjectId: shiftId, effectiveFrom: '2026-03-05',
      value: { start: '09:00', end: '18:00', graceMinutes: 30, halfDayLateMinutes: 120, fullDayMinHours: 8, halfDayMinHours: 4 } });
    await workDay('E006', LHR, '2026-03-05 09:20', '2026-03-05 17:30');
    assert.deepEqual((await day(t, 'E006', '2026-03-05')).flags, [], 'not late under the new 30-minute grace');
    assert.deepEqual((await day(t, 'E006', '2026-03-04')).flags, ['late'], 'yesterday keeps the old rule');
  });

  test('leave, holidays, weekends and absence', async () => {
    const ali = await t.as('E003');
    const { request } = await leave.createLeaveRequest(ali, { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-09' });
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });
    t.at('2026-03-24 10:00');
    const days = await att.daySummaries(t.hr, t.emp('E003'), { from: '2026-03-06', to: '2026-03-09' });
    assert.deepEqual(days.map((d) => d.status), ['absent', 'weekend', 'weekend', 'on_leave']);
    assert.equal((await day(t, 'E003', '2026-03-23')).status, 'holiday');
    assert.equal((await day(t, 'E007', '2026-02-01')).status, 'not_employed', 'Hamza joined 2 Feb');
  });
});

describe('WFH check-in and verification', () => {
  let t, hira;
  before(async () => { t = await setup(); hira = await t.as('E010'); });
  after(() => t.close());

  test('only on an approved WFH day', async () => {
    const r = await wfh.createWfhRequest(hira, { employeeId: t.emp('E010'), dates: ['2026-03-09'] });
    await decideRequest(await t.as('E009'), 'wfh', r.requestGroupId, { decision: 'approved' });
    t.at('2026-03-09 09:02');
    const { event } = await att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh' });
    assert.equal(event.method, 'wfh');
    t.at('2026-03-09 18:00');
    await att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh' });
    assert.equal((await day(t, 'E010', '2026-03-09')).status, 'wfh');
    t.at('2026-03-10 09:00');
    assert.deepEqual(await reasonsOf(att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh' })), ['attendance.no_wfh_approval']);
  });

  test('selfie verification is a policy setting, with a registered device as the non-biometric alternative', async () => {
    t.at('2026-03-10 09:00');
    await t.publishSetting({ key: 'wfh.policy', patch: { verification: 'selfie' } });
    await wfh.createOverride(t.hr, { employeeId: t.emp('E010'), startDate: '2026-03-11', endDate: '2026-03-12', reason: 'Home renovation' });

    t.at('2026-03-11 09:00');
    assert.deepEqual(await reasonsOf(att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh' })), ['attendance.wfh_verification_required']);
    assert.deepEqual(await reasonsOf(att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh', selfieRef: 's3://selfies/1.jpg' })), ['attendance.selfie_consent_required']);
    await setFlag(t.hr, 'selfie_verification', { enabled: true });
    await recordConsent(hira, { kind: 'selfie', granted: true });
    const selfie = await att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh', selfieRef: 's3://selfies/1.jpg' });
    assert.deepEqual(selfie.event.flags, ['selfie_verified']);
    t.at('2026-03-11 18:00');
    await att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh' });

    await registerDevice(hira, { employeeId: t.emp('E010'), deviceId: 'android-abc', label: 'My phone' });
    t.at('2026-03-12 09:00');
    const device = await att.punch(hira, { employeeId: t.emp('E010'), method: 'wfh', deviceId: 'android-abc' });
    assert.deepEqual(device.event.flags, ['device_verified']);
  });
});

describe('offline punches', () => {
  let t, ayesha;
  before(async () => { t = await setup(); ayesha = await consented(t, 'E004'); });
  after(() => t.close());

  test('a server-signed time anchor + elapsed time gives a verified punch time', async () => {
    t.at('2026-03-05 08:00');
    const anchor = att.timeAnchor(ayesha);
    t.at('2026-03-05 11:00'); // phone comes back online 3h later
    const { event } = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', ...LHR, clientPunchId: 'off-1',
      deviceTime: '2026-03-05T04:01:00Z', offline: { anchorToken: anchor.token, elapsedMs: 61 * 60_000 } });
    assert.equal(event.punch_time.toISOString(), '2026-03-05T04:01:00.000Z'); // 09:01 local
    assert.equal(event.server_time.toISOString(), '2026-03-05T06:00:00.000Z');
    assert.equal(event.time_verified, true);
    assert.deepEqual(event.flags, ['offline']);
  });

  test('without an anchor the device time is used and marked unverified', async () => {
    const { event } = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', clientPunchId: 'off-2',
      deviceTime: '2026-03-05T05:30:00Z', offline: {} });
    assert.equal(event.event_type, 'out');
    assert.equal(event.time_verified, false);
    assert.deepEqual(event.flags, ['offline_unverified', 'offline']);
  });

  test('a forged anchor is ignored; very old punches are refused', async () => {
    const r = await att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', ...LHR, deviceTime: '2026-03-05T05:40:00Z',
      offline: { anchorToken: 'forged.token.value', elapsedMs: 1000 } });
    assert.equal(r.event.time_verified, false);
    assert.deepEqual(await reasonsOf(att.punch(ayesha, { employeeId: t.emp('E004'), method: 'office_manual', deviceTime: '2026-02-20T05:00:00Z', offline: {} })),
      ['attendance.offline_too_old']);
  });
});

describe('auto-close and corrections', () => {
  let t, ali;
  before(async () => { t = await setup(); ali = await consented(t, 'E003'); });
  after(() => t.close());

  test('forgotten sessions are closed at the configured time and flagged', async () => {
    t.at('2026-03-04 09:00');
    await att.punch(ali, { employeeId: t.emp('E003'), method: 'office_manual', ...LHR });
    t.at('2026-03-04 23:00');
    assert.equal(await att.autoCloseSessions(t.system), 0, 'not yet: auto-close time is 23:30');
    t.at('2026-03-04 23:31');
    assert.equal(await att.autoCloseSessions(t.system), 1);
    const s = await day(t, 'E003', '2026-03-04');
    assert.deepEqual(s.flags, ['missed_checkout']);
    assert.equal(s.lastOut.toISOString(), '2026-03-04T18:30:00.000Z');
    assert.equal(s.workedMinutes, 540, 'counted until shift end (18:00), no overtime from a forgotten session');
    const [n] = await listNotifications(ali);
    assert.equal(n.title, 'Missed check-out on 2026-03-04');
  });

  test('an approved correction replaces the wrong event without editing it', async () => {
    const auto = await t.db.one(`select * from attendance_events where employee_id = $1 and method = 'system_autoclose'`, [t.emp('E003')]);
    t.at('2026-03-05 10:00');
    const { correction, workflow } = await att.requestCorrection(ali, { employeeId: t.emp('E003'), workDate: '2026-03-04', eventType: 'out',
      correctedTime: '2026-03-04T13:10:00Z', targetEventId: auto.id, reason: 'Forgot to check out, left at 18:10' });
    assert.equal(workflow.status, 'pending');
    await decideRequest(await t.as('E002'), 'attendance_correction', correction.id, { decision: 'approved' });

    const s = await day(t, 'E003', '2026-03-04');
    assert.equal(s.lastOut.toISOString(), '2026-03-04T13:10:00.000Z');
    assert.deepEqual(s.flags, ['corrected', 'overtime'], 'missed_checkout is gone; 09:00-18:10 is 10 min over the shift');
    assert.equal(s.workedMinutes, 550);
    const { n } = await t.db.one('select count(*)::int as n from attendance_events where employee_id = $1', [t.emp('E003')]);
    assert.equal(n, 3, 'original in, the auto-close and the correction are all kept');
    await assert.rejects(t.db.query('update attendance_events set punch_time = now()'), /append-only/);
  });

  test('no corrections inside a locked payroll period', async () => {
    await t.db.query(`insert into payroll_runs (tenant_id, period_key, period_start, period_end, status)
                      values ($1, '2026-02', '2026-01-26', '2026-02-25', 'locked')`, [t.tenant.id]);
    const err = await att.requestCorrection(ali, { employeeId: t.emp('E003'), workDate: '2026-02-24', eventType: 'in',
      correctedTime: '2026-02-24T04:00:00Z', reason: 'Card reader down' }).catch((e) => e);
    assert.deepEqual(codes(err.details.reasons), ['attendance.period_locked']);
  });
});
