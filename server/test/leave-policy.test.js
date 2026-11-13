/**
 * Leave engine + ledger. Every behaviour is driven by published
 * 'leave.type' settings. "Today" starts at Wed 2026-03-04.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codes } from './helpers.js';
import * as leave from '../src/services/leave.js';
import * as settings from '../src/services/settings.js';
import { createLookup } from '../src/services/lookups.js';

const balanceOf = async (t, ctx, code, typeCode) =>
  (await leave.getBalances(ctx, t.emp(code))).find((b) => b.leaveType.code === typeCode);
const typeRule = async (t, typeCode) =>
  (await settings.list(t.hr, { key: 'leave.type', subjectId: t.demo.leaveTypes[typeCode] })).find((s) => s.scope_type === 'company').current.value;
const publishRule = async (t, typeCode, patch, effectiveFrom) =>
  t.publishSetting({ key: 'leave.type', subjectId: t.demo.leaveTypes[typeCode], value: { ...(await typeRule(t, typeCode)), ...patch }, effectiveFrom });

describe('entitlement is a setting', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('annual leave 20 -> 24 updates balances, explained by the ledger', async () => {
    const before = await balanceOf(t, t.hr, 'E003', 'ANNUAL');
    assert.equal(before.entitled, 20);
    assert.equal(before.available, 20);

    await publishRule(t, 'ANNUAL', { entitlementDays: 24 });

    const after = await balanceOf(t, t.hr, 'E003', 'ANNUAL');
    assert.equal(after.entitled, 24);
    assert.equal(after.available, 24);
    const ledger = await leave.getLedger(t.hr, t.emp('E003'), t.demo.leaveTypes.ANNUAL);
    assert.deepEqual(ledger.map((l) => [l.kind, l.days]), [['grant', 20], ['policy_adjustment', 4]]);
    assert.match(ledger[1].note, /Entitlement changed from 20 to 24 days \(standard; rule company v2\)/);
  });

  test('new joiners are pro-rated (Hamza joined 2 Feb)', async () => {
    const b = await balanceOf(t, t.hr, 'E007', 'ANNUAL');
    assert.equal(b.entitled, 22); // 24 x 333/365 = 21.9, rounded to the 0.5 step
  });

  test('employees see their own balance only', async () => {
    const ali = await t.as('E003');
    await assert.rejects(leave.getBalances(ali, t.emp('E004')), { code: 'forbidden' });
    assert.ok((await leave.getBalances(ali, t.emp('E003'))).length > 0);
  });
});

describe('probation quota and tenure', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('probation quota applies until probation ends, then the full quota', async () => {
    assert.equal((await balanceOf(t, t.hr, 'E007', 'ANNUAL')).entitled, 18);
    await publishRule(t, 'ANNUAL', { probationEntitlementDays: 6 });
    assert.equal((await balanceOf(t, t.hr, 'E007', 'ANNUAL')).entitled, 5.5); // 6 x 333/365, pro-rated
    t.clock.set('2026-08-03T05:00:00Z'); // probation ended 31 July
    const b = await balanceOf(t, t.hr, 'E007', 'ANNUAL');
    assert.equal(b.entitled, 18);
    const ledger = await leave.getLedger(t.hr, t.emp('E007'), t.demo.leaveTypes.ANNUAL);
    assert.deepEqual(ledger.map((l) => l.days), [18, -12.5, 12.5]);
  });

  test('tenure bands raise the quota for long-serving staff', async () => {
    await publishRule(t, 'ANNUAL', { tenureBands: [{ minMonths: 96, entitlementDays: 25 }] });
    assert.equal((await balanceOf(t, t.hr, 'E005', 'ANNUAL')).entitled, 25, 'Usman joined 2017');
    assert.equal((await balanceOf(t, t.hr, 'E003', 'ANNUAL')).entitled, 20, 'Ali joined 2022');
  });
});

describe('counting days', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('weekends and public holidays are skipped unless the leave type counts them', async () => {
    const fatima = { employeeId: t.emp('E006'), leaveTypeId: t.demo.leaveTypes.ANNUAL };
    const r1 = await leave.checkLeave(t.hr, { ...fatima, startDate: '2026-03-13', endDate: '2026-03-16' });
    assert.equal(r1.days, 2);
    const r2 = await leave.checkLeave(t.hr, { ...fatima, startDate: '2026-03-19', endDate: '2026-03-24' });
    assert.equal(r2.days, 2, 'Thu + Tue; Eid, weekend and Pakistan Day skipped');
    assert.deepEqual(r2.dates.filter((d) => !d.counted).map((d) => d.why), ['holiday', 'holiday', 'holiday', 'holiday']);

    await publishRule(t, 'ANNUAL', { countWeekends: true });
    const r3 = await leave.checkLeave(t.hr, { ...fatima, startDate: '2026-03-13', endDate: '2026-03-16' });
    assert.equal(r3.days, 4);
  });

  test('half-day permission is a setting', async () => {
    const req = { employeeId: t.emp('E004'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-10', unit: 'half_day' };
    const ok = await leave.checkLeave(t.hr, req);
    assert.equal(ok.allowed, true);
    assert.equal(ok.days, 0.5);
    await publishRule(t, 'CASUAL', { allowHalfDay: false });
    const blocked = await leave.checkLeave(t.hr, req);
    assert.deepEqual(codes(blocked.reasons), ['leave.half_day_not_allowed']);
  });

  test('notice, backdating, max consecutive days and overlap', async () => {
    const ali = { employeeId: t.emp('E003') };
    assert.deepEqual(codes((await leave.checkLeave(t.hr, { ...ali, leaveTypeId: t.demo.leaveTypes.ANNUAL, startDate: '2026-03-05' })).reasons), ['leave.min_notice']);
    assert.deepEqual(codes((await leave.checkLeave(t.hr, { ...ali, leaveTypeId: t.demo.leaveTypes.SICK, startDate: '2026-02-20' })).reasons), ['leave.backdated_limit']);
    assert.equal((await leave.checkLeave(t.hr, { ...ali, leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-02' })).allowed, true);
    assert.deepEqual(codes((await leave.checkLeave(t.hr, { ...ali, leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-09', endDate: '2026-03-12' })).reasons), ['leave.max_consecutive']);
    await leave.createLeaveRequest(await t.as('E003'), { ...ali, leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-09' });
    assert.deepEqual(codes((await leave.checkLeave(t.hr, { ...ali, leaveTypeId: t.demo.leaveTypes.SICK, startDate: '2026-03-09' })).reasons), ['leave.overlap']);
  });

  test('unpaid leave has no balance and is fully unpaid', async () => {
    const r = await leave.checkLeave(t.hr, { employeeId: t.emp('E010'), leaveTypeId: t.demo.leaveTypes.UNPAID, startDate: '2026-03-16', endDate: '2026-03-18' });
    assert.equal(r.allowed, true);
    assert.deepEqual([r.paidDays, r.unpaidDays, r.balance], [0, 3, null]);
  });
});

describe('insufficient balance and approvals', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('excess is converted to unpaid or rejected, as HR configures', async () => {
    const req = { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.SICK, startDate: '2026-03-09', endDate: '2026-03-20' };
    assert.deepEqual(codes((await leave.checkLeave(t.hr, req)).reasons), ['leave.certificate_required']);
    const converted = await leave.checkLeave(t.hr, { ...req, attachmentRef: 'files/cert.pdf' });
    assert.equal(converted.allowed, true);
    assert.deepEqual([converted.days, converted.paidDays, converted.unpaidDays], [9, 8, 1]);
    assert.deepEqual(codes(converted.warnings), ['leave.converted_to_unpaid']);

    await publishRule(t, 'SICK', { insufficientBalance: 'reject' });
    const rejected = await leave.checkLeave(t.hr, { ...req, attachmentRef: 'files/cert.pdf' });
    assert.deepEqual(codes(rejected.reasons), ['leave.insufficient_balance']);
    assert.deepEqual(rejected.reasons[0].params, { requested: 9, available: 8 });
  });

  test('pending leave reduces "available"; approval posts usage to the ledger', async () => {
    const ayesha = await t.as('E004');
    const { request } = await leave.createLeaveRequest(ayesha, { employeeId: t.emp('E004'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-09', endDate: '2026-03-10', reason: 'Wedding' });
    let b = await balanceOf(t, t.hr, 'E004', 'CASUAL');
    assert.deepEqual([b.balance, b.pending, b.available], [10, 2, 8]);

    await assert.rejects(leave.decideLeave(await t.as('E003'), request.id, { decision: 'approved' }), { code: 'forbidden' });
    await assert.rejects(leave.decideLeave(await t.as('E005'), request.id, { decision: 'approved' }), { code: 'forbidden' }, 'other team manager');
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved', comment: 'Enjoy!' });

    b = await balanceOf(t, t.hr, 'E004', 'CASUAL');
    assert.deepEqual([b.balance, b.pending, b.available, b.used], [8, 0, 8, 2]);
    const usage = (await leave.getLedger(t.hr, t.emp('E004'), t.demo.leaveTypes.CASUAL)).find((l) => l.kind === 'usage');
    assert.equal(usage.ref_id, request.id);
    assert.equal(usage.days, -2);
    await assert.rejects(t.db.query('update leave_ledger set days = 0'), /append-only/);
  });
});

describe('accrual uses the rule in force each month', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('HR adds a new accrual leave type, then changes the monthly rate', async () => {
    const study = await createLookup(t.hr, 'leave-types', { code: 'STUDY', name: 'Study Leave' });
    const base = await typeRule(t, 'ANNUAL');
    await t.publishSetting({ key: 'leave.type', subjectId: study.id,
      value: { ...base, entitlementDays: 18, accrual: { enabled: true, daysPerMonth: 1.5, postOn: 'month_start' }, carryForward: { maxDays: 0, expiryMonths: null } } });

    t.clock.set('2026-06-15T05:00:00Z');
    let b = (await leave.getBalances(t.hr, t.emp('E006'))).find((x) => x.leaveType.code === 'STUDY');
    assert.equal(b.accrued, 4.5, 'Apr, May, Jun (the rule did not exist before March 4)');

    const rule = (await settings.list(t.hr, { key: 'leave.type', subjectId: study.id }))[0].current.value;
    await t.publishSetting({ key: 'leave.type', subjectId: study.id, value: { ...rule, accrual: { ...rule.accrual, daysPerMonth: 2 } }, effectiveFrom: '2026-07-01' });
    t.clock.set('2026-09-02T05:00:00Z');
    b = (await leave.getBalances(t.hr, t.emp('E006'))).find((x) => x.leaveType.code === 'STUDY');
    assert.equal(b.accrued, 10.5, '3 x 1.5 + 3 x 2');
    const ledger = await leave.getLedger(t.hr, t.emp('E006'), study.id);
    assert.deepEqual(ledger.map((l) => l.period_key), ['A-2026-04', 'A-2026-05', 'A-2026-06', 'A-2026-07', 'A-2026-08', 'A-2026-09']);
  });
});

describe('year end: carry forward, lapse, expiry, frozen history', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('unused days carry forward up to the limit; the rest lapse', async () => {
    assert.equal((await balanceOf(t, t.hr, 'E003', 'ANNUAL')).available, 20);
    t.clock.set('2027-01-11T05:00:00Z');
    const b = await balanceOf(t, t.hr, 'E003', 'ANNUAL');
    assert.deepEqual([b.year.year, b.entitled, b.carriedForward, b.balance], [2027, 20, 10, 30]);
    const old = await leave.getLedger(t.hr, t.emp('E003'), t.demo.leaveTypes.ANNUAL, { year: 2026 });
    assert.deepEqual(old.map((l) => [l.kind, l.days]), [['grant', 20], ['lapse', -10]]);
  });

  test('carried days not used within 3 months expire (usage consumes them first)', async () => {
    const ali = await t.as('E003');
    const { request } = await leave.createLeaveRequest(ali, { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.ANNUAL, startDate: '2027-02-01', endDate: '2027-02-02' });
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });
    t.clock.set('2027-04-05T05:00:00Z');
    const b = await balanceOf(t, t.hr, 'E003', 'ANNUAL');
    assert.equal(b.balance, 20); // 20 + 10 carried - 2 used - 8 expired
    const expiry = (await leave.getLedger(t.hr, t.emp('E003'), t.demo.leaveTypes.ANNUAL)).find((l) => l.kind === 'expiry');
    assert.equal(expiry.days, -8);
  });

  test('a policy change never rewrites a past leave year', async () => {
    await publishRule(t, 'ANNUAL', { entitlementDays: 30 });
    const b = await balanceOf(t, t.hr, 'E003', 'ANNUAL');
    assert.equal(b.entitled, 30);
    const old = await leave.getLedger(t.hr, t.emp('E003'), t.demo.leaveTypes.ANNUAL, { year: 2026 });
    assert.deepEqual(old.map((l) => l.kind), ['grant', 'lapse'], '2026 untouched');
  });
});
