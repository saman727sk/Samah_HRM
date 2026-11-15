import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppError } from '../../lib/errors.js';
import { identity } from '../../auth/identity.js';
import { PRODUCT_NAME } from '../../lib/product.js';
import { rateLimiter } from '../../lib/rateLimit.js';
import { billingSettings, subscriptionSummary } from '../../services/billing.js';
import { logoUrl } from '../../services/company.js';
import { enabledModules } from '../../services/features.js';
import { requestSignup, verifySignup } from '../../services/signup.js';
import { requestPasswordReset, resetPassword } from '../../services/passwordReset.js';
import { emailConfigured } from '../../services/notifications.js';
import { otpRequired, resendCode, startChallenge, verifyChallenge } from '../../services/loginOtp.js';

/** sv: the user's session_version; a password change raises it, ending every older token. */
const signToken = (app, userId, sessionVersion = 0) => jwt.sign({ sub: userId, sv: sessionVersion }, app.jwtSecret, { expiresIn: process.env.JWT_TTL ?? '12h' });

export default async function authRoutes(app) {
  // Per process; see lib/rateLimit.js.
  const loginLimit = rateLimiter({ limit: 10, windowMs: 15 * 60_000, message: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
  const signupLimit = rateLimiter({ limit: 5, windowMs: 60 * 60_000, message: 'Too many sign-ups from this network. Try again in an hour.' });
  const verifyLimit = rateLimiter({ limit: 20, windowMs: 60 * 60_000 });
  const otpLimit = rateLimiter({ limit: 20, windowMs: 15 * 60_000, message: 'Too many code attempts. Wait 15 minutes and try again.' });
  // No email set up while developing: the page shows the code itself (never in production, never with SMTP).
  const exposeCode = () => process.env.NODE_ENV !== 'production' && !emailConfigured();

  /** Tells the web app how to sign in ('firebase' or 'password') and whether companies can sign up. */
  app.get('/auth/config', async () => ({ provider: identity().name, signupEnabled: (await billingSettings(app.db)).signupEnabled !== false }));

  /** Public company sign-up: emails a confirmation link; nothing is created yet. */
  app.post('/auth/signup', async (req, reply) => {
    signupLimit(req.ip);
    // No email set up while developing: the page shows the link itself (never in production, never with SMTP).
    const exposeLink = process.env.NODE_ENV !== 'production' && !emailConfigured();
    const r = await requestSignup({ db: app.db, clock: app.clock, mailer: app.mailer, appUrl: app.appUrl, exposeLink }, req.body ?? {}, { ip: req.ip });
    return reply.status(202).send({ ok: true, message: 'Check your email for a link to confirm it and create your company.', devLink: r.devLink });
  });

  /** Opens the emailed link: creates the company and its HR admin, and signs them in (local mode). */
  const forgotLimit = rateLimiter({ limit: 5, windowMs: 15 * 60_000, message: 'Too many reset requests. Wait 15 minutes and try again.' });
  const resetLimit = rateLimiter({ limit: 20, windowMs: 60 * 60_000 });

  /** Forgot password: emails a one-time reset link (same answer whether or not the email has an account). */
  app.post('/auth/password/forgot', async (req) => {
    forgotLimit(`${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`);
    const exposeLink = process.env.NODE_ENV !== 'production' && !emailConfigured(); // development without email
    const r = await requestPasswordReset({ db: app.db, clock: app.clock, mailer: app.mailer, appUrl: app.appUrl, exposeLink }, req.body?.email, { ip: req.ip });
    return { ok: true, message: 'If this email has an account, a reset link is on its way. It works for 1 hour.', devLinks: r.devLinks };
  });

  /** Sets the new password from the emailed link. */
  app.post('/auth/password/reset', async (req) => {
    resetLimit(req.ip);
    const r = await resetPassword({ db: app.db, clock: app.clock }, req.body?.token, req.body?.password);
    return { ok: true, email: r.email, company: r.company };
  });

  app.post('/auth/signup/verify', async (req) => {
    verifyLimit(req.ip);
    const r = await verifySignup({ db: app.db, clock: app.clock, mailer: app.mailer, appUrl: app.appUrl }, req.body?.token);
    // Waiting for the super admin's approval: nobody can sign in yet, so no token.
    return { email: r.email, company: r.tenant.name, pending: r.pending,
      token: !r.pending && identity().name === 'password' ? signToken(app, r.userId) : null };
  });

  app.post('/auth/login', async (req) => {
    if (identity().name === 'firebase') throw new AppError(410, 'use_firebase', 'Sign in with Firebase; this server does not check passwords itself.');
    const { email, password, tenantId } = req.body ?? {};
    loginLimit(`${req.ip}|${String(email ?? '').toLowerCase()}`);
    // One email can have a login in several companies (separate accounts and passwords).
    const { rows } = email && password ? await app.db.query(
      `select u.*, t.name as company, t.status as company_status from users u left join tenants t on t.id = u.tenant_id
        where lower(u.email) = lower($1) and u.is_active and u.password_hash is not null order by t.name nulls first`, [email]) : { rows: [] };
    const matches = [];
    for (const u of rows) if (await bcrypt.compare(password, u.password_hash)) matches.push(u);
    if (!matches.length) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    // The software owner (super admin) always signs in directly; company logins may need a choice.
    let user = matches.find((u) => u.access_level === 'super_admin');
    if (!user) {
      user = tenantId ? matches.find((u) => u.tenant_id === tenantId) : matches.length === 1 ? matches[0] : null;
      // Only companies whose password matched are listed, so this reveals nothing to someone without it.
      if (!user) {
        throw new AppError(409, 'choose_company', 'This email has a login in more than one company. Choose the company to sign in to.',
          { details: { companies: matches.map((u) => ({ id: u.tenant_id, name: u.company })) } });
      }
    }
    // Say why at sign-in rather than failing on the first page.
    if (user.company_status === 'pending') throw new AppError(403, 'tenant_pending', `${user.company} is waiting for approval by ${PRODUCT_NAME}. You'll get an email as soon as it is approved.`);
    if (user.company_status === 'suspended') throw new AppError(403, 'tenant_suspended', `${user.company}'s account is suspended. Contact ${PRODUCT_NAME}.`);
    // Two-step sign-in: the password was right; now a code emailed to the account.
    if (await otpRequired(app.db)) {
      const c = await startChallenge({ db: app.db, clock: app.clock, mailer: app.mailer, exposeCode: exposeCode() }, user, { ip: req.ip });
      return { otpRequired: true, company: user.company ?? null, ...c };
    }
    return session(user);
  });

  const session = (user) => ({ token: signToken(app, user.id, user.session_version),
    user: { id: user.id, email: user.email, accessLevel: user.access_level, tenantId: user.tenant_id, company: user.company ?? null } });

  /** Second step: the emailed code -> the session. */
  app.post('/auth/login/otp', async (req) => {
    otpLimit(req.ip);
    const userId = await verifyChallenge({ db: app.db, clock: app.clock }, req.body?.challenge, req.body?.code);
    const user = await app.db.one(
      `select u.*, t.name as company, t.status as company_status from users u left join tenants t on t.id = u.tenant_id where u.id = $1`, [userId]);
    if (user.company_status === 'pending') throw new AppError(403, 'tenant_pending', `${user.company} is waiting for approval by ${PRODUCT_NAME}.`);
    if (user.company_status === 'suspended') throw new AppError(403, 'tenant_suspended', `${user.company}'s account is suspended. Contact ${PRODUCT_NAME}.`);
    return session(user);
  });

  /** A new code for the same sign-in (30 seconds apart, at most 5). */
  app.post('/auth/login/otp/resend', async (req) => {
    otpLimit(req.ip);
    return resendCode({ db: app.db, clock: app.clock, mailer: app.mailer, exposeCode: exposeCode() }, req.body?.challenge);
  });

  /** Change my own password: the current one is checked; other sessions end, this one gets a new token. */
  app.post('/me/password', async (req) => {
    if (identity().name === 'firebase') throw new AppError(400, 'use_firebase', 'Use "Forgot password" on the sign-in page to change your password.');
    loginLimit(`pw|${req.ctx.actor.userId}`);
    const { currentPassword, newPassword } = req.body ?? {};
    const u = await app.db.one('select id, password_hash, session_version from users where id = $1', [req.ctx.actor.userId]);
    if (!u?.password_hash || !currentPassword || !(await bcrypt.compare(currentPassword, u.password_hash))) {
      throw new AppError(400, 'wrong_password', 'Your current password is not right.');
    }
    if (!newPassword || String(newPassword).length < 8) throw new AppError(400, 'password_invalid', 'The new password must be at least 8 characters.');
    if (newPassword === currentPassword) throw new AppError(400, 'password_invalid', 'Choose a password different from the current one.');
    const { passwordHash } = await identity().createAccount({ password: newPassword });
    const next = await app.db.one(`update users set password_hash = $2, password_changed_at = now(), session_version = session_version + 1
      where id = $1 returning session_version`, [u.id, passwordHash]);
    return { token: signToken(app, u.id, next.session_version) };
  });

  app.get('/me', async (req) => {
    const { actor, tenant } = req.ctx;
    const employee = actor.employeeId
      ? await app.db.one('select id, employee_code, full_name, department_id, role_id, manager_id from employees where id = $1', [actor.employeeId])
      : null;
    const modules = tenant ? await enabledModules(req.ctx) : [];
    const subscription = tenant ? await subscriptionSummary(app.db, tenant.id, req.ctx.clock) : null;
    return { user: actor, tenant: tenant && { id: tenant.id, name: tenant.name, timezone: tenant.timezone, currency: tenant.currency, logoUrl: logoUrl(tenant) },
      employee, modules, subscription };
  });
}
