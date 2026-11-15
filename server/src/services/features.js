import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { requireHr } from './access.js';

/**
 * A module is on when HR switched it on AND the company's subscription
 * includes it (subscriptions.modules null = every module) AND, for the
 * personal modules below, the signed-in person may use it
 * (employees.module_access null = all of them). HR admins, system jobs and
 * the super admin are never limited per person.
 */
const INCLUDED = `(s.modules is null or s.modules @> to_jsonb(f.module_key))`;

/** Modules HR can tick / untick for each employee. */
export const PERSONAL_MODULES = ['attendance', 'wfh', 'leave', 'payroll', 'tasks'];

/** The signed-in person's own module list, or null when not limited. Cached on the request. */
async function personalAccess(ctx) {
  const a = ctx.actor;
  if (!a?.employeeId || a.system || a.accessLevel === 'hr_admin') return null;
  if (ctx.moduleAccess === undefined) {
    ctx.moduleAccess = (await ctx.db.one('select module_access from employees where id = $1 and tenant_id = $2',
      [a.employeeId, ctx.tenant.id]))?.module_access ?? null;
  }
  return ctx.moduleAccess;
}

const personallyAllowed = (access, moduleKey) => access == null || !PERSONAL_MODULES.includes(moduleKey) || access.includes(moduleKey);

export async function isEnabled(ctx, moduleKey) {
  const row = await ctx.db.one(
    `select f.enabled and ${INCLUDED} as on from feature_flags f left join subscriptions s on s.tenant_id = f.tenant_id
      where f.tenant_id = $1 and f.module_key = $2`, [ctx.tenant.id, moduleKey]);
  return row?.on === true && personallyAllowed(await personalAccess(ctx), moduleKey);
}

export async function requireModule(ctx, moduleKey) {
  if (!(await isEnabled(ctx, moduleKey))) {
    const personal = !personallyAllowed(await personalAccess(ctx), moduleKey);
    throw new AppError(403, 'module_disabled', personal
      ? `You don't have access to "${moduleKey}". Ask HR if you need it.`
      : `The "${moduleKey}" module is switched off for this company.`, { params: { module: moduleKey } });
  }
}

/** Modules that are switched on, included in the plan and allowed for the signed-in person. */
export async function enabledModules(ctx) {
  const access = await personalAccess(ctx);
  return (await ctx.db.query(
    `select f.module_key from feature_flags f left join subscriptions s on s.tenant_id = f.tenant_id
      where f.tenant_id = $1 and f.enabled and ${INCLUDED} order by f.module_key`, [ctx.tenant.id])).rows
    .map((r) => r.module_key).filter((m) => personallyAllowed(access, m));
}

/** Checks an employees.module_access value from a request: null, or a list of personal modules. */
export function normalizeModuleAccess(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((m) => !PERSONAL_MODULES.includes(m))) {
    throw new AppError(400, 'employee_invalid', `Module access must be a list chosen from: ${PERSONAL_MODULES.join(', ')}.`);
  }
  const list = PERSONAL_MODULES.filter((m) => value.includes(m));
  return list.length === PERSONAL_MODULES.length ? null : list; // everything ticked = not limited
}

export async function listFlags(ctx) {
  return (await ctx.db.query(
    `select f.module_key, f.enabled, f.config, ${INCLUDED} as included from feature_flags f left join subscriptions s on s.tenant_id = f.tenant_id
      where f.tenant_id = $1 order by f.module_key`, [ctx.tenant.id])).rows;
}

export async function setFlag(ctx, moduleKey, { enabled, config }) {
  requireHr(ctx);
  if (enabled) {
    const sub = await ctx.db.one('select plan_name, modules from subscriptions where tenant_id = $1', [ctx.tenant.id]);
    if (sub?.modules && !sub.modules.includes(moduleKey)) {
      throw new AppError(402, 'plan_feature', `The "${moduleKey}" module isn't included in your ${sub.plan_name} plan. Upgrade the plan to use it.`,
        { params: { module: moduleKey } });
    }
  }
  const before = await ctx.db.one('select enabled, config from feature_flags where tenant_id = $1 and module_key = $2', [ctx.tenant.id, moduleKey]);
  const row = await ctx.db.one(
    `insert into feature_flags (tenant_id, module_key, enabled, config) values ($1, $2, $3, coalesce($4, '{}'::jsonb))
     on conflict (tenant_id, module_key) do update set enabled = excluded.enabled,
       config = coalesce($4, feature_flags.config), updated_at = now()
     returning module_key, enabled, config`, [ctx.tenant.id, moduleKey, enabled, config ?? null]);
  await audit(ctx.db, ctx, { action: 'feature_flag.set', entityType: 'feature_flag', entityId: moduleKey, oldValue: before, newValue: row });
  return row;
}

/** Modules switched on and in the plan for the company, whoever is asking (for HR / manager pickers). */
export async function companyModules(ctx) {
  return (await ctx.db.query(
    `select f.module_key from feature_flags f left join subscriptions s on s.tenant_id = f.tenant_id
      where f.tenant_id = $1 and f.enabled and ${INCLUDED} order by f.module_key`, [ctx.tenant.id])).rows.map((r) => r.module_key);
}
