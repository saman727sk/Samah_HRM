/**
 * Firebase mode: Realtime Database as the system of record (write-through,
 * reload from Firebase, single-writer lease) and Firebase Authentication.
 * Uses in-memory doubles of Realtime Database and Firebase Auth, so it runs
 * offline and never touches a real project.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { SyncConflictError, createSync, decodeRow, encodeRow } from '../src/firebase/sync.js';
import { firebaseProvider, passwordProvider, setIdentityProvider } from '../src/auth/identity.js';
import { createEmployee, updateEmployee } from '../src/services/employees.js';
import { createLookup, deleteLookup } from '../src/services/lookups.js';
import { buildApp } from '../src/api/app.js';

/** Behaves like Realtime Database where it matters: nulls and empty objects vanish, multi-path updates, transactions. */
class FakeRtdb {
  data = {};
  static prune(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const p = FakeRtdb.prune(x); if (p !== undefined) out[k] = p; }
    return Object.keys(out).length ? out : undefined;
  }
  getAt(parts) { return parts.reduce((o, k) => (o == null ? undefined : o[k]), this.data); }
  setAt(parts, value) {
    const v = FakeRtdb.prune(JSON.parse(JSON.stringify(value ?? null)));
    if (!parts.length) { this.data = v ?? {}; return; }
    let o = this.data;
    for (const k of parts.slice(0, -1)) o = o[k] ??= {};
    if (v === undefined) delete o[parts.at(-1)]; else o[parts.at(-1)] = v;
    this.data = FakeRtdb.prune(this.data) ?? {};
  }
  ref(path) {
    const parts = path.split('/').filter(Boolean);
    const snap = (v) => ({ val: () => (v === undefined ? null : structuredClone(v)), exists: () => v !== undefined });
    return {
      get: async () => snap(this.getAt(parts)),
      set: async (v) => this.setAt(parts, v),
      update: async (obj) => { for (const [k, v] of Object.entries(obj)) this.setAt([...parts, ...k.split('/').filter(Boolean)], v); },
      transaction: async (fn) => {
        const cur = this.getAt(parts);
        const next = fn(cur === undefined ? null : structuredClone(cur));
        if (next === undefined) return { committed: false, snapshot: snap(cur) };
        this.setAt(parts, next);
        return { committed: true, snapshot: snap(this.getAt(parts)) };
      },
    };
  }
}

const countAll = async (db) => {
  const { rows } = await db.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
                                    and table_name not in ('schema_migrations', '_changes', '_sync_state') order by 1`);
  const out = {};
  for (const { table_name: t } of rows) out[t] = (await db.one(`select count(*)::int as n from ${t}`)).n;
  return out;
};

describe('Realtime Database as the system of record', () => {
  let t, fake, sync1, db2, sync2;
  before(async () => {
    t = await setup();
    fake = new FakeRtdb();
  });
  after(async () => { await sync2?.stop().catch(() => {}); await db2?.close(); await t.close(); });

  test('row encoding keeps JSON, drops nulls and never uploads password hashes', () => {
    const info = { json: new Set(['flags', 'value']), columns: [] };
    const enc = encodeRow({ id: 'x', flags: [], value: { a: { b: [] } }, note: null, n: 0, ok: false, password_hash: 'h' }, info, 'users');
    assert.deepEqual(enc, { id: 'x', flags: '[]', value: '{"a":{"b":[]}}', n: 0, ok: false });
    assert.deepEqual(decodeRow(enc, info), { id: 'x', flags: [], value: { a: { b: [] } }, n: 0, ok: false });
  });

  test('first start uploads the local data to an empty Firebase', async () => {
    sync1 = createSync({ db: t.db, rtdb: fake, instanceId: 'A', intervalMs: 60_000 });
    await sync1.start();
    const tables = fake.data.hrm.tables;
    assert.equal(Object.keys(tables.employees).length, 12);
    assert.ok(Object.values(tables.users).every((u) => !('password_hash' in u)));
    assert.equal(fake.data.hrm._meta.version, 1);
    assert.equal(fake.data.hrm._meta.writer.instance, 'A');
  });

  test('every change is written through, deletes included', async () => {
    const emp = await createEmployee(t.hr, { employee_code: 'E900', full_name: 'Sana Firebase', joining_date: '2026-03-01' });
    const office = await createLookup(t.hr, 'locations', { code: 'ISB', name: 'Islamabad', lat: 33.6844, lng: 73.0479, radius_m: 200 });
    assert.ok((await t.db.one('select count(*)::int as n from _changes')).n >= 2);
    await sync1.flush();
    assert.equal(fake.data.hrm.tables.employees[emp.id].full_name, 'Sana Firebase');
    assert.equal(fake.data.hrm.tables.locations[office.id].lat, 33.6844);
    assert.equal((await t.db.one('select count(*)::int as n from _changes')).n, 0);
    await deleteLookup(t.hr, 'locations', office.id);
    await sync1.flush();
    assert.equal(fake.data.hrm.tables.locations[office.id], undefined);
    assert.ok(fake.data.hrm._meta.version >= 3);
  });

  test('a second server is refused while the first one is writing', async () => {
    const other = createSync({ db: t.db, rtdb: fake, instanceId: 'B' });
    await assert.rejects(other.start(), SyncConflictError);
  });

  test('a fresh server loads everything back from Firebase, with all guarantees intact', async () => {
    await sync1.stop();
    assert.equal(fake.data.hrm._meta.writer, undefined); // lease released
    db2 = await createDb();
    await migrate(db2);
    sync2 = createSync({ db: db2, rtdb: fake, instanceId: 'B', intervalMs: 60_000 });
    await sync2.start();
    assert.deepEqual(await countAll(db2), await countAll(t.db));
    const policy = (db) => db.one(`select v.value from setting_versions v join settings s on s.id = v.setting_id
                                    where s.key = 'wfh.policy' and s.scope_type = 'company' and v.status = 'published'`);
    assert.deepEqual((await policy(db2)).value, (await policy(t.db)).value);
    // Append-only and identity columns still work on the reloaded copy.
    await assert.rejects(db2.query('update audit_log set action = $1', ['tampered']), /append-only/);
    const before = (await db2.one('select max(id) as m from audit_log')).m;
    const row = await db2.one(`insert into audit_log (action, entity_type) values ('test', 'test') returning id`);
    assert.ok(row.id > before);
  });

  test('changes made on the new server reach Firebase too', async () => {
    await db2.query(`update employees set full_name = 'Sana F.' where employee_code = 'E900'`);
    await sync2.flush();
    const e = Object.values(fake.data.hrm.tables.employees).find((x) => x.employee_code === 'E900');
    assert.equal(e.full_name, 'Sana F.');
  });
});

describe('Firebase Authentication', () => {
  let t, app;
  const calls = { deleted: [], updated: [] };
  const fakeAuth = {
    verifyIdToken: async (token) => {
      if (token === 'tok-ali') return { uid: 'uid-ali' };
      if (token === 'tok-stranger') return { uid: 'uid-stranger' };
      throw Object.assign(new Error('bad token'), { code: 'auth/argument-error' });
    },
    createUser: async ({ email }) => ({ uid: `uid-${email}` }),
    deleteUser: async (uid) => { calls.deleted.push(uid); },
    updateUser: async (uid, patch) => { calls.updated.push([uid, patch]); },
  };
  const call = (token, method, url, body) => app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });

  before(async () => {
    t = await setup();
    setIdentityProvider(firebaseProvider(fakeAuth));
    await t.db.query(`update users set firebase_uid = 'uid-ali' where email = 'ali@acme.test'`);
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
  });
  after(async () => { setIdentityProvider(passwordProvider()); await app.close(); await t.close(); });

  test('the API accepts Firebase ID tokens, matched by UID', async () => {
    assert.equal(JSON.parse((await call(null, 'GET', '/api/auth/config')).body).provider, 'firebase');
    const me = await call('tok-ali', 'GET', '/api/me');
    assert.equal(me.statusCode, 200);
    assert.equal(JSON.parse(me.body).employee.full_name, 'Ali Raza');
    assert.equal((await call('tok-stranger', 'GET', '/api/me')).statusCode, 401); // valid Firebase user, no HRM login
    assert.equal((await call('garbage', 'GET', '/api/me')).statusCode, 401);
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'ali@acme.test', password: 'Passw0rd!' })).statusCode, 410);
  });

  test('HR creates logins in Firebase; deactivating disables them; failures leave no orphans', async () => {
    const emp = await createEmployee(t.hr, { employee_code: 'E901', full_name: 'Nida Auth', joining_date: '2026-03-01',
      login: { email: 'nida@acme.test', password: 'Secret123' } });
    const user = await t.db.one('select * from users where id = $1', [emp.user_id]);
    assert.equal(user.firebase_uid, 'uid-nida@acme.test');
    assert.equal(user.password_hash, null);
    await updateEmployee(t.hr, emp.id, { status: 'inactive' });
    assert.deepEqual(calls.updated.at(-1), ['uid-nida@acme.test', { disabled: true }]);

    await assert.rejects(createEmployee(t.hr, { employee_code: 'E901', full_name: 'Duplicate', joining_date: '2026-03-01',
      login: { email: 'dupe@acme.test', password: 'Secret123' } }), { code: 'duplicate' });
    assert.deepEqual(calls.deleted, ['uid-dupe@acme.test']);
  });
});
