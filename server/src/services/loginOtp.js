/**
 * Two-step sign-in (local sign-in only): after the password is right, a 6-digit code is
 * emailed and must be entered before a session is issued.
 *
 *   startChallenge   password OK -> email a code, return a challenge token for the browser
 *   verifyChallenge  challenge + code -> the user (the route then issues the session token)
 *   resendCode       a fresh code for the same challenge (30 s apart, at most 5 per sign-in)
 *
 * Only SHA-256 hashes of the challenge token and the code are stored. A code works once, for
 * 10 minutes, and 5 wrong codes end the challenge (the user signs in again).
 *
 * Switched on by the platform setting `loginOtp`. LOGIN_OTP=off in server/.env turns it off
 * for the whole server (an emergency switch, e.g. when email stops working). In production
 * it needs email (Resend or SMTP): without it nobody could receive a code, so sign-in stays password-only.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { audit } from '../lib/audit.js';
import { AppError, badRequest } from '../lib/errors.js';
import { PRODUCT_NAME } from '../lib/product.js';
import { billingSettings } from './billing.js';
import { emailConfigured } from './notifications.js';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_SENDS = 5;
export const RESEND_AFTER_MS = 30_000;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const codeHash = (token, code) => sha(`${token}:${code}`); // tied to its challenge

/** Whether sign-in asks for an emailed code. */
export async function otpRequired(db) {
  if (String(process.env.LOGIN_OTP ?? '').toLowerCase() === 'off') return false;
  if (process.env.NODE_ENV === 'production' && !emailConfigured()) return false;
  return (await billingSettings(db)).loginOtp === true;
}

/** "ali@gmail.com" -> "a**@gmail.com": shows where the code went without revealing the address. */
export const maskEmail = (email) => {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(name.length - 1, 6)))}@${domain}`;
};

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

async function sendCode(ctx, user, code) {
  const where = user.company ? ` to ${user.company}` : ` as the ${PRODUCT_NAME} owner`;
  await ctx.mailer.send({ to: user.email, subject: `${code} is your ${PRODUCT_NAME} sign-in code`,
    text: `Hello,\n\nYour code to sign in${where} is:\n\n    ${code}\n\nIt works once and expires in 10 minutes.\n\n` +
      `If you didn't just try to sign in, someone knows your password: change it now with "Forgot password?" on the sign-in page.\n\n${PRODUCT_NAME}` });
}

/**
 * ctx: { db, clock, mailer, exposeCode? }; user: the row from sign-in (id, email, company).
 * -> { challenge, email (masked), expiresIn (s), devCode? }
 */
export async function startChallenge(ctx, user, { ip = null } = {}) {
  const token = randomBytes(32).toString('base64url');
  const code = newCode();
  const now = ctx.clock.now();
  await ctx.db.query('delete from login_challenges where user_id = $1 and used_at is null', [user.id]); // only the newest code works
  await ctx.db.query(
    `insert into login_challenges (user_id, token_hash, code_hash, expires_at, last_sent_at, ip) values ($1, $2, $3, $4, $5, $6)`,
    [user.id, sha(token), codeHash(token, code), new Date(now.getTime() + CODE_TTL_MS), now, ip]);
  await sendCode(ctx, user, code);
  return { challenge: token, email: maskEmail(user.email), expiresIn: CODE_TTL_MS / 1000, ...(ctx.exposeCode ? { devCode: code } : {}) };
}

const expired = () => new AppError(401, 'otp_expired', 'This sign-in code has expired or was used. Sign in again to get a new code.');

async function loadChallenge(db, token) {
  if (typeof token !== 'string' || token.length < 20) throw expired();
  return db.one('select * from login_challenges where token_hash = $1 for update', [sha(token)]);
}

/** ctx: { db, clock } -> the user's id, once the code is right. */
export async function verifyChallenge(ctx, token, code) {
  const entered = String(code ?? '').replace(/\D/g, '');
  if (entered.length !== 6) throw badRequest('otp_invalid', 'Enter the 6-digit code from the email.');
  const result = await ctx.db.tx(async (db) => {
    const c = await loadChallenge(db, token);
    if (!c || c.used_at || new Date(c.expires_at) < ctx.clock.now() || c.attempts >= MAX_ATTEMPTS) return { error: expired() };
    const ok = timingSafeEqual(Buffer.from(codeHash(token, entered)), Buffer.from(c.code_hash));
    if (!ok) {
      const left = MAX_ATTEMPTS - (c.attempts + 1);
      await db.query('update login_challenges set attempts = attempts + 1 where id = $1', [c.id]);
      return { error: left > 0
        ? new AppError(401, 'otp_wrong', `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { details: { left } })
        : new AppError(401, 'otp_locked', 'Too many wrong codes. Sign in again to get a new code.') };
    }
    await db.query('update login_challenges set used_at = now() where id = $1', [c.id]);
    return { userId: c.user_id };
  });
  // The wrong-code count is saved before the error is thrown (outside the transaction).
  if (result.error) throw result.error;
  const user = await ctx.db.one(
    `select u.id, u.tenant_id from users u where u.id = $1 and u.is_active`, [result.userId]);
  if (!user) throw expired();
  const tenant = user.tenant_id ? await ctx.db.one('select * from tenants where id = $1', [user.tenant_id]) : null;
  await audit(ctx.db, { tenant, actor: { userId: user.id } }, { action: 'user.signed_in', entityType: 'user', entityId: user.id, meta: { via: 'email code' } });
  return result.userId;
}

/** ctx: { db, clock, mailer, exposeCode? } -> { email, expiresIn, devCode? } */
export async function resendCode(ctx, token) {
  return ctx.db.tx(async (db) => {
    const c = await loadChallenge(db, token);
    const now = ctx.clock.now();
    if (!c || c.used_at || c.attempts >= MAX_ATTEMPTS) throw expired();
    if (c.sends >= MAX_SENDS) throw new AppError(429, 'otp_resend_limit', 'Too many codes sent. Sign in again to start over.');
    const wait = Math.ceil((new Date(c.last_sent_at).getTime() + RESEND_AFTER_MS - now.getTime()) / 1000);
    if (wait > 0) throw new AppError(429, 'otp_resend_wait', `Wait ${wait} seconds before asking for another code.`, { details: { wait } });
    const user = await db.one(
      `select u.id, u.email, t.name as company from users u left join tenants t on t.id = u.tenant_id where u.id = $1 and u.is_active`, [c.user_id]);
    if (!user) throw expired();
    const code = newCode();
    await db.query(
      `update login_challenges set code_hash = $2, expires_at = $3, attempts = 0, sends = sends + 1, last_sent_at = $4 where id = $1`,
      [c.id, codeHash(token, code), new Date(now.getTime() + CODE_TTL_MS), now]);
    await sendCode(ctx, user, code);
    return { email: maskEmail(user.email), expiresIn: CODE_TTL_MS / 1000, ...(ctx.exposeCode ? { devCode: code } : {}) };
  });
}
