/**
 * Draft > Preview: simulate a change before publishing (nothing is saved).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import * as settings from '../src/services/settings.js';
import { resolve } from '../src/config/resolver.js';

describe('preview / simulation', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('WFH 2 -> 3 per week: affected employees, shadowed overrides, per-person numbers', async () => {
    const company = (await settings.list(t.hr, { key: 'wfh.policy' })).find((s) => s.scope_type === 'company');
    const draft = await settings.createDraft(t.hr, { key: 'wfh.policy', value: { ...company.current.value, maxPerWeek: 3 } });
    const p = await settings.preview(t.hr, draft.id);

    assert.equal(p.inScopeCount, 12);
    assert.equal(p.affectedCount, 7, 'Engineering (5) already has its own 3-day override');
    assert.equal(p.shadowedCount, 5);
    assert.equal(p.summary[0], 'This change affects 7 employees from 2026-03-04.');
    assert.match(p.summary[2], /^With this policy, Ali Raza \(Sales\) can work from home on Mon, Fri, up to 3 per week/);

    const ali = p.employees.find((e) => e.name === 'Ali Raza');
    assert.deepEqual(ali.changes, [{ path: 'maxPerWeek', change: 'changed', old: 2, new: 3 }]);
    assert.deepEqual(ali.metrics.find((m) => m.key === 'wfhWeekRemaining'), { key: 'wfhWeekRemaining', label: 'WFH days left this week', old: 2, new: 3 });
    assert.ok(!p.employees.some((e) => e.department === 'Engineering'));

    // Nothing was saved.
    const r = await resolve(t.db, { tenantId: t.tenant.id, key: 'wfh.policy', date: '2026-03-04' });
    assert.equal(r.value.maxPerWeek, 2);
  });

  test('leave entitlement 20 -> 24 preview shows entitlement and available before/after', async () => {
    const subjectId = t.demo.leaveTypes.ANNUAL;
    const company = (await settings.list(t.hr, { key: 'leave.type', subjectId })).find((s) => s.scope_type === 'company');
    const draft = await settings.createDraft(t.hr, { key: 'leave.type', subjectId, value: { ...company.current.value, entitlementDays: 24 } });
    const p = await settings.preview(t.hr, draft.id);
    assert.equal(p.affectedCount, 12);
    const ali = p.employees.find((e) => e.name === 'Ali Raza');
    assert.deepEqual(ali.metrics.map((m) => [m.key, m.old, m.new]), [['entitlement', 20, 24], ['available', 20, 24]]);
    const hamza = p.employees.find((e) => e.name === 'Hamza Malik');
    assert.deepEqual(hamza.metrics[0].old, 18);
    assert.deepEqual(hamza.metrics[0].new, 22);
  });

  test('a department override preview only touches that department', async () => {
    const draft = await settings.createDraft(t.hr, { key: 'wfh.policy', scopeType: 'department', scopeId: t.demo.departments.FIN, value: { maxPerWeek: 1 } });
    const p = await settings.preview(t.hr, draft.id, { effectiveFrom: '2026-03-09' });
    assert.deepEqual(p.employees.map((e) => e.name).sort(), ['Hira Javed', 'Omar Farooq']);
    assert.equal(p.effectiveFrom, '2026-03-09');
  });
});
