/**
 * "Forgot password" for local sign-in (Firebase sign-in uses Firebase's own reset email).
 *
 *   1. requestPasswordReset: emails a one-time link to the address, if it has a login.
 *      The answer is the same either way, so the form can't reveal who has an account.
 *      An email with logins in several companies gets one link per company.
 *   2. resetPassword: the link's token (stored only as a SHA-256 hash, valid one hour,
 *      usable once) sets the new password. Sessions signed in before it stop working.
 */
import { createHash, randomBytes } from 'node:crypto';
import { identity } from '../auth/identity.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest } from '../lib/errors.js';
import { PRODUCT_NAME } from '../lib/product.js';

const TOKEN_TTL_MS = 60 * 60_000;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const MIN_PASSWORD = 8;

/** ctx: { db, clock, mailer, appUrl, exposeLink? } */
export async function requestPasswordReset(ctx, email, { ip = null } = {}) {
  if (identity().name === 'firebase') throw new AppError(410, 'use_firebase', 'Password resets are sent by Firebase on this server.');
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw badRequest('email_invalid', 'Enter the email you sign in with.');
  const { rows } = await ctx.db.query(
    `select u.id, u.email, t.name as company from users u left join tenants t on t.id = u.tenant_id
      where lower(u.email) = $1 and u.is_active and u.password_hash is not null order by t.name nulls first`, [address]);
  if (!rows.length) return {}; // same answer as when it exists
  const links = [];
  for (const u of rows) {
    await ctx.db.query('delete from password_resets where user_id = $1 and used_at is null', [u.id]); // only the newest link works
    const token = randomBytes(32).toString('base64url');
    await ctx.db.query('insert into password_resets (user_id, token_hash, expires_at, ip) values ($1, $2, $3, $4)',
      [u.id, hashToken(token), new Date(ctx.clock.now().getTime() + TOKEN_TTL_MS), ip]);
    links.push({ company: u.company ?? `${PRODUCT_NAME} (platform owner)`, link: `${ctx.appUrl}/#/reset?token=${token}` });
  }
  const body = links.length === 1
    ? `Open this link to choose a new password:\n\n${links[0].link}`
    : `This email signs in to more than one company. Open the link for the one whose password you want to reset:\n\n${links.map((l) => `${l.company}:\n${l.link}`).join('\n\n')}`;
  try {
    await ctx.mailer.send({ to: address, subject: `Reset your ${PRODUCT_NAME} password`,
      text: `Hello,\n\nWe received a request to reset the password for ${address}.\n\n${body}\n\nThe link works once and expires in 1 hour. ` +
        `If you didn't ask for this, ignore this email: your password stays the same.\n\n${PRODUCT_NAME}` });
  } catch (err) {
    // Same answer as for an unknown email (an error here would reveal the account exists); the transport logged why.
    if (err.code !== 'email_failed') throw err;
  }
  return ctx.exposeLink ? { devLinks: links } : {};
}

/** ctx: { db, clock } -> { email, company } */
export async function resetPassword(ctx, token, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw badRequest('password_invalid', `The new password must be at least ${MIN_PASSWORD} characters.`);
  }
  const invalid = () => badRequest('link_invalid', 'This reset link is invalid, already used or expired. Ask for a new one.');
  if (typeof token !== 'string' || token.length < 20) throw invalid();
  const { passwordHash } = await identity().createAccount({ password }); // local mode: a bcrypt hash
  return ctx.db.tx(async (db) => {
    const r = await db.one('select * from password_resets where token_hash = $1 for update', [hashToken(token)]);
    if (!r || r.used_at || new Date(r.expires_at) < ctx.clock.now()) throw invalid();
    const user = await db.one(
      `update users set password_hash = $2, password_changed_at = now(), session_version = session_version + 1 where id = $1 and is_active
       returning id, email, tenant_id`, [r.user_id, passwordHash]);
    if (!user) throw invalid();
    await db.query('update password_resets set used_at = now() where id = $1', [r.id]);
    await db.query('delete from password_resets where user_id = $1 and used_at is null', [user.id]);
    const tenant = user.tenant_id ? await db.one('select * from tenants where id = $1', [user.tenant_id]) : null;
    await audit(db, { tenant, actor: { userId: user.id } }, { action: 'user.password_reset', entityType: 'user', entityId: user.id, meta: { via: 'email link' } });
    return { email: user.email, company: tenant?.name ?? null };
  });
}
