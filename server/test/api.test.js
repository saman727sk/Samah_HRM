/**
 * HTTP layer: authentication, role-based access, tenant isolation and the
 * draft > preview > publish flow end to end.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { seedDemo, DEMO_PASSWORD } from '../seed/demo.js';

describe('API', () => {
  let t, app, globex;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}`, 'accept-language': 'en' } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  before(async () => {
    t = await setup();
    globex = await seedDemo(t.db, { rounds: 4, slug: 'globex' }); // a second company sharing the database
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    for (const [who, email] of [['hr', 'hr@acme.test'], ['bilal', 'bilal@acme.test'], ['ali', 'ali@acme.test'],
      ['globexHr', 'hr+globex@acme.test'], ['owner', 'owner@hrm.test']]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } });
      assert.equal(res.statusCode, 200, `login ${email}`);
      tokens[who] = JSON.parse(res.body).token;
    }
  });
  after(async () => { await app.close(); await t.close(); });

  test('rejects missing / bad credentials', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'hr@acme.test', password: 'nope' } });
    assert.equal(bad.statusCode, 401);
    const anon = await app.inject({ method: 'GET', url: '/api/employees' });
    assert.equal(anon.statusCode, 401);
  });

  test('employee sees only themselves; manager sees their team; HR sees everyone', async () => {
    assert.deepEqual((await call('ali', 'GET', '/api/employees')).body.map((e) => e.full_name), ['Ali Raza']);
    assert.deepEqual((await call('bilal', 'GET', '/api/employees')).body.map((e) => e.full_name), ['Ali Raza', 'Ayesha Siddiqui', 'Bilal Khan']);
    assert.equal((await call('hr', 'GET', '/api/employees')).body.length, 12);
    assert.equal((await call('ali', 'GET', `/api/employees/${t.emp('E004')}`)).status, 403);
    assert.equal((await call('bilal', 'GET', `/api/employees/${t.emp('E006')}`)).status, 403);
  });

  test('tenant isolation: another company cannot read or address our rows', async () => {
    const res = await call('globexHr', 'GET', `/api/employees/${t.emp('E003')}`);
    assert.equal(res.status, 404);
    assert.equal((await call('globexHr', 'GET', '/api/employees')).body.every((e) => e.tenant_id !== t.tenant.id), true);
    const patch = await call('globexHr', 'PATCH', `/api/lookups/departments/${t.demo.departments.SALES}`, { name: 'Hacked' });
    assert.equal(patch.status, 404);
  });

  test('tenant isolation: HR cannot write into another company with a known id', async () => {
    const ali = t.emp('E003');
    const ledgerOf = async () => (await t.db.one('select count(*)::int as n from leave_ledger where employee_id = $1', [ali])).n;
    const before = await ledgerOf();

    const adjust = await call('globexHr', 'POST', '/api/leave/adjustments',
      { employeeId: ali, leaveTypeId: globex.leaveTypes.ANNUAL, days: 10, note: 'cross-tenant' });
    assert.equal(adjust.status, 404);
    const foreignType = await call('globexHr', 'POST', '/api/leave/adjustments',
      { employeeId: globex.employees.E003, leaveTypeId: t.demo.leaveTypes.ANNUAL, days: 1, note: 'foreign leave type' });
    assert.equal(foreignType.status, 400);
    assert.equal(await ledgerOf(), before);

    const override = await call('globexHr', 'POST', '/api/wfh/overrides',
      { employeeId: ali, startDate: '2026-03-09', endDate: '2026-03-20', reason: 'cross-tenant' });
    assert.equal(override.status, 404);
    const device = await call('globexHr', 'POST', '/api/devices', { employeeId: ali, deviceId: 'x', label: 'x' });
    assert.equal(device.status, 404);

    const employee = await call('globexHr', 'POST', '/api/employees',
      { full_name: 'Planted', joining_date: '2026-01-01', department_id: t.demo.departments.SALES, manager_id: ali });
    assert.equal(employee.status, 400);
    assert.equal(employee.body.error.code, 'reference_invalid');
    const move = await call('globexHr', 'PATCH', `/api/employees/${globex.employees.E003}`, { manager_id: ali });
    assert.equal(move.status, 400);
    const dept = await call('globexHr', 'POST', '/api/lookups/departments', { code: 'X', name: 'X', parent_id: t.demo.departments.SALES });
    assert.equal(dept.status, 400);
  });

  test('the same email can be a login in two companies; sign-in asks which, and each is its own account', async () => {
    const hire = (who, password, extra = {}) => call(who, 'POST', '/api/employees',
      { full_name: 'Zara Shared', joining_date: '2026-01-05', login: { email: 'Zara@Shared.test', password, ...extra } });
    assert.equal((await hire('hr', 'Shared123!')).status, 201);
    assert.equal((await hire('hr', 'Other123!')).status, 409, 'once per company');
    assert.equal((await hire('globexHr', 'Shared123!')).status, 201, 'another company may use it');
    const owner = await call('hr', 'POST', '/api/employees', { full_name: 'X', joining_date: '2026-01-05', login: { email: 'owner@hrm.test', password: 'Whatever1!' } });
    assert.equal(owner.status, 409, "the platform owner's email is reserved");

    const signIn = (payload) => app.inject({ method: 'POST', url: '/api/auth/login', payload });
    const ask = await signIn({ email: 'zara@shared.test', password: 'Shared123!' });
    assert.equal(ask.statusCode, 409);
    const { companies } = JSON.parse(ask.body).error.details;
    assert.equal(companies.length, 2);
    const globex = companies.find((c) => c.id !== t.tenant.id);
    const chosen = await signIn({ email: 'zara@shared.test', password: 'Shared123!', tenantId: globex.id });
    assert.equal(chosen.statusCode, 200);
    const me = JSON.parse((await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${JSON.parse(chosen.body).token}` } })).body);
    assert.equal(me.tenant.id, globex.id, 'signed in to the chosen company only');
    assert.equal((await signIn({ email: 'zara@shared.test', password: 'wrong' })).statusCode, 401);
    assert.equal((await signIn({ email: 'owner@hrm.test', password: DEMO_PASSWORD })).statusCode, 200, 'super admin signs in directly');
  });

  test('with different passwords, the password decides the company', async () => {
    await call('hr', 'POST', '/api/employees', { full_name: 'Omar Two', joining_date: '2026-01-05', login: { email: 'omar@two.test', password: 'AcmePass1!' } });
    await call('globexHr', 'POST', '/api/employees', { full_name: 'Omar Two', joining_date: '2026-01-05', login: { email: 'omar@two.test', password: 'GlobexPass1!' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'omar@two.test', password: 'GlobexPass1!' } });
    assert.equal(res.statusCode, 200);
    assert.notEqual(JSON.parse(res.body).user.tenantId, t.tenant.id);
  });

  test('tenant isolation: the database itself refuses cross-company references', async () => {
    await assert.rejects(
      t.db.query(`insert into wfh_overrides (tenant_id, employee_id, start_date, end_date, reason)
                  values ($1, $2, '2026-03-09', '2026-03-10', 'x')`, [globex.tenant.id, t.emp('E003')]),
      (err) => err.code === '23503');
    await assert.rejects(
      t.db.query('update employees set department_id = $1 where id = $2', [t.demo.departments.SALES, globex.employees.E003]),
      (err) => err.code === '23503');
  });

  test('only HR can manage settings and lookups', async () => {
    assert.equal((await call('ali', 'POST', '/api/setting-versions', { key: 'wfh.policy', value: {} })).status, 403);
    assert.equal((await call('bilal', 'POST', '/api/lookups/departments', { code: 'X', name: 'X' })).status, 403);
    assert.equal((await call('owner', 'GET', '/api/employees')).status, 403, 'super admin works via /api/admin');
    assert.equal((await call('owner', 'GET', '/api/admin/tenants')).body.length, 2);
    assert.equal((await call('hr', 'GET', '/api/admin/tenants')).status, 403);
  });

  test('draft > preview > publish over HTTP changes the WFH outcome', async () => {
    const check = () => call('ali', 'POST', '/api/wfh/check', { dates: ['2026-03-10'] });
    const blocked = await check();
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.results[0].reasons[0].message, 'WFH is not allowed on Tuesday. Allowed days: Monday, Friday.');

    const sales = (await call('hr', 'GET', '/api/settings?key=wfh.policy')).body.find((s) => s.scope_id === t.demo.departments.SALES);
    const draft = await call('hr', 'POST', '/api/setting-versions',
      { key: 'wfh.policy', scopeType: 'department', scopeId: t.demo.departments.SALES, value: { allowedWeekdays: [1, 2, 5] } });
    assert.equal(draft.status, 201);
    const preview = await call('hr', 'POST', `/api/setting-versions/${draft.body.id}/preview`, {});
    assert.equal(preview.body.affectedCount, 3);
    const diff = await call('hr', 'GET', `/api/setting-versions/${draft.body.id}/diff`);
    assert.deepEqual(diff.body.changes, [{ path: 'allowedWeekdays', change: 'changed', old: [1, 5], new: [1, 2, 5] }]);
    const pub = await call('hr', 'POST', `/api/setting-versions/${draft.body.id}/publish`, { effectiveFrom: '2026-03-04' });
    assert.equal(pub.status, 200);

    assert.equal((await check()).body.ok, true);
    const hist = await call('hr', 'GET', `/api/settings/${sales.id}/versions`);
    assert.deepEqual(hist.body.map((v) => v.version), [2, 1]);
  });

  test('policy violations come back as 422 with translated reasons', async () => {
    const res = await call('ali', 'POST', '/api/leave/requests', { leaveTypeId: t.demo.leaveTypes.ANNUAL, startDate: '2026-03-05' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.reasons[0].message, 'This leave must be requested at least 7 day(s) in advance.');
  });

  test('Urdu texts via Accept-Language, with English fallback', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/i18n/ur', headers: { authorization: `Bearer ${tokens.ali}` } });
    assert.equal(JSON.parse(res.body)['status.wfh'], 'گھر سے کام');
  });

  test('HR can rename a term for their company only', async () => {
    const created = await call('hr', 'POST', '/api/lookups/translations', { locale: 'en', key: 'status.wfh', value: 'Remote' });
    assert.equal(created.status, 201);
    assert.equal((await call('ali', 'GET', '/api/i18n/en')).body['status.wfh'], 'Remote');
    assert.equal((await call('globexHr', 'GET', '/api/i18n/en')).body['status.wfh'], 'Work from home');
  });
});
