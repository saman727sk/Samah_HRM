/**
 * Public company sign-up (email verification, one-time links, no account
 * enumeration, rate limit) and online payments through Stripe Checkout
 * (signed webhooks with Stripe's real verification, idempotent redelivery,
 * plan purchase and invoice payment, company isolation).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';
import { stripeProvider } from '../src/services/payments.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const realStripe = new Stripe('sk_test_offline');

function mailbox() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); }, last: (to) => sent.filter((m) => m.to === to).at(-1) };
}

describe('public sign-up', () => {
  let t, app, mail;
  const signup = (body, ip) => app.inject({ method: 'POST', url: '/api/auth/signup', payload: body, remoteAddress: ip });
  const verify = (token) => app.inject({ method: 'POST', url: '/api/auth/signup/verify', payload: { token } });
  const tokenIn = (m) => /token=([\w-]+)/.exec(m.text)?.[1];
  const form = { companyName: 'Wayne Logistics', ownerName: 'Lucius Fox', email: 'lucius@wayne.test', password: 'Gotham2026!',
    timezone: 'Asia/Karachi', currency: 'PKR', country: 'Pakistan' };

  before(async () => {
    t = await setup();
    mail = mailbox();
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret', mailer: mail, appUrl: 'https://hrm.example' });
    // These tests cover sign-up itself; approval by the super admin has its own test below.
    await t.db.query(`update platform_settings set value = value || '{"signupRequiresApproval": false}' where id = 'billing'`);
  });
  after(async () => { await app.close(); await t.close(); });

  test('validates the form', async () => {
    const res = await signup({ ...form, email: 'nope', password: 'short' }, '10.0.0.1');
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error.message, /valid work email.*8 characters/);
  });

  test('nothing is created until the emailed link is opened; the link signs the owner in', async () => {
    const before = (await t.db.one('select count(*)::int as n from tenants')).n;
    assert.equal((await signup(form, '10.0.0.1')).statusCode, 202);
    assert.equal((await t.db.one('select count(*)::int as n from tenants')).n, before);
    const email = mail.last(form.email);
    assert.match(email.text, /^https:\/\/hrm\.example\/#\/verify\?token=/m);
    const stored = await t.db.one('select token_hash, password_hash from signup_requests where email = $1', [form.email]);
    assert.notEqual(stored.token_hash, tokenIn(email), 'only a hash of the token is stored');
    assert.notEqual(stored.password_hash, form.password);

    const res = await verify(tokenIn(email));
    assert.equal(res.statusCode, 200);
    const { token, company } = JSON.parse(res.body);
    assert.equal(company, 'Wayne Logistics');
    const me = JSON.parse((await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${token}` } })).body);
    assert.equal(me.user.accessLevel, 'hr_admin');
    assert.equal(me.tenant.name, 'Wayne Logistics');
    assert.equal(me.subscription.status, 'trialing');
    assert.equal(me.employee.full_name, 'Lucius Fox');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: form.email, password: form.password } });
    assert.equal(login.statusCode, 200, 'the password chosen at sign-up works');
    const tenant = await t.db.one('select slug, contact_email, country from tenants where name = $1', ['Wayne Logistics']);
    assert.deepEqual(tenant, { slug: 'wayne-logistics', contact_email: form.email, country: 'Pakistan' });
  });

  test('a link works once', async () => {
    const reused = await verify(tokenIn(mail.last(form.email)));
    assert.equal(reused.statusCode, 400);
    assert.equal((await verify('x'.repeat(43))).statusCode, 400);
  });

  test("the platform owner's email can't register a company, and the answer looks the same", async () => {
    const res = await signup({ ...form, email: 'owner@hrm.test' }, '10.0.0.2');
    assert.equal(res.statusCode, 202);
    assert.match(mail.last('owner@hrm.test').subject, /already have/);
    assert.equal((await t.db.one(`select count(*)::int as n from signup_requests where email = 'owner@hrm.test'`)).n, 0);
  });

  test('someone with a login in one company can register another; signing in then asks which company', async () => {
    await signup({ ...form, companyName: 'Sara Consulting', email: 'hr@acme.test', password: DEMO_PASSWORD }, '10.0.0.6');
    assert.match(mail.last('hr@acme.test').subject, /Confirm your email/);
    assert.equal((await verify(tokenIn(mail.last('hr@acme.test')))).statusCode, 200);
    const both = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'hr@acme.test', password: DEMO_PASSWORD } });
    assert.equal(both.statusCode, 409);
    const { companies } = JSON.parse(both.body).error.details;
    assert.deepEqual(companies.map((c) => c.name).sort(), ['Acme Technologies (Pvt) Ltd', 'Sara Consulting']);
  });

  test('links expire after 24 hours; a second sign-up for the same email replaces the first', async () => {
    const email = 'late@example.test';
    await signup({ ...form, companyName: 'Late Co', email }, '10.0.0.3');
    const first = tokenIn(mail.last(email));
    await signup({ ...form, companyName: 'Late Co', email }, '10.0.0.3');
    const second = tokenIn(mail.last(email));
    assert.equal((await verify(first)).statusCode, 400, 'replaced');
    t.clock.set(new Date(t.clock.now().getTime() + 25 * 3600_000));
    assert.equal((await verify(second)).statusCode, 400, 'expired');
  });

  test('the same company name gets its own slug', async () => {
    const email = 'second@wayne.test';
    await signup({ ...form, email }, '10.0.0.4');
    assert.equal((await verify(tokenIn(mail.last(email)))).statusCode, 200);
    const { slug } = await t.db.one(`select slug from tenants where contact_email = $1`, [email]);
    assert.match(slug, /^wayne-logistics-[0-9a-f]{4}$/);
  });

  test('the super admin can close sign-ups', async () => {
    const owner = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@hrm.test', password: DEMO_PASSWORD } })).body).token;
    await app.inject({ method: 'PUT', url: '/api/admin/billing-settings', payload: { signupEnabled: false }, headers: { authorization: `Bearer ${owner}` } });
    assert.equal(JSON.parse((await app.inject({ url: '/api/auth/config' })).body).signupEnabled, false);
    assert.equal((await signup({ ...form, email: 'closed@example.test' }, '10.0.0.5')).statusCode, 403);
    await app.inject({ method: 'PUT', url: '/api/admin/billing-settings', payload: { signupEnabled: true }, headers: { authorization: `Bearer ${owner}` } });
  });

  test('with approval on, a new company waits for the super admin, who approves or rejects it', async () => {
    const owner = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@hrm.test', password: DEMO_PASSWORD } })).body).token;
    const admin = (method, url, body) => app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${owner}` } });
    await admin('PUT', '/api/admin/billing-settings', { signupRequiresApproval: true, supportEmail: 'sales@samah.test' });
    const signIn = (email) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: form.password } });

    for (const [email, name] of [['ok@pending.test', 'Approved Co'], ['no@pending.test', 'Rejected Co']]) {
      await signup({ ...form, companyName: name, email }, '10.0.1.1');
      const v = JSON.parse((await verify(tokenIn(mail.last(email)))).body);
      assert.equal(v.pending, true);
      assert.equal(v.token, null, 'no sign-in while pending');
    }
    assert.match(mail.last('sales@samah.test').subject, /awaiting approval: Rejected Co/);
    const blocked = await signIn('ok@pending.test');
    assert.equal(blocked.statusCode, 403);
    assert.equal(JSON.parse(blocked.body).error.code, 'tenant_pending');

    const list = JSON.parse((await admin('GET', '/api/admin/tenants?status=pending')).body);
    const approved = list.find((c) => c.name === 'Approved Co');
    const rejected = list.find((c) => c.name === 'Rejected Co');
    assert.equal((await admin('POST', `/api/admin/tenants/${approved.id}/approve`)).statusCode, 200);
    assert.match(mail.last('ok@pending.test').subject, /approved/);
    assert.equal((await signIn('ok@pending.test')).statusCode, 200);
    assert.equal((await admin('POST', `/api/admin/tenants/${approved.id}/approve`)).statusCode, 409, 'only pending companies');

    assert.equal((await admin('POST', `/api/admin/tenants/${rejected.id}/reject`, {})).statusCode, 400, 'reason required');
    assert.equal((await admin('POST', `/api/admin/tenants/${rejected.id}/reject`, { reason: 'Test account' })).statusCode, 200);
    assert.equal(JSON.parse((await signIn('no@pending.test')).body).error.code, 'tenant_suspended');
    await admin('PUT', '/api/admin/billing-settings', { signupRequiresApproval: false });
  });

  test('sign-ups are rate limited per network address', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await signup({ ...form, email: `flood${i}@example.test` }, '10.9.9.9')).statusCode);
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
  });
});

describe('online payments (Stripe Checkout)', () => {
  let t, app, plain, globex;
  const sessions = [];
  const tokens = {};
  const fakeClient = {
    checkout: { sessions: { create: async (params) => { sessions.push(params); return { id: `cs_test_${sessions.length}`, url: `https://checkout.stripe.test/${sessions.length}` }; } } },
    webhooks: realStripe.webhooks,
  };
  const call = async (who, method, url, body, on = app) => {
    const res = await on.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  /** A Stripe event signed exactly as Stripe signs it. */
  const deliver = (eventId, type, s, { secret = WEBHOOK_SECRET } = {}) => {
    const payload = JSON.stringify({ id: eventId, object: 'event', type, data: { object: {
      object: 'checkout.session', id: s.id, payment_status: s.paid === false ? 'unpaid' : 'paid',
      amount_total: Math.round(s.amount * 100), currency: (s.currency ?? 'pkr').toLowerCase(), payment_intent: s.pi ?? `pi_${s.id}` } } });
    const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret });
    return app.inject({ method: 'POST', url: '/api/billing/webhook', payload, headers: { 'content-type': 'application/json', 'stripe-signature': signature } });
  };
  const sub = async (who = 'hr') => (await call(who, 'GET', '/api/billing/subscription')).body;

  before(async () => {
    t = await setup();
    globex = await seedDemo(t.db, { rounds: 4, slug: 'globex' });
    const payments = await stripeProvider({ webhookSecret: WEBHOOK_SECRET, client: fakeClient });
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret', payments, appUrl: 'https://hrm.example' });
    plain = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    for (const [who, email] of [['hr', 'hr@acme.test'], ['ali', 'ali@acme.test'], ['globexHr', 'hr+globex@acme.test'], ['owner', 'owner@hrm.test']]) {
      tokens[who] = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } })).body).token;
    }
  });
  after(async () => { await app.close(); await plain.close(); await t.close(); });

  test('without a provider, online payment is off', async () => {
    assert.equal((await call('hr', 'GET', '/api/billing/subscription', undefined, plain)).body.onlinePayments, false);
    assert.equal((await call('hr', 'POST', '/api/billing/checkout', { planId: 'x' }, plain)).status, 400);
  });

  test('buying a plan opens Stripe Checkout and changes nothing until Stripe confirms', async () => {
    const pro = (await sub()).plans.find((p) => p.code === 'professional');
    assert.equal((await call('ali', 'POST', '/api/billing/checkout', { planId: pro.id })).status, 403, 'employees cannot pay');
    const res = await call('hr', 'POST', '/api/billing/checkout', { planId: pro.id, billingCycle: 'monthly' });
    assert.equal(res.status, 200);
    assert.equal(res.body.url, 'https://checkout.stripe.test/1');
    const sent = sessions[0];
    assert.equal(sent.mode, 'payment');
    assert.equal(sent.line_items[0].price_data.unit_amount, 999900);
    assert.equal(sent.line_items[0].price_data.currency, 'pkr');
    assert.equal(sent.success_url, 'https://hrm.example/#/billing?checkout=success');
    assert.equal(sent.customer_email, 'hr@acme.test');
    assert.equal((await sub()).subscription.status, 'trialing');
  });

  test('forged or unsigned webhooks are rejected', async () => {
    assert.equal((await deliver('evt_forged', 'checkout.session.completed', { id: 'cs_test_1', amount: 9999 }, { secret: 'whsec_wrong' })).statusCode, 400);
    const unsigned = await app.inject({ method: 'POST', url: '/api/billing/webhook', payload: { id: 'evt_x' } });
    assert.equal(unsigned.statusCode, 400);
    assert.equal((await sub()).subscription.status, 'trialing');
  });

  test('a paid checkout activates the plan and records the payment once, however often Stripe redelivers it', async () => {
    const first = await deliver('evt_1', 'checkout.session.completed', { id: 'cs_test_1', amount: 9999, pi: 'pi_1' });
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).status, 'processed');
    assert.equal(JSON.parse((await deliver('evt_1', 'checkout.session.completed', { id: 'cs_test_1', amount: 9999, pi: 'pi_1' })).body).status, 'processed');
    await deliver('evt_1b', 'checkout.session.completed', { id: 'cs_test_1', amount: 9999, pi: 'pi_1' }); // same session, new event id
    const s = await sub();
    assert.equal(s.subscription.status, 'active');
    assert.equal(s.subscription.plan_code, 'professional');
    assert.equal(s.invoices.length, 1);
    assert.equal(s.invoices[0].status, 'paid');
    assert.equal(s.payments.length, 1);
    assert.equal(s.payments[0].provider, 'stripe');
    assert.equal(s.payments[0].reference, 'pi_1');
  });

  test('paying an open invoice online', async () => {
    const ent = (await call('owner', 'GET', '/api/admin/plans')).body.find((p) => p.code === 'enterprise');
    const { invoice } = (await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/plan`, { planId: ent.id })).body;
    assert.equal((await call('globexHr', 'POST', '/api/billing/checkout', { invoiceId: invoice.id })).status, 404, "another company's invoice");
    const res = await call('hr', 'POST', '/api/billing/checkout', { invoiceId: invoice.id });
    assert.equal(res.status, 200);
    assert.equal(sessions.at(-1).line_items[0].price_data.unit_amount, 2499900);
    await deliver('evt_2', 'checkout.session.completed', { id: `cs_test_${sessions.length}`, amount: 24999, pi: 'pi_2' });
    assert.equal((await sub()).invoices.find((i) => i.id === invoice.id).status, 'paid');
  });

  test('an unpaid session is ignored; a payment for an invoice already settled is flagged for refund', async () => {
    const ent = (await call('owner', 'GET', '/api/admin/plans')).body.find((p) => p.code === 'professional');
    const { invoice } = (await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/plan`, { planId: ent.id, billingCycle: 'yearly' })).body;
    await call('hr', 'POST', '/api/billing/checkout', { invoiceId: invoice.id });
    const session = { id: `cs_test_${sessions.length}`, amount: invoice.total, pi: 'pi_3' };
    assert.equal(JSON.parse((await deliver('evt_3a', 'checkout.session.completed', { ...session, paid: false })).body).status, 'ignored');
    await call('owner', 'POST', `/api/admin/invoices/${invoice.id}/payments`, { amount: invoice.total, method: 'bank_transfer' }); // paid by bank meanwhile
    await deliver('evt_3b', 'checkout.session.async_payment_succeeded', session);
    const checkout = await t.db.one('select status, note from payment_checkouts where session_id = $1', [session.id]);
    assert.equal(checkout.status, 'completed');
    assert.match(checkout.note, /already paid.*Refund/);
    assert.equal((await sub()).payments.filter((p) => p.invoice_id === invoice.id).length, 1, 'no second payment recorded');
  });

  test('a checkout for one company never touches another', async () => {
    const other = await sub('globexHr');
    assert.equal(other.subscription.status, 'trialing');
    assert.equal(other.payments.length, 0);
    assert.equal(other.subscription.tenant_id, globex.tenant.id);
  });
});
