/**
 * Configuration store: draft / validate / publish / history / diff /
 * restore, guardrails, audit log and cache invalidation.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import * as settings from '../src/services/settings.js';
import { resolve } from '../src/config/resolver.js';
import { createLookup, deleteLookup, updateLookup } from '../src/services/lookups.js';

const companyWfh = async (t) => (await settings.list(t.hr, { key: 'wfh.policy' })).find((s) => s.scope_type === 'company');

describe('configuration store', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('only HR can change settings', async () => {
    const ali = await t.as('E003');
    await assert.rejects(settings.createDraft(ali, { key: 'wfh.policy', value: {} }), { code: 'forbidden' });
    const bilal = await t.as('E002');
    await assert.rejects(settings.list(bilal, {}), { code: 'forbidden' });
  });

  test('validation gives plain-language errors and blocks publishing', async () => {
    const s = await companyWfh(t);
    const draft = await settings.createDraft(t.hr, { key: 'wfh.policy', value: { ...s.current.value, maxPerWeek: 9, maxPerWek: 2 } });
    const v = await settings.validate(t.hr, draft.id);
    assert.equal(v.ok, false);
    assert.deepEqual(v.errors.map((e) => e.message).sort(), [
      '"maxPerWek" is not a known setting here.',
      'Max WFH days per week must be a whole number between 0 and 7.',
    ]);
    await assert.rejects(settings.publish(t.hr, draft.id), (err) => err.code === 'validation_failed' && err.details.errors.length === 2);
    await settings.discardDraft(t.hr, draft.id);
  });

  test('conflicting values produce warnings', async () => {
    const s = await companyWfh(t);
    const draft = await settings.createDraft(t.hr, { key: 'wfh.policy', value: { ...s.current.value, maxPerWeek: 4, maxPerMonth: 3, allowedWeekdays: [1, 5] } });
    const v = await settings.validate(t.hr, draft.id);
    assert.equal(v.ok, true);
    assert.equal(v.warnings.length, 2);
    assert.match(v.warnings.map((w) => w.message).join(' '), /monthly limit \(3\) is lower than the weekly limit \(4\)/);
    await settings.discardDraft(t.hr, draft.id);
  });

  test('overrides are validated after merging with the inherited rule', async () => {
    const draft = await settings.createDraft(t.hr, { key: 'wfh.policy', scopeType: 'department', scopeId: t.demo.departments.FIN, value: { maxPerWeek: 'two' } });
    const v = await settings.validate(t.hr, draft.id);
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /Max WFH days per week must be a whole number/);
    await settings.discardDraft(t.hr, draft.id);
  });

  test('one draft at a time per setting', async () => {
    const s = await companyWfh(t);
    const d = await settings.createDraft(t.hr, { key: 'wfh.policy', value: s.current.value });
    await assert.rejects(settings.createDraft(t.hr, { key: 'wfh.policy', value: s.current.value }), { code: 'draft_exists' });
    await settings.discardDraft(t.hr, d.id);
  });

  test('cannot publish with an effective date in the past', async () => {
    const s = await companyWfh(t);
    const d = await settings.createDraft(t.hr, { key: 'wfh.policy', value: s.current.value });
    await assert.rejects(settings.publish(t.hr, d.id, { effectiveFrom: '2026-03-01' }), { code: 'effective_date_in_past' });
    await settings.discardDraft(t.hr, d.id);
  });

  test('cannot publish into an approved/locked payroll period', async () => {
    // 'approved' guards exactly like 'locked', and (unlike locked) can be cleaned up afterwards.
    await t.db.query(`insert into payroll_runs (tenant_id, period_key, period_start, period_end, status)
                      values ($1, '2026-03', '2026-02-26', '2026-03-25', 'approved')`, [t.tenant.id]);
    const s = await companyWfh(t);
    const d = await settings.createDraft(t.hr, { key: 'wfh.policy', value: s.current.value });
    await assert.rejects(settings.publish(t.hr, d.id, { effectiveFrom: '2026-03-10' }), { code: 'payroll_locked' });
    const ok = await settings.publish(t.hr, d.id, { effectiveFrom: '2026-03-26' });
    assert.equal(ok.version.status, 'published');
    await t.db.query(`delete from payroll_runs where tenant_id = $1`, [t.tenant.id]);
  });
});

describe('versioning, history, diff and rollback', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('publishing closes the previous version and keeps history', async () => {
    const s = await companyWfh(t);
    const v1 = s.current;
    const { version: v2, previousVersionId } = await t.publishSetting({ key: 'wfh.policy', patch: { maxPerWeek: 3 } });
    assert.equal(previousVersionId, v1.id);
    const hist = await settings.history(t.hr, s.id);
    assert.deepEqual(hist.map((h) => [h.version, h.status, h.effective_from, h.effective_to]), [
      [2, 'published', '2026-03-04', null],
      [1, 'published', '2026-01-01', '2026-03-03'],
    ]);
    // History is still resolvable: a February date uses v1.
    const feb = await resolve(t.db, { tenantId: t.tenant.id, key: 'wfh.policy', date: '2026-02-10' });
    assert.equal(feb.value.maxPerWeek, 2);
    assert.equal(feb.versionIds[0], v1.id);
    assert.equal(v2.version, 2);
  });

  test('diff shows old vs new', async () => {
    const s = await companyWfh(t);
    const hist = await settings.history(t.hr, s.id);
    const d = await settings.diff(t.hr, hist[1].id, hist[0].id);
    assert.deepEqual(d.changes, [{ path: 'maxPerWeek', change: 'changed', old: 2, new: 3 }]);
    assert.equal(d.from.version, 1);
    assert.equal(d.to.version, 2);
  });

  test('restore v1 as a new draft, publish = rollback (history is never rewritten)', async () => {
    const s = await companyWfh(t);
    const v1 = (await settings.history(t.hr, s.id)).find((h) => h.version === 1);
    const draft = await settings.restoreAsDraft(t.hr, v1.id);
    assert.equal(draft.version, 3);
    assert.equal(draft.based_on_version_id, v1.id);
    await settings.publish(t.hr, draft.id, { effectiveFrom: '2026-03-10' });
    const r = await resolve(t.db, { tenantId: t.tenant.id, key: 'wfh.policy', date: '2026-03-10' });
    assert.equal(r.value.maxPerWeek, 2);
    const between = await resolve(t.db, { tenantId: t.tenant.id, key: 'wfh.policy', date: '2026-03-05' });
    assert.equal(between.value.maxPerWeek, 3, 'v2 still applies until the rollback date');
    assert.equal((await settings.history(t.hr, s.id)).length, 3);
  });

  test('a later publish with an earlier date supersedes a future version', async () => {
    const s = await companyWfh(t);
    const { supersededVersionIds } = await t.publishSetting({ key: 'wfh.policy', patch: { maxPerWeek: 4 }, effectiveFrom: '2026-03-06' });
    assert.equal(supersededVersionIds.length, 1, 'the 2026-03-10 rollback version is archived');
    const hist = await settings.history(t.hr, s.id);
    assert.equal(hist.find((h) => h.version === 3).status, 'archived');
  });

  test('every change is in the audit log with old and new values', async () => {
    const { rows } = await t.db.query(
      `select action, old_value, new_value, actor_user_id from audit_log where tenant_id = $1 and action = 'setting.published'
        and (meta->>'bootstrap') is null order by id`, [t.tenant.id]);
    assert.ok(rows.length >= 3);
    assert.equal(rows[0].old_value.maxPerWeek, 2);
    assert.equal(rows[0].new_value.maxPerWeek, 3);
    assert.equal(rows[0].actor_user_id, t.hr.actor.userId);
    await assert.rejects(t.db.query('delete from audit_log'), /append-only/);
  });

  test('cache is invalidated the moment a version is published', async () => {
    const args = { tenantId: t.tenant.id, key: 'wfh.policy', date: '2026-03-20' };
    const before = await resolve(t.db, args); // warms the cache
    await t.publishSetting({ key: 'wfh.policy', patch: { maxPerWeek: before.value.maxPerWeek + 1 }, effectiveFrom: '2026-03-20' });
    const after = await resolve(t.db, args);
    assert.equal(after.value.maxPerWeek, before.value.maxPerWeek + 1);
  });

  test('retiring a department override falls back to the company rule', async () => {
    const dept = (await settings.list(t.hr, { key: 'wfh.policy' })).find((s) => s.scope_type === 'department' && s.scope_id === t.demo.departments.SALES);
    const ali = await t.db.one('select * from employees where id = $1', [t.emp('E003')]);
    const args = { tenantId: t.tenant.id, key: 'wfh.policy', employee: ali };
    assert.deepEqual((await resolve(t.db, { ...args, date: '2026-03-05' })).value.allowedWeekdays, [1, 5]);
    await settings.retire(t.hr, dept.id, { effectiveFrom: '2026-03-05' });
    assert.deepEqual((await resolve(t.db, { ...args, date: '2026-03-05' })).value.allowedWeekdays, [1, 2, 3, 4, 5]);
    assert.deepEqual((await resolve(t.db, { ...args, date: '2026-03-04' })).value.allowedWeekdays, [1, 5], 'today is untouched');
  });
});

describe('dynamic lookups guardrails', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('HR can add, rename and delete an unused leave type', async () => {
    const lt = await createLookup(t.hr, 'leave-types', { code: 'STUDY', name: 'Study Leave' });
    const renamed = await updateLookup(t.hr, 'leave-types', lt.id, { name: 'Exam Leave' });
    assert.equal(renamed.name, 'Exam Leave');
    await deleteLookup(t.hr, 'leave-types', lt.id);
  });

  test('anything used by records or settings cannot be deleted, only disabled', async () => {
    await assert.rejects(deleteLookup(t.hr, 'departments', t.demo.departments.SALES), { code: 'in_use' });
    await assert.rejects(deleteLookup(t.hr, 'leave-types', t.demo.leaveTypes.ANNUAL), { code: 'in_use' });
    const disabled = await updateLookup(t.hr, 'leave-types', t.demo.leaveTypes.BEREAVEMENT, { is_active: false });
    assert.equal(disabled.is_active, false);
  });

  test('leave type codes are immutable once created; duplicate codes are rejected', async () => {
    await assert.rejects(updateLookup(t.hr, 'leave-types', t.demo.leaveTypes.ANNUAL, { code: 'AL' }), { code: 'code_immutable' });
    await assert.rejects(createLookup(t.hr, 'departments', { code: 'SALES', name: 'Sales 2' }), { code: 'duplicate' });
  });
});
