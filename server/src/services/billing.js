/**
 * SaaS billing: plans, one subscription per company, invoices and payments.
 *
 * Who does what
 *   super admin   plans, assigning plans, limits, trials, cancel/suspend,
 *                 recording payments and refunds, voiding invoices
 *   company HR    reads its own subscription, usage and invoices
 *   daily job     trial reminders/expiry, renewals (one invoice per period),
 *                 past_due after the due date, unpaid after the grace period
 *
 * Subscription status
 *   trialing  free until trial_ends_on          active    paid up
 *   past_due  an invoice is overdue (works)      unpaid    grace period over: blocked
 *   cancelled / expired: blocked until the super admin assigns a plan
 * Blocked companies can still sign in and see their billing page.
 *
 * Changing plan starts a new period today and voids unpaid invoices of the
 * old plan (no proration). Money is rounded to 2 decimals; dates are UTC.
 */
import { randomUUID } from 'node:crypto';
import { audit } from '../lib/audit.js';
import { addDays, addMonths, diffDays, isYmd, monthStart } from '../lib/dates.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { CURRENCY_HELP, isCurrency } from '../lib/currency.js';
import { PRODUCT_NAME } from '../lib/product.js';
import { round2 } from '../lib/util.js';
import { hrUserIds, notify } from './notifications.js';

export const MODULES = ['attendance', 'wfh', 'leave', 'payroll', 'overtime', 'loans', 'auto_checkin', 'selfie_verification'];
export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque', 'card', 'online', 'other'];
const BLOCKED = new Set(['unpaid', 'cancelled', 'expired']);

const utcToday = (clock) => clock.now().toISOString().slice(0, 10);
const periodEndFor = (start, cycle) => addDays(addMonths(start, cycle === 'yearly' ? 12 : 1), -1);
const fmt = (amount, currency) => `${currency} ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function requireSuperAdmin(ctx) {
  if (ctx.actor?.accessLevel !== 'super_admin' && !ctx.actor?.system) throw forbidden('Only the SaaS owner can manage billing.');
}

// ---------------------------------------------------------------------
// Platform billing settings
// ---------------------------------------------------------------------

const SETTING_DEFAULTS = { trialPlanCode: 'trial', invoiceDueDays: 7, graceDays: 7, taxRate: 0, taxLabel: 'Sales tax', trialReminderDays: 3, supportEmail: null,
  paymentInstructions: null, signupEnabled: true, signupRequiresApproval: true, loginOtp: false };

export async function billingSettings(db) {
  const row = await db.one(`select value from platform_settings where id = 'billing'`);
  return { ...SETTING_DEFAULTS, ...(row?.value ?? {}) };
}

export async function updateBillingSettings(ctx, input) {
  requireSuperAdmin(ctx);
  const before = await billingSettings(ctx.db);
  const next = { ...before };
  const errors = [];
  const int = (key, min, max, label) => {
    if (input[key] === undefined) return;
    const v = Number(input[key]);
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${label} must be a whole number from ${min} to ${max}.`);
    else next[key] = v;
  };
  int('invoiceDueDays', 0, 90, 'Days to pay an invoice');
  int('graceDays', 0, 90, 'Grace period');
  int('trialReminderDays', 0, 30, 'Trial reminder');
  if (input.taxRate !== undefined) {
    const v = Number(input.taxRate);
    if (!Number.isFinite(v) || v < 0 || v > 100) errors.push('Tax rate must be between 0 and 100.');
    else next.taxRate = round2(v);
  }
  if (input.taxLabel !== undefined) next.taxLabel = String(input.taxLabel).trim() || 'Tax';
  if (input.supportEmail !== undefined) {
    const v = input.supportEmail ? String(input.supportEmail).trim() : null;
    if (v && !v.includes('@')) errors.push('Support email must be an email address.');
    else next.supportEmail = v;
  }
  if (input.signupEnabled !== undefined) next.signupEnabled = input.signupEnabled === true;
  if (input.signupRequiresApproval !== undefined) next.signupRequiresApproval = input.signupRequiresApproval === true;
  if (input.loginOtp !== undefined) next.loginOtp = input.loginOtp === true;
  if (input.paymentInstructions !== undefined) next.paymentInstructions = String(input.paymentInstructions ?? '').trim().slice(0, 2000) || null;
  if (input.trialPlanCode !== undefined) {
    const plan = await ctx.db.one(`select 1 from plans where code = $1 and status = 'active'`, [input.trialPlanCode]);
    if (!plan) errors.push('The plan for new companies must be an active plan.');
    else next.trialPlanCode = input.trialPlanCode;
  }
  if (errors.length) throw badRequest('settings_invalid', errors.join(' '), { details: { errors } });
  await ctx.db.query(`update platform_settings set value = $1, updated_by = $2, updated_at = now() where id = 'billing'`, [next, ctx.actor?.userId ?? null]);
  await audit(ctx.db, ctx, { action: 'billing.settings_updated', entityType: 'platform_settings', entityId: 'billing', oldValue: before, newValue: next });
  return next;
}

// ---------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------

const PLAN_COLUMNS = ['code', 'name', 'description', 'currency', 'price_monthly', 'price_yearly', 'trial_days', 'max_employees', 'max_admins',
  'modules', 'status', 'sort_order'];

function validatePlan(p) {
  const errors = [];
  if (!/^[a-z0-9-]{2,40}$/.test(p.code ?? '')) errors.push('Code may only use lowercase letters, numbers and dashes (2-40).');
  if (!p.name?.trim()) errors.push('Name is required.');
  if (!isCurrency(p.currency)) errors.push(CURRENCY_HELP);
  for (const [k, label] of [['price_monthly', 'Monthly price'], ['price_yearly', 'Yearly price']]) {
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) errors.push(`${label} must be 0 or more.`);
  }
  if (!Number.isInteger(p.trial_days) || p.trial_days < 0 || p.trial_days > 365) errors.push('Trial days must be a whole number from 0 to 365.');
  for (const [k, label] of [['max_employees', 'Employee limit'], ['max_admins', 'Admin limit']]) {
    if (p[k] != null && (!Number.isInteger(p[k]) || p[k] < 1)) errors.push(`${label} must be empty (unlimited) or a whole number of at least 1.`);
  }
  if (p.modules != null && (!Array.isArray(p.modules) || p.modules.some((m) => !MODULES.includes(m)))) {
    errors.push(`Modules must be chosen from: ${MODULES.join(', ')}.`);
  }
  if (!['active', 'inactive', 'archived'].includes(p.status)) errors.push('Status must be active, inactive or archived.');
  if (errors.length) throw badRequest('plan_invalid', errors.join(' '), { details: { errors } });
}

export async function listPlans(db, { includeArchived = false } = {}) {
  return (await db.query(
    `select p.*, (select count(*)::int from subscriptions s where s.plan_id = p.id and s.status not in ('cancelled', 'expired')) as companies
       from plans p ${includeArchived ? '' : `where p.status <> 'archived'`} order by p.sort_order, p.price_monthly`)).rows;
}

const planInput = (input) => Object.fromEntries(PLAN_COLUMNS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));

export async function createPlan(ctx, input) {
  requireSuperAdmin(ctx);
  const data = { description: null, currency: 'PKR', price_monthly: 0, price_yearly: 0, trial_days: 0, max_employees: null, max_admins: null,
    modules: null, status: 'active', sort_order: 0, ...planInput(input) };
  validatePlan(data);
  const cols = Object.keys(data);
  let row;
  try {
    row = await ctx.db.one(`insert into plans (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
      cols.map((c) => (c === 'modules' && data[c] != null ? JSON.stringify(data[c]) : data[c])));
  } catch (err) {
    if (err.code === '23505') throw conflict('duplicate', 'A plan with this code already exists.');
    throw err;
  }
  await audit(ctx.db, ctx, { action: 'plan.created', entityType: 'plan', entityId: row.id, newValue: row });
  return row;
}

/**
 * Deletes a plan nobody has ever used. A plan any company was on (even in
 * the past) stays, because its subscriptions and invoices refer to it:
 * archive it instead. The plan new companies start on can't be deleted either.
 */
export async function deletePlan(ctx, id) {
  requireSuperAdmin(ctx);
  const plan = await ctx.db.one('select * from plans where id = $1', [id]);
  if (!plan) throw notFound('Plan');
  const { trialPlanCode } = await billingSettings(ctx.db);
  if (plan.code === trialPlanCode) {
    throw conflict('plan_in_use', 'New companies start on this plan, so it can\'t be deleted. Choose another plan for new companies in Settings first.');
  }
  const used = await ctx.db.one(
    `select (select count(*)::int from subscriptions where plan_id = $1) as subs,
            (select count(*)::int from payment_checkouts where plan_id = $1) as checkouts`, [id]);
  if (used.subs || used.checkouts) {
    const who = used.subs ? `${used.subs} ${used.subs === 1 ? 'company has' : 'companies have'} used it` : 'payments refer to it';
    throw conflict('plan_in_use', `${plan.name} can't be deleted because ${who} and their history points to it. Archive it instead: it disappears from new assignments and the history stays intact.`);
  }
  await ctx.db.tx(async (db) => {
    await db.query('delete from plans where id = $1', [id]);
    await audit(db, ctx, { action: 'plan.deleted', entityType: 'plan', entityId: id, oldValue: plan });
  });
}

/** Price and limit changes apply to companies assigned the plan from now on; existing subscriptions keep theirs. */
export async function updatePlan(ctx, id, input) {
  requireSuperAdmin(ctx);
  const before = await ctx.db.one('select * from plans where id = $1', [id]);
  if (!before) throw notFound('Plan');
  const data = planInput(input);
  if (data.code !== undefined && data.code !== before.code) throw conflict('code_immutable', "A plan's code can't change. Create a new plan instead.");
  delete data.code;
  validatePlan({ ...before, ...data });
  if (data.status && data.status !== 'active') {
    const { trialPlanCode } = await billingSettings(ctx.db);
    if (before.code === trialPlanCode) throw conflict('plan_in_use', 'New companies start on this plan. Choose another trial plan in Billing settings first.');
  }
  const cols = Object.keys(data);
  if (!cols.length) return before;
  const row = await ctx.db.one(
    `update plans set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
    [id, ...cols.map((c) => (c === 'modules' && data[c] != null ? JSON.stringify(data[c]) : data[c]))]);
  await audit(ctx.db, ctx, { action: 'plan.updated', entityType: 'plan', entityId: id, oldValue: before, newValue: row });
  return row;
}

// ---------------------------------------------------------------------
// Usage and limits (enforced on the server)
// ---------------------------------------------------------------------

export async function usageOf(db, tenantId) {
  return db.one(
    `select (select count(*)::int from employees where tenant_id = $1 and status = 'active') as active_employees,
            (select count(*)::int from employees where tenant_id = $1) as total_employees,
            (select count(*)::int from users where tenant_id = $1 and access_level = 'hr_admin' and is_active) as admins,
            (select count(*)::int from locations where tenant_id = $1 and is_active) as offices`, [tenantId]);
}

/** Refuses to add an employee / HR admin beyond the subscription's limit. */
export async function assertWithinLimit(ctx, kind) {
  const sub = await ctx.db.one('select plan_name, max_employees, max_admins from subscriptions where tenant_id = $1', [ctx.tenant.id]);
  const max = kind === 'employees' ? sub?.max_employees : sub?.max_admins;
  if (max == null) return;
  const u = await usageOf(ctx.db, ctx.tenant.id);
  const used = kind === 'employees' ? u.active_employees : u.admins;
  if (used >= max) {
    const what = kind === 'employees' ? 'active employees' : 'HR admin logins';
    throw new AppError(402, 'plan_limit', `Your ${sub.plan_name} plan allows up to ${max} ${what}, and all are in use. Upgrade the plan or deactivate one first.`,
      { params: { kind, limit: max, used } });
  }
}

// ---------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------

/** What the request path needs: trial end is checked live, so access stops on time even before the job runs. */
export function accessState(sub, today) {
  if (!sub) return { status: null, blocked: false };
  const status = sub.status === 'trialing' && sub.trial_ends_on < today ? 'expired' : sub.status;
  return { status, blocked: BLOCKED.has(status) };
}

export async function subscriptionOf(db, tenantId, { lock = false } = {}) {
  return db.one(`select * from subscriptions where tenant_id = $1 ${lock ? 'for update' : ''}`, [tenantId]);
}

/** Short summary for GET /me: banners and the blocked screen. */
export async function subscriptionSummary(db, tenantId, clock) {
  const sub = await subscriptionOf(db, tenantId);
  if (!sub) return null;
  const today = utcToday(clock);
  const { status, blocked } = accessState(sub, today);
  const overdue = await db.one(
    `select number, total - amount_paid as amount_due, currency, due_on from invoices
      where tenant_id = $1 and status = 'open' and due_on < $2 order by due_on limit 1`, [tenantId, today]);
  return {
    status, blocked, planName: sub.plan_name, trialEndsOn: sub.trial_ends_on, currentPeriodEnd: sub.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end, trialDaysLeft: sub.trial_ends_on ? Math.max(0, diffDays(today, sub.trial_ends_on)) : null,
    overdue: overdue && { number: overdue.number, amountDue: overdue.amount_due, currency: overdue.currency, dueOn: overdue.due_on },
    modules: sub.modules,
  };
}

async function logEvent(db, sub, { event, from = sub.status, to = sub.status, detail = {}, dedupeKey = null, actorId = null }) {
  const row = await db.one(
    `insert into subscription_events (tenant_id, subscription_id, event, from_status, to_status, detail, dedupe_key, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (dedupe_key) do nothing returning id`,
    [sub.tenant_id, sub.id, event, from, to, detail, dedupeKey, actorId]);
  return !!row;
}

async function tenantCtx(db, tenantId, ctx) {
  const tenant = await db.one('select * from tenants where id = $1', [tenantId]);
  if (!tenant) throw notFound('Company');
  return { db, tenant, clock: ctx.clock, actor: ctx.actor, locale: tenant.default_locale };
}

async function notifyCompany(tctx, event, params) {
  await notify(tctx, { userIds: await hrUserIds(tctx), event, params, channels: ['in_app', 'email'] });
}

/** Starts the free trial for a new company (inside provisionTenant's transaction). */
export async function startTrial(db, tenant, { today, actorId = null }) {
  const settings = await billingSettings(db);
  const plan = await db.one(`select * from plans where code = $1 and status = 'active'`, [settings.trialPlanCode]);
  if (!plan) throw badRequest('no_trial_plan', `The plan for new companies ("${settings.trialPlanCode}") is missing or inactive. Fix it in Billing settings.`);
  const sub = await db.one(
    `insert into subscriptions (tenant_id, plan_id, plan_code, plan_name, billing_cycle, price, currency, max_employees, max_admins, modules,
                                status, trial_ends_on)
     values ($1, $2, $3, $4, 'monthly', 0, $5, $6, $7, $8, 'trialing', $9) returning *`,
    [tenant.id, plan.id, plan.code, plan.name, plan.currency, plan.max_employees, plan.max_admins,
      plan.modules == null ? null : JSON.stringify(plan.modules), addDays(today, plan.trial_days)]);
  await logEvent(db, sub, { event: 'trial_started', from: null, detail: { plan: plan.code, trialEndsOn: sub.trial_ends_on }, actorId });
  return sub;
}

/** source 'renewal': at most one live invoice per period (a re-run never double-bills); 'plan_change': always issued. */
async function issueInvoice(db, sub, { periodStart, periodEnd, today, settings, actorId = null, source }) {
  if (source === 'renewal') {
    const exists = await db.one(`select id from invoices where subscription_id = $1 and period_start = $2 and status <> 'void' and source = 'renewal'`,
      [sub.id, periodStart]);
    if (exists) return null;
  }
  const { n } = await db.one(`select nextval('invoice_number_seq')::int as n`);
  const subtotal = round2(sub.price);
  const tax = round2((subtotal * settings.taxRate) / 100);
  const lines = [{ description: `${sub.plan_name} plan (${sub.billing_cycle}), ${periodStart} to ${periodEnd}`, amount: subtotal }];
  return db.one(
    `insert into invoices (tenant_id, subscription_id, number, period_start, period_end, issued_on, due_on, currency,
                           subtotal, tax_rate, tax, total, lines, created_by, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning *`,
    [sub.tenant_id, sub.id, `INV-${today.slice(0, 4)}-${String(n).padStart(6, '0')}`, periodStart, periodEnd, today,
      addDays(today, settings.invoiceDueDays), sub.currency, subtotal, settings.taxRate, tax, round2(subtotal + tax), JSON.stringify(lines), actorId, source]);
}

const invoiceParams = (inv, sub) => ({
  number: inv.number, amount: fmt(inv.total, inv.currency), plan: sub.plan_name, period: `${inv.period_start} to ${inv.period_end}`, dueOn: inv.due_on,
});

/** Overdue companies return to 'active' once nothing overdue is left. */
async function settleStatus(db, sub, today, actorId) {
  if (!['past_due', 'unpaid'].includes(sub.status)) return sub;
  const overdue = await db.one(`select 1 from invoices where subscription_id = $1 and status = 'open' and due_on < $2 limit 1`, [sub.id, today]);
  if (overdue) return sub;
  let next = await db.one(`update subscriptions set status = 'active', updated_at = now() where id = $1 returning *`, [sub.id]);
  await logEvent(db, next, { event: 'reactivated', from: sub.status, to: 'active', detail: { reason: 'paid' }, actorId });
  // Blocked past the end of its period: a new period starts today instead of back-billing the blocked time.
  if (sub.status === 'unpaid' && next.current_period_end && next.current_period_end < today) {
    const end = periodEndFor(today, next.billing_cycle);
    next = await db.one('update subscriptions set current_period_start = $2, current_period_end = $3 where id = $1 returning *', [sub.id, today, end]);
    if (next.price > 0) await issueInvoice(db, next, { periodStart: today, periodEnd: end, today, settings: await billingSettings(db), actorId, source: 'renewal' });
  }
  return next;
}

/** An active plan the company's current usage fits into. */
export async function assignablePlan(db, tenantId, planId, billingCycle) {
  if (!['monthly', 'yearly'].includes(billingCycle)) throw badRequest('cycle_invalid', 'Billing cycle must be monthly or yearly.');
  const plan = planId && await db.one(`select * from plans where id = $1`, [planId]).catch(() => null);
  if (!plan) throw badRequest('plan_invalid', 'Choose a plan.');
  if (plan.status !== 'active') throw badRequest('plan_inactive', `The ${plan.name} plan is not available for new subscriptions.`);
  const u = await usageOf(db, tenantId);
  const over = [];
  if (plan.max_employees != null && u.active_employees > plan.max_employees) over.push(`${u.active_employees} active employees (plan allows ${plan.max_employees})`);
  if (plan.max_admins != null && u.admins > plan.max_admins) over.push(`${u.admins} HR admins (plan allows ${plan.max_admins})`);
  if (over.length) throw conflict('over_limit', `This company has ${over.join(' and ')}. Deactivate some first or choose a bigger plan.`);
  return plan;
}

export async function changePlan(ctx, tenantId, { planId, billingCycle = 'monthly' } = {}) {
  requireSuperAdmin(ctx);
  const plan = await assignablePlan(ctx.db, tenantId, planId, billingCycle);

  const today = utcToday(ctx.clock);
  const settings = await billingSettings(ctx.db);
  return ctx.db.tx(async (db) => {
    const before = await subscriptionOf(db, tenantId, { lock: true });
    const tctx = await tenantCtx(db, tenantId, ctx);
    const price = billingCycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
    const trial = price === 0 && plan.trial_days > 0;
    const values = [plan.id, plan.code, plan.name, billingCycle, price, plan.currency, plan.max_employees, plan.max_admins,
      plan.modules == null ? null : JSON.stringify(plan.modules), trial ? 'trialing' : 'active', trial ? addDays(today, plan.trial_days) : null,
      trial ? null : today, trial ? null : periodEndFor(today, billingCycle)];
    let sub;
    if (before) {
      // Unpaid invoices of the old plan are replaced by the new plan's invoice.
      await db.query(`update invoices set status = 'void', voided_at = now(), void_reason = 'Replaced by a plan change'
                       where subscription_id = $1 and status = 'open' and amount_paid = 0`, [before.id]);
      sub = await db.one(
        `update subscriptions set plan_id = $2, plan_code = $3, plan_name = $4, billing_cycle = $5, price = $6, currency = $7, max_employees = $8,
                max_admins = $9, modules = $10, status = $11, trial_ends_on = $12, current_period_start = $13, current_period_end = $14,
                cancel_at_period_end = false, cancelled_at = null, updated_at = now()
          where id = $1 returning *`, [before.id, ...values]);
    } else {
      sub = await db.one(
        `insert into subscriptions (tenant_id, plan_id, plan_code, plan_name, billing_cycle, price, currency, max_employees, max_admins, modules,
                                    status, trial_ends_on, current_period_start, current_period_end)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`, [tenantId, ...values]);
    }
    const invoice = price > 0 ? await issueInvoice(db, sub, { periodStart: today, periodEnd: sub.current_period_end, today, settings, actorId: (ctx.actor?.userId ?? null), source: 'plan_change' }) : null;
    await logEvent(db, sub, { event: 'plan_changed', from: before?.status ?? null, to: sub.status, actorId: (ctx.actor?.userId ?? null),
      detail: { fromPlan: before?.plan_code ?? null, toPlan: plan.code, billingCycle, price, invoice: invoice?.number ?? null } });
    await audit(db, tctx, { action: 'subscription.plan_changed', entityType: 'subscription', entityId: sub.id, oldValue: before, newValue: sub });
    if (invoice) await notifyCompany(tctx, 'billing_invoice_issued', invoiceParams(invoice, sub));
    return { subscription: sub, invoice };
  });
}

/** Custom limits for one company (e.g. an Enterprise deal); empty = unlimited. */
export async function setLimits(ctx, tenantId, { maxEmployees, maxAdmins }) {
  requireSuperAdmin(ctx);
  const clean = (v, label) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw badRequest('limits_invalid', `${label} must be empty (unlimited) or a whole number of at least 1.`);
    return n;
  };
  const maxE = clean(maxEmployees, 'Employee limit');
  const maxA = clean(maxAdmins, 'Admin limit');
  return ctx.db.tx(async (db) => {
    const before = await subscriptionOf(db, tenantId, { lock: true });
    if (!before) throw notFound('Subscription');
    const sub = await db.one('update subscriptions set max_employees = $2, max_admins = $3, updated_at = now() where id = $1 returning *', [before.id, maxE, maxA]);
    await logEvent(db, sub, { event: 'limits_changed', detail: { maxEmployees: maxE, maxAdmins: maxA }, actorId: (ctx.actor?.userId ?? null) });
    await audit(db, await tenantCtx(db, tenantId, ctx), { action: 'subscription.limits_changed', entityType: 'subscription', entityId: sub.id,
      oldValue: { maxEmployees: before.max_employees, maxAdmins: before.max_admins }, newValue: { maxEmployees: maxE, maxAdmins: maxA } });
    return sub;
  });
}

/** Sets a new trial end date (extend, or reopen an expired trial). */
export async function setTrialEnd(ctx, tenantId, { trialEndsOn }) {
  requireSuperAdmin(ctx);
  const today = utcToday(ctx.clock);
  if (!isYmd(trialEndsOn) || trialEndsOn < today) throw badRequest('date_invalid', 'The trial end must be today or later.');
  return ctx.db.tx(async (db) => {
    const before = await subscriptionOf(db, tenantId, { lock: true });
    if (!before) throw notFound('Subscription');
    if (!['trialing', 'expired'].includes(before.status)) throw conflict('not_trial', 'Only a company on a trial (or whose trial ended) can get a trial extension.');
    const sub = await db.one(`update subscriptions set status = 'trialing', trial_ends_on = $2, updated_at = now() where id = $1 returning *`, [before.id, trialEndsOn]);
    await logEvent(db, sub, { event: 'trial_extended', from: before.status, to: 'trialing', detail: { from: before.trial_ends_on, to: trialEndsOn }, actorId: (ctx.actor?.userId ?? null) });
    await audit(db, await tenantCtx(db, tenantId, ctx), { action: 'subscription.trial_extended', entityType: 'subscription', entityId: sub.id,
      oldValue: { trialEndsOn: before.trial_ends_on }, newValue: { trialEndsOn } });
    return sub;
  });
}

export async function cancelSubscription(ctx, tenantId, { atPeriodEnd = true, reason } = {}) {
  requireSuperAdmin(ctx);
  if (!reason?.trim()) throw badRequest('reason_required', 'Give a reason for the cancellation.');
  return ctx.db.tx(async (db) => {
    const before = await subscriptionOf(db, tenantId, { lock: true });
    if (!before) throw notFound('Subscription');
    if (['cancelled', 'expired'].includes(before.status)) throw conflict('already_inactive', 'This subscription is already inactive.');
    const later = atPeriodEnd && before.status !== 'trialing' && before.current_period_end;
    const sub = later
      ? await db.one('update subscriptions set cancel_at_period_end = true, updated_at = now() where id = $1 returning *', [before.id])
      : await db.one(`update subscriptions set status = 'cancelled', cancelled_at = now(), cancel_at_period_end = false, updated_at = now() where id = $1 returning *`, [before.id]);
    await logEvent(db, sub, { event: later ? 'cancel_scheduled' : 'cancelled', from: before.status, to: sub.status, detail: { reason, endsOn: later ? sub.current_period_end : null }, actorId: (ctx.actor?.userId ?? null) });
    await audit(db, await tenantCtx(db, tenantId, ctx), { action: 'subscription.cancelled', entityType: 'subscription', entityId: sub.id,
      oldValue: { status: before.status }, newValue: { status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end }, meta: { reason } });
    return sub;
  });
}

/** Undoes a cancellation scheduled for the end of the period. */
export async function resumeSubscription(ctx, tenantId) {
  requireSuperAdmin(ctx);
  return ctx.db.tx(async (db) => {
    const before = await subscriptionOf(db, tenantId, { lock: true });
    if (!before?.cancel_at_period_end) throw conflict('not_scheduled', 'No cancellation is scheduled.');
    const sub = await db.one('update subscriptions set cancel_at_period_end = false, updated_at = now() where id = $1 returning *', [before.id]);
    await logEvent(db, sub, { event: 'cancel_withdrawn', actorId: (ctx.actor?.userId ?? null) });
    await audit(db, await tenantCtx(db, tenantId, ctx), { action: 'subscription.resumed', entityType: 'subscription', entityId: sub.id });
    return sub;
  });
}

/** Manual suspension by the SaaS owner (e.g. abuse): blocks every login of the company. */
export async function setTenantStatus(ctx, tenantId, { status, reason }) {
  requireSuperAdmin(ctx);
  if (!['active', 'suspended'].includes(status)) throw badRequest('status_invalid', 'Status must be active or suspended.');
  if (status === 'suspended' && !reason?.trim()) throw badRequest('reason_required', 'Give a reason for suspending the company.');
  const before = await ctx.db.one('select * from tenants where id = $1', [tenantId]);
  if (!before) throw notFound('Company');
  const row = await ctx.db.one('update tenants set status = $2 where id = $1 returning *', [tenantId, status]);
  await audit(ctx.db, { ...ctx, tenant: row }, { action: status === 'suspended' ? 'tenant.suspended' : 'tenant.reactivated', entityType: 'tenant',
    entityId: tenantId, oldValue: { status: before.status }, newValue: { status }, meta: { reason: reason ?? null } });
  return row;
}

/** Owner and HR admin emails of a company (for approval emails). */
async function companyEmails(db, tenant) {
  const { rows } = await db.query(`select email from users where tenant_id = $1 and access_level = 'hr_admin' and is_active`, [tenant.id]);
  return [...new Set([tenant.contact_email, ...rows.map((r) => r.email)].filter(Boolean))];
}

/**
 * Lets a company that signed itself up start using the platform. Its free
 * trial starts now (not when it signed up). ctx.mailer, ctx.appUrl: optional email.
 */
export async function approveTenant(ctx, tenantId) {
  requireSuperAdmin(ctx);
  const today = utcToday(ctx.clock);
  const result = await ctx.db.tx(async (db) => {
    const before = await db.one('select * from tenants where id = $1 for update', [tenantId]);
    if (!before) throw notFound('Company');
    if (before.status !== 'pending') throw conflict('not_pending', 'This company is not waiting for approval.');
    const tenant = await db.one(`update tenants set status = 'active' where id = $1 returning *`, [tenantId]);
    const sub = await subscriptionOf(db, tenantId, { lock: true });
    if (sub?.status === 'trialing') {
      const plan = await db.one('select trial_days from plans where id = $1', [sub.plan_id]);
      const next = await db.one('update subscriptions set trial_ends_on = $2, updated_at = now() where id = $1 returning *', [sub.id, addDays(today, plan.trial_days)]);
      await logEvent(db, next, { event: 'approved', detail: { trialEndsOn: next.trial_ends_on }, actorId: ctx.actor?.userId ?? null });
    }
    await audit(db, { ...ctx, tenant }, { action: 'tenant.approved', entityType: 'tenant', entityId: tenantId, oldValue: { status: 'pending' }, newValue: { status: 'active' } });
    return { tenant, to: await companyEmails(db, tenant) };
  });
  for (const to of result.to) {
    await ctx.mailer?.send({ to, subject: `${result.tenant.name} is approved on ${PRODUCT_NAME}`,
      text: `Good news: ${result.tenant.name} has been approved. You can sign in now${ctx.appUrl ? ` at ${ctx.appUrl}/` : ''}.\n\n${PRODUCT_NAME}` })
      .catch(() => {}); // the approval stands even if the email can't be sent
  }
  return result.tenant;
}

/** Refuses a pending company: it stays blocked (suspended) with the reason recorded. */
export async function rejectTenant(ctx, tenantId, { reason }) {
  requireSuperAdmin(ctx);
  if (!reason?.trim()) throw badRequest('reason_required', 'Give a reason (it is recorded, not sent to the company).');
  const before = await ctx.db.one('select * from tenants where id = $1', [tenantId]);
  if (!before) throw notFound('Company');
  if (before.status !== 'pending') throw conflict('not_pending', 'This company is not waiting for approval.');
  const tenant = await ctx.db.one(`update tenants set status = 'suspended' where id = $1 returning *`, [tenantId]);
  await audit(ctx.db, { ...ctx, tenant }, { action: 'tenant.rejected', entityType: 'tenant', entityId: tenantId,
    oldValue: { status: 'pending' }, newValue: { status: 'suspended' }, meta: { reason } });
  for (const to of await companyEmails(ctx.db, tenant)) {
    await ctx.mailer?.send({ to, subject: `Your ${PRODUCT_NAME} registration`,
      text: `Thank you for registering ${tenant.name}. We could not approve the account at this time.\n\nIf you think this is a mistake, reply to this email.\n\n${PRODUCT_NAME}` })
      .catch(() => {});
  }
  return tenant;
}

// ---------------------------------------------------------------------
// Invoices and payments
// ---------------------------------------------------------------------

export async function listInvoices(db, { tenantId = null, status = null, limit = 200 } = {}) {
  return (await db.query(
    `select i.*, t.name as company, round(i.total - i.amount_paid, 2) as amount_due
       from invoices i join tenants t on t.id = i.tenant_id
      where ($1::uuid is null or i.tenant_id = $1) and ($2::text is null or i.status = $2)
      order by i.issued_on desc, i.number desc limit $3`, [tenantId, status, Math.min(limit, 500)])).rows;
}

export async function listPayments(db, { tenantId = null, limit = 200 } = {}) {
  return (await db.query(
    `select p.*, t.name as company, i.number as invoice_number,
            (select coalesce(sum(r.amount), 0) from payments r where r.refund_of = p.id) as refunded
       from payments p join tenants t on t.id = p.tenant_id join invoices i on i.id = p.invoice_id
      where ($1::uuid is null or p.tenant_id = $1)
      order by p.received_on desc, p.created_at desc limit $2`, [tenantId, Math.min(limit, 500)])).rows;
}

/** `provider` / `providerPaymentId`: set only by the payment webhook (unique id = a payment is recorded once). */
export async function recordPayment(ctx, invoiceId, { amount, method, reference, receivedOn, note }, { provider = null, providerPaymentId = null } = {}) {
  requireSuperAdmin(ctx);
  const today = utcToday(ctx.clock);
  const value = round2(Number(amount));
  if (!(value > 0)) throw badRequest('payment_invalid', 'Enter the amount received.');
  if (!PAYMENT_METHODS.includes(method)) throw badRequest('payment_invalid', `Method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  const on = receivedOn ?? today;
  if (!isYmd(on) || on > today) throw badRequest('payment_invalid', 'The date received must be today or earlier.');
  return ctx.db.tx(async (db) => {
    const inv = await db.one('select * from invoices where id = $1 for update', [invoiceId]).catch(() => null);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'open') throw conflict('invoice_closed', `Invoice ${inv.number} is ${inv.status}.`);
    const due = round2(inv.total - inv.amount_paid);
    if (value > due) throw badRequest('payment_invalid', `Only ${fmt(due, inv.currency)} is due on invoice ${inv.number}.`);
    const payment = await db.one(
      `insert into payments (tenant_id, invoice_id, amount, currency, method, reference, received_on, note, recorded_by, provider, provider_payment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [inv.tenant_id, inv.id, value, inv.currency, method, reference?.trim() || null, on, note?.trim() || null, (ctx.actor?.userId ?? null),
        provider, providerPaymentId]);
    const paid = round2(inv.amount_paid + value);
    const invoice = await db.one(
      `update invoices set amount_paid = $2, status = case when $2 >= total then 'paid' else 'open' end,
              paid_at = case when $2 >= total then now() else null end where id = $1 returning *`, [inv.id, paid]);
    const sub = await subscriptionOf(db, inv.tenant_id, { lock: true });
    await logEvent(db, sub, { event: 'payment_recorded', detail: { invoice: inv.number, amount: value, method }, actorId: (ctx.actor?.userId ?? null) });
    await settleStatus(db, sub, today, (ctx.actor?.userId ?? null));
    const tctx = await tenantCtx(db, inv.tenant_id, ctx);
    await audit(db, tctx, { action: 'billing.payment_recorded', entityType: 'payment', entityId: payment.id, newValue: payment });
    await notifyCompany(tctx, 'billing_payment_received', { amount: fmt(value, inv.currency), number: inv.number });
    return { payment, invoice };
  });
}

export async function refundPayment(ctx, paymentId, { amount, reason }) {
  requireSuperAdmin(ctx);
  if (!reason?.trim()) throw badRequest('reason_required', 'Give a reason for the refund.');
  const value = round2(Number(amount));
  if (!(value > 0)) throw badRequest('refund_invalid', 'Enter the amount refunded.');
  const today = utcToday(ctx.clock);
  return ctx.db.tx(async (db) => {
    const p = await db.one(`select * from payments where id = $1 and kind = 'payment'`, [paymentId]).catch(() => null);
    if (!p) throw notFound('Payment');
    const inv = await db.one('select * from invoices where id = $1 for update', [p.invoice_id]);
    const { refunded } = await db.one('select coalesce(sum(amount), 0) as refunded from payments where refund_of = $1', [p.id]);
    const left = round2(p.amount - refunded);
    if (value > left) throw badRequest('refund_invalid', `Only ${fmt(left, p.currency)} of this payment can still be refunded.`);
    const refund = await db.one(
      `insert into payments (tenant_id, invoice_id, kind, refund_of, amount, currency, method, received_on, note, recorded_by)
       values ($1, $2, 'refund', $3, $4, $5, $6, $7, $8, $9) returning *`,
      [p.tenant_id, p.invoice_id, p.id, value, p.currency, p.method, today, reason.trim(), (ctx.actor?.userId ?? null)]);
    const paid = round2(inv.amount_paid - value);
    // A refunded void invoice stays void; otherwise it is owed again.
    await db.query(
      `update invoices set amount_paid = $2, status = case when status = 'void' then 'void' when $2 >= total then 'paid' else 'open' end,
              paid_at = case when $2 >= total then paid_at else null end where id = $1`, [inv.id, paid]);
    const sub = await subscriptionOf(db, p.tenant_id);
    await logEvent(db, sub, { event: 'refund_recorded', detail: { invoice: inv.number, amount: value, reason }, actorId: (ctx.actor?.userId ?? null) });
    await audit(db, await tenantCtx(db, p.tenant_id, ctx), { action: 'billing.refund_recorded', entityType: 'payment', entityId: refund.id, newValue: refund });
    return refund;
  });
}

export async function voidInvoice(ctx, invoiceId, { reason }) {
  requireSuperAdmin(ctx);
  if (!reason?.trim()) throw badRequest('reason_required', 'Give a reason for voiding the invoice.');
  return ctx.db.tx(async (db) => {
    const inv = await db.one('select * from invoices where id = $1 for update', [invoiceId]).catch(() => null);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'open') throw conflict('invoice_closed', `Invoice ${inv.number} is ${inv.status}.`);
    if (inv.amount_paid > 0) throw conflict('invoice_has_payments', 'This invoice has payments. Refund them before voiding it.');
    const row = await db.one(`update invoices set status = 'void', voided_at = now(), void_reason = $2 where id = $1 returning *`, [inv.id, reason.trim()]);
    const sub = await subscriptionOf(db, inv.tenant_id, { lock: true });
    await logEvent(db, sub, { event: 'invoice_voided', detail: { invoice: inv.number, reason }, actorId: (ctx.actor?.userId ?? null) });
    await settleStatus(db, sub, utcToday(ctx.clock), (ctx.actor?.userId ?? null));
    await audit(db, await tenantCtx(db, inv.tenant_id, ctx), { action: 'billing.invoice_voided', entityType: 'invoice', entityId: inv.id, meta: { reason } });
    return row;
  });
}

// ---------------------------------------------------------------------
// Online payments (payment provider checkout, see payments.js)
// ---------------------------------------------------------------------

/**
 * A company's HR admin pays an open invoice, or buys a plan, on the
 * provider's hosted page. Nothing changes here until the provider's signed
 * webhook confirms the payment (handlePaymentEvent).
 * ctx: request ctx + { payments: provider, appUrl }
 */
export async function startCheckout(ctx, { invoiceId, planId, billingCycle = 'monthly' } = {}) {
  if (ctx.actor?.accessLevel !== 'hr_admin') throw forbidden('Only HR admins can pay for the subscription.');
  if (!ctx.payments) throw badRequest('online_payments_off', 'Online payment is not set up. Please use the payment instructions on this page.');
  const db = ctx.db;
  const tenantId = ctx.tenant.id;
  let checkout;
  if (invoiceId) {
    const inv = await db.one('select * from invoices where id = $1 and tenant_id = $2', [invoiceId, tenantId]).catch(() => null);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'open') throw conflict('invoice_closed', `Invoice ${inv.number} is ${inv.status}.`);
    checkout = { kind: 'invoice', invoiceId: inv.id, amount: round2(inv.total - inv.amount_paid), currency: inv.currency, description: `Invoice ${inv.number}` };
  } else {
    const plan = await assignablePlan(db, tenantId, planId, billingCycle);
    const price = billingCycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
    if (!(price > 0)) throw badRequest('plan_free', 'This plan has no price to pay. Contact us to switch to it.');
    const { taxRate } = await billingSettings(db);
    checkout = { kind: 'plan', planId: plan.id, billingCycle, amount: round2(price + round2((price * taxRate) / 100)), currency: plan.currency,
      description: `${plan.name} plan (${billingCycle})` };
  }
  const id = randomUUID();
  const user = await db.one('select email from users where id = $1', [ctx.actor.userId]);
  const back = (state) => `${ctx.appUrl}/#/billing?checkout=${state}`;
  const session = await ctx.payments.createCheckout({
    amount: checkout.amount, currency: checkout.currency, description: `${checkout.description}: ${ctx.tenant.name}`,
    successUrl: back('success'), cancelUrl: back('cancelled'), metadata: { checkoutId: id, tenantId }, customerEmail: user?.email,
  });
  await db.query(
    `insert into payment_checkouts (id, tenant_id, provider, session_id, kind, invoice_id, plan_id, billing_cycle, amount, currency, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, tenantId, ctx.payments.name, session.id, checkout.kind, checkout.invoiceId ?? null, checkout.planId ?? null,
      checkout.kind === 'plan' ? checkout.billingCycle : null, checkout.amount, checkout.currency, ctx.actor.userId]);
  await audit(db, ctx, { action: 'billing.checkout_started', entityType: 'payment_checkout', entityId: id,
    newValue: { kind: checkout.kind, amount: checkout.amount, currency: checkout.currency, description: checkout.description } });
  return { url: session.url };
}

/**
 * Applies a verified provider event once. Redelivered events are no-ops;
 * a failure is recorded and rethrown so the provider retries it.
 */
export async function handlePaymentEvent(db, clock, provider, event) {
  const prior = await db.one('select status from payment_webhook_events where provider = $1 and event_id = $2', [provider, event.id]);
  if (prior && ['processed', 'ignored'].includes(prior.status)) return { status: prior.status, duplicate: true };
  if (!prior) {
    await db.query(`insert into payment_webhook_events (provider, event_id, type, payload) values ($1, $2, $3, $4) on conflict do nothing`,
      [provider, event.id, event.type, event.raw ?? {}]);
  }
  const finish = (status, error = null) => db.query(
    `update payment_webhook_events set status = $3, error = $4, processed_at = now() where provider = $1 and event_id = $2`, [provider, event.id, status, error]);
  try {
    const result = await applyPaymentEvent(db, clock, provider, event);
    await finish(result.status, result.note ?? null);
    return result;
  } catch (err) {
    await finish('failed', err.message);
    throw err;
  }
}

async function applyPaymentEvent(db, clock, provider, event) {
  const s = event.session;
  if (!s) return { status: 'ignored' };
  if (event.type === 'checkout.session.expired') {
    await db.query(`update payment_checkouts set status = 'expired' where provider = $1 and session_id = $2 and status = 'open'`, [provider, s.id]);
    return { status: 'processed' };
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return { status: 'ignored' };
  if (!s.paid) return { status: 'ignored', note: 'Payment not completed yet (the provider sends another event when it is).' };
  return db.tx(async (tx) => {
    const c = await tx.one('select * from payment_checkouts where provider = $1 and session_id = $2 for update', [provider, s.id]);
    if (!c) return { status: 'ignored', note: 'Unknown checkout session.' };
    if (c.status === 'completed') return { status: 'processed', note: 'Already applied.' };
    const sys = { db: tx, clock, actor: { system: true, userId: c.created_by } };
    const paid = round2(s.amount ?? c.amount);
    const manual = (why) => `Paid ${fmt(paid, c.currency)} online but ${why}. Refund it in the payment provider's dashboard or record it manually.`;
    let note = null;
    let invoice = null;
    if (s.currency && s.currency !== c.currency) note = manual(`in ${s.currency} instead of ${c.currency}`);
    else if (c.kind === 'plan') {
      try {
        ({ invoice } = await changePlan(sys, c.tenant_id, { planId: c.plan_id, billingCycle: c.billing_cycle }));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        note = manual(`the plan could not be applied (${err.message})`);
      }
    } else {
      invoice = await tx.one('select * from invoices where id = $1', [c.invoice_id]);
    }
    if (!note && invoice?.status !== 'open') note = manual(invoice ? `invoice ${invoice.number} is already ${invoice.status}` : 'no invoice was due');
    if (!note) {
      const due = round2(invoice.total - invoice.amount_paid);
      await recordPayment(sys, invoice.id, { amount: Math.min(paid, due), method: 'card', reference: s.paymentId, note: `Paid online (${provider})` },
        { provider, providerPaymentId: s.paymentId });
      if (paid > due) note = `Paid ${fmt(paid, c.currency)}, ${fmt(round2(paid - due), c.currency)} more than was due on ${invoice.number}. Refund the difference in the provider's dashboard.`;
    }
    await tx.query(`update payment_checkouts set status = $2, completed_at = now(), note = $3 where id = $1`,
      [c.id, note && !invoice ? 'failed' : 'completed', note]);
    return { status: 'processed', note };
  });
}

// ---------------------------------------------------------------------
// Daily job
// ---------------------------------------------------------------------

/** Idempotent: events carry dedupe keys and invoices are unique per period, so running it twice changes nothing. */
export async function runBillingJobs(db, clock) {
  const today = utcToday(clock);
  const settings = await billingSettings(db);
  const out = { trialReminders: 0, trialsExpired: 0, renewed: 0, cancelled: 0, pastDue: 0, unpaid: 0 };
  const { rows } = await db.query(`select s.id, s.tenant_id from subscriptions s join tenants t on t.id = s.tenant_id order by s.created_at`);
  for (const r of rows) {
    await db.tx(async (tx) => {
      let sub = await tx.one('select * from subscriptions where id = $1 for update', [r.id]);
      const tctx = await tenantCtx(tx, sub.tenant_id, { clock, actor: { system: true } });

      if (sub.status === 'trialing') {
        if (sub.trial_ends_on < today) {
          await tx.query(`update subscriptions set status = 'expired', updated_at = now() where id = $1`, [sub.id]);
          if (await logEvent(tx, sub, { event: 'trial_expired', to: 'expired', dedupeKey: `trial_expired:${sub.id}:${sub.trial_ends_on}` })) {
            await notifyCompany(tctx, 'billing_trial_expired', {});
          }
          out.trialsExpired += 1;
        } else if (diffDays(today, sub.trial_ends_on) <= settings.trialReminderDays
          && await logEvent(tx, sub, { event: 'trial_reminder', dedupeKey: `trial_reminder:${sub.id}:${sub.trial_ends_on}` })) {
          await notifyCompany(tctx, 'billing_trial_ending', { date: sub.trial_ends_on });
          out.trialReminders += 1;
        }
        return;
      }

      if (['active', 'past_due'].includes(sub.status) && sub.current_period_end && sub.current_period_end < today) {
        if (sub.cancel_at_period_end) {
          await tx.query(`update subscriptions set status = 'cancelled', cancelled_at = now(), cancel_at_period_end = false, updated_at = now() where id = $1`, [sub.id]);
          await logEvent(tx, sub, { event: 'cancelled', to: 'cancelled', detail: { reason: 'Cancelled at the end of the period' }, dedupeKey: `cancelled:${sub.id}:${sub.current_period_end}` });
          out.cancelled += 1;
          return;
        }
        // Catch up every missed period (the server may have been off), one invoice each.
        for (let guard = 0; sub.current_period_end < today && guard < 36; guard += 1) {
          const start = addDays(sub.current_period_end, 1);
          const end = periodEndFor(start, sub.billing_cycle);
          sub = await tx.one('update subscriptions set current_period_start = $2, current_period_end = $3, updated_at = now() where id = $1 returning *', [sub.id, start, end]);
          const inv = sub.price > 0 ? await issueInvoice(tx, sub, { periodStart: start, periodEnd: end, today, settings, source: 'renewal' }) : null;
          if (await logEvent(tx, sub, { event: 'renewed', detail: { periodStart: start, periodEnd: end, invoice: inv?.number ?? null }, dedupeKey: `renewed:${sub.id}:${start}` })) {
            out.renewed += 1;
          }
          if (inv) await notifyCompany(tctx, 'billing_invoice_issued', invoiceParams(inv, sub));
        }
      }

      if (!['active', 'past_due'].includes(sub.status)) return;
      const inv = await tx.one(`select * from invoices where subscription_id = $1 and status = 'open' and due_on < $2 order by due_on limit 1`, [sub.id, today]);
      if (!inv) return;
      const pauseOn = addDays(inv.due_on, settings.graceDays);
      const params = { ...invoiceParams(inv, sub), amount: fmt(round2(inv.total - inv.amount_paid), inv.currency), pauseOn };
      if (pauseOn < today) {
        await tx.query(`update subscriptions set status = 'unpaid', updated_at = now() where id = $1`, [sub.id]);
        if (await logEvent(tx, sub, { event: 'unpaid', to: 'unpaid', detail: { invoice: inv.number }, dedupeKey: `unpaid:${inv.id}` })) {
          await notifyCompany(tctx, 'billing_unpaid', params);
        }
        out.unpaid += 1;
      } else if (sub.status === 'active') {
        await tx.query(`update subscriptions set status = 'past_due', updated_at = now() where id = $1`, [sub.id]);
        if (await logEvent(tx, sub, { event: 'past_due', to: 'past_due', detail: { invoice: inv.number }, dedupeKey: `past_due:${inv.id}` })) {
          await notifyCompany(tctx, 'billing_overdue', params);
        }
        out.pastDue += 1;
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------

/** Company view (HR): plan, usage, invoices, payments, other plans. */
export async function companyBilling(ctx) {
  const db = ctx.db;
  const tenantId = ctx.tenant.id;
  const [sub, usage, invoices, payments, plans, settings, summary, submissions] = await Promise.all([
    subscriptionOf(db, tenantId), usageOf(db, tenantId), listInvoices(db, { tenantId }), listPayments(db, { tenantId }),
    db.query(`select id, code, name, description, currency, price_monthly, price_yearly, max_employees, max_admins, modules
                from plans where status = 'active' order by sort_order, price_monthly`).then((r) => r.rows),
    billingSettings(db), subscriptionSummary(db, tenantId, ctx.clock),
    db.query(`select s.id, s.kind, s.amount, s.currency, s.method, s.reference, s.paid_on, s.status, s.review_note, s.created_at, s.reviewed_at,
                     s.proof_mime is not null as has_proof, i.number as invoice_number, p.name as plan_name, s.billing_cycle
                from payment_submissions s left join invoices i on i.id = s.invoice_id left join plans p on p.id = s.plan_id
               where s.tenant_id = $1 order by s.created_at desc limit 50`, [tenantId]).then((r) => r.rows),
  ]);
  return { subscription: sub, summary, usage, invoices, payments, plans, supportEmail: settings.supportEmail, taxLabel: settings.taxLabel,
    taxRate: settings.taxRate, paymentInstructions: settings.paymentInstructions, onlinePayments: !!ctx.payments, submissions };
}

export async function listCompanies(db, { q = null, status = null } = {}) {
  return (await db.query(
    `select t.id, t.name, t.slug, t.status, t.timezone, t.currency, t.created_at, t.logo_updated_at,
            s.plan_name, s.plan_code, s.status as subscription_status, s.billing_cycle, s.price, s.currency as billing_currency,
            s.trial_ends_on, s.current_period_end, s.cancel_at_period_end, s.max_employees,
            (select count(*)::int from employees e where e.tenant_id = t.id and e.status = 'active') as employees,
            (select string_agg(u.email, ', ' order by u.created_at) from users u where u.tenant_id = t.id and u.access_level = 'hr_admin' and u.is_active) as admins,
            (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i where i.tenant_id = t.id and i.status = 'open') as balance_due
       from tenants t left join subscriptions s on s.tenant_id = t.id
      where ($1::text is null or t.name ilike '%' || $1 || '%' or t.slug ilike '%' || $1 || '%')
        and ($2::text is null or t.status = $2 or s.status = $2)
      order by t.created_at desc`, [q || null, status || null])).rows;
}

export async function companyDetail(db, tenantId) {
  const tenant = await db.one('select * from tenants where id = $1', [tenantId]).catch(() => null);
  if (!tenant) throw notFound('Company');
  const [subscription, usage, invoices, payments, events, admins] = await Promise.all([
    subscriptionOf(db, tenantId), usageOf(db, tenantId), listInvoices(db, { tenantId }), listPayments(db, { tenantId }),
    db.query(`select e.*, u.email as actor_email from subscription_events e left join users u on u.id = e.actor_user_id
               where e.tenant_id = $1 order by e.created_at desc limit 100`, [tenantId]).then((r) => r.rows),
    db.query(`select u.email, u.is_active, u.created_at, e.full_name from users u left join employees e on e.user_id = u.id
               where u.tenant_id = $1 and u.access_level = 'hr_admin' order by u.created_at`, [tenantId]).then((r) => r.rows),
  ]);
  return { tenant, subscription, usage, invoices, payments, events, admins };
}

/** Platform dashboard. Every money figure comes from recorded invoices and payments. */
export async function platformDashboard(db, clock) {
  const today = utcToday(clock);
  const thisMonth = monthStart(today);
  const firstMonth = addMonths(thisMonth, -11);
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const [companies, subs, people, mrr, collected, pending, renewals, recentCompanies, recentPayments, revenue, signups] = await Promise.all([
    db.one(`select count(*)::int as total, count(*) filter (where status = 'active')::int as active,
                   count(*) filter (where status = 'suspended')::int as suspended,
                   count(*) filter (where status = 'pending')::int as pending from tenants`),
    q(`select status, count(*)::int as n from subscriptions group by status`),
    db.one(`select (select count(*)::int from users where tenant_id is not null and is_active) as users,
                   (select count(*)::int from employees where status = 'active') as employees,
                   (select count(*)::int from payment_submissions where status = 'pending') as payments_to_verify`),
    q(`select currency, round(sum(case billing_cycle when 'yearly' then price / 12 else price end), 2) as mrr
         from subscriptions where status in ('active', 'past_due') and price > 0 group by currency order by currency`),
    q(`select currency, sum(case kind when 'payment' then amount else -amount end) as total,
              sum(case when received_on >= $1 then (case kind when 'payment' then amount else -amount end) else 0 end) as this_month
         from payments group by currency order by currency`, [thisMonth]),
    q(`select currency, count(*)::int as invoices, sum(total - amount_paid) as amount,
              count(*) filter (where due_on < $1)::int as overdue, coalesce(sum(total - amount_paid) filter (where due_on < $1), 0) as overdue_amount
         from invoices where status = 'open' group by currency order by currency`, [today]),
    q(`select t.id as tenant_id, t.name, s.plan_name, s.status, s.price, s.currency, s.billing_cycle,
              case when s.status = 'trialing' then s.trial_ends_on else s.current_period_end end as on_date, s.cancel_at_period_end
         from subscriptions s join tenants t on t.id = s.tenant_id
        where (s.status = 'trialing' and s.trial_ends_on between $1 and $2)
           or (s.status in ('active', 'past_due') and s.current_period_end between $1 and $2)
        order by on_date limit 20`, [today, addDays(today, 30)]),
    q(`select t.id, t.name, t.created_at, s.plan_name, s.status from tenants t left join subscriptions s on s.tenant_id = t.id
        order by t.created_at desc limit 8`),
    q(`select p.id, p.kind, p.amount, p.currency, p.method, p.received_on, t.name as company, i.number as invoice_number
         from payments p join tenants t on t.id = p.tenant_id join invoices i on i.id = p.invoice_id
        order by p.created_at desc limit 10`),
    q(`select to_char(received_on, 'YYYY-MM') as month, currency, sum(case kind when 'payment' then amount else -amount end) as amount
         from payments where received_on >= $1 group by 1, 2`, [firstMonth]),
    q(`select to_char(created_at, 'YYYY-MM') as month, count(*)::int as n from tenants where created_at >= $1 group by 1`, [firstMonth]),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(firstMonth, i).slice(0, 7));
  const currencies = [...new Set(revenue.map((r) => r.currency))].sort();
  const byStatus = Object.fromEntries(subs.map((r) => [r.status, r.n]));
  return {
    today,
    companies: { ...companies, trialing: byStatus.trialing ?? 0 },
    subscriptions: byStatus,
    people,
    mrr: mrr.map((r) => ({ currency: r.currency, mrr: r.mrr, arr: round2(r.mrr * 12) })),
    collected, pending, renewals, recentCompanies, recentPayments,
    revenueByMonth: { currencies, rows: months.map((m) => ({ month: m, ...Object.fromEntries(currencies.map((c) => [c, round2(revenue.find((r) => r.month === m && r.currency === c)?.amount ?? 0)])) })) },
    signupsByMonth: months.map((m) => ({ month: m, companies: signups.find((r) => r.month === m)?.n ?? 0 })),
  };
}

/** Platform-level audit: billing/plan actions and anything a super admin did inside a company. */
export async function platformAudit(db, { limit = 200 } = {}) {
  return (await db.query(
    `select a.*, u.email as actor_email, t.name as company from audit_log a
       left join users u on u.id = a.actor_user_id left join tenants t on t.id = a.tenant_id
      where a.tenant_id is null or u.access_level = 'super_admin' or a.action like 'billing.%' or a.action like 'subscription.%'
         or a.action like 'tenant.%'
      order by a.id desc limit $1`, [Math.min(limit, 500)])).rows;
}
