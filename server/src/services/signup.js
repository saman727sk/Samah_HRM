/**
 * Public company sign-up.
 *
 *   1. requestSignup: validates, stores a signup_request (password already
 *      hashed, or a disabled Firebase account) and emails a one-time link.
 *      The answer is the same whether or not the email already has an
 *      account, so the form can't be used to find out who is registered.
 *   2. verifySignup: the link's token (stored only as a SHA-256 hash, valid
 *      24 hours, usable once) creates the company on the trial plan and its
 *      first HR admin, in one transaction. With "signupRequiresApproval" on
 *      (the default) the company stays 'pending' until the super admin
 *      approves it (billing.approveTenant), and the support email is told.
 *
 * Nothing is created for an unverified email, so typos and fake sign-ups
 * leave no company behind; expired requests are purged by the jobs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { identity } from '../auth/identity.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { CURRENCY_HELP, isCurrency } from '../lib/currency.js';
import { PRODUCT_NAME } from '../lib/product.js';
import { billingSettings } from './billing.js';
import { createEmployee, emailTaken } from './employees.js';
import { loadDefaults, provisionTenant } from './tenants.js';

const TOKEN_TTL_MS = 24 * 3600_000;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const utcToday = (clock) => clock.now().toISOString().slice(0, 10);

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function validate(input) {
  const errors = [];
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const data = {
    companyName: s(input.companyName), ownerName: s(input.ownerName), email: s(input.email).toLowerCase(), password: input.password ?? '',
    phone: s(input.phone) || null, country: s(input.country) || null, timezone: s(input.timezone) || 'Asia/Karachi',
    currency: (s(input.currency) || 'PKR').toUpperCase(),
  };
  if (data.companyName.length < 2 || data.companyName.length > 120) errors.push('Enter your company name (2-120 characters).');
  if (!data.ownerName) errors.push('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('Enter a valid work email.');
  if (typeof data.password !== 'string' || data.password.length < 8) errors.push('The password must be at least 8 characters.');
  if (!validTimezone(data.timezone)) errors.push('Choose a valid time zone.');
  if (!isCurrency(data.currency)) errors.push(CURRENCY_HELP);
  if (errors.length) throw badRequest('signup_invalid', errors.join(' '), { details: { errors } });
  return data;
}

/** ctx: { db, clock, mailer, appUrl, exposeLink? } */
export async function requestSignup(ctx, input, { ip = null } = {}) {
  const settings = await billingSettings(ctx.db);
  if (settings.signupEnabled === false) throw new AppError(403, 'signup_closed', 'New sign-ups are closed at the moment. Please contact us.');
  const data = validate(input);
  const send = (subject, text) => ctx.mailer.send({ to: data.email, subject, text });

  // A login in another company doesn't stop a new sign-up (it becomes a separate account);
  // the owner's email, and any used email under Firebase sign-in, does.
  if (await emailTaken(ctx.db, data.email, null)) {
    await send(`You already have a ${PRODUCT_NAME} account`,
      `Someone (hopefully you) tried to register a company with ${data.email}, which already has an account.\n\n` +
      `Sign in at ${ctx.appUrl}/ instead. If you forgot your password, ask your company's HR admin.\n\nIf this wasn't you, you can ignore this email.\n\n${PRODUCT_NAME}`);
    return { ok: true };
  }

  // A new request replaces any earlier unverified one for the same email.
  const { rows: old } = await ctx.db.query(
    `delete from signup_requests where lower(email) = $1 and verified_at is null returning firebase_uid`, [data.email]);
  for (const r of old) if (r.firebase_uid) await identity().removeAccount(r.firebase_uid);

  // Firebase: create the account now (disabled) so the password never reaches our database.
  const account = await identity().createAccount({ email: data.email, password: data.password, displayName: data.ownerName });
  if (account.firebaseUid) await identity().setDisabled(account.firebaseUid, true);

  const token = randomBytes(32).toString('base64url');
  await ctx.db.query(
    `insert into signup_requests (email, company_name, owner_name, phone, country, timezone, currency, password_hash, firebase_uid, token_hash, expires_at, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [data.email, data.companyName, data.ownerName, data.phone, data.country, data.timezone, data.currency, account.passwordHash, account.firebaseUid,
      hashToken(token), new Date(ctx.clock.now().getTime() + TOKEN_TTL_MS), ip]);
  await send(`Confirm your email to create ${data.companyName}`,
    `Hello ${data.ownerName},\n\nOpen this link to confirm your email and create your company's ${PRODUCT_NAME} account:\n\n` +
    `${ctx.appUrl}/#/verify?token=${token}\n\nThe link works once and expires in 24 hours.\n\nIf you didn't sign up, ignore this email; nothing is created.\n\n${PRODUCT_NAME}`);
  // Development without email: hand the link back so it can be opened from the page (never in production).
  return ctx.exposeLink ? { ok: true, devLink: `${ctx.appUrl}/#/verify?token=${token}` } : { ok: true };
}

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'company';

/** ctx: { db, clock, mailer?, appUrl? } -> { tenant, userId, email, pending } */
export async function verifySignup(ctx, token) {
  const invalid = () => badRequest('link_invalid', 'This link is invalid, already used or expired. Please sign up again.');
  if (typeof token !== 'string' || token.length < 20) throw invalid();
  const defaults = await loadDefaults();
  const settings = await billingSettings(ctx.db);
  const pending = settings.signupRequiresApproval !== false;
  const result = await ctx.db.tx(async (db) => {
    const req = await db.one('select * from signup_requests where token_hash = $1 for update', [hashToken(token)]);
    if (!req || req.verified_at || new Date(req.expires_at) < ctx.clock.now()) throw invalid();
    if (await emailTaken(db, req.email, null)) throw conflict('login_exists', 'An account with this email already exists. Sign in instead.');
    let slug = slugify(req.company_name);
    while (await db.one('select 1 from tenants where slug = $1', [slug])) slug = `${slugify(req.company_name).slice(0, 27)}-${randomBytes(2).toString('hex')}`;
    const today = utcToday(ctx.clock);
    const { tenant } = await provisionTenant(db, { name: req.company_name, slug, timezone: req.timezone, currency: req.currency, today }, defaults);
    await db.query('update tenants set contact_email = $2, phone = $3, country = $4, status = $5 where id = $1',
      [tenant.id, req.email, req.phone, req.country, pending ? 'pending' : 'active']);
    const tctx = { db, clock: ctx.clock, tenant, actor: { system: true }, locale: 'en' };
    const employee = await createEmployee(tctx, { full_name: req.owner_name, email: req.email, phone: req.phone, joining_date: today,
      login: { email: req.email, accessLevel: 'hr_admin' } }, { account: { passwordHash: req.password_hash, firebaseUid: req.firebase_uid } });
    await db.query('update signup_requests set verified_at = now(), tenant_id = $2 where id = $1', [req.id, tenant.id]);
    return { tenant, userId: employee.user_id, email: req.email, firebaseUid: req.firebase_uid };
  });
  if (result.firebaseUid) await identity().setDisabled(result.firebaseUid, false);
  if (pending && settings.supportEmail && ctx.mailer) {
    await ctx.mailer.send({ to: settings.supportEmail, subject: `New company awaiting approval: ${result.tenant.name}`,
      text: `${result.tenant.name} (${result.email}) signed up and confirmed its email.\n\nApprove or reject it in ${PRODUCT_NAME}: ${ctx.appUrl ?? ''}/#/admin/companies` })
      .catch(() => {}); // the sign-up stands even if this email can't be sent
  }
  return { ...result, pending };
}

/** Removes unverified sign-ups a week after their link expired (and their disabled Firebase accounts). */
export async function purgeExpiredSignups(db, clock) {
  const { rows } = await db.query(
    `delete from signup_requests where verified_at is null and expires_at < $1 returning firebase_uid`,
    [new Date(clock.now().getTime() - 7 * 24 * 3600_000)]);
  for (const r of rows) if (r.firebase_uid) await identity().removeAccount(r.firebase_uid);
  return rows.length;
}
