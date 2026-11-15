/** The SaaS owner edits a company, its logins (name, email, password), and deletes a company with all its data. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';

describe('owner manages companies', () => {
  let t, app, globex;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const signIn = (email, password) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const login = async (who, email) => {
    const res = await signIn(email, DEMO_PASSWORD);
    assert.equal(res.statusCode, 200, `login ${email}`);
    tokens[who] = JSON.parse(res.body).token;
  };

  before(async () => {
    t = await setup();
    globex = await seedDemo(t.db, { rounds: 4, slug: 'globex', withHistory: true });
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    await login('owner', 'owner@hrm.test');
    await login('hr', 'hr@acme.test');
    await login('globexHr', 'hr+globex@acme.test');
  });
  after(async () => { await app.close(); await t.close(); });

  test('only the owner can edit or delete a company', async () => {
    assert.equal((await call('hr', 'PATCH', `/api/admin/tenants/${t.tenant.id}`, { name: 'Hacked' })).status, 403);
    assert.equal((await call('hr', 'DELETE', `/api/admin/tenants/${globex.tenant.id}`, { confirmName: 'x' })).status, 403);
  });

  test('the owner edits the company details, slug and time zone', async () => {
    const res = await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}`,
      { name: 'Acme Renamed', slug: 'acme-renamed', timezone: 'Asia/Dubai', phone: '+92 300 0000000' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Acme Renamed');
    assert.equal(res.body.slug, 'acme-renamed');
    assert.equal(res.body.timezone, 'Asia/Dubai');
    assert.equal(res.body.phone, '+92 300 0000000');
    assert.equal((await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}`, { slug: 'globex' })).status, 409);
    assert.equal((await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}`, { timezone: 'Mars/Base' })).status, 400);
    assert.equal((await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}`, { name: 'x' })).status, 400);
  });

  test("the owner changes an HR admin's name, email and password", async () => {
    const detail = (await call('owner', 'GET', `/api/admin/tenants/${t.tenant.id}`)).body;
    const admin = detail.admins.find((a) => a.email === 'hr@acme.test');
    assert.ok(admin?.id, 'admins carry their login id');
    const res = await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}/logins/${admin.id}`,
      { fullName: 'New HR Name', email: 'new-hr@acme.test', password: 'brand-new-pass' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.changed.sort(), ['email', 'name', 'password']);
    assert.equal((await signIn('hr@acme.test', DEMO_PASSWORD)).statusCode, 401);
    assert.equal((await signIn('new-hr@acme.test', DEMO_PASSWORD)).statusCode, 401);
    assert.equal((await signIn('new-hr@acme.test', 'brand-new-pass')).statusCode, 200);
    // The old session ended with the password change.
    assert.equal((await call('hr', 'GET', '/api/billing/subscription')).status, 401);
    const after = (await call('owner', 'GET', `/api/admin/tenants/${t.tenant.id}`)).body.admins.find((a) => a.id === admin.id);
    assert.equal(after.full_name, 'New HR Name');
    assert.equal(after.email, 'new-hr@acme.test');
    // Bad input and someone else's company are refused.
    assert.equal((await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}/logins/${admin.id}`, { password: 'short' })).status, 400);
    assert.equal((await call('owner', 'PATCH', `/api/admin/tenants/${t.tenant.id}/logins/${admin.id}`, { email: 'owner@hrm.test' })).status, 409);
    assert.equal((await call('owner', 'PATCH', `/api/admin/tenants/${globex.tenant.id}/logins/${admin.id}`, { fullName: 'X' })).status, 404);
  });

  test('deleting a company needs its name, removes all its data and leaves other companies alone', async () => {
    const id = globex.tenant.id;
    const acmeUsers = (await t.db.one('select count(*)::int as n from users where tenant_id = $1', [t.tenant.id])).n;
    assert.equal((await call('owner', 'DELETE', `/api/admin/tenants/${id}`, { confirmName: 'wrong' })).status, 400);
    const res = await call('owner', 'DELETE', `/api/admin/tenants/${id}`, { confirmName: globex.tenant.name });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, true);
    assert.ok(res.body.rows.employees > 0 && res.body.rows.users > 0);

    assert.equal((await call('owner', 'GET', `/api/admin/tenants/${id}`)).status, 404);
    const { rows } = await t.db.query(
      `select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'tenant_id'`);
    for (const { table_name: tbl } of rows) {
      const left = (await t.db.one(`select count(*)::int as n from ${tbl} where tenant_id = $1`, [id])).n;
      assert.equal(left, 0, `${tbl} still has rows of the deleted company`);
    }
    // Its people can no longer sign in, and the other company is untouched.
    assert.equal((await call('globexHr', 'GET', '/api/billing/subscription')).status, 401);
    assert.equal((await t.db.one('select count(*)::int as n from users where tenant_id = $1', [t.tenant.id])).n, acmeUsers);
    assert.equal((await signIn('new-hr@acme.test', 'brand-new-pass')).statusCode, 200);
    const audit = await t.db.one(`select * from audit_log where action = 'tenant.deleted' and entity_id = $1`, [id]);
    assert.ok(audit, 'the deletion is in the platform audit log');
  });
});
