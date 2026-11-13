/**
 * Tenant provisioning. Default data comes from seed/defaults.json and is
 * written as ordinary rows, so HR can edit or delete any of it later.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { startTrial } from './billing.js';
import { CURRENCY_HELP, isCurrency } from '../lib/currency.js';

const DEFAULTS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../seed/defaults.json');

export async function loadDefaults(file = DEFAULTS_PATH) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Global (tenant-less) templates and product-default translations. Idempotent. */
export async function installGlobals(db, defaults) {
  for (const t of defaults.globalTemplates) {
    await db.query(
      `insert into setting_templates (tenant_id, key, code, name, description, value) values (null, $1, $2, $3, $4, $5)
       on conflict (tenant_id, key, code) do update set name = excluded.name, description = excluded.description, value = excluded.value`,
      [t.key, t.code, t.name, t.description ?? null, t.value]);
  }
  for (const [locale, entries] of Object.entries(defaults.translations)) {
    for (const [key, value] of Object.entries(entries)) {
      await db.query(
        `insert into translations (tenant_id, locale, key, value) values (null, $1, $2, $3)
         on conflict (tenant_id, locale, key) do update set value = excluded.value`, [locale, key, value]);
    }
  }
}

/**
 * Bootstrap-only: writes a published v1 directly (used when creating a
 * company, before anyone could have attendance under it). All later
 * changes go through the draft > publish flow in config/store.js.
 */
export async function seedPublished(db, ctx, { key, subjectId = null, scopeType = 'company', scopeId = null, value, effectiveFrom }) {
  const s = await db.one(
    `insert into settings (tenant_id, key, subject_id, scope_type, scope_id, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [ctx.tenant.id, key, subjectId, scopeType, scopeId, ctx.actor?.userId ?? null]);
  const v = await db.one(
    `insert into setting_versions (tenant_id, setting_id, version, status, value, effective_from, change_note, created_by, published_by, published_at)
     values ($1, $2, 1, 'published', $3, $4, 'Initial setup', $5, $5, now()) returning id`,
    [ctx.tenant.id, s.id, value, effectiveFrom, ctx.actor?.userId ?? null]);
  await audit(db, ctx, { action: 'setting.published', entityType: 'setting_version', entityId: v.id, newValue: value,
    meta: { key, subjectId, scopeType, scopeId, version: 1, effectiveFrom, bootstrap: true } });
  return { settingId: s.id, versionId: v.id };
}

function fromTemplate(defaults, key, value) {
  if (!value.fromTemplate) return value;
  const t = defaults.globalTemplates.find((x) => x.key === key && x.code === value.fromTemplate);
  if (!t) throw new Error(`defaults.json: template ${key}/${value.fromTemplate} not found`);
  return t.value;
}

export async function provisionTenant(db, { name, slug, timezone, currency, goLiveDate, today = new Date().toISOString().slice(0, 10) }, defaults,
  actor = { system: true }) {
  if (!name?.trim() || !/^[a-z0-9-]{2,40}$/.test(slug ?? '')) {
    throw badRequest('tenant_invalid', 'Company name is required and the slug may only contain lowercase letters, numbers and dashes.');
  }
  if (currency != null && currency !== '' && !isCurrency(currency)) throw badRequest('tenant_invalid', CURRENCY_HELP);
  return db.tx(async (t) => {
    const tenant = await t.one(
      `insert into tenants (name, slug, timezone, currency, go_live_date)
       values ($1, $2, coalesce($3, 'Asia/Karachi'), coalesce($4, 'PKR'), coalesce($5::date, current_date)) returning *`,
      [name, slug, timezone ?? null, currency ?? null, goLiveDate ?? null]);
    const ctx = { db: t, tenant, actor };
    const d = defaults.tenant;
    const from = tenant.go_live_date;
    const ids = { leaveTypes: {}, shifts: {}, employmentTypes: {}, holidayCalendars: {} };

    // Every new company starts on the platform's trial plan (see Billing settings).
    await startTrial(t, tenant, { today, actorId: actor?.userId ?? null });
    for (const [moduleKey, enabled] of Object.entries(d.featureFlags)) {
      await t.query('insert into feature_flags (tenant_id, module_key, enabled) values ($1, $2, $3)', [tenant.id, moduleKey, enabled]);
    }
    for (const [i, et] of d.employmentTypes.entries()) {
      ids.employmentTypes[et.code] = (await t.one(
        'insert into employment_types (tenant_id, code, name, sort_order) values ($1, $2, $3, $4) returning id', [tenant.id, et.code, et.name, i])).id;
    }
    for (const [key, value] of Object.entries(d.settings)) {
      await seedPublished(t, ctx, { key, value: fromTemplate(defaults, key, value), effectiveFrom: from });
    }
    for (const [i, lt] of d.leaveTypes.entries()) {
      const id = (await t.one('insert into leave_types (tenant_id, code, name, color, sort_order) values ($1, $2, $3, $4, $5) returning id',
        [tenant.id, lt.code, lt.name, lt.color ?? null, i])).id;
      ids.leaveTypes[lt.code] = id;
      await seedPublished(t, ctx, { key: 'leave.type', subjectId: id, value: fromTemplate(defaults, 'leave.type', lt.rules), effectiveFrom: from });
    }
    for (const [i, sh] of d.shifts.entries()) {
      const id = (await t.one('insert into shifts (tenant_id, code, name, sort_order) values ($1, $2, $3, $4) returning id', [tenant.id, sh.code, sh.name, i])).id;
      ids.shifts[sh.code] = id;
      await seedPublished(t, ctx, { key: 'shift.rules', subjectId: id, value: sh.rules, effectiveFrom: from });
    }
    for (const cal of d.holidayCalendars) {
      const id = (await t.one('insert into holiday_calendars (tenant_id, code, name, is_default) values ($1, $2, $3, $4) returning id',
        [tenant.id, cal.code, cal.name, cal.is_default ?? false])).id;
      ids.holidayCalendars[cal.code] = id;
      for (const h of cal.holidays) {
        await t.query('insert into holidays (tenant_id, calendar_id, date, name, note) values ($1, $2, $3, $4, $5)', [tenant.id, id, h.date, h.name, h.note ?? null]);
      }
    }
    ids.salaryComponents = {};
    for (const [i, c] of d.salaryComponents.entries()) {
      const id = (await t.one('insert into salary_components (tenant_id, code, name, kind, sort_order) values ($1, $2, $3, $4, $5) returning id',
        [tenant.id, c.code, c.name, c.kind, i])).id;
      ids.salaryComponents[c.code] = id;
      if (c.rules) await seedPublished(t, ctx, { key: 'payroll.component', subjectId: id, value: c.rules, effectiveFrom: from });
    }
    await audit(t, ctx, { action: 'tenant.provisioned', entityType: 'tenant', entityId: tenant.id, newValue: { name, slug } });
    return { tenant, ids };
  });
}
