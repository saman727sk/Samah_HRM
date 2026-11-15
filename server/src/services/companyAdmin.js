/**
 * The SaaS owner's edits to a company: its details, the sign-in of any of its
 * logins (name, email, password) and deleting the company with all its data.
 */
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { identity } from '../auth/identity.js';
import { requireSuperAdmin } from './billing.js';
import { saveCompanyProfile } from './company.js';
import { emailTaken } from './employees.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

async function loadTenant(db, tenantId) {
  const tenant = await db.one('select * from tenants where id = $1', [tenantId]);
  if (!tenant) throw notFound('Company');
  return tenant;
}

/** Name, contact details, currency (as HR can), plus the slug and time zone. */
export async function updateCompany(ctx, tenantId, input) {
  requireSuperAdmin(ctx);
  const tenant = await loadTenant(ctx.db, tenantId);
  const extra = {};
  if (input.slug !== undefined && input.slug !== tenant.slug) {
    const slug = String(input.slug).trim().toLowerCase();
    if (!SLUG.test(slug)) throw badRequest('company_invalid', 'The slug can use lowercase letters, numbers and dashes (up to 40).');
    if (await ctx.db.one('select 1 from tenants where slug = $1 and id <> $2', [slug, tenantId])) {
      throw conflict('duplicate', 'A company with this slug already exists.');
    }
    extra.slug = slug;
  }
  if (input.timezone !== undefined && input.timezone !== tenant.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone || 'invalid' }); }
    catch { throw badRequest('timezone_invalid', 'Choose a valid time zone.'); }
    extra.timezone = input.timezone;
  }
  return ctx.db.tx(async (db) => {
    const sub = { ...ctx, db, tenant };
    await saveCompanyProfile(sub, input);
    const cols = Object.keys(extra);
    if (cols.length) {
      await db.query(`update tenants set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
        [tenantId, ...cols.map((c) => extra[c])]);
      await audit(db, sub, { action: 'tenant.updated', entityType: 'tenant', entityId: tenantId,
        oldValue: Object.fromEntries(cols.map((c) => [c, tenant[c]])), newValue: extra });
    }
    return db.one('select * from tenants where id = $1', [tenantId]);
  });
}

/**
 * Changes a login of the company: the person's name, the sign-in email and/or
 * the password. A new password signs the person out everywhere.
 */
export async function updateLogin(ctx, tenantId, userId, { fullName, email, password } = {}) {
  requireSuperAdmin(ctx);
  const tenant = await loadTenant(ctx.db, tenantId);
  const user = await ctx.db.one('select * from users where id = $1 and tenant_id = $2', [userId, tenantId]);
  if (!user) throw notFound('Login');
  const nextEmail = email?.trim().toLowerCase();
  const emailChanged = !!nextEmail && nextEmail !== user.email.toLowerCase();
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail ?? '')) throw badRequest('login_invalid', 'Enter a valid email.');
  if (password && password.length < 8) throw badRequest('login_invalid', 'The password must be at least 8 characters.');
  if (fullName !== undefined && !fullName?.trim()) throw badRequest('login_invalid', 'Enter the name.');
  if (emailChanged) {
    const taken = await emailTaken(ctx.db, nextEmail, tenantId);
    if (taken) {
      throw conflict('login_exists', {
        company: 'This company already has a login with this email.',
        owner: 'This email is reserved for the platform owner. Use another email.',
        firebase: 'A login with this email already exists (with Firebase sign-in an email can have one login only).',
      }[taken]);
    }
  }
  const sub = { ...ctx, tenant };
  return ctx.db.tx(async (db) => {
    const changed = [];
    if (emailChanged) {
      try {
        await db.query('update users set email = $2 where id = $1', [userId, nextEmail]);
      } catch (err) {
        if (err.code === '23505') throw conflict('login_exists', 'A login with this email already exists.');
        throw err;
      }
      // Keep the employee record's contact email in step when it was the sign-in email.
      await db.query('update employees set email = $3 where user_id = $1 and tenant_id = $2 and (email is null or lower(email) = lower($4))',
        [userId, tenantId, nextEmail, user.email]);
      changed.push('email');
    }
    if (fullName?.trim()) {
      const r = await db.query('update employees set full_name = $3, updated_at = now() where user_id = $1 and tenant_id = $2 and full_name <> $3 returning id',
        [userId, tenantId, fullName.trim()]);
      if (r.rows.length) changed.push('name');
    }
    if (password) {
      const account = user.firebase_uid ? { passwordHash: null } : await identity().createAccount({ password });
      await db.query(`update users set password_hash = coalesce($2, password_hash), password_changed_at = now(),
                             session_version = session_version + 1 where id = $1`, [userId, account.passwordHash]);
      changed.push('password');
    }
    if (!changed.length) return { changed };
    // Firebase sign-in: change the Firebase account too. Last, so a refusal rolls the database back.
    if (user.firebase_uid && (emailChanged || password)) {
      await identity().updateAccount(user.firebase_uid, { email: emailChanged ? nextEmail : undefined, password: password || undefined });
    }
    await audit(db, sub, { action: 'login.updated_by_owner', entityType: 'user', entityId: userId,
      oldValue: emailChanged ? { email: user.email } : null, newValue: emailChanged ? { email: nextEmail } : null, meta: { changed } });
    return { changed };
  });
}

/** Tables with a column of this name, read from the database itself so new tables are covered. */
async function tablesWithColumn(db, column) {
  const { rows } = await db.query(
    `select table_name from information_schema.columns
      where table_schema = current_schema() and column_name = $1 and table_name <> 'tenants'`, [column]);
  return rows.map((r) => r.table_name);
}

/**
 * Deletes the company and everything in it: employees, logins, attendance,
 * payroll, invoices... `confirmName` must repeat the company's name.
 * Cannot be undone. The deletion itself stays in the platform audit log.
 */
export async function deleteCompany(ctx, tenantId, { confirmName } = {}) {
  requireSuperAdmin(ctx);
  const tenant = await loadTenant(ctx.db, tenantId);
  if ((confirmName ?? '').trim().toLowerCase() !== tenant.name.trim().toLowerCase()) {
    throw badRequest('confirm_required', `Type the company name (${tenant.name}) to confirm.`);
  }
  const firebaseUids = [];
  const counts = await ctx.db.tx(async (db) => {
    // Lets the append-only / frozen-payroll triggers allow deleting this company's rows (migration 019), for this transaction only.
    await db.query(`select set_config('hrm.deleting_tenant', $1, true)`, [tenantId]);
    const users = (await db.query('select id, firebase_uid from users where tenant_id = $1', [tenantId])).rows;
    firebaseUids.push(...users.map((u) => u.firebase_uid).filter(Boolean));
    // Rows outside this company that name one of its users (e.g. "updated by") keep the row, without the name.
    const { rows: refs } = await db.query(
      `select c.conrelid::regclass::text as tbl, a.attname as col, a.attnotnull as not_null
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'users'::regclass and array_length(c.conkey, 1) = 1`);
    const tenantTables = new Set(await tablesWithColumn(db, 'tenant_id'));
    for (const r of refs) {
      if (r.not_null) continue; // only rows of this company can point there; they are deleted below
      const own = tenantTables.has(r.tbl) ? ' and tenant_id is distinct from $1' : '';
      await db.query(`update ${r.tbl} set ${r.col} = null where ${r.col} in (select id from users where tenant_id = $1)${own}`, [tenantId]);
    }
    // Sign-in helpers kept without foreign keys (see migrations 013 and 016).
    for (const tbl of ['password_resets', 'login_challenges']) {
      await db.query(`delete from ${tbl} where user_id in (select id from users where tenant_id = $1)`, [tenantId]);
    }
    // Delete children before parents: retry tables a foreign key still blocks until none is left.
    const deleted = {};
    let pending = [...tenantTables];
    while (pending.length) {
      const blocked = [];
      for (const tbl of pending) {
        await db.query('savepoint del_company');
        try {
          const r = await db.query(`delete from ${tbl} where tenant_id = $1 returning 1`, [tenantId]);
          await db.query('release savepoint del_company');
          if (r.rows.length) deleted[tbl] = r.rows.length;
        } catch (err) {
          await db.query('rollback to savepoint del_company');
          if (err.code !== '23503') throw err; // only "still referenced" is retried
          blocked.push({ tbl, err });
        }
      }
      if (blocked.length === pending.length) {
        throw conflict('delete_blocked', `The company could not be deleted: ${blocked[0].err.message}`);
      }
      pending = blocked.map((b) => b.tbl);
    }
    await db.query('delete from tenants where id = $1', [tenantId]);
    await audit(db, { ...ctx, tenant: null }, { action: 'tenant.deleted', entityType: 'tenant', entityId: tenantId,
      oldValue: { name: tenant.name, slug: tenant.slug, contact_email: tenant.contact_email }, meta: { rows: deleted } });
    return deleted;
  });
  // Firebase accounts are removed once the database change is committed.
  for (const uid of firebaseUids) await identity().removeAccount(uid);
  return { deleted: true, name: tenant.name, rows: counts };
}
