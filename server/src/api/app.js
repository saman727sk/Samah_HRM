/**
 * Fastify application. Every /api route (except login) gets a request
 * context: { db, clock, tenant, actor, locale }. Tenancy comes from the
 * signed token, never from the request body, so one tenant can't address
 * another tenant's rows.
 */
import { effectivePermissions } from '../services/access.js';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { AppError } from '../lib/errors.js';
import { localize } from '../lib/i18n.js';
import { systemClock } from '../lib/clock.js';
import { identity } from '../auth/identity.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import lookupRoutes from './routes/lookups.js';
import employeeRoutes from './routes/employees.js';
import settingRoutes from './routes/settings.js';
import wfhRoutes from './routes/wfh.js';
import leaveRoutes from './routes/leave.js';
import miscRoutes from './routes/misc.js';
import attendanceRoutes from './routes/attendance.js';
import workflowRoutes from './routes/workflow.js';
import dashboardRoutes from './routes/dashboard.js';
import payrollRoutes from './routes/payroll.js';
import billingRoutes from './routes/billing.js';
import companyRoutes from './routes/company.js';
import taskRoutes from './routes/tasks.js';
import rotaRoutes from './routes/rota.js';
import helpdeskRoutes from './routes/helpdesk.js';
import assignedTaskRoutes from './routes/assignedTasks.js';
import accessRoutes from './routes/access.js';
import { logoOf } from '../services/company.js';
import { accessState } from '../services/billing.js';
import { logTransport } from '../services/notifications.js';
import { PRODUCT_NAME } from '../lib/product.js';
import '../services/jobs.js'; // registers workflow handlers

const PUBLIC = new Set(['/api/auth/login', '/api/auth/config', '/api/health', '/api/auth/signup', '/api/auth/signup/verify',
  '/api/auth/password/forgot', '/api/auth/password/reset', '/api/billing/webhook',
  '/api/auth/login/otp', '/api/auth/login/otp/resend']);
// Still reachable while a company's subscription is inactive, so it can see why and pay.
const OPEN_WHEN_BLOCKED = ['/api/me', '/api/billing', '/api/i18n', '/api/notifications'];
const BLOCKED_MESSAGES = {
  expired: "Your company's free trial has ended. Your HR admin can choose a plan on the Subscription page; your data is kept.",
  unpaid: "Access is paused because an invoice is unpaid. It returns as soon as the payment is recorded.",
  cancelled: `Your company's subscription was cancelled. Contact ${PRODUCT_NAME} to reactivate it; your data is kept.`,
};

/**
 * mailer    { send({ to, subject, text }) } for emails sent directly (sign-up links)
 * payments  online payment provider (services/payments.js) or null
 * appUrl    where the web app is served, for links in emails and payment redirects
 */
export function buildApp({ db, clock = systemClock(), jwtSecret = process.env.JWT_SECRET, logger = false,
  mailer = logTransport(), payments = null, appUrl = process.env.APP_URL ?? 'http://localhost:5300' } = {}) {
  if (!jwtSecret) throw new Error('JWT_SECRET is required');
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY === 'true' });
  app.decorate('db', db);
  app.decorate('clock', clock);
  app.decorate('jwtSecret', jwtSecret);
  app.decorate('mailer', mailer);
  app.decorate('payments', payments);
  app.decorate('appUrl', appUrl.replace(/\/+$/, ''));
  app.decorateRequest('ctx', null);
  app.decorateRequest('rawBody', null);
  // Accept POSTs that send a JSON content-type with no body (treated as {}).
  // The raw text is kept for webhook signature checks.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err); }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', req.headers.origin || '*');
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('access-control-allow-headers', 'authorization, content-type, accept-language');
    reply.header('access-control-allow-credentials', 'true');
    if (req.method === 'OPTIONS') {
      reply.status(204).send();
      return;
    }
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path) || path.startsWith('/api/logos/')) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError(401, 'unauthenticated', 'Please sign in.');
    const expired = () => new AppError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
    const idp = identity();
    let where;
    let sessionVersion = null; // local tokens carry the user's session_version (sv)
    if (idp.name === 'firebase') {
      // Firebase ID token from the browser's Firebase sign-in; matched by UID only.
      let decoded;
      try { decoded = await idp.verifyToken(token); } catch { throw expired(); }
      where = ['u.firebase_uid = $1', decoded.uid];
    } else {
      let claims;
      try { claims = jwt.verify(token, jwtSecret); } catch { throw expired(); }
      where = ['u.id = $1', claims.sub];
      sessionVersion = claims.sv ?? 0;
    }
    const user = await db.one(
      `select u.id, u.tenant_id, u.access_level, u.locale, u.is_active, u.session_version, e.id as employee_id, e.permissions
         from users u left join employees e on e.user_id = u.id where ${where[0]}`, [where[1]]);
    if (!user && idp.name === 'firebase') throw new AppError(401, 'unauthenticated', 'This Firebase account has no access to the HRM. Ask HR to create your login.');
    if (!user?.is_active) throw new AppError(401, 'unauthenticated', 'This account is disabled.');
    // Signed in before the password was changed (e.g. reset by email): that session is over.
    if (sessionVersion != null && sessionVersion !== user.session_version) {
      throw new AppError(401, 'unauthenticated', 'Your password was changed. Please sign in again.');
    }
    const tenant = user.tenant_id ? await db.one('select * from tenants where id = $1', [user.tenant_id]) : null;
    if (tenant?.status === 'pending') {
      throw new AppError(403, 'tenant_pending', `${tenant.name} is waiting for approval by ${PRODUCT_NAME}. You'll get an email as soon as it is approved.`);
    }
    if (tenant && tenant.status !== 'active') throw new AppError(403, 'tenant_suspended', 'This company account is suspended.');
    req.ctx = {
      db, clock, tenant, jwtSecret,
      actor: { userId: user.id, accessLevel: user.access_level, employeeId: user.employee_id, tenantId: user.tenant_id,
        permissions: effectivePermissions(user.access_level, user.permissions) },
      locale: req.headers['accept-language']?.split(',')[0]?.split('-')[0] || user.locale || tenant?.default_locale || 'en',
    };
    if (!tenant && !path.startsWith('/api/admin/') && path !== '/api/me') {
      throw new AppError(403, 'forbidden', 'Super admins manage companies under /api/admin.');
    }
    if (tenant) {
      const sub = await db.one('select status, trial_ends_on from subscriptions where tenant_id = $1', [tenant.id]);
      const state = accessState(sub, clock.now().toISOString().slice(0, 10));
      if (state.blocked && !OPEN_WHEN_BLOCKED.some((p) => path === p || path.startsWith(`${p}/`))) {
        throw new AppError(402, 'subscription_inactive', BLOCKED_MESSAGES[state.status], { params: { status: state.status } });
      }
    }
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof AppError) {
      const details = await localizeDetails(req, err.details);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, params: err.params, details } });
    }
    if (err.validation) return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    if (err.code === 'P0001') return reply.status(409).send({ error: { code: 'append_only', message: err.message } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  /** Is the API up and can it reach its database? (No details that would help an attacker.) */
  app.get('/api/health', async (req, reply) => {
    const started = Date.now();
    try {
      await db.one('select 1');
      return { ok: true, database: 'connected', databaseMs: Date.now() - started };
    } catch {
      return reply.status(503).send({ ok: false, database: 'unreachable' });
    }
  });
  /** A company's logo: public (for <img> tags and emails), versioned by ?v= so it can be cached for good. */
  app.get('/api/logos/:tenantId', async (req, reply) => {
    const logo = /^[0-9a-f-]{36}$/i.test(req.params.tenantId) ? await logoOf(db, req.params.tenantId) : null;
    if (!logo) throw new AppError(404, 'not_found', 'Logo not found.');
    return reply.header('content-type', logo.mime).header('x-content-type-options', 'nosniff')
      .header('cache-control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300').send(logo.buffer);
  });
  app.register(authRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(lookupRoutes, { prefix: '/api/lookups' });
  app.register(employeeRoutes, { prefix: '/api/employees' });
  app.register(settingRoutes, { prefix: '/api' });
  app.register(wfhRoutes, { prefix: '/api/wfh' });
  app.register(leaveRoutes, { prefix: '/api/leave' });
  app.register(miscRoutes, { prefix: '/api' });
  app.register(attendanceRoutes, { prefix: '/api/attendance' });
  app.register(workflowRoutes, { prefix: '/api' });
  app.register(dashboardRoutes, { prefix: '/api' });
  app.register(payrollRoutes, { prefix: '/api' });
  app.register(billingRoutes, { prefix: '/api/billing' });
  app.register(companyRoutes, { prefix: '/api/company' });
  app.register(taskRoutes, { prefix: '/api/tasks' });
  app.register(rotaRoutes, { prefix: '/api/rota' });
  app.register(helpdeskRoutes, { prefix: '/api/helpdesk' });
  app.register(assignedTaskRoutes, { prefix: '/api/assigned-tasks' });
  app.register(accessRoutes, { prefix: '/api/access' });
  return app;
}

/** Adds rendered `message`s to { code, params } reasons inside error details / results. */
export async function localizeReasons(req, value) {
  const ctx = req.ctx;
  if (!ctx?.tenant || value == null) return value;
  const fix = (list) => localize(ctx.db, ctx.tenant.id, ctx.locale, list);
  if (Array.isArray(value.reasons)) value.reasons = await fix(value.reasons);
  if (Array.isArray(value.warnings) && value.warnings.every((w) => w?.code)) value.warnings = await fix(value.warnings);
  if (Array.isArray(value.results)) for (const r of value.results) r.reasons = await fix(r.reasons);
  return value;
}

const localizeDetails = (req, details) => localizeReasons(req, details);
