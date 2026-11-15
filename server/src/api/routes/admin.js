/** SaaS owner (super admin): companies, plans, subscriptions, invoices, payments. */
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import * as billing from '../../services/billing.js';
import * as companyAdmin from '../../services/companyAdmin.js';
import * as submissions from '../../services/paymentSubmissions.js';
import { assertEmailFree, createEmployee } from '../../services/employees.js';
import { loadDefaults, provisionTenant } from '../../services/tenants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function adminRoutes(app) {
  app.addHook('preHandler', async (req) => {
    if (req.ctx.actor.accessLevel !== 'super_admin') throw forbidden('Only the SaaS owner can manage companies.');
    if (req.params?.id && !UUID.test(req.params.id)) throw notFound();
  });
  const db = app.db;

  app.get('/dashboard', async (req) => billing.platformDashboard(db, req.ctx.clock));

  // Companies
  app.get('/tenants', async (req) => billing.listCompanies(db, { q: req.query.q, status: req.query.status }));
  app.get('/tenants/:id', async (req) => billing.companyDetail(db, req.params.id));

  /** Creates the company (on the trial plan) and, optionally, its first HR admin login. */
  app.post('/tenants', async (req, reply) => {
    const { admin, ...company } = req.body ?? {};
    if (admin) {
      if (!admin.fullName?.trim()) throw badRequest('admin_invalid', "Enter the HR admin's name.");
      if (!admin.email?.includes('@')) throw badRequest('admin_invalid', 'Enter a valid email for the HR admin.');
      if (!admin.password || admin.password.length < 8) throw badRequest('admin_invalid', 'The password must be at least 8 characters.');
      await assertEmailFree(db, admin.email, null); // the new company has no logins yet: only the owner's and Firebase's limits apply
    }
    // Attendance and payroll dates depend on it, so it must be a real IANA zone (e.g. Asia/Karachi).
    if (company.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en', { timeZone: company.timezone || 'invalid' }); }
      catch { throw badRequest('timezone_invalid', 'Choose a valid time zone.'); }
    }
    if (company.slug && await db.one('select 1 from tenants where slug = $1', [company.slug])) {
      throw conflict('duplicate', 'A company with this slug already exists.');
    }
    const today = req.ctx.clock.now().toISOString().slice(0, 10);
    const { tenant } = await provisionTenant(db, { ...company, today }, await loadDefaults(), req.ctx.actor);
    if (admin) {
      const ctx = { db, clock: req.ctx.clock, tenant, actor: { system: true, userId: req.ctx.actor.userId }, locale: 'en' };
      await createEmployee(ctx, { full_name: admin.fullName.trim(), joining_date: tenant.go_live_date,
        login: { email: admin.email.trim(), password: admin.password, accessLevel: 'hr_admin' } });
    }
    return reply.status(201).send(tenant);
  });

  app.patch('/tenants/:id', async (req) => companyAdmin.updateCompany(req.ctx, req.params.id, req.body ?? {}));
  app.delete('/tenants/:id', async (req) => companyAdmin.deleteCompany(req.ctx, req.params.id, req.body ?? {}));
  app.patch('/tenants/:id/logins/:userId', async (req) => {
    if (!UUID.test(req.params.userId)) throw notFound();
    return companyAdmin.updateLogin(req.ctx, req.params.id, req.params.userId, req.body ?? {});
  });

  app.post('/tenants/:id/plan', async (req) => billing.changePlan(req.ctx, req.params.id, req.body ?? {}));
  app.post('/tenants/:id/limits', async (req) => billing.setLimits(req.ctx, req.params.id, req.body ?? {}));
  app.post('/tenants/:id/trial', async (req) => billing.setTrialEnd(req.ctx, req.params.id, req.body ?? {}));
  app.post('/tenants/:id/cancel', async (req) => billing.cancelSubscription(req.ctx, req.params.id, req.body ?? {}));
  app.post('/tenants/:id/resume', async (req) => billing.resumeSubscription(req.ctx, req.params.id));
  app.post('/tenants/:id/approve', async (req) => billing.approveTenant({ ...req.ctx, mailer: app.mailer, appUrl: app.appUrl }, req.params.id));
  app.post('/tenants/:id/reject', async (req) => billing.rejectTenant({ ...req.ctx, mailer: app.mailer }, req.params.id, req.body ?? {}));
  app.post('/tenants/:id/suspend', async (req) => billing.setTenantStatus(req.ctx, req.params.id, { status: 'suspended', reason: req.body?.reason }));
  app.post('/tenants/:id/reactivate', async (req) => billing.setTenantStatus(req.ctx, req.params.id, { status: 'active', reason: req.body?.reason }));

  // Plans
  app.get('/plans', async (req) => billing.listPlans(db, { includeArchived: req.query.all === 'true' }));
  app.post('/plans', async (req, reply) => reply.status(201).send(await billing.createPlan(req.ctx, req.body ?? {})));
  app.patch('/plans/:id', async (req) => billing.updatePlan(req.ctx, req.params.id, req.body ?? {}));
  app.delete('/plans/:id', async (req, reply) => { await billing.deletePlan(req.ctx, req.params.id); return reply.status(204).send(); });

  // Invoices and payments
  app.get('/invoices', async (req) => billing.listInvoices(db, { status: req.query.status || null, tenantId: req.query.tenantId || null }));
  app.post('/invoices/:id/payments', async (req, reply) => reply.status(201).send(await billing.recordPayment(req.ctx, req.params.id, req.body ?? {})));
  app.post('/invoices/:id/void', async (req) => billing.voidInvoice(req.ctx, req.params.id, req.body ?? {}));
  app.get('/payments', async (req) => billing.listPayments(db, { tenantId: req.query.tenantId || null }));
  app.post('/payments/:id/refund', async (req, reply) => reply.status(201).send(await billing.refundPayment(req.ctx, req.params.id, req.body ?? {})));

  // Payments reported by companies: check the receipt, then confirm or reject
  app.get('/payment-submissions', async (req) => submissions.listSubmissions(db, { status: req.query.status || null, tenantId: req.query.tenantId || null }));
  app.get('/payment-submissions/:id/proof', async (req, reply) => {
    const p = await submissions.proofOf(db, req.params.id);
    return reply.header('content-type', p.mime).header('x-content-type-options', 'nosniff').send(p.buffer);
  });
  app.post('/payment-submissions/:id/confirm', async (req) => submissions.confirmSubmission(req.ctx, req.params.id));
  app.post('/payment-submissions/:id/reject', async (req) => submissions.rejectSubmission(req.ctx, req.params.id, req.body ?? {}));

  // Settings, audit, jobs
  app.get('/billing-settings', async () => billing.billingSettings(db));
  app.put('/billing-settings', async (req) => billing.updateBillingSettings(req.ctx, req.body ?? {}));
  app.get('/audit', async (req) => billing.platformAudit(db, { limit: Number(req.query.limit ?? 200) }));
  /** Runs the billing job now (it also runs on the server's schedule). */
  app.post('/billing/run', async (req) => billing.runBillingJobs(db, req.ctx.clock));
}
