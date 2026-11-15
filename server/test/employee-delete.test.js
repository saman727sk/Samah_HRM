/**
 * 1. A company created in the middle of a month: its dashboards work for that first month
 *    (its rules start on its go-live date, the month view starts on the 1st).
 * 2. HR deletes an employee added by mistake; employees with history are kept (set to Exited).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';

describe('first month of a new company, and deleting employees', () => {
  let t, app;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const signIn = (email, password = DEMO_PASSWORD) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const login = async (who, email, password) => {
    const res = await signIn(email, password);
    assert.equal(res.statusCode, 200, `login ${email}: ${res.body}`);
    tokens[who] = JSON.parse(res.body).token;
  };

  before(async () => {
    t = await setup(); // the clock is Wed 2026-03-04
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    await login('owner', 'owner@hrm.test');
    await login('hr', 'hr@acme.test');
    await login('bilal', 'bilal@acme.test');
    await t.db.query('update subscriptions set max_employees = null where tenant_id = $1', [t.tenant.id]);
  });
  after(async () => { await app.close(); await t.close(); });

  test('a company created on the 4th has working dashboards for the 1st to the 3rd too', async () => {
    const res = await call('owner', 'POST', '/api/admin/tenants', { name: 'Midmonth Ltd', slug: 'midmonth',
      admin: { fullName: 'Mona HR', email: 'mona@midmonth.test', password: 'mona-pass-123' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const goLive = res.body.go_live_date;
    if (goLive.endsWith('-01')) await t.db.query(`update tenants set go_live_date = go_live_date + 3 where id = $1`, [res.body.id]); // must start after the 1st
    await login('mona', 'mona@midmonth.test', 'mona-pass-123');
    // Before the fix: "No published attendance.calendar setting applies on <the 1st>"
    const hr = await call('mona', 'GET', `/api/dashboard/hr?month=${goLive.slice(0, 7)}`);
    assert.equal(hr.status, 200, JSON.stringify(hr.body));
    const me = await call('mona', 'GET', '/api/dashboard/employee');
    assert.equal(me.status, 200, JSON.stringify(me.body));
  });

  const addPerson = async (body) => {
    const res = await call('hr', 'POST', '/api/employees', { joining_date: '2026-03-01', ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };

  test('only HR can delete', async () => {
    const p = await addPerson({ full_name: 'Not Bilals Call' });
    assert.equal((await call('bilal', 'DELETE', `/api/employees/${p.id}`)).status, 403);
  });

  test('an employee added by mistake is deleted with their login, and the email can be used again', async () => {
    const p = await addPerson({ full_name: 'Mistake Person', email: 'oops@acme.test', login: { email: 'oops@acme.test', password: 'oops-pass-123' } });
    const kept = await addPerson({ full_name: 'Kept Person' });
    // An automatic leave grant for each (the leave job adds these)
    const grant = (id) => t.db.query(`insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_date, kind, days)
      select $1, $2, id, 2026, '2026-03-01', 'grant', 10 from leave_types where tenant_id = $1 limit 1`, [t.tenant.id, id]);
    await grant(p.id); await grant(kept.id);
    assert.equal((await signIn('oops@acme.test', 'oops-pass-123')).statusCode, 200);
    const res = await call('hr', 'DELETE', `/api/employees/${p.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await call('hr', 'GET', `/api/employees/${p.id}`)).status, 404);
    assert.equal((await signIn('oops@acme.test', 'oops-pass-123')).statusCode, 401);
    // Their leave balance went with them; the ledger stays append-only for everyone else
    assert.equal((await t.db.one('select count(*)::int as n from leave_ledger where employee_id = $1', [p.id])).n, 0);
    await assert.rejects(t.db.query('delete from leave_ledger where employee_id = $1', [kept.id]), /append-only/);
    const again = await addPerson({ full_name: 'Right Person', email: 'oops@acme.test', login: { email: 'oops@acme.test', password: 'oops-pass-456' } });
    assert.ok(again.user_id);
    assert.ok(await t.db.one(`select 1 from audit_log where action = 'employee.deleted' and entity_id = $1`, [p.id]));
  });

  test('someone with attendance or payroll history is kept: HR is told to set them to Exited', async () => {
    await t.db.query(`insert into work_logs (tenant_id, employee_id, work_date, title, hours, status) values ($1, $2, '2026-03-02', 'Client visit', 3, 'completed')`,
      [t.tenant.id, t.emp('E004')]);
    const res = await call('hr', 'DELETE', `/api/employees/${t.emp('E004')}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'employee_has_history');
    assert.match(res.body.error.message, /1 daily task logs.*Exited/s);
    assert.ok(await t.db.one('select 1 from employees where id = $1', [t.emp('E004')]), 'still there');
  });

  test('a manager is kept until their people have another manager; nobody deletes themselves', async () => {
    const boss = await addPerson({ full_name: 'New Boss' });
    const report = await addPerson({ full_name: 'New Report', manager_id: boss.id });
    const blocked = await call('hr', 'DELETE', `/api/employees/${boss.id}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /another manager/);
    await call('hr', 'PATCH', `/api/employees/${report.id}`, { manager_id: null });
    assert.equal((await call('hr', 'DELETE', `/api/employees/${boss.id}`)).status, 200);
    const self = await call('hr', 'DELETE', `/api/employees/${t.emp('E001')}`);
    assert.equal(self.status, 409);
    assert.match(self.body.error.message, /yourself/);
  });

  test('a login that appears in the audit log is retired (never signs in again) and its email freed', async () => {
    const p = await addPerson({ full_name: 'Audited Person', email: 'audited@acme.test', login: { email: 'audited@acme.test', password: 'audited-pass-1' } });
    await t.db.query(`insert into audit_log (tenant_id, actor_user_id, action, entity_type) values ($1, $2, 'test.action', 'test')`, [t.tenant.id, p.user_id]);
    assert.equal((await call('hr', 'DELETE', `/api/employees/${p.id}`)).status, 200);
    const u = await t.db.one('select is_active, email, password_hash from users where id = $1', [p.user_id]);
    assert.deepEqual([u.is_active, u.password_hash], [false, null]);
    assert.notEqual(u.email, 'audited@acme.test');
    assert.equal((await signIn('audited@acme.test', 'audited-pass-1')).statusCode, 401);
    await addPerson({ full_name: 'Reuses Email', email: 'audited@acme.test', login: { email: 'audited@acme.test', password: 'audited-pass-2' } });
  });
});
