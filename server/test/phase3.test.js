/**
 * Phase 3 backend: dashboards, CSV reports, settings export/import,
 * employee logins, and the form descriptions the settings panel renders.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { seedDemo } from '../seed/demo.js';
import * as att from '../src/services/attendance.js';
import { attendanceCsv, employeeDashboard, hrDashboard, managerDashboard } from '../src/services/dashboard.js';
import { exportSettings, importSettings } from '../src/services/configTransfer.js';
import { createEmployee, updateEmployee } from '../src/services/employees.js';
import { recordConsent } from '../src/services/privacy.js';
import * as settings from '../src/services/settings.js';
import * as leave from '../src/services/leave.js';

const LHR = { lat: 31.5205, lng: 74.3588 };

describe('dashboards and reports', () => {
  let t;
  before(async () => {
    t = await setup();
    // Ali works a normal day, Fatima arrives late, Ayesha is on approved leave.
    for (const [code, inAt, outAt] of [['E003', '2026-03-04 08:58', '2026-03-04 18:01'], ['E006', '2026-03-04 09:40', null]]) {
      const ctx = await t.as(code);
      await recordConsent(ctx, { kind: 'location', granted: true });
      t.at(inAt);
      await att.punch(ctx, { employeeId: t.emp(code), method: 'office_manual', ...LHR });
      if (outAt) { t.at(outAt); await att.punch(ctx, { employeeId: t.emp(code), method: 'office_manual' }); }
    }
    t.at('2026-03-02 10:00');
    const { request } = await leave.createLeaveRequest(await t.as('E004'), { employeeId: t.emp('E004'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-04' });
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });
    t.at('2026-03-04 19:00');
  });
  after(() => t.close());

  test('employee dashboard: today, month calendar, quota, balances', async () => {
    const d = await employeeDashboard(await t.as('E003'));
    assert.equal(d.today.summary.status, 'present');
    assert.equal(d.month.days.length, 31);
    assert.equal(d.month.totals.present, 1);
    assert.equal(d.wfhQuota.week.max, 2);
    assert.ok(d.balances.find((b) => b.leaveType.code === 'ANNUAL'));
    await assert.rejects(employeeDashboard(await t.as('E003'), t.emp('E004')), { code: 'forbidden' });
  });

  test('manager dashboard: team status today and pending approvals', async () => {
    await leave.createLeaveRequest(await t.as('E003'), { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.ANNUAL, startDate: '2026-03-16' });
    const d = await managerDashboard(await t.as('E002'));
    assert.deepEqual(d.team.people.map((p) => [p.name, p.status]), [['Ali Raza', 'present'], ['Ayesha Siddiqui', 'on_leave']]);
    assert.equal(d.approvals.length, 1);
    assert.equal(d.calendar.employees.length, 3);
  });

  test('HR dashboard: headcount, today counts, departments, alerts', async () => {
    const d = await hrDashboard(t.hr);
    assert.equal(d.headcount, 12);
    assert.equal(d.today.counts.present, 2);
    assert.equal(d.today.counts.on_leave, 1);
    assert.equal(d.today.counts.late, 1);
    assert.equal(d.today.counts.absent, 9);
    const eng = d.departments.find((x) => x.department === 'Engineering');
    assert.equal(eng.headcount, 5);
    assert.equal(eng.late, 1);
    assert.equal(d.departments.find((x) => x.department === 'Sales').leaveDays['Casual Leave'], 1);
    assert.equal(d.pendingApprovals.leave, 1);
    await assert.rejects(hrDashboard(await t.as('E002')), { code: 'forbidden' });
  });

  test('CSV export: daily rows and monthly summary, scoped to the caller', async () => {
    const daily = await attendanceCsv(t.hr, { month: '2026-03' });
    const lines = daily.trim().split('\r\n');
    assert.equal(lines[0], 'Code,Name,Department,Date,Status,First in,Last out,Hours,Late (min),Overtime (min),Leave,Flags');
    assert.equal(lines.length, 1 + 12 * 31);
    assert.ok(lines.includes('E003,Ali Raza,Sales,2026-03-04,present,08:58,18:01,9.05,0,3,,overtime'));
    const summary = await attendanceCsv(await t.as('E002'), { month: '2026-03', detail: 'summary' });
    assert.equal(summary.trim().split('\r\n').length, 1 + 3, 'a manager sees their team + self');
  });
});

describe('settings export / import', () => {
  let t, globexHr;
  before(async () => {
    t = await setup();
    const globex = await seedDemo(t.db, { rounds: 4, slug: 'globex' });
    const tenant = await t.db.one('select * from tenants where id = $1', [globex.tenant.id]);
    const u = await t.db.one(`select u.id, e.id as employee_id from users u join employees e on e.user_id = u.id where u.email = 'hr+globex@acme.test'`);
    globexHr = { db: t.db, tenant, clock: t.clock, locale: 'en', actor: { userId: u.id, accessLevel: 'hr_admin', employeeId: u.employee_id, tenantId: tenant.id } };
  });
  after(() => t.close());

  test('export uses codes, not ids, so it is portable', async () => {
    await t.publishSetting({ key: 'wfh.policy', scopeType: 'role', scopeId: t.demo.roles.QA, value: { maxPerWeek: 4, eligibility: { allowedRoleIds: [t.demo.roles.QA, t.demo.roles.SWE] } } });
    const data = await exportSettings(t.hr);
    assert.equal(data.format, 'hrm-settings/1');
    const qa = data.settings.find((s) => s.key === 'wfh.policy' && s.scope.type === 'role');
    assert.deepEqual(qa.scope, { type: 'role', code: 'QA' });
    assert.deepEqual(qa.value.eligibility.allowedRoleIds, ['QA', 'SWE']);
    assert.ok(data.settings.find((s) => s.key === 'leave.type' && s.subject === 'ANNUAL'));
    assert.ok(data.lookups.holidays.length >= 14);
  });

  test('dry run reports changes and writes nothing; apply creates drafts only', async () => {
    await t.publishSetting({ key: 'leave.type', subjectId: t.demo.leaveTypes.ANNUAL,
      value: { ...(await settings.resolveFor(t.hr, { key: 'leave.type', subjectId: t.demo.leaveTypes.ANNUAL })).value, entitlementDays: 25 } });
    const data = await exportSettings(t.hr);
    data.lookups.departments.push({ code: 'OPS', name: 'Operations', is_active: true, sort_order: 9 });

    const dry = await importSettings(globexHr, data, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.lookups.created, 1);
    assert.deepEqual(dry.drafts.map((d) => d.item).sort(), ['leave.type (ANNUAL) @ company', 'wfh.policy @ role QA']);
    assert.equal(await t.db.one(`select 1 from departments where tenant_id = $1 and code = 'OPS'`, [globexHr.tenant.id]), null);

    const applied = await importSettings(globexHr, data, { dryRun: false });
    assert.equal(applied.drafts.length, 2);
    const draft = await settings.getVersion(globexHr, applied.drafts.find((d) => d.item.startsWith('leave.type')).versionId);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.value.entitlementDays, 25);
    const live = await settings.resolveFor(globexHr, { key: 'leave.type', subjectId: draft.subject_id });
    assert.equal(live.value.entitlementDays, 20, 'nothing is live until HR publishes');
    const qa = await settings.getVersion(globexHr, applied.drafts.find((d) => d.item.startsWith('wfh')).versionId);
    const globexQa = await t.db.one(`select id from roles where tenant_id = $1 and code = 'QA'`, [globexHr.tenant.id]);
    assert.ok(qa.value.eligibility.allowedRoleIds.includes(globexQa.id), 'role codes mapped to the target company ids');
  });

  test('rejects files that are not exports', async () => {
    await assert.rejects(importSettings(t.hr, { hello: 1 }), { code: 'import_invalid' });
  });
});

describe('employees and forms', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('HR creates an employee with a login; deactivating disables the login', async () => {
    const e = await createEmployee(t.hr, { employee_code: 'E013', full_name: 'Nida Shah', joining_date: '2026-03-02', department_id: t.demo.departments.FIN,
      manager_id: t.emp('E009'), login: { email: 'nida@acme.test', password: 'Welcome123', accessLevel: 'employee' } });
    assert.ok(e.user_id);
    await updateEmployee(t.hr, e.id, { status: 'inactive' });
    assert.equal((await t.db.one('select is_active from users where id = $1', [e.user_id])).is_active, false);
    await assert.rejects(createEmployee(t.hr, { employee_code: 'E013', full_name: 'X', joining_date: '2026-03-02' }), { code: 'duplicate' });
  });

  test('manager loops are refused', async () => {
    await assert.rejects(updateEmployee(t.hr, t.emp('E002'), { manager_id: t.emp('E003') }), { code: 'employee_invalid' });
  });

  test('setting definitions carry form fields derived from validation', async () => {
    const wfhDef = settings.definitions().find((d) => d.key === 'wfh.policy');
    const byPath = Object.fromEntries(wfhDef.fields.map((f) => [f.path, f]));
    assert.deepEqual([byPath.maxPerWeek.type, byPath.maxPerWeek.min, byPath.maxPerWeek.max], ['int', 0, 7]);
    assert.equal(byPath['eligibility.allowedRoleIds'].type, 'refs');
    assert.equal(byPath['eligibility.allowedRoleIds'].entity, 'roles');
    assert.deepEqual(byPath['requests.approval'].options, ['manager', 'auto_within_limits']);
    assert.equal(byPath.blackoutDates.columns.length, 2);
    assert.equal(byPath['requests.minNoticeDays'].groupLabel, 'Request rules');
  });
});

describe('automatic employee codes', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('follows the existing pattern and fills an empty code on create', async () => {
    const { nextEmployeeCode } = await import('../src/services/employees.js');
    assert.equal(await nextEmployeeCode(t.hr), 'E013'); // demo has E001..E012
    const e = await createEmployee(t.hr, { full_name: 'Auto Code', joining_date: '2026-03-01' });
    assert.equal(e.employee_code, 'E013');
    assert.equal(await nextEmployeeCode(t.hr), 'E014');
    await createEmployee(t.hr, { employee_code: 'E100', full_name: 'Manual Code', joining_date: '2026-03-01' });
    assert.equal(await nextEmployeeCode(t.hr), 'E101');
  });
});
