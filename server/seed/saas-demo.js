/**
 * Dummy SaaS data for testing the super admin panel: one company in every
 * subscription situation, each with an HR admin and an employee login
 * (password DEMO_PASSWORD), its own logo (seed/logos), plus three months of paid invoices for Acme so
 * the dashboard's revenue chart has data.
 *
 * Billing states are produced by the real billing code run at past dates
 * (changePlan, recordPayment, the daily job), not written by hand, so they
 * behave exactly like real companies. Idempotent: existing slugs are skipped.
 */
import { readFile } from 'node:fs/promises';
import { addDays } from '../src/lib/dates.js';
import { setLogo } from '../src/services/company.js';
import { fixedClock, systemClock } from '../src/lib/clock.js';
import { changePlan, recordPayment, runBillingJobs, setTenantStatus } from '../src/services/billing.js';
import { createEmployee } from '../src/services/employees.js';
import { loadDefaults, provisionTenant } from '../src/services/tenants.js';
import { DEMO_PASSWORD } from './demo.js';

// slug, name, what to do. Days are counted back from today.
export const DEMO_COMPANIES = [
  { slug: 'globex', name: 'Globex Trading', created: 40, plan: 'starter', cycle: 'monthly', planDaysAgo: 10, note: 'Starter, invoice overdue (past due, still working)' },
  { slug: 'umbrella', name: 'Umbrella Pharma', created: 70, plan: 'professional', cycle: 'monthly', planDaysAgo: 25, note: 'Professional, unpaid after the grace period (paused)' },
  { slug: 'stark', name: 'Stark Industries', created: 50, plan: 'enterprise', cycle: 'yearly', planDaysAgo: 40, paid: true, note: 'Enterprise yearly, paid' },
  { slug: 'initech', name: 'Initech Software', created: 11, trialEndsIn: 3, note: 'Free trial ending in 3 days' },
  { slug: 'hooli', name: 'Hooli Labs', created: 16, trialEndsIn: -2, note: 'Free trial ended (paused until a plan is chosen)' },
  { slug: 'wayne', name: 'Wayne Enterprises', created: 1, pending: true, note: 'Signed up, waiting for your approval' },
  { slug: 'cyberdyne', name: 'Cyberdyne Systems', created: 90, plan: 'starter', cycle: 'yearly', planDaysAgo: 80, paid: true,
    suspend: 'Test: suspended by the super admin', note: 'Starter yearly, suspended by you' },
];

const STAFF = ['Ayesha Khan', 'Bilal Ahmed', 'Hina Raza', 'Usman Ali'];
const utcToday = (clock) => clock.now().toISOString().slice(0, 10);
const at = (ymd) => fixedClock(`${ymd}T06:00:00Z`);

async function openInvoice(db, tenantId) {
  return db.one(`select * from invoices where tenant_id = $1 and status = 'open' order by issued_on desc limit 1`, [tenantId]);
}

export async function seedSaasDemo(db, { clock = systemClock(), log = console.log } = {}) {
  const today = utcToday(clock);
  const owner = await db.one(`select id from users where access_level = 'super_admin' order by created_at limit 1`);
  const sys = (c) => ({ db, clock: c, actor: { system: true, userId: owner?.id ?? null } });
  const planId = async (code) => (await db.one('select id from plans where code = $1', [code])).id;
  const pay = async (tenantId, on) => {
    const inv = await openInvoice(db, tenantId);
    if (inv) await recordPayment(sys(at(on)), inv.id, { amount: inv.total - inv.amount_paid, method: 'bank_transfer', reference: `DEMO-${inv.number}`, receivedOn: on });
  };
  const created = [];

  // Acme (the main demo company): three months on Professional, every invoice paid two days after it was issued.
  const acme = await db.one(`select t.id from tenants t join subscriptions s on s.tenant_id = t.id where t.slug = 'acme' and s.status = 'trialing'`);
  if (acme) {
    let day = addDays(today, -95);
    await changePlan(sys(at(day)), acme.id, { planId: await planId('professional'), billingCycle: 'monthly' });
    await pay(acme.id, addDays(day, 2));
    for (let i = 0; i < 6; i += 1) {
      const { current_period_end: end } = await db.one('select current_period_end from subscriptions where tenant_id = $1', [acme.id]);
      day = addDays(end, 1);
      if (day > today) break;
      await runBillingJobs(db, at(day)); // renews: issues the next invoice
      if (addDays(day, 2) <= today) await pay(acme.id, addDays(day, 2));
    }
    created.push('acme (billing history)');
  }

  const defaults = await loadDefaults();
  for (const c of DEMO_COMPANIES) {
    if (await db.one('select 1 from tenants where slug = $1', [c.slug])) continue;
    const start = addDays(today, -c.created);
    const { tenant } = await provisionTenant(db, { name: c.name, slug: c.slug, goLiveDate: addDays(today, -120), today: start }, defaults);
    await db.query(`update tenants set created_at = $2, contact_email = $3, country = 'Pakistan' where id = $1`, [tenant.id, `${start}T09:00:00Z`, `hr@${c.slug}.test`]);
    const tctx = { db, clock: at(start), tenant, actor: { system: true }, locale: 'en' };
    await createEmployee(tctx, { full_name: `${c.name.split(' ')[0]} HR Admin`, joining_date: addDays(today, -400),
      login: { email: `hr@${c.slug}.test`, password: DEMO_PASSWORD, accessLevel: 'hr_admin' } });
    for (const [i, name] of STAFF.entries()) {
      await createEmployee(tctx, { full_name: name, joining_date: addDays(today, -300 + i * 30),
        ...(i === 0 ? { login: { email: `staff@${c.slug}.test`, password: DEMO_PASSWORD, accessLevel: 'employee' } } : {}) });
    }
    if (c.plan) {
      const assigned = addDays(today, -c.planDaysAgo);
      await changePlan(sys(at(assigned)), tenant.id, { planId: await planId(c.plan), billingCycle: c.cycle });
      if (c.paid) await pay(tenant.id, addDays(assigned, 3));
    }
    if (c.trialEndsIn != null) {
      await db.query('update subscriptions set trial_ends_on = $2 where tenant_id = $1', [tenant.id, addDays(today, c.trialEndsIn)]);
    }
    if (c.pending) await db.query(`update tenants set status = 'pending' where id = $1`, [tenant.id]);
    if (c.suspend) await setTenantStatus(sys(clock), tenant.id, { status: 'suspended', reason: c.suspend });
    created.push(c.slug);
  }

  // Each company's own logo and letterhead details (only where it has no logo yet).
  for (const slug of ['acme', ...DEMO_COMPANIES.map((c) => c.slug)]) {
    const tenant = await db.one('select * from tenants where slug = $1 and logo_updated_at is null', [slug]);
    if (!tenant) continue;
    const png = await readFile(new URL(`./logos/${slug}.png`, import.meta.url)).catch(() => null);
    if (!png) continue;
    await setLogo({ db, tenant, actor: { system: true } }, { dataUrl: png.toString('base64') });
    await db.query(`update tenants set address = coalesce(address, $2), phone = coalesce(phone, $3) where id = $1`,
      [tenant.id, '45-B Main Boulevard, Gulberg III, Lahore', '+92 42 3500 0000']);
    if (!created.includes(slug)) created.push(`${slug} (logo)`);
  }

  // Today's run turns overdue invoices into past due / paused and ends expired trials.
  if (created.length) await runBillingJobs(db, clock);
  if (created.length) log(`SaaS demo: ${created.join(', ')}`);
  return created;
}
