/**
 * Two-step sign-in: password, then a 6-digit code emailed to the account.
 * Codes work once, expire, lock after 5 wrong tries, can be resent (not too fast).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';

describe('sign-in code (OTP)', () => {
  let t, app;
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const codeIn = (m) => m.text.match(/\b(\d{6})\b/)[1];
  const lastCode = (to) => codeIn(sent.filter((m) => m.to === to).at(-1));
  const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, payload, headers });
  const login = (email) => post('/api/auth/login', { email, password: DEMO_PASSWORD });
  const otp = (challenge, code) => post('/api/auth/login/otp', { challenge, code });

  before(async () => {
    t = await setup();
    await t.db.query(`update platform_settings set value = value || '{"loginOtp": true}'::jsonb where id = 'billing'`);
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret', mailer });
  });
  after(async () => { await app.close(); await t.close(); });

  test('the right password gives no session yet, only a challenge; the emailed code gives the session', async () => {
    const res = await login('ali@acme.test');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.otpRequired, true);
    assert.equal(body.token, undefined);
    assert.match(body.email, /^a\*+@acme\.test$/);
    assert.ok(body.devCode, 'no SMTP while testing: the code is shown');
    const code = lastCode('ali@acme.test');
    assert.equal(body.devCode, code);

    const ok = await otp(body.challenge, code);
    assert.equal(ok.statusCode, 200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${ok.json().token}` } });
    assert.equal(me.statusCode, 200);

    // The code works once
    assert.match((await otp(body.challenge, code)).body, /otp_expired/);
  });

  test('a wrong password still fails before any code is sent', async () => {
    const before = sent.length;
    const res = await post('/api/auth/login', { email: 'ali@acme.test', password: 'wrong-password' });
    assert.equal(res.statusCode, 401);
    assert.equal(sent.length, before);
  });

  test('5 wrong codes end the challenge, even the right code then fails', async () => {
    const { challenge } = (await login('ali@acme.test')).json();
    const code = lastCode('ali@acme.test');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left--) {
      const r = await otp(challenge, wrong);
      assert.equal(r.statusCode, 401);
      assert.match(r.body, new RegExp(`${left} tr`));
    }
    assert.match((await otp(challenge, wrong)).body, /otp_locked/);
    assert.match((await otp(challenge, code)).body, /otp_expired/);
  });

  test('codes expire after 10 minutes; an older code stops working when a new sign-in starts', async () => {
    const first = (await login('ali@acme.test')).json();
    const firstCode = lastCode('ali@acme.test');
    const second = (await login('ali@acme.test')).json();
    assert.match((await otp(first.challenge, firstCode)).body, /otp_expired/);

    const start = t.clock.now();
    t.clock.set(new Date(start.getTime() + 11 * 60_000));
    assert.match((await otp(second.challenge, lastCode('ali@acme.test'))).body, /otp_expired/);
    t.clock.set(start);
  });

  test('resend: not within 30 seconds, then a new code that replaces the old one', async () => {
    const { challenge } = (await login('ali@acme.test')).json();
    const oldCode = lastCode('ali@acme.test');
    const tooSoon = await post('/api/auth/login/otp/resend', { challenge });
    assert.equal(tooSoon.statusCode, 429);
    assert.match(tooSoon.body, /otp_resend_wait/);

    const start = t.clock.now();
    t.clock.set(new Date(start.getTime() + 31_000));
    const again = await post('/api/auth/login/otp/resend', { challenge });
    assert.equal(again.statusCode, 200);
    const newCode = lastCode('ali@acme.test');
    if (newCode !== oldCode) assert.match((await otp(challenge, oldCode)).body, /otp_wrong/);
    assert.equal((await otp(challenge, newCode)).statusCode, 200);
    t.clock.set(start);
  });

  test('a made-up challenge is refused', async () => {
    assert.match((await otp('x'.repeat(43), '123456')).body, /otp_expired/);
    assert.equal((await otp('x'.repeat(43), '12')).statusCode, 400);
  });

  test('turned off in Settings: the password alone signs in again', async () => {
    await t.db.query(`update platform_settings set value = value || '{"loginOtp": false}'::jsonb where id = 'billing'`);
    const res = (await login('ali@acme.test')).json();
    assert.ok(res.token);
    assert.equal(res.otpRequired, undefined);
    await t.db.query(`update platform_settings set value = value || '{"loginOtp": true}'::jsonb where id = 'billing'`);
  });
});
