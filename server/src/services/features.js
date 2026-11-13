import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { requireHr } from './access.js';

/**
 * A module is on when HR switched it on AND the company's subscription
 * includes it (subscriptions.modules null = every module).
 */
const INCLUDED = `(s.modules is null or s.modules @> to_jsonb(f.module_key))`;

export async function isEnabled(ctx, moduleKey) {
  const row = await ctx.db.one(
    `select f.enabled and ${INCLUDED} as on from feature_flags f left join subscriptions s on s.tenant_id = f.tenant_id
      where f.tenant_id = $1 and f.module_key = $2`, [ctx.tenant.id, moduleKey]);
  return row?.on === true;
}

export async function requireModule(ctx, moduleKey) {
  if (!(await isEnabled(ctx, moduleKey))) {
    throw new AppError(403, 'module_disabled', `The "${moduleKey}" module is switched off for this company.`, { params: { module: moduleKey } });
  }
}

/** Modules that are switched on and included in the plan. */
export async function enabledModules(ctx) {
  return (await ctx.db.query(
    `select f.module_key from feature_flags f left join subscriptions s on s.tenant_id = f.tenant_id
      where f.tenant_id = $1 and f.enabled and ${INCLUDED} order by f.module_key`, [ctx.tenant.id])).rows.map((r) => r.module_key);
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
