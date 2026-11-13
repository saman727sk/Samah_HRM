/**
 * Payments reported by a company (bank transfer, cash...) with a receipt,
 * confirmed or rejected by the super admin: clears invoices, can buy a plan,
 * notifies the company, and never crosses companies.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';

const receipt = (await readFile(new URL('../seed/logos/acme.png', import.meta.url))).toString('base64');

describe('payments reported by companies', () => {
  let t, app, globex;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : res.rawPayload) : null };
  };
  const sub = async (who = 'hr') => (await call(who, 'GET', '/api/billing/subscription')).body;
  const planId = async (code) => (await call('owner', 'GET', '/api/admin/plans')).body.find((p) => p.code === code).id;

  before(async () => {
    t = await setup();
    globex = await seedDemo(t.db, { rounds: 4, slug: 'globex' });
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    for (const [who, email] of [['hr', 'hr@acme.test'], ['ali', 'ali@acme.test'], ['globexHr', 'hr+globex@acme.test'], ['owner', 'owner@hrm.test']]) {
      tokens[who] = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } })).body).token;
    }
    await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/plan`, { planId: await planId('professional') });
  });
  after(async () => { await app.close(); await t.close(); });

  test('HR reports a payment for an open invoice, with a receipt; checks on the way in', async () => {
    const inv = (await sub()).invoices[0];
    const base = { invoiceId: inv.id, amount: inv.amount_due, method: 'bank_transfer', reference: 'HBL-778899', paidOn: '2026-03-04' };
    assert.equal((await call('ali', 'POST', '/api/billing/payments', base)).status, 403, 'employees cannot');
    assert.equal((await call('hr', 'POST', '/api/billing/payments', { ...base, reference: '' })).status, 400, 'transfer needs a reference');
    assert.equal((await call('hr', 'POST', '/api/billing/payments', { ...base, amount: inv.amount_due + 1 })).status, 400, 'not more than due');
    assert.equal((await call('hr', 'POST', '/api/billing/payments', { ...base, proof: Buffer.from('<svg/>').toString('base64') })).status, 400, 'receipt type');
    assert.equal((await call('globexHr', 'POST', '/api/billing/payments', base)).status, 404, "another company's invoice");
    const ok = await call('hr', 'POST', '/api/billing/payments', { ...base, proof: `data:image/png;base64,${receipt}` });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.status, 'pending');
    assert.equal((await call('hr', 'POST', '/api/billing/payments', base)).status, 409, 'one pending report per invoice');
    const mine = (await sub()).submissions;
    assert.equal(mine[0].status, 'pending');
    assert.equal(mine[0].has_proof, true);
    assert.equal((await call('hr', 'GET', `/api/billing/payments/${mine[0].id}/proof`)).status, 200);
    assert.equal((await call('globexHr', 'GET', `/api/billing/payments/${mine[0].id}/proof`)).status, 404, "can't see another company's receipt");
    const notes = (await call('hr', 'GET', '/api/notifications')).body;
    assert.ok(notes.some((n) => n.event === 'billing_payment_submitted'));
  });

  test('the owner sees it, opens the receipt, confirms it: the invoice is paid', async () => {
    assert.equal((await call('owner', 'GET', '/api/admin/dashboard')).body.people.payments_to_verify, 1);
    const [s] = (await call('owner', 'GET', '/api/admin/payment-submissions?status=pending')).body;
    assert.equal(s.company, 'Acme Technologies (Pvt) Ltd');
    const proof = await call('owner', 'GET', `/api/admin/payment-submissions/${s.id}/proof`);
    assert.equal(proof.status, 200);
    assert.equal((await call('hr', 'POST', `/api/admin/payment-submissions/${s.id}/confirm`)).status, 403, 'only the owner confirms');
    assert.equal((await call('owner', 'POST', `/api/admin/payment-submissions/${s.id}/confirm`)).status, 200);
    assert.equal((await call('owner', 'POST', `/api/admin/payment-submissions/${s.id}/confirm`)).status, 409, 'once');
    const after = await sub();
    assert.equal(after.invoices[0].status, 'paid');
    assert.equal(after.payments[0].reference, 'HBL-778899');
    assert.equal(after.submissions[0].status, 'confirmed');
    assert.ok((await call('hr', 'GET', '/api/notifications')).body.some((n) => n.event === 'billing_payment_received'));
  });

  test('a company on trial can buy a plan this way: the plan starts when the owner confirms', async () => {
    const pro = await planId('professional');
    assert.equal((await sub('globexHr')).subscription.status, 'trialing');
    const r = await call('globexHr', 'POST', '/api/billing/payments', { planId: pro, billingCycle: 'monthly', amount: 9999, method: 'online', reference: 'JazzCash 5566' });
    assert.equal(r.status, 201);
    assert.equal((await sub('globexHr')).subscription.status, 'trialing', 'nothing changes before confirmation');
    await call('owner', 'POST', `/api/admin/payment-submissions/${r.body.id}/confirm`);
    const s = await sub('globexHr');
    assert.equal(s.subscription.status, 'active');
    assert.equal(s.subscription.plan_code, 'professional');
    assert.equal(s.invoices[0].status, 'paid');
    assert.equal(s.subscription.tenant_id, globex.tenant.id);
  });

  test('rejecting needs a reason, tells the company, and lets them send it again', async () => {
    await call('owner', 'POST', `/api/admin/tenants/${t.tenant.id}/plan`, { planId: await planId('enterprise') });
    const inv = (await sub()).invoices.find((i) => i.status === 'open');
    const r = await call('hr', 'POST', '/api/billing/payments', { invoiceId: inv.id, amount: inv.amount_due, method: 'cash', paidOn: '2026-03-03' });
    assert.equal((await call('owner', 'POST', `/api/admin/payment-submissions/${r.body.id}/reject`, {})).status, 400);
    assert.equal((await call('owner', 'POST', `/api/admin/payment-submissions/${r.body.id}/reject`, { reason: 'No cash received' })).body.status, 'rejected');
    const s = await sub();
    assert.equal(s.submissions[0].review_note, 'No cash received');
    assert.equal(s.invoices.find((i) => i.id === inv.id).status, 'open', 'still owed');
    const note = (await call('hr', 'GET', '/api/notifications')).body.find((n) => n.event === 'billing_payment_rejected');
    assert.match(note.body, /No cash received/);
    assert.equal((await call('hr', 'POST', '/api/billing/payments', { invoiceId: inv.id, amount: inv.amount_due, method: 'cash' })).status, 201, 'can try again');
  });
});
