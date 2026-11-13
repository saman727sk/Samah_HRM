/**
 * Choosing the email service from server/.env, and the Resend HTTP transport (with a fake fetch).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { emailConfigured, emailProvider, resendTransport } from '../src/services/notifications.js';

describe('email transport', () => {
  test('Resend wins over SMTP; nothing set means log only', () => {
    assert.equal(emailProvider({ RESEND_API_KEY: 're_abc', SMTP_HOST: 'smtp.gmail.com' }), 'Resend');
    assert.equal(emailProvider({ SMTP_HOST: 'smtp.gmail.com' }), 'smtp.gmail.com');
    assert.equal(emailProvider({}), null);
    assert.equal(emailConfigured({}), false);
    assert.equal(emailConfigured({ RESEND_API_KEY: 're_abc' }), true);
  });

  test('Resend: posts the email with the API key', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ id: 'x' }) }; };
    const t = resendTransport({ apiKey: 're_test_123456789', from: 'Samah HRM <no-reply@samah.test>', fetchImpl });
    await t.send({ to: 'ali@acme.test', subject: 'Hi', text: 'Hello' });
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.authorization, 'Bearer re_test_123456789');
    assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Samah HRM <no-reply@samah.test>', to: ['ali@acme.test'], subject: 'Hi', text: 'Hello' });
  });

  test('Resend: a refused email throws with Resend\'s reason, so the notification is marked failed', async () => {
    const logged = [];
    const fetchImpl = async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ message: 'The domain is not verified.' }) });
    const t = resendTransport({ apiKey: 're_test_123456789', from: 'x@y.test', fetchImpl }, (m) => logged.push(m));
    await assert.rejects(t.send({ to: 'a@b.test', subject: 's', text: 't' }), (e) => e.status === 503 && e.code === 'email_failed'
      && /can't deliver to a@b.test yet/.test(e.message) && /Resend 403: The domain is not verified/.test(e.details.reason));
    const other = resendTransport({ apiKey: 're_test_123456789', from: 'x@y.test', fetchImpl: async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) }) }, () => {});
    await assert.rejects(other.send({ to: 'a@b.test', subject: 's', text: 't' }), /couldn't send the email to a@b.test/);
    assert.match(logged[0], /could not send to a@b.test/);
  });

  test('verify catches a key pasted wrongly', async () => {
    await assert.rejects(resendTransport({ apiKey: 'abc', from: 'x@y.test' }).verify(), /start with "re_"/);
    await resendTransport({ apiKey: 're_AbCdEf123456', from: 'x@y.test' }).verify();
  });
});

describe('when the email service refuses', () => {
  test('sign-up answers 503 with a clear message instead of a 500', async () => {
    const { setup } = await import('./helpers.js');
    const { buildApp } = await import('../src/api/app.js');
    const { emailFailed } = await import('../src/services/notifications.js');
    const t = await setup();
    const app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret', mailer: { send: async (m) => { throw emailFailed(m.to, 'Resend 403', 'cannot deliver yet'); } } });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { companyName: 'Zeta Ltd', ownerName: 'Zara', email: 'zara@zeta.test', password: 'Str0ng-Passw0rd!', timezone: 'Asia/Karachi', currency: 'PKR' } });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, 'email_failed');
      assert.equal(res.json().error.message, 'cannot deliver yet');
      // Forgot password keeps its usual answer (no hint that the account exists)
      const forgot = await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email: 'ali@acme.test' } });
      assert.equal(forgot.statusCode, 200);
    } finally { await app.close(); await t.close(); }
  });
});
