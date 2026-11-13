/**
 * WFH engine: every behaviour below is switched by publishing a setting —
 * no code changes. "Today" is Wed 2026-03-04 (see helpers.js).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codes } from './helpers.js';
import * as wfh from '../src/services/wfh.js';
import * as settings from '../src/services/settings.js';
import { localize } from '../src/lib/i18n.js';

describe('WFH policy engine', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('max WFH per week 2 -> 3 makes the 3rd request pass (no code change)', async () => {
    const me = await t.as('E012'); // HR Officer: company default "Hybrid 2 days", Mon-Fri
    await wfh.createWfhRequest(me, { employeeId: t.emp('E012'), dates: ['2026-03-09'] });
    await wfh.createWfhRequest(me, { employeeId: t.emp('E012'), dates: ['2026-03-10'] });

    const blocked = await wfh.checkWfh(me, { employeeId: t.emp('E012'), dates: ['2026-03-11'] });
    assert.equal(blocked.ok, false);
    assert.deepEqual(codes(blocked.results[0].reasons), ['wfh.weekly_limit']);
    const [msg] = await localize(t.db, t.tenant.id, 'en', blocked.results[0].reasons);
    assert.equal(msg.message, '2 of 2 WFH days used this week.');

    await t.publishSetting({ key: 'wfh.policy', patch: { maxPerWeek: 3 } });

    const allowed = await wfh.checkWfh(me, { employeeId: t.emp('E012'), dates: ['2026-03-11'] });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.results[0].quota.week.remaining, 0);
    const created = await wfh.createWfhRequest(me, { employeeId: t.emp('E012'), dates: ['2026-03-11'] });
    assert.equal(created.status, 'pending');
  });

  test('message is rendered in Urdu from the translations table', async () => {
    const me = await t.as('E012');
    const r = await wfh.checkWfh(me, { employeeId: t.emp('E012'), dates: ['2026-03-12'] });
    const [msg] = await localize(t.db, t.tenant.id, 'ur', r.results[0].reasons);
    assert.match(msg.message, /3 میں سے 3/);
  });
});

describe('scope priority: employee > role > department > company', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('department override: Engineering gets 3 days/week, Sales only Mon & Fri', async () => {
    const eng = await wfh.checkWfh(t.hr, { employeeId: t.emp('E006'), dates: ['2026-03-09', '2026-03-10', '2026-03-11'] });
    assert.equal(eng.ok, true);
    const sales = await wfh.checkWfh(t.hr, { employeeId: t.emp('E003'), dates: ['2026-03-10'] });
    assert.deepEqual(codes(sales.results[0].reasons), ['wfh.weekday_not_allowed']);
    const [msg] = await localize(t.db, t.tenant.id, 'en', sales.results[0].reasons);
    assert.equal(msg.message, 'WFH is not allowed on Tuesday. Allowed days: Monday, Friday.');
  });

  test('employee-level override beats the department rule', async () => {
    await t.publishSetting({ key: 'wfh.policy', scopeType: 'employee', scopeId: t.emp('E003'), value: { allowedWeekdays: [1, 2, 3, 4, 5] } });
    const r = await wfh.checkWfh(t.hr, { employeeId: t.emp('E003'), dates: ['2026-03-10'] });
    assert.equal(r.ok, true);
    // The rest of Sales is unaffected.
    const ayesha = await wfh.checkWfh(t.hr, { employeeId: t.emp('E004'), dates: ['2026-03-10'] });
    assert.equal(ayesha.ok, false);
  });

  test('role-level rule applies between department and employee', async () => {
    await t.publishSetting({ key: 'wfh.policy', scopeType: 'role', scopeId: t.demo.roles.SALES_EXEC, value: { allowedWeekdays: [3] } });
    const ayesha = await wfh.checkWfh(t.hr, { employeeId: t.emp('E004'), dates: ['2026-03-11'] });
    assert.equal(ayesha.ok, true, 'Sales Executive role allows Wednesday');
    const bilal = await wfh.checkWfh(t.hr, { employeeId: t.emp('E002'), dates: ['2026-03-11'] });
    assert.equal(bilal.ok, false, 'Sales Manager still follows the department rule');
  });

  test('nested fields merge: an override can change one eligibility flag only', async () => {
    const before = await wfh.checkWfh(t.hr, { employeeId: t.emp('E007'), dates: ['2026-03-09'] });
    assert.deepEqual(codes(before.results[0].reasons), ['wfh.probation']);
    await t.publishSetting({ key: 'wfh.policy', scopeType: 'employee', scopeId: t.emp('E007'), value: { eligibility: { blockDuringProbation: false } } });
    const r = await settings.resolveFor(t.hr, { key: 'wfh.policy', employeeId: t.emp('E007') });
    assert.equal(r.value.eligibility.blockDuringProbation, false);
    assert.equal(r.value.eligibility.minServiceMonths, 0, 'sibling field inherited from company');
    assert.equal(r.value.maxPerWeek, 3, 'department override still applies');
    assert.deepEqual(r.sources.map((s) => s.scopeType), ['company', 'department', 'employee']);
    const after = await wfh.checkWfh(t.hr, { employeeId: t.emp('E007'), dates: ['2026-03-09'] });
    assert.equal(after.ok, true);
  });
});

describe('effective dating, drafts and other rules', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('a draft never changes behaviour until published', async () => {
    const current = (await settings.list(t.hr, { key: 'wfh.policy' })).find((s) => s.scope_type === 'company');
    const draft = await settings.createDraft(t.hr, { key: 'wfh.policy', value: { ...current.current.value, enabled: false } });
    const r = await wfh.checkWfh(t.hr, { employeeId: t.emp('E010'), dates: ['2026-03-09'] });
    assert.equal(r.ok, true);
    await settings.discardDraft(t.hr, draft.id);
  });

  test('future-dated rule applies only from its effective date', async () => {
    await t.publishSetting({ key: 'wfh.policy', patch: { maxPerWeek: 1 }, effectiveFrom: '2026-04-01' });
    const march = await wfh.checkWfh(t.hr, { employeeId: t.emp('E010'), dates: ['2026-03-16', '2026-03-17'] });
    assert.equal(march.ok, true, 'March still uses 2 per week');
    const april = await wfh.checkWfh(t.hr, { employeeId: t.emp('E010'), dates: ['2026-04-06', '2026-04-07'] });
    assert.deepEqual(codes(april.results[1].reasons), ['wfh.weekly_limit']);
  });

  test('minimum notice, weekends and holidays', async () => {
    const r = await wfh.checkWfh(t.hr, { employeeId: t.emp('E010'), dates: ['2026-03-04', '2026-03-07', '2026-03-23'] });
    assert.deepEqual(r.results.map((x) => codes(x.reasons)), [['wfh.min_notice'], ['wfh.weekend', 'wfh.weekday_not_allowed'], ['wfh.holiday']]);
  });

  test('blackout date explains the reason', async () => {
    await t.publishSetting({ key: 'wfh.policy', patch: { blackoutDates: [{ date: '2026-03-13', reason: 'Quarter close' }] } });
    const r = await wfh.checkWfh(t.hr, { employeeId: t.emp('E010'), dates: ['2026-03-13'] });
    const [msg] = await localize(t.db, t.tenant.id, 'en', r.results[0].reasons);
    assert.equal(msg.message, '2026-03-13 is a WFH blackout date: Quarter close.');
  });

  test('monthly limit', async () => {
    await t.publishSetting({ key: 'wfh.policy', patch: { maxPerMonth: 3, blackoutDates: [] } });
    const r = await wfh.checkWfh(t.hr, { employeeId: t.emp('E009'), dates: ['2026-03-09', '2026-03-10', '2026-03-16', '2026-03-17'] });
    assert.deepEqual(r.results.map((x) => x.allowed), [true, true, true, false]);
    assert.ok(codes(r.results[3].reasons).includes('wfh.monthly_limit'));
  });

  test('temporary override bypasses limits and does not consume quota', async () => {
    const me = await t.as('E004');
    await wfh.createOverride(t.hr, { employeeId: t.emp('E004'), startDate: '2026-03-09', endDate: '2026-03-20', reason: 'Medical: knee surgery recovery' });
    const r = await wfh.createWfhRequest(me, { employeeId: t.emp('E004'), dates: ['2026-03-10', '2026-03-11', '2026-03-12'] });
    assert.equal(r.status, 'approved');
    assert.equal(r.autoApproved, true);
    const quota = await wfh.getWfhQuota(t.hr, t.emp('E004'), { date: '2026-03-10' });
    assert.equal(quota.week.used, 0);
  });

  test('auto-approve within limits is a setting', async () => {
    const current = (await settings.list(t.hr, { key: 'wfh.policy' })).find((s) => s.scope_type === 'company').current.value;
    await t.publishSetting({ key: 'wfh.policy', value: { ...current, requests: { ...current.requests, approval: 'auto_within_limits' } } });
    const me = await t.as('E012');
    const r = await wfh.createWfhRequest(me, { employeeId: t.emp('E012'), dates: ['2026-03-09'] });
    assert.equal(r.status, 'approved');
  });

  test('recurring weekly pattern expands into dates and is checked per date', async () => {
    const r = await wfh.checkWfh(t.hr, { employeeId: t.emp('E006'), recurrence: { startDate: '2026-03-09', endDate: '2026-03-27', weekdays: [1, 3] } });
    assert.deepEqual(r.results.map((x) => x.date), ['2026-03-09', '2026-03-11', '2026-03-16', '2026-03-18', '2026-03-23', '2026-03-25']);
    assert.deepEqual(codes(r.results.find((x) => x.date === '2026-03-23').reasons), ['wfh.holiday']);
    assert.equal(r.results.filter((x) => x.allowed).length, 5);
  });

  test('disabling the module blocks WFH entirely', async () => {
    const { setFlag } = await import('../src/services/features.js');
    await setFlag(t.hr, 'wfh', { enabled: false });
    await assert.rejects(wfh.checkWfh(t.hr, { employeeId: t.emp('E006'), dates: ['2026-03-09'] }), { code: 'module_disabled' });
    await setFlag(t.hr, 'wfh', { enabled: true });
  });
});
