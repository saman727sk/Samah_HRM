/**
 * Forgot password by email: one-time hashed links that expire, no account
 * enumeration, old sessions ended after a reset, one link per company for
 * an email that signs in to several.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';

describe('forgot password', () => {
  let t, app;
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const lastTo = (to) => sent.filter((m) => m.to === to).at(-1);
  const tokensIn = (m) => [...m.text.matchAll(/token=([\w-]+)/g)].map((x) => x[1]);
  const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, payload, headers });
  const login = (email, password, tenantId) => post('/api/auth/login', { email, password, tenantId });
  let globex;

  before(async () => {
    t = await setup();
    globex = await seedDemo(t.db, { rounds: 4, slug: 'globex' });
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret', mailer, appUrl: 'https://hrm.example' });
  });
  after(async () => { await app.close(); await t.close(); });

  test('the answer is the same whether or not the email has an account', async () => {
    const unknown = await post('/api/auth/password/forgot', { email: 'nobody@nowhere.test' });
    const known = await post('/api/auth/password/forgot', { email: 'ali@acme.test' });
    assert.equal(unknown.statusCode, 200);
    assert.equal(JSON.parse(unknown.body).message, JSON.parse(known.body).message);
    assert.equal(lastTo('nobody@nowhere.test'), undefined, 'no email to unknown addresses');
    assert.equal((await post('/api/auth/password/forgot', { email: 'not-an-email' })).statusCode, 400);
  });

  test('the link sets a new password once; the old password and old sessions stop working', async () => {
    const before = JSON.parse((await login('ali@acme.test', DEMO_PASSWORD)).body).token;
    t.clock.set(new Date(t.clock.now().getTime() + 2000)); // the reset happens a moment after that sign-in
    await post('/api/auth/password/forgot', { email: 'ALI@acme.test' });
    const mail = lastTo('ali@acme.test');
    assert.match(mail.subject, /Reset your .* password/);
    assert.match(mail.text, /^https:\/\/hrm\.example\/#\/reset\?token=/m);
    const [token] = tokensIn(mail);
    const stored = await t.db.one('select token_hash from password_resets order by created_at desc limit 1');
    assert.notEqual(stored.token_hash, token, 'only a hash is stored');

    assert.equal((await post('/api/auth/password/reset', { token, password: 'short' })).statusCode, 400);
    const ok = await post('/api/auth/password/reset', { token, password: 'NewSecret#2026' });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).company, 'Acme Technologies (Pvt) Ltd');
    assert.equal((await post('/api/auth/password/reset', { token, password: 'Another#2026' })).statusCode, 400, 'works once');

    assert.equal((await login('ali@acme.test', DEMO_PASSWORD)).statusCode, 401);
    const fresh = await login('ali@acme.test', 'NewSecret#2026');
    assert.equal(fresh.statusCode, 200);
    const old = await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${before}` } });
    assert.equal(old.statusCode, 401, 'signed out everywhere');
    assert.match(JSON.parse(old.body).error.message, /password was changed/);
    const now = await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${JSON.parse(fresh.body).token}` } });
    assert.equal(now.statusCode, 200);
  });

  test('only the newest link works, and links expire after an hour', async () => {
    await post('/api/auth/password/forgot', { email: 'bilal@acme.test' });
    const [first] = tokensIn(lastTo('bilal@acme.test'));
    await post('/api/auth/password/forgot', { email: 'bilal@acme.test' });
    const [second] = tokensIn(lastTo('bilal@acme.test'));
    assert.equal((await post('/api/auth/password/reset', { token: first, password: 'Whatever#2026' })).statusCode, 400);
    t.clock.set(new Date(t.clock.now().getTime() + 61 * 60_000));
    assert.equal((await post('/api/auth/password/reset', { token: second, password: 'Whatever#2026' })).statusCode, 400);
  });

  test('an email that signs in to two companies gets a link for each, and each resets only its own login', async () => {
    const hr = JSON.parse((await login('hr@acme.test', DEMO_PASSWORD)).body).token;
    const gx = JSON.parse((await login('hr+globex@acme.test', DEMO_PASSWORD)).body).token;
    for (const token of [hr, gx]) {
      const r = await post('/api/employees', { full_name: 'Zara Both', joining_date: '2026-01-05', login: { email: 'zara@both.test', password: 'Original#1' } },
        { authorization: `Bearer ${token}` });
      assert.equal(r.statusCode, 201);
    }
    await post('/api/auth/password/forgot', { email: 'zara@both.test' });
    const mail = lastTo('zara@both.test');
    const links = tokensIn(mail);
    assert.equal(links.length, 2);
    assert.match(mail.text, /Acme Technologies/);
    // The first link in the email belongs to Acme (sorted by company name)
    await post('/api/auth/password/reset', { token: links[0], password: 'AcmeOnly#2026' });
    assert.equal((await login('zara@both.test', 'AcmeOnly#2026')).statusCode, 200);
    const globexStill = await login('zara@both.test', 'Original#1');
    assert.equal(globexStill.statusCode, 200);
    assert.equal(JSON.parse(globexStill.body).user.tenantId, globex.tenant.id);
  });
});
