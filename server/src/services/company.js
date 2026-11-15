/**
 * A company's own profile: the name, contact details and logo shown on its
 * screens and printed on its payslips. Managed by the company's HR admins.
 *
 * Logos: PNG or JPEG only, recognised from the file's bytes (not its name or
 * declared type), at most 512 KB. SVG is refused because it can carry script.
 * They are served from a public, versioned URL (/api/logos/<company>?v=...)
 * so <img> tags and the PDF renderer can load them without a session.
 */
import { audit } from '../lib/audit.js';
import { CURRENCY_HELP, isCurrency } from '../lib/currency.js';
import { badRequest } from '../lib/errors.js';
import { requireHr } from './access.js';

export const MAX_LOGO_BYTES = 512 * 1024;

export const logoUrl = (tenant) =>
  (tenant?.logo_updated_at ? `/api/logos/${tenant.id}?v=${new Date(tenant.logo_updated_at).getTime()}` : null);

/** Salaries and payslips exist in the current currency once a payroll has run. */
export async function hasPayroll(db, tenantId) {
  return !!(await db.one('select 1 from payroll_runs where tenant_id = $1 limit 1', [tenantId]));
}

export function companyProfile(tenant) {
  return {
    id: tenant.id, name: tenant.name, contactEmail: tenant.contact_email, phone: tenant.phone, address: tenant.address,
    country: tenant.country, timezone: tenant.timezone, currency: tenant.currency, logoUrl: logoUrl(tenant),
  };
}

export async function updateCompanyProfile(ctx, input) {
  requireHr(ctx);
  return saveCompanyProfile(ctx, input);
}

/** The profile change itself, without the access check (the SaaS owner edits through services/companyAdmin.js). */
export async function saveCompanyProfile(ctx, input) {
  const clean = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const errors = [];
  const next = {};
  if (input.name !== undefined) {
    const name = clean(input.name, 120);
    if (!name || name.length < 2) errors.push('The company name needs at least 2 characters.');
    else next.name = name;
  }
  if (input.contactEmail !== undefined) {
    const email = clean(input.contactEmail, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email.');
    else next.contact_email = email;
  }
  if (input.phone !== undefined) next.phone = clean(input.phone, 40);
  if (input.address !== undefined) next.address = clean(input.address, 300);
  if (input.country !== undefined) next.country = clean(input.country, 80);
  if (input.currency !== undefined && input.currency !== ctx.tenant.currency) {
    if (!isCurrency(input.currency)) errors.push(CURRENCY_HELP);
    else if (await hasPayroll(ctx.db, ctx.tenant.id)) {
      errors.push(`The currency can't change after the first payroll run (salaries and payslips are in ${ctx.tenant.currency}).`);
    } else next.currency = input.currency;
  }
  if (errors.length) throw badRequest('company_invalid', errors.join(' '), { details: { errors } });
  const cols = Object.keys(next);
  if (!cols.length) return companyProfile(ctx.tenant);
  const before = ctx.tenant;
  const row = await ctx.db.one(`update tenants set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning *`,
    [ctx.tenant.id, ...cols.map((c) => next[c])]);
  await audit(ctx.db, ctx, { action: 'company.updated', entityType: 'tenant', entityId: row.id,
    oldValue: Object.fromEntries(cols.map((c) => [c, before[c]])), newValue: next });
  return companyProfile(row);
}

/** Recognises PNG / JPEG from the first bytes. */
function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** input: { dataUrl: 'data:image/png;base64,...' } (or plain base64). */
export async function setLogo(ctx, { dataUrl } = {}) {
  requireHr(ctx);
  const b64 = typeof dataUrl === 'string' ? dataUrl.replace(/^data:[^,]*;base64,/, '') : '';
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('logo_invalid', 'Choose an image file.');
  if (buf.length > MAX_LOGO_BYTES) throw badRequest('logo_too_big', 'The logo must be 512 KB or smaller. Save it smaller (about 500 pixels wide is plenty).');
  const mime = imageType(buf);
  if (!mime) throw badRequest('logo_invalid', 'The logo must be a PNG or JPEG image.');
  await ctx.db.tx(async (db) => {
    await db.query(
      `insert into tenant_logos (tenant_id, mime, data, updated_by) values ($1, $2, $3, $4)
       on conflict (tenant_id) do update set mime = excluded.mime, data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`,
      [ctx.tenant.id, mime, buf.toString('base64'), ctx.actor?.userId ?? null]);
    ctx.tenant = await db.one('update tenants set logo_updated_at = now() where id = $1 returning *', [ctx.tenant.id]);
    await audit(db, ctx, { action: 'company.logo_updated', entityType: 'tenant', entityId: ctx.tenant.id, newValue: { mime, bytes: buf.length } });
  });
  return companyProfile(ctx.tenant);
}

export async function removeLogo(ctx) {
  requireHr(ctx);
  await ctx.db.tx(async (db) => {
    await db.query('delete from tenant_logos where tenant_id = $1', [ctx.tenant.id]);
    ctx.tenant = await db.one('update tenants set logo_updated_at = null where id = $1 returning *', [ctx.tenant.id]);
    await audit(db, ctx, { action: 'company.logo_removed', entityType: 'tenant', entityId: ctx.tenant.id });
  });
  return companyProfile(ctx.tenant);
}

/** -> { mime, buffer } or null */
export async function logoOf(db, tenantId) {
  const row = await db.one('select mime, data from tenant_logos where tenant_id = $1', [tenantId]);
  return row ? { mime: row.mime, buffer: Buffer.from(row.data, 'base64') } : null;
}
