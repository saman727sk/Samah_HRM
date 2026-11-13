/**
 * SaaS billing over HTTP: plans, plan changes and invoices, module and
 * employee limits, overdue > blocked > paid, renewals without double
 * billing, refunds, trial expiry, suspension and company isolation.
 * The clock starts on Wed 2026-03-04 and is moved forward by the tests.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';

describe('billing', () => {
  let t, app, globex;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const login = async (who, email) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } });
    assert.equal(res.statusCode, 200, `login ${email}`);
    tokens[who] = JSON.parse(res.body).token;
  };
  const day = (ymd) => t.clock.set(new Date(`${ymd}T05:00:00Z`));
  const plan = async (code) => (await call('owner', 'GET', '/api/admin/plans')).body.find((p) => p.code === code);
  const acmeSub = async () => (await call('hr', 'GET', '/api/billing/subscription')).body;
  const runJob = async () => (await call('owner', 'POST', '/api/admin/billing/run')).body;

  before(async () => {
    t = await setup();
    globex = await seedDemo(t.db, { rounds: 4, slug: 'globex' });
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    await login('owner', 'owner@hrm.test');
    await login('hr', 'hr@acme.test');
    await login('ali', 'ali@acme.test');
    await login('globexHr', 'hr+globex@acme.test');
  });
  after(async () => { await app.close(); await t.close(); });

  test('new companies start on the trial plan; only the super admin manages billing', async () => {
    const sub = await acmeSub();
    assert.equal(sub.subscription.status, 'trialing');
    assert.equal(sub.subscription.plan_code, 'trial');
    assert.equal((await call('hr', 'GET', '/api/admin/plans')).status, 403);
    assert.equal((await call('hr', 'GET', '/api/admin/dashboard')).status, 403);
    assert.equal((await call('ali', 'GET', '/api/billing/subscription')).status, 403, 'employees do not see billing');
    assert.equal((await call('owner', 'GET', '/api/admin/plans')).body.length, 7);
  });

  test('plans: validation, unique code, code cannot change, price change keeps existing subscriptions', async () => {
    assert.equal((await call('owner', 'POST', '/api/admin/plans', { code: 'Bad Code', name: '' })).status, 400);
    const created = await call('owner', 'POST', '/api/admin/plans',
      { code: 'team', name: 'Team', currency: 'PKR', price_monthly: 2000, price_yearly: 20000, max_employees: 15, modules: ['attendance', 'leave'] });
    assert.equal(created.status, 201);
    assert.equal((await call('owner', 'POST', '/api/admin/plans', { code: 'team', name: 'Again' })).status, 409);
    assert.equal((await call('owner', 'PATCH', `/api/admin/plans/${created.body.id}`, { code: 'other' })).status, 409);
    assert.equal((await call('owner', 'PATCH', `/api/admin/plans/${created.body.id}`, { modules: ['nope'] })).status, 400);
    assert.equal((await call('owner', 'PATCH', `/api/admin/plans/${created.body.id}`, { currency: 'XYZ' })).status, 400, 'not an ISO currency');
    assert.equal((await call('owner', 'PATCH', `/api/admin/plans/${created.body.id}`, { currency: 'EUR' })).body.currency, 'EUR');
  });

  test('a plan can be deleted only if no company ever used it, and never the plan new companies start on', async () => {
    const spare = await call('owner', 'POST', '/api/admin/plans', { code: 'spare', name: 'Spare', currency: 'PKR', price_monthly: 100, price_yearly: 1000 });
    assert.equal((await call('hr', 'DELETE', `/api/admin/plans/${spare.body.id}`)).status, 403);
    assert.equal((await call('owner', 'DELETE', `/api/admin/plans/${spare.body.id}`)).status, 204);
    assert.equal((await plan('spare')), undefined);
    const trial = await call('owner', 'DELETE', `/api/admin/plans/${(await plan('trial')).id}`);
    assert.equal(trial.status, 409, 'new companies start on it (and companies used it)');
    assert.equal((await call('owner', 'DELETE', '/api/admin/plans/00000000-0000-0000-0000-000000000000')).status, 404);
  });

  test('assigning a paid plan issues one invoice and notifies HR', async () => {
    const pro = await plan('professional');
    const res = await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/plan`, { planId: pro.id, billingCycle: 'monthly' });
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.status, 'active');
    assert.equal(res.body.subscription.current_period_start, '2026-03-04');
    assert.equal(res.body.subscription.current_period_end, '2026-04-03');
    assert.equal(res.body.invoice.total, 9999);
    assert.equal(res.body.invoice.due_on, '2026-03-11');
    assert.match(res.body.invoice.number, /^INV-2026-\d{6}$/);
    const notes = (await call('hr', 'GET', '/api/notifications')).body;
    assert.ok(notes.some((n) => n.event === 'billing_invoice_issued' && n.title.includes(res.body.invoice.number)));
    // Changing the plan's price later does not touch this company's price.
    await call('owner', 'PATCH', `/api/admin/plans/${pro.id}`, { price_monthly: 12000 });
    assert.equal((await acmeSub()).subscription.price, 9999);
    await call('owner', 'PATCH', `/api/admin/plans/${pro.id}`, { price_monthly: 9999 });
  });

  test('a company sees only its own subscription and invoices', async () => {
    const acme = await acmeSub();
    const other = (await call('globexHr', 'GET', '/api/billing/subscription')).body;
    assert.equal(acme.invoices.length, 1);
    assert.equal(other.invoices.length, 0);
    assert.equal(other.subscription.tenant_id, globex.tenant.id);
    assert.equal((await call('globexHr', 'GET', `/api/admin/tenants/${t.tenant.id}`)).status, 403);
  });

  test('modules outside the plan are off and cannot be switched on', async () => {
    const res = await call('hr', 'PUT', '/api/features/selfie_verification', { enabled: true });
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'plan_feature');
    const flags = (await call('hr', 'GET', '/api/features')).body;
    assert.equal(flags.find((f) => f.module_key === 'selfie_verification').included, false);
    assert.equal(flags.find((f) => f.module_key === 'payroll').included, true);
  });

  test('employee limit is enforced by the server', async () => {
    assert.equal((await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/limits`, { maxEmployees: 12, maxAdmins: 5 })).status, 200);
    const res = await call('hr', 'POST', '/api/employees', { full_name: 'One Too Many', joining_date: '2026-03-01' });
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'plan_limit');
    await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/limits`, { maxEmployees: 100, maxAdmins: 5 });
    assert.equal((await call('hr', 'POST', '/api/employees', { full_name: 'Fits Now', joining_date: '2026-03-01' })).status, 201);
  });

  test('overdue -> past due (still works) -> unpaid after the grace period (blocked except billing)', async () => {
    day('2026-03-12');
    assert.equal((await runJob()).pastDue, 1);
    assert.equal((await call('hr', 'GET', '/api/employees')).status, 200);
    const me = (await call('hr', 'GET', '/api/me')).body;
    assert.equal(me.subscription.status, 'past_due');
    assert.equal(me.subscription.overdue.amountDue, 9999);

    day('2026-03-19'); // due 03-11 + 7 grace days = 03-18
    assert.equal((await runJob()).unpaid, 1);
    await runJob(); // idempotent
    const blocked = await call('hr', 'GET', '/api/employees');
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.error.code, 'subscription_inactive');
    assert.equal((await call('ali', 'POST', '/api/attendance/punch', { method: 'wfh' })).status, 402);
    assert.equal((await call('hr', 'GET', '/api/billing/subscription')).status, 200);
    assert.equal((await call('hr', 'GET', '/api/me')).body.subscription.blocked, true);
    const events = (await call('owner', 'GET', `/api/admin/tenants/${t.tenant.id}`)).body.events;
    assert.equal(events.filter((e) => e.event === 'unpaid').length, 1);
    assert.equal((await call('globexHr', 'GET', '/api/employees')).status, 200, 'other companies are unaffected');
  });

  test('recording payments restores access; overpaying is refused', async () => {
    const inv = (await acmeSub()).invoices[0];
    assert.equal((await call('owner', 'POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 20000, method: 'bank_transfer' })).status, 400);
    assert.equal((await call('owner', 'POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 100, method: 'card', receivedOn: '2026-04-01' })).status, 400, 'future date');
    const part = await call('owner', 'POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 4999, method: 'bank_transfer', reference: 'TRX-1' });
    assert.equal(part.status, 201);
    assert.equal(part.body.invoice.status, 'open');
    assert.equal((await call('hr', 'GET', '/api/employees')).status, 402, 'still unpaid');
    const rest = await call('owner', 'POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 5000, method: 'cash' });
    assert.equal(rest.body.invoice.status, 'paid');
    assert.equal((await acmeSub()).subscription.status, 'active');
    assert.equal((await call('hr', 'GET', '/api/employees')).status, 200);
  });

  test('renewal issues exactly one invoice per period, even when the job runs twice', async () => {
    day('2026-04-05');
    assert.equal((await runJob()).renewed, 1);
    await runJob();
    const invoices = (await acmeSub()).invoices;
    assert.equal(invoices.length, 2);
    assert.equal(invoices[0].period_start, '2026-04-04');
    assert.equal(invoices[0].period_end, '2026-05-03');
  });

  test('refunds: limited to what was paid; the invoice is owed again', async () => {
    const payments = (await call('owner', 'GET', `/api/admin/payments?tenantId=${t.tenant.id}`)).body;
    const cash = payments.find((p) => p.method === 'cash');
    assert.equal((await call('owner', 'POST', `/api/admin/payments/${cash.id}/refund`, { amount: 6000, reason: 'x' })).status, 400);
    assert.equal((await call('owner', 'POST', `/api/admin/payments/${cash.id}/refund`, { amount: 1000 })).status, 400, 'reason required');
    assert.equal((await call('owner', 'POST', `/api/admin/payments/${cash.id}/refund`, { amount: 1000, reason: 'Goodwill' })).status, 201);
    const first = (await acmeSub()).invoices.find((i) => i.period_start === '2026-03-04');
    assert.equal(first.status, 'open');
    assert.equal(first.amount_due, 1000);
  });

  test('dashboard money comes from recorded payments and subscriptions', async () => {
    const d = (await call('owner', 'GET', '/api/admin/dashboard')).body;
    assert.deepEqual(d.mrr, [{ currency: 'PKR', mrr: 9999, arr: 119988 }]);
    assert.equal(d.collected[0].total, 8999); // 4999 + 5000 - 1000 refund
    assert.equal(d.companies.total, 2);
    assert.equal(d.pending[0].invoices, 2);
  });

  test('voiding needs a reason and an invoice without payments', async () => {
    const [april, march] = (await acmeSub()).invoices;
    assert.equal((await call('owner', 'POST', `/api/admin/invoices/${march.id}/void`, { reason: 'x' })).status, 409, 'has payments');
    assert.equal((await call('owner', 'POST', `/api/admin/invoices/${april.id}/void`, {})).status, 400);
    assert.equal((await call('owner', 'POST', `/api/admin/invoices/${april.id}/void`, { reason: 'Billed in error' })).body.status, 'void');
  });

  test('suspending a company blocks every login of that company', async () => {
    assert.equal((await call('owner', 'POST', `/api/admin/tenants/${globex.tenant.id}/suspend`, {})).status, 400, 'reason required');
    await call('owner', 'POST', `/api/admin/tenants/${globex.tenant.id}/suspend`, { reason: 'Test' });
    assert.equal((await call('globexHr', 'GET', '/api/me')).status, 403);
    await call('owner', 'POST', `/api/admin/tenants/${globex.tenant.id}/reactivate`, {});
    assert.equal((await call('globexHr', 'GET', '/api/me')).status, 200);
    const audit = (await call('owner', 'GET', '/api/admin/audit')).body;
    assert.ok(audit.some((a) => a.action === 'tenant.suspended' && a.company === globex.tenant.name));
  });

  test('an ended trial blocks the company until a plan is assigned or the trial is extended', async () => {
    const trialEnd = (await call('globexHr', 'GET', '/api/billing/subscription')).body.subscription.trial_ends_on;
    t.clock.set(new Date(`${trialEnd}T00:00:00Z`).getTime() + 2 * 86400_000);
    assert.equal((await call('globexHr', 'GET', '/api/employees')).status, 402, 'blocked even before the job runs');
    await runJob();
    assert.equal((await call('globexHr', 'GET', '/api/billing/subscription')).body.subscription.status, 'expired');
    const today = t.clock.now().toISOString().slice(0, 10);
    assert.equal((await call('owner', 'POST', `/api/admin/tenants/${globex.tenant.id}/trial`, { trialEndsOn: today })).status, 200);
    assert.equal((await call('globexHr', 'GET', '/api/employees')).status, 200);
  });

  test('creating a company also creates its first HR admin, who can sign in', async () => {
    const res = await call('owner', 'POST', '/api/admin/tenants',
      { name: 'Initech', slug: 'initech', admin: { fullName: 'Peter Gibbons', email: 'peter@initech.test', password: 'Initech123!' } });
    assert.equal(res.status, 201);
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'peter@initech.test', password: 'Initech123!' } });
    assert.equal(signIn.statusCode, 200);
    tokens.initech = JSON.parse(signIn.body).token;
    const me = (await call('initech', 'GET', '/api/me')).body;
    assert.equal(me.user.accessLevel, 'hr_admin');
    assert.equal(me.subscription.status, 'trialing');
    assert.equal((await call('owner', 'POST', '/api/admin/tenants', { name: 'Dup', slug: 'initech' })).status, 409);
  });
});
