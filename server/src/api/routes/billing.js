/** A company's own subscription, usage and invoices (HR admins), and online payment. */
import { AppError } from '../../lib/errors.js';
import { requireHr } from '../../services/access.js';
import { companyBilling, handlePaymentEvent, startCheckout } from '../../services/billing.js';
import { proofOf, submitPayment } from '../../services/paymentSubmissions.js';

export default async function billingRoutes(app) {
  const withPayments = (req) => ({ ...req.ctx, payments: app.payments, appUrl: app.appUrl });

  app.get('/subscription', async (req) => {
    requireHr(req.ctx);
    return companyBilling(withPayments(req));
  });

  /** Report a payment made outside the system (with an optional receipt, up to 2 MB). */
  app.post('/payments', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) =>
    reply.status(201).send(await submitPayment({ ...req.ctx, mailer: app.mailer, appUrl: app.appUrl }, req.body ?? {})));
  /** The receipt of one of this company's own payment reports. */
  app.get('/payments/:id/proof', async (req, reply) => {
    requireHr(req.ctx);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new AppError(404, 'not_found', 'Receipt not found.');
    const p = await proofOf(app.db, req.params.id, { tenantId: req.ctx.tenant.id });
    return reply.header('content-type', p.mime).header('x-content-type-options', 'nosniff').send(p.buffer);
  });

  /** { invoiceId } or { planId, billingCycle } -> { url } of the provider's payment page. */
  app.post('/checkout', async (req) => startCheckout(withPayments(req), req.body ?? {}));

  /** Payment provider webhook (public; trusted only after its signature checks out). */
  app.post('/webhook', async (req) => {
    if (!app.payments) throw new AppError(404, 'not_found', 'Online payments are not configured.');
    let event;
    try {
      event = app.payments.parseWebhook(req.rawBody ?? '', req.headers);
    } catch {
      throw new AppError(400, 'bad_signature', 'Webhook signature verification failed.');
    }
    const result = await handlePaymentEvent(app.db, app.clock, app.payments.name, event);
    return { received: true, status: result.status };
  });
}
