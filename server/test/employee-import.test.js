/** Bulk employee import from CSV: preview, real import, updates, managers, logins and bad rows. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';
import { parseDate } from '../src/services/employeeImport.js';
import { parseCsv } from '../src/lib/csv.js';

test('dates are read the way people type them', () => {
  assert.equal(parseDate('2024-03-15'), '2024-03-15');
  assert.equal(parseDate('15/03/2024'), '2024-03-15');
  assert.equal(parseDate('05/03/2024'), '2024-03-05'); // day first
  assert.equal(parseDate('03/15/2024'), '2024-03-15'); // impossible day-first: month first
  assert.equal(parseDate('15-03-24'), '2024-03-15');
  assert.equal(parseDate('15.03.2024'), '2024-03-15');
  assert.equal(parseDate('15 Mar 2024'), '2024-03-15');
  assert.equal(parseDate('15-Mar-2024'), '2024-03-15');
  assert.equal(parseDate('March 15, 2024'), '2024-03-15');
  assert.equal(parseDate('45366'), '2024-03-15'); // Excel day number
  assert.equal(parseDate('31/02/2024'), null);
  assert.equal(parseDate('soon'), null);
});

test('CSV: quotes, commas and line breaks inside cells, semicolons, BOM', () => {
  assert.deepEqual(parseCsv('﻿Name,Note\r\n"Khan, Ali","said ""hi""\nthere"\r\n\r\n'), [['Name', 'Note'], ['Khan, Ali', 'said "hi"\nthere']]);
  assert.deepEqual(parseCsv('Name;Dept\nAli;Sales\n'), [['Name', 'Dept'], ['Ali', 'Sales']]);
});

describe('employee import over HTTP', () => {
  let t, app;
  const mails = [];
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : res.body };
  };
  const login = async (who, email) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } });
    assert.equal(res.statusCode, 200, `login ${email}`);
    tokens[who] = JSON.parse(res.body).token;
  };
  const count = async (sql, params) => (await t.db.one(sql, params)).n;

  before(async () => {
    t = await setup();
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret', mailer: { send: async (m) => { mails.push(m); } } });
    await login('hr', 'hr@acme.test');
    await login('ali', 'ali@acme.test');
    await login('bilal', 'bilal@acme.test');
    // Room for the imported people on the trial plan
    await t.db.query('update subscriptions set max_employees = null where tenant_id = $1', [t.tenant.id]);
  });
  after(async () => { await app.close(); await t.close(); });

  // Real-world headers: none of them is spelled like the template.
  const csv = [
    'Emp ID,Employee Name,Official Email,Mobile No,Dept,Designation,Reports To,DOJ,Status,Create Login,Notes',
    'N100,Nadia Shah,nadia.shah@acme.test,0300 1111111,Sales,Sales Executive,N101,01/02/2025,Active,yes,top seller',
    'N101,Naveed Iqbal,naveed@acme.test,,Customer Success,Team Lead,,15 Jan 2024,active,no,',
    'N102,Bad Date,,,,,,,someday,,',
    'E003,Ali Raza,,,,,,,Inactive,,',
    'N103,No Dept Typo,,,,,,2025-05-05,Retired,,',
  ].join('\n');

  test('only HR can import', async () => {
    assert.equal((await call('ali', 'POST', '/api/employees/import', { csv })).status, 403);
  });

  test('the template downloads with every column', async () => {
    const res = await call('hr', 'GET', '/api/employees/import-template.csv');
    assert.equal(res.status, 200);
    assert.match(res.body, /Employee code,Full name,Email,Phone,Department,Role,Employment type,Manager,Joining date/);
  });

  test('the preview reports exactly what would happen and saves nothing', async () => {
    const before = await count('select count(*)::int as n from employees where tenant_id = $1', [t.tenant.id]);
    const res = await call('hr', 'POST', '/api/employees/import', { csv });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body;
    assert.equal(r.dryRun, true);
    assert.deepEqual([r.total, r.added, r.updated, r.failed], [5, 2, 1, 2]);
    assert.deepEqual(r.ignoredColumns, ['Notes']);
    const byLine = Object.fromEntries(r.rows.map((x) => [x.line, x]));
    assert.match(byLine[4].error, /someday/);
    assert.match(byLine[6].error, /Status "Retired"/);
    assert.equal(byLine[5].action, 'updated');
    assert.deepEqual(r.created.department?.sort(), ['Customer Success']);
    assert.equal(await count('select count(*)::int as n from employees where tenant_id = $1', [t.tenant.id]), before);
    assert.equal(await count(`select count(*)::int as n from departments where tenant_id = $1 and name = 'Customer Success'`, [t.tenant.id]), 0);
    assert.equal(mails.length, 0);
  });

  test('the import adds, updates, links managers, creates logins and emails a password link', async () => {
    const res = await call('hr', 'POST', '/api/employees/import', { csv, dryRun: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.added, res.body.updated, res.body.failed, res.body.logins, res.body.invitesSent], [2, 1, 2, 1, 1]);

    const nadia = await t.db.one(`select e.*, m.employee_code as manager_code, d.name as dept, r.name as role from employees e
      left join employees m on m.id = e.manager_id left join departments d on d.id = e.department_id left join roles r on r.id = e.role_id
      where e.tenant_id = $1 and e.employee_code = 'N100'`, [t.tenant.id]);
    assert.equal(nadia.full_name, 'Nadia Shah');
    assert.equal(nadia.joining_date, '2025-02-01');
    assert.equal(nadia.manager_code, 'N101'); // a manager listed further down the file
    assert.equal(nadia.dept, 'Sales');
    assert.equal(nadia.role, 'Sales Executive');
    assert.ok(nadia.user_id, 'login created');
    const naveed = await t.db.one(`select user_id from employees where tenant_id = $1 and employee_code = 'N101'`, [t.tenant.id]);
    assert.equal(naveed.user_id, null, 'Login = no');
    const ali = await t.db.one(`select status, full_name from employees where tenant_id = $1 and employee_code = 'E003'`, [t.tenant.id]);
    assert.deepEqual([ali.status, ali.full_name], ['inactive', 'Ali Raza']);

    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'nadia.shah@acme.test');
    const token = mails[0].text.match(/token=([\w-]+)/)[1];
    const reset = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token, password: 'nadia-own-pass' } });
    assert.equal(reset.statusCode, 200, reset.body);
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nadia.shah@acme.test', password: 'nadia-own-pass' } });
    assert.equal(signIn.statusCode, 200);
  });

  test('importing the same file again only updates (no duplicates, no new logins)', async () => {
    const res = await call('hr', 'POST', '/api/employees/import', { csv, dryRun: false });
    assert.deepEqual([res.body.added, res.body.updated, res.body.logins], [0, 3, 0]);
    assert.equal(await count(`select count(*)::int as n from employees where tenant_id = $1 and employee_code like 'N1%'`, [t.tenant.id]), 2);
  });

  test('a list created by a row that then fails is not left behind', async () => {
    const res = await call('hr', 'POST', '/api/employees/import', { dryRun: false,
      csv: 'Name,Department,Joining date\nGhost Row,Phantom Dept,not-a-date\nReal Person,Phantom Dept,2025-01-01' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.added, res.body.failed], [1, 1]);
    assert.equal(await count(`select count(*)::int as n from departments where tenant_id = $1 and name = 'Phantom Dept'`, [t.tenant.id]), 1);
  });

  test('export downloads everyone in the template columns, and imports back unchanged', async () => {
    await t.db.query(`update employees set phone = '+92 300 7654321' where tenant_id = $1 and employee_code = 'N100'`, [t.tenant.id]);
    assert.equal((await call('bilal', 'GET', '/api/employees/export.csv')).status, 403); // a manager is not HR
    const active = await call('hr', 'GET', '/api/employees/export.csv');
    assert.equal(active.status, 200);
    const lines = parseCsv(active.body);
    assert.deepEqual(lines[0].slice(0, 4), ['Employee code', 'Full name', 'Email', 'Phone']);
    assert.equal(lines[0].at(-1), 'Exit date');
    const activeCount = await count(`select count(*)::int as n from employees where tenant_id = $1 and status = 'active'`, [t.tenant.id]);
    assert.equal(lines.length - 1, activeCount);
    const nadia = lines.find((l) => l[0] === 'N100');
    assert.deepEqual([nadia[1], nadia[4], nadia[5], nadia[7], nadia[8], nadia[13], nadia[14]],
      ['Nadia Shah', 'Sales', 'Sales Executive', 'N101', '2025-02-01', 'Yes', 'Employee']);
    const all = await call('hr', 'GET', '/api/employees/export.csv?status=all');
    assert.ok(parseCsv(all.body).some((l) => l[0] === 'E003' && l[10] === 'Inactive'), 'inactive people with status=all');

    // Round trip: nothing changes, nobody is added, the + phone keeps no apostrophe.
    const back = await call('hr', 'POST', '/api/employees/import', { csv: all.body, dryRun: false });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual([back.body.added, back.body.failed], [0, 0]);
    assert.equal((await t.db.one(`select phone from employees where tenant_id = $1 and employee_code = 'N100'`, [t.tenant.id])).phone, '+92 300 7654321');
    assert.ok(await t.db.one(`select 1 from audit_log where tenant_id = $1 and action = 'employees.exported'`, [t.tenant.id]));
  });

  test('a file without a name column is refused with the columns it has', async () => {
    const res = await call('hr', 'POST', '/api/employees/import', { csv: 'Code,Dept\nX1,Sales' });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /No name column/);
  });
});
