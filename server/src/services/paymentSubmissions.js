/**
 * Payments a company reports itself (bank transfer, cash, cheque, mobile
 * wallet...), for an open invoice or to buy a plan, with an optional receipt.
 *
 *   company HR    submitPayment            -> status 'pending'
 *   super admin   confirmSubmission        -> the payment is recorded through the normal
 *                                             billing code (invoice cleared; a plan purchase
 *                                             starts the plan), status 'confirmed'
 *                 rejectSubmission         -> status 'rejected' with the reason
 * The company is told in the app and by email at each step; the owner is
 * emailed (support email) when a new report arrives.
 */
import { audit } from '../lib/audit.js';
import { isYmd } from '../lib/dates.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { PRODUCT_NAME } from '../lib/product.js';
import { round2 } from '../lib/util.js';
import { assignablePlan, billingSettings, changePlan, recordPayment, requireSuperAdmin } from './billing.js';
import { hrUserIds, notify } from './notifications.js';

export const SUBMIT_METHODS = ['bank_transfer', 'cash', 'cheque', 'online', 'other'];
export const MAX_PROOF_BYTES = 2 * 1024 * 1024;
const fmt = (amount, currency) => `${currency} ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 3 })}`;
const utcToday = (clock) => clock.now().toISOString().slice(0, 10);

/** Receipt files: PNG, JPEG or PDF, recognised from their bytes. */
function proofType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const describe = (s) => (s.kind === 'plan' ? `${s.plan_name ?? 'plan'} (${s.billing_cycle})` : `invoice ${s.invoice_number ?? ''}`.trim());

async function tellCompany(db, clock, tenantId, event, params) {
  const tenant = await db.one('select * from tenants where id = $1', [tenantId]);
  const tctx = { db, tenant, clock, actor: { system: true } };
  await notify(tctx, { userIds: await hrUserIds(tctx), event, params, channels: ['in_app', 'email'] });
}

/** Company HR reports a payment. ctx: request ctx + { mailer?, appUrl? } */
export async function submitPayment(ctx, input = {}) {
  if (ctx.actor?.accessLevel !== 'hr_admin') throw forbidden('Only HR admins can report payments for the subscription.');
  const db = ctx.db;
  const tenantId = ctx.tenant.id;
  const today = utcToday(ctx.clock);
  const amount = round2(Number(input.amount));
  const errors = [];
  if (!(amount > 0)) errors.push('Enter the amount you paid.');
  if (!SUBMIT_METHODS.includes(input.method)) errors.push('Choose how you paid.');
  const paidOn = input.paidOn ?? today;
  if (!isYmd(paidOn) || paidOn > today) errors.push('The payment date must be today or earlier.');
  const reference = String(input.reference ?? '').trim().slice(0, 120) || null;
  if (['bank_transfer', 'online', 'cheque'].includes(input.method) && !reference) errors.push('Enter the transaction ID or cheque number, so the payment can be matched.');
  let proof = null;
  if (input.proof) {
    const buf = Buffer.from(String(input.proof).replace(/^data:[^,]*;base64,/, ''), 'base64');
    const mime = proofType(buf);
    if (!mime) errors.push('The receipt must be a PNG or JPEG image or a PDF.');
    else if (buf.length > MAX_PROOF_BYTES) errors.push('The receipt must be 2 MB or smaller.');
    else proof = { mime, data: buf.toString('base64') };
  }
  if (errors.length) throw badRequest('payment_invalid', errors.join(' '), { details: { errors } });

  let row;
  if (input.invoiceId) {
    const inv = await db.one('select * from invoices where id = $1 and tenant_id = $2', [input.invoiceId, tenantId]).catch(() => null);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'open') throw conflict('invoice_closed', `Invoice ${inv.number} is already ${inv.status}.`);
    const due = round2(inv.total - inv.amount_paid);
    if (amount > due) throw badRequest('payment_invalid', `Only ${fmt(due, inv.currency)} is due on invoice ${inv.number}.`);
    if (await db.one(`select 1 from payment_submissions where invoice_id = $1 and status = 'pending'`, [inv.id])) {
      throw conflict('already_reported', `A payment for invoice ${inv.number} is already waiting for confirmation.`);
    }
    row = { kind: 'invoice', invoiceId: inv.id, currency: inv.currency, what: `invoice ${inv.number}` };
  } else {
    const cycle = input.billingCycle ?? 'monthly';
    const plan = await assignablePlan(db, tenantId, input.planId, cycle);
    const price = cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
    if (!(price > 0)) throw badRequest('plan_free', 'This plan has no price to pay.');
    if (await db.one(`select 1 from payment_submissions where tenant_id = $1 and kind = 'plan' and status = 'pending'`, [tenantId])) {
      throw conflict('already_reported', 'A plan payment is already waiting for confirmation.');
    }
    row = { kind: 'plan', planId: plan.id, cycle, currency: plan.currency, what: `${plan.name} plan (${cycle})` };
  }
  const saved = await db.one(
    `insert into payment_submissions (tenant_id, kind, invoice_id, plan_id, billing_cycle, amount, currency, method, reference, paid_on, note,
                                      proof_mime, proof_data, submitted_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id, status, created_at`,
    [tenantId, row.kind, row.invoiceId ?? null, row.planId ?? null, row.cycle ?? null, amount, row.currency, input.method, reference, paidOn,
      String(input.note ?? '').trim().slice(0, 500) || null, proof?.mime ?? null, proof?.data ?? null, ctx.actor.userId]);
  await audit(db, ctx, { action: 'billing.payment_reported', entityType: 'payment_submission', entityId: saved.id,
    newValue: { kind: row.kind, amount, currency: row.currency, method: input.method, reference, paidOn } });
  await tellCompany(db, ctx.clock, tenantId, 'billing_payment_submitted', { amount: fmt(amount, row.currency), what: row.what });
  const { supportEmail } = await billingSettings(db);
  if (supportEmail && ctx.mailer) {
    await ctx.mailer.send({ to: supportEmail, subject: `Payment to confirm: ${ctx.tenant.name}, ${fmt(amount, row.currency)}`,
      text: `${ctx.tenant.name} reports a payment of ${fmt(amount, row.currency)} for ${row.what}.\nMethod: ${input.method}${reference ? `, reference ${reference}` : ''}, paid on ${paidOn}.\n\nConfirm or reject it in ${PRODUCT_NAME}: ${ctx.appUrl ?? ''}/#/admin/billing` })
      .catch(() => {});
  }
  return saved;
}

export async function listSubmissions(db, { tenantId = null, status = null, limit = 200 } = {}) {
  return (await db.query(
    `select s.id, s.tenant_id, s.kind, s.amount, s.currency, s.method, s.reference, s.paid_on, s.note, s.status, s.review_note,
            s.created_at, s.reviewed_at, s.proof_mime is not null as has_proof, s.billing_cycle,
            t.name as company, i.number as invoice_number, round(i.total - i.amount_paid, 2) as invoice_due, i.status as invoice_status,
            p.name as plan_name, u.email as submitted_by_email
       from payment_submissions s join tenants t on t.id = s.tenant_id
       left join invoices i on i.id = s.invoice_id left join plans p on p.id = s.plan_id left join users u on u.id = s.submitted_by
      where ($1::uuid is null or s.tenant_id = $1) and ($2::text is null or s.status = $2)
      order by (s.status = 'pending') desc, s.created_at desc limit $3`, [tenantId, status, Math.min(limit, 500)])).rows;
}

/** The receipt file: { mime, buffer }. tenantId limits it to one company (company HR). */
export async function proofOf(db, id, { tenantId = null } = {}) {
  const row = await db.one(`select proof_mime, proof_data from payment_submissions where id = $1 and ($2::uuid is null or tenant_id = $2)`, [id, tenantId])
    .catch(() => null);
  if (!row?.proof_data) throw notFound('Receipt');
  return { mime: row.proof_mime, buffer: Buffer.from(row.proof_data, 'base64') };
}

/** Super admin: the money arrived. Records it through the normal billing code. */
export async function confirmSubmission(ctx, id) {
  requireSuperAdmin(ctx);
  return ctx.db.tx(async (db) => {
    const s = await db.one(`select s.*, p.name as plan_name, i.number as invoice_number from payment_submissions s
      left join plans p on p.id = s.plan_id left join invoices i on i.id = s.invoice_id where s.id = $1 for update of s`, [id]).catch(() => null);
    if (!s) throw notFound('Payment report');
    if (s.status !== 'pending') throw conflict('already_reviewed', `This payment was already ${s.status}.`);
    const sctx = { ...ctx, db };
    let invoice;
    if (s.kind === 'plan') {
      ({ invoice } = await changePlan(sctx, s.tenant_id, { planId: s.plan_id, billingCycle: s.billing_cycle }));
      if (!invoice) throw new AppError(409, 'plan_free', 'That plan no longer has a price; reject this report.');
    } else {
      invoice = await db.one('select * from invoices where id = $1', [s.invoice_id]);
      if (invoice.status !== 'open') throw conflict('invoice_closed', `Invoice ${invoice.number} is already ${invoice.status}. Reject this report instead.`);
    }
    const due = round2(invoice.total - invoice.amount_paid);
    const { payment } = await recordPayment(sctx, invoice.id, {
      amount: Math.min(Number(s.amount), due), method: s.method, reference: s.reference, receivedOn: s.paid_on, note: 'Reported by the company, confirmed',
    });
    const row = await db.one(`update payment_submissions set status = 'confirmed', payment_id = $2, reviewed_by = $3, reviewed_at = now()
      where id = $1 returning id, status`, [id, payment.id, ctx.actor?.userId ?? null]);
    const tenant = await db.one('select * from tenants where id = $1', [s.tenant_id]);
    await audit(db, { ...ctx, tenant }, { action: 'billing.payment_report_confirmed', entityType: 'payment_submission', entityId: id,
      newValue: { invoice: invoice.number, amount: Math.min(Number(s.amount), due) } });
    return { ...row, invoice: invoice.number, short: Number(s.amount) < due ? round2(due - Number(s.amount)) : 0 };
  });
}

/** Super admin: the money didn't arrive (or doesn't match). The company sees the reason. */
export async function rejectSubmission(ctx, id, { reason } = {}) {
  requireSuperAdmin(ctx);
  if (!reason?.trim()) throw badRequest('reason_required', 'Tell the company why the payment could not be confirmed.');
  const s = await ctx.db.one(`select s.*, p.name as plan_name, i.number as invoice_number from payment_submissions s
    left join plans p on p.id = s.plan_id left join invoices i on i.id = s.invoice_id where s.id = $1`, [id]).catch(() => null);
  if (!s) throw notFound('Payment report');
  if (s.status !== 'pending') throw conflict('already_reviewed', `This payment was already ${s.status}.`);
  const row = await ctx.db.one(`update payment_submissions set status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now()
    where id = $1 returning id, status`, [id, reason.trim(), ctx.actor?.userId ?? null]);
  const tenant = await ctx.db.one('select * from tenants where id = $1', [s.tenant_id]);
  await audit(ctx.db, { ...ctx, tenant }, { action: 'billing.payment_report_rejected', entityType: 'payment_submission', entityId: id, meta: { reason } });
  await tellCompany(ctx.db, ctx.clock, s.tenant_id, 'billing_payment_rejected',
    { amount: fmt(s.amount, s.currency), what: describe(s), reason: reason.trim() });
  return row;
}
