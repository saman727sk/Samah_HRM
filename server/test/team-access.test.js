/**
 * Teams & access: HR decides who is a manager, who works under whom and what each person may do;
 * managers with the right choose their team's features.
 * Demo: E001 HR; E002 Bilal manages E003 Ali, E004 Ayesha; E005 Usman manages E006 Fatima...; E009 Omar (finance manager).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';
import { effectivePermissions } from '../src/services/access.js';
import * as access from '../src/services/teamAccess.js';
import * as rota from '../src/services/rota.js';
import * as tasks from '../src/services/assignedTasks.js';
import * as helpdesk from '../src/services/helpdesk.js';
import * as leave from '../src/services/leave.js';
import * as payroll from '../src/services/payroll.js';
import * as salary from '../src/services/salary.js';
import { requireModule } from '../src/services/features.js';
import { listNotifications } from '../src/services/notifications.js';

describe('teams & access', () => {
  let t, hr;
  before(async () => { t = await setup(); hr = t.hr; });
  after(() => t.close());

  /** A request context with the rights as they are stored now (like a fresh sign-in). */
  const as = async (code) => {
    const ctx = await t.as(code);
    const r = await t.db.one('select u.access_level, e.permissions from employees e join users u on u.id = e.user_id where e.id = $1', [t.emp(code)]);
    ctx.actor.accessLevel = r.access_level;
    ctx.actor.permissions = effectivePermissions(r.access_level, r.permissions);
    return ctx;
  };

  test('managers start with the default team rights; only HR sees and changes access', async () => {
    const o = await access.accessOverview(hr);
    const bilal = o.people.find((p) => p.employee_code === 'E002');
    assert.deepEqual(bilal.effective, ['team.approve', 'team.rota', 'team.tasks', 'team.attendance']);
    assert.equal(bilal.custom, false);
    assert.equal(bilal.team_size, 2);
    assert.ok(o.permissions.some((p) => p.key === 'payroll'));
    await assert.rejects(access.accessOverview(await as('E002')), /Only HR/);
    await assert.rejects(access.setAccess(await as('E002'), t.emp('E003'), { permissions: ['helpdesk'] }), /Only HR/);
    await assert.rejects(access.teamFeatures(await as('E002')), /choose your team's features/);
  });

  test('taking a team right away blocks it at once; the person is told', async () => {
    await access.setAccess(hr, t.emp('E002'), { permissions: ['team.approve', 'team.tasks'] });
    const bilal = await as('E002');
    await assert.rejects(rota.getRota(bilal, {}), /plan the rota/);
    assert.equal((await tasks.assignablePeople(bilal)).length, 2, 'tasks still allowed');
    const note = (await listNotifications(bilal)).find((n) => n.event === 'access_changed');
    assert.match(note.body, /− Plan the rota/);
    await access.setAccess(hr, t.emp('E002'), { permissions: null });
    await rota.getRota(await as('E002'), {});
  });

  test('without "approve requests", pending approvals and new requests go to HR', async () => {
    const ali = await as('E003');
    const first = await leave.createLeaveRequest(ali, { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-09' });
    const approver = async (id) => (await t.db.one(`select approver_kind, approver_employee_id from approval_tasks where request_id = $1 and status = 'pending'`, [id]));
    assert.equal((await approver(first.request.id)).approver_employee_id, t.emp('E002'));
    await access.setAccess(hr, t.emp('E002'), { permissions: ['team.rota', 'team.tasks'] });
    assert.equal((await approver(first.request.id)).approver_kind, 'hr', 'moved to HR');
    const second = await leave.createLeaveRequest(ali, { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-11' });
    assert.equal((await approver(second.request.id)).approver_kind, 'hr', 'new ones skip Bilal');
    await access.setAccess(hr, t.emp('E002'), { permissions: null });
  });

  test('help desk staff (not HR) answer everyone, and hear about new requests', async () => {
    await access.setAccess(hr, t.emp('E004'), { permissions: ['helpdesk', 'team.rota'] });
    const row = (await access.accessOverview(hr)).people.find((p) => p.employee_code === 'E004');
    assert.deepEqual(row.effective, ['helpdesk'], 'team rights are dropped for an employee');
    const ayesha = await as('E004');
    const tk = await helpdesk.openTicket(await as('E006'), { category: 'it', subject: 'Laptop is slow', body: 'Please help' });
    assert.ok((await listNotifications(ayesha)).some((n) => n.event === 'ticket_new'));
    assert.ok((await helpdesk.listTickets(ayesha, {})).tickets.some((x) => x.id === tk.id));
    const r = await helpdesk.replyTicket(ayesha, tk.id, { body: 'Restart it please' });
    assert.equal(r.status, 'answered');
    await assert.rejects(helpdesk.getTicket(await as('E003'), tk.id), /not found/i, 'others still see only their own');
  });

  test('payroll staff run payroll and edit salaries, but never their own pay', async () => {
    await access.setAccess(hr, t.emp('E009'), { permissions: ['payroll', 'team.approve'] });
    const omar = await as('E009');
    assert.ok(Array.isArray(await payroll.listRuns(omar)));
    const ali = await salary.salaryOf(omar, t.emp('E003'));
    assert.ok(ali);
    await assert.rejects(salary.setPaymentDetails(omar, t.emp('E009'), { bankName: 'X', accountTitle: 'Omar', iban: 'PK36SCBL0000001123456702' }), /your own salary/);
    await assert.rejects(payroll.listRuns(await as('E005')), /payroll staff/);
  });

  test('HR builds teams: make a team lead, add people, no loops in the reporting line', async () => {
    await assert.rejects(access.setTeam(hr, t.emp('E006'), { add: [t.emp('E007')] }), /not a manager/);
    await access.setAccess(hr, t.emp('E006'), { accessLevel: 'manager' });
    const r = await access.setTeam(hr, t.emp('E006'), { add: [t.emp('E007'), t.emp('E008')] });
    assert.equal(r.added, 2);
    const fatima = await as('E006');
    assert.equal(fatima.actor.accessLevel, 'manager');
    assert.deepEqual((await tasks.assignablePeople(fatima)).map((p) => p.employee_code).sort(), ['E007', 'E008']);
    await assert.rejects(access.setTeam(hr, t.emp('E006'), { add: [t.emp('E005')] }), /above/);
    const out = await access.setTeam(hr, t.emp('E006'), { remove: [t.emp('E008')] });
    assert.equal(out.removed, 1);
    assert.equal((await t.db.one('select manager_id from employees where id = $1', [t.emp('E008')])).manager_id, null);
  });

  test('someone without a login becomes a manager: HR sets the password, no email is sent', async () => {
    const sent = [];
    const ctx = { ...hr, mailer: { send: async (m) => { sent.push(m); } }, appUrl: 'http://app.test' };
    const emp = await t.db.one(`insert into employees (tenant_id, employee_code, full_name, joining_date, status)
      values ($1, 'N900', 'Nadia Shah', '2026-01-05', 'active') returning id`, [t.tenant.id]);
    await assert.rejects(access.setAccess(ctx, emp.id, { accessLevel: 'manager', password: 'Start123!' }), /no email/);
    await assert.rejects(access.setAccess(ctx, emp.id, { accessLevel: 'manager', email: 'nadia@acme.test' }), /Set a password/);
    await assert.rejects(access.setAccess(ctx, emp.id, { accessLevel: 'manager', email: 'nadia@acme.test', password: 'short' }), /at least 8/);
    const r = await access.setAccess(ctx, emp.id, { accessLevel: 'manager', email: 'Nadia@Acme.test', password: 'Start123!' });
    assert.equal(r.access_level, 'manager');
    assert.deepEqual(r.login, { userId: r.login.userId, email: 'nadia@acme.test', invited: false, inviteFailed: false });
    assert.equal(sent.length, 0, 'no email');
    assert.equal((await t.db.one('select email from employees where id = $1', [emp.id])).email, 'nadia@acme.test');

    // She signs in with the password HR gave her, then changes it herself.
    const app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    const login = (password) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nadia@acme.test', password } });
    const first = await login('Start123!');
    assert.equal(first.statusCode, 200);
    const auth = { authorization: `Bearer ${JSON.parse(first.body).token}` };
    const wrong = await app.inject({ method: 'POST', url: '/api/me/password', headers: auth, payload: { currentPassword: 'nope', newPassword: 'MyOwnPass1' } });
    assert.equal(wrong.statusCode, 400);
    const ok = await app.inject({ method: 'POST', url: '/api/me/password', headers: auth, payload: { currentPassword: 'Start123!', newPassword: 'MyOwnPass1' } });
    assert.equal(ok.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).statusCode, 401, 'the old session ends');
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${JSON.parse(ok.body).token}` } })).statusCode, 200);
    assert.equal((await login('Start123!')).statusCode, 401);
    assert.equal((await login('MyOwnPass1')).statusCode, 200);

    // HR resets it when she forgets it.
    const { setLoginPassword } = await import('../src/services/employees.js');
    await setLoginPassword(hr, emp.id, { password: 'Reset4567' });
    assert.equal((await login('Reset4567')).statusCode, 200);
    await app.close();
    const other = await t.db.one(`insert into employees (tenant_id, employee_code, full_name, joining_date, status)
      values ($1, 'N901', 'Naveed Iqbal', '2026-01-05', 'active') returning id`, [t.tenant.id]);
    await assert.rejects(access.setAccess(ctx, other.id, { accessLevel: 'manager', email: 'hr@acme.test', password: 'Start123!' }), /already has a login with this email/);
    assert.equal((await t.db.one('select user_id from employees where id = $1', [other.id])).user_id, null, 'nothing half-made');
  });

  test('a manager with "choose team features" decides what each person in their team can use', async () => {
    await access.setAccess(hr, t.emp('E002'), { permissions: ['team.approve', 'team.access'] });
    const bilal = await as('E002');
    const team = await access.teamFeatures(bilal);
    assert.deepEqual(team.people.map((p) => p.employee_code).sort(), ['E003', 'E004']);
    assert.ok(team.modules.some((m) => m.key === 'leave'));
    await access.setTeamFeatures(bilal, t.emp('E003'), { modules: ['attendance', 'tasks'] });
    await assert.rejects(requireModule(await as('E003'), 'leave'), /don't have access/);
    await requireModule(await as('E003'), 'tasks');
    await assert.rejects(access.setTeamFeatures(bilal, t.emp('E006'), { modules: [] }), /doesn't work under you/);
    await assert.rejects(access.setTeamFeatures(bilal, t.emp('E002'), { modules: [] }), /your own/);
    await access.setTeamFeatures(bilal, t.emp('E003'), { modules: null });
  });

  test('over HTTP: /api/me carries the rights; /api/access is HR only', async () => {
    const app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    const login = async (email) => ({ authorization: `Bearer ${JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } })).body).token}` });
    const bilal = await login('bilal@acme.test');
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/api/me', headers: bilal })).body);
    assert.deepEqual(me.user.permissions, ['team.approve', 'team.access']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/access', headers: bilal })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/access/team', headers: bilal })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/access', headers: await login('hr@acme.test') })).statusCode, 200);
    await app.close();
  });
});

describe('logins for everyone', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('"Give logins to everyone" makes Employee logins with HR\'s starting password, no emails; people without an email are listed', async () => {
    const { addMissingLogins } = await import('../src/services/employees.js');
    const add = (code, name, email) => t.db.one(`insert into employees (tenant_id, employee_code, full_name, email, joining_date, status)
      values ($1, $2, $3, $4, '2026-01-05', 'active') returning id`, [t.tenant.id, code, name, email]);
    const a = await add('N800', 'Hassan Raza', 'hassan.raza@acme.test');
    await add('N801', 'No Email', null);
    const sent = [];
    const ctx = { ...t.hr, mailer: { send: async (m) => { sent.push(m.to); } }, appUrl: 'http://app.test' };
    await assert.rejects(addMissingLogins(ctx, {}), /starting password/);
    const r = await addMissingLogins(ctx, { password: 'Welcome2026' });
    assert.equal(r.created, 1);
    assert.equal(r.invited, 0);
    assert.deepEqual(r.noEmail, ['No Email']);
    assert.deepEqual(sent, [], 'no emails');
    const u = await t.db.one('select u.access_level from employees e join users u on u.id = e.user_id where e.id = $1', [a.id]);
    assert.equal(u.access_level, 'employee', 'limited access: their own data only');
    assert.equal((await addMissingLogins(t.hr, { password: 'Welcome2026' })).created, 0, 'running it again changes nothing');
  });
});

describe('the profile email is the sign-in email', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('changing the email on the employee record changes the login; a taken email is refused', async () => {
    const emp = await import('../src/services/employees.js');
    const row = await t.db.one(`insert into employees (tenant_id, employee_code, full_name, email, joining_date, status)
      values ($1, 'N700', 'Hassan Raza', 'hassan@old.test', '2026-01-05', 'active') returning id`, [t.tenant.id]);
    await emp.addLogin(t.hr, row.id, { password: '12345678' });
    await emp.updateEmployee(t.hr, row.id, { email: 'Hassan.Raza@Gmail.com' });
    const app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    const login = (email, password) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    assert.equal((await login('hassan.raza@gmail.com', '12345678')).statusCode, 200);
    assert.equal((await login('hassan@old.test', '12345678')).statusCode, 401);
    const listed = (await emp.listEmployees(t.hr)).find((e) => e.id === row.id);
    assert.equal(listed.login_email, 'hassan.raza@gmail.com');
    await assert.rejects(emp.updateEmployee(t.hr, row.id, { email: 'ali@acme.test' }), /already has a login with this email/);
    await app.close();
  });
});
