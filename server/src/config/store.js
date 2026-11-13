/**
 * Configuration store: Draft > (Validate / Preview) > Publish, with full
 * version history, diff and "restore as new draft".
 *
 * Publishing rules (guardrails):
 *  - effective_from may not be before "today" in the tenant's timezone, so
 *    past attendance/leave/payroll are never re-interpreted by a new rule;
 *  - effective_from may not fall inside an approved/locked payroll period;
 *  - the version running on effective_from is closed the day before, and
 *    any published-but-future version of the same setting is archived.
 * Every change is written to the audit log and drops the resolver cache.
 */
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, isYmd } from '../lib/dates.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { deepMerge, diffValues, isPlainObject } from '../lib/util.js';
import { SCOPE_TABLES, getDefinition, validateSetting } from './registry.js';
import { invalidate, resolve } from './resolver.js';

const VERSION_COLUMNS = `v.id, v.setting_id, v.version, v.status, v.value, v.effective_from, v.effective_to,
  v.change_note, v.based_on_version_id, v.created_by, v.created_at, v.updated_at, v.published_by, v.published_at,
  s.key, s.subject_id, s.scope_type, s.scope_id, s.name`;

export async function getVersion(ctx, versionId, db = ctx.db) {
  const row = await db.one(
    `select ${VERSION_COLUMNS} from setting_versions v join settings s on s.id = v.setting_id
      where v.id = $1 and v.tenant_id = $2`, [versionId, ctx.tenant.id]);
  if (!row) throw notFound('Setting version');
  return row;
}

async function assertTargetExists(ctx, { key, subjectId, scopeType, scopeId }) {
  const def = getDefinition(key);
  if (!def) throw badRequest('unknown_setting', `Unknown setting "${key}".`);
  if (!def.scopes.includes(scopeType)) {
    throw badRequest('scope_not_allowed', `"${def.label}" can only be set for: ${def.scopes.join(', ')}.`);
  }
  if ((scopeType === 'company') !== (scopeId == null)) {
    throw badRequest('scope_invalid', scopeType === 'company' ? 'A company-wide setting has no scope id.' : `Choose which ${scopeType} this applies to.`);
  }
  if (scopeType !== 'company') {
    const ok = await ctx.db.one(`select 1 from ${SCOPE_TABLES[scopeType]} where id = $1 and tenant_id = $2`, [scopeId, ctx.tenant.id]);
    if (!ok) throw badRequest('scope_invalid', `The selected ${scopeType} does not exist.`);
  }
  if (def.subjectTable) {
    if (!subjectId) throw badRequest('subject_required', `Choose which record "${def.label}" is for.`);
    const ok = await ctx.db.one(`select 1 from ${def.subjectTable} where id = $1 and tenant_id = $2`, [subjectId, ctx.tenant.id]);
    if (!ok) throw badRequest('subject_invalid', 'The selected record does not exist.');
  } else if (subjectId) {
    throw badRequest('subject_invalid', `"${def.label}" is not tied to a specific record.`);
  }
  return def;
}

function assertValue(value) {
  if (!isPlainObject(value)) throw badRequest('value_invalid', 'The setting value must be a group of fields (JSON object).');
}

/** Creates (or reuses) the setting identity and adds a draft version. */
export async function createDraft(ctx, { key, subjectId = null, scopeType = 'company', scopeId = null, value, changeNote = null, name = null }) {
  assertValue(value);
  await assertTargetExists(ctx, { key, subjectId, scopeType, scopeId });
  const versionId = await ctx.db.tx(async (db) => {
    await db.query(
      `insert into settings (tenant_id, key, subject_id, scope_type, scope_id, name, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
      [ctx.tenant.id, key, subjectId, scopeType, scopeId, name, ctx.actor?.userId ?? null]);
    const setting = await db.one(
      `select id from settings where tenant_id = $1 and key = $2 and subject_id is not distinct from $3
          and scope_type = $4 and scope_id is not distinct from $5 for update`,
      [ctx.tenant.id, key, subjectId, scopeType, scopeId]);
    const draft = await db.one(`select id from setting_versions where setting_id = $1 and status = 'draft'`, [setting.id]);
    if (draft) {
      throw conflict('draft_exists', 'This setting already has a draft. Edit or discard that draft first.', { details: { versionId: draft.id } });
    }
    const { next } = await db.one(`select coalesce(max(version), 0) + 1 as next from setting_versions where setting_id = $1`, [setting.id]);
    const row = await db.one(
      `insert into setting_versions (tenant_id, setting_id, version, status, value, change_note, created_by)
       values ($1, $2, $3, 'draft', $4, $5, $6) returning id`,
      [ctx.tenant.id, setting.id, next, value, changeNote, ctx.actor?.userId ?? null]);
    await audit(db, ctx, { action: 'setting.draft_created', entityType: 'setting_version', entityId: row.id, newValue: value,
      meta: { key, subjectId, scopeType, scopeId, version: next } });
    return row.id;
  });
  return getVersion(ctx, versionId);
}

export async function updateDraft(ctx, versionId, { value, changeNote }) {
  const v = await getVersion(ctx, versionId);
  if (v.status !== 'draft') throw conflict('not_draft', 'Only drafts can be edited. Restore this version as a new draft to change it.');
  if (value !== undefined) assertValue(value);
  await ctx.db.tx(async (db) => {
    await db.query(
      `update setting_versions set value = coalesce($2, value), change_note = coalesce($3, change_note), updated_at = now()
        where id = $1`, [versionId, value ?? null, changeNote ?? null]);
    await audit(db, ctx, { action: 'setting.draft_updated', entityType: 'setting_version', entityId: versionId,
      oldValue: v.value, newValue: value ?? v.value, meta: { key: v.key } });
  });
  return getVersion(ctx, versionId);
}

export async function discardDraft(ctx, versionId) {
  const v = await getVersion(ctx, versionId);
  if (v.status !== 'draft') throw conflict('not_draft', 'Only drafts can be discarded. Published versions are kept as history.');
  await ctx.db.tx(async (db) => {
    await db.query('delete from setting_versions where id = $1', [versionId]);
    await audit(db, ctx, { action: 'setting.draft_discarded', entityType: 'setting_version', entityId: versionId, oldValue: v.value, meta: { key: v.key } });
  });
}

/** The value a non-company override would be layered on (company rule at `date`). */
async function inheritedBase(ctx, v, date) {
  if (v.scope_type === 'company') return undefined;
  const base = await resolve(ctx.db, { tenantId: ctx.tenant.id, key: v.key, subjectId: v.subject_id, date });
  return base.found ? base.value : {};
}

/** Validates a draft (or any version) as if it took effect on `date`. */
export async function validateVersion(ctx, versionId, { date } = {}) {
  const v = typeof versionId === 'object' ? versionId : await getVersion(ctx, versionId);
  const on = date ?? tenantToday(ctx);
  const base = await inheritedBase(ctx, v, on);
  const merged = base === undefined ? undefined : deepMerge(base, v.value);
  const result = validateSetting(v.key, { value: v.value, scopeType: v.scope_type, merged });
  const check = getDefinition(v.key)?.check;
  if (check && result.ok) {
    const extra = await check(ctx, { value: v.value, merged: merged ?? v.value, version: v, date: on });
    result.errors.push(...(extra.errors ?? []));
    result.warnings.push(...(extra.warnings ?? []));
    result.ok = result.errors.length === 0;
  }
  return result;
}

async function assertPublishDate(ctx, effectiveFrom) {
  if (!isYmd(effectiveFrom)) throw badRequest('date_invalid', 'Effective date must be a date like 2026-04-01.');
  const today = tenantToday(ctx);
  if (effectiveFrom < today) {
    throw badRequest('effective_date_in_past',
      `The effective date can't be in the past (today is ${today}). Past attendance, leave and payroll are never recalculated, so choose today or a later date.`,
      { params: { today } });
  }
  const locked = await ctx.db.one(
    `select period_key, period_end from payroll_runs where tenant_id = $1 and status in ('approved', 'locked') and period_end >= $2
      order by period_end desc limit 1`, [ctx.tenant.id, effectiveFrom]);
  if (locked) {
    throw conflict('payroll_locked',
      `Payroll for ${locked.period_key} is already approved/locked. Choose an effective date after ${locked.period_end}.`,
      { params: { period: locked.period_key, after: locked.period_end } });
  }
}

export async function publish(ctx, versionId, { effectiveFrom, changeNote } = {}) {
  const from = effectiveFrom ?? tenantToday(ctx);
  await assertPublishDate(ctx, from);
  let key;
  const result = await ctx.db.tx(async (db) => {
    const tctx = { ...ctx, db };
    const v = await db.one(
      `select ${VERSION_COLUMNS} from setting_versions v join settings s on s.id = v.setting_id
        where v.id = $1 and v.tenant_id = $2 for update of v`, [versionId, ctx.tenant.id]);
    if (!v) throw notFound('Setting version');
    if (v.status !== 'draft') throw conflict('not_draft', 'Only a draft can be published.');
    key = v.key;
    const validation = await validateVersion(tctx, v, { date: from });
    if (!validation.ok) {
      throw new AppError(422, 'validation_failed', 'Please fix the highlighted problems before publishing.', { details: validation });
    }
    const previous = await db.one(
      `select id, version, value from setting_versions
        where setting_id = $1 and status = 'published' and effective_from <= $2 and (effective_to is null or effective_to >= $2)
        order by effective_from desc, version desc limit 1`, [v.setting_id, from]);
    const superseded = await db.query(
      `update setting_versions set status = 'archived', updated_at = now()
        where setting_id = $1 and status = 'published' and effective_from >= $2 returning id, version`, [v.setting_id, from]);
    await db.query(
      `update setting_versions set effective_to = $3, updated_at = now()
        where setting_id = $1 and status = 'published' and effective_from < $2 and (effective_to is null or effective_to >= $2)`,
      [v.setting_id, from, addDays(from, -1)]);
    await db.query(
      `update setting_versions set status = 'published', effective_from = $2, effective_to = null, published_by = $3,
              published_at = now(), change_note = coalesce($4, change_note), updated_at = now()
        where id = $1`, [versionId, from, ctx.actor?.userId ?? null, changeNote ?? null]);
    await audit(db, ctx, {
      action: 'setting.published', entityType: 'setting_version', entityId: versionId,
      oldValue: previous?.value ?? null, newValue: v.value,
      meta: { key: v.key, subjectId: v.subject_id, scopeType: v.scope_type, scopeId: v.scope_id, version: v.version,
        effectiveFrom: from, previousVersionId: previous?.id ?? null, supersededVersionIds: superseded.rows.map((r) => r.id) },
    });
    return { warnings: validation.warnings, previousVersionId: previous?.id ?? null, supersededVersionIds: superseded.rows.map((r) => r.id) };
  });
  invalidate(ctx.tenant.id, key);
  return { version: await getVersion(ctx, versionId), ...result };
}

/** Copies any historical version into a new draft ("rollback" = restore + publish). */
export async function restoreAsDraft(ctx, versionId, { changeNote } = {}) {
  const src = await getVersion(ctx, versionId);
  if (src.status === 'draft') throw conflict('is_draft', 'This version is already a draft.');
  const newId = await ctx.db.tx(async (db) => {
    const existing = await db.one(`select id from setting_versions where setting_id = $1 and status = 'draft'`, [src.setting_id]);
    if (existing) throw conflict('draft_exists', 'This setting already has a draft. Edit or discard that draft first.', { details: { versionId: existing.id } });
    const { next } = await db.one(`select coalesce(max(version), 0) + 1 as next from setting_versions where setting_id = $1`, [src.setting_id]);
    const row = await db.one(
      `insert into setting_versions (tenant_id, setting_id, version, status, value, change_note, based_on_version_id, created_by)
       values ($1, $2, $3, 'draft', $4, $5, $6, $7) returning id`,
      [ctx.tenant.id, src.setting_id, next, src.value, changeNote ?? `Restored from version ${src.version}`, src.id, ctx.actor?.userId ?? null]);
    await audit(db, ctx, { action: 'setting.restored_as_draft', entityType: 'setting_version', entityId: row.id,
      newValue: src.value, meta: { key: src.key, fromVersionId: src.id, fromVersion: src.version } });
    return row.id;
  });
  return getVersion(ctx, newId);
}

/** Diff two versions; with only `fromId`, diff it against the version in force today. */
export async function diffVersions(ctx, fromId, toId) {
  const a = await getVersion(ctx, fromId);
  let b;
  if (toId) b = await getVersion(ctx, toId);
  else {
    const today = tenantToday(ctx);
    const current = await ctx.db.one(
      `select id from setting_versions where setting_id = $1 and status = 'published' and effective_from <= $2
          and (effective_to is null or effective_to >= $2) order by effective_from desc limit 1`, [a.setting_id, today]);
    b = current ? await getVersion(ctx, current.id) : null;
  }
  // Present as "old -> new": the older version number is the "from" side.
  const [oldV, newV] = b && b.version > a.version ? [a, b] : [b, a];
  return {
    from: oldV && { id: oldV.id, version: oldV.version, status: oldV.status, effectiveFrom: oldV.effective_from },
    to: { id: newV.id, version: newV.version, status: newV.status, effectiveFrom: newV.effective_from },
    changes: diffValues(oldV?.value ?? {}, newV.value),
  };
}

/** Stops a department/role/employee override from applying from a date on. */
export async function retire(ctx, settingId, { effectiveFrom } = {}) {
  const s = await ctx.db.one('select * from settings where id = $1 and tenant_id = $2', [settingId, ctx.tenant.id]);
  if (!s) throw notFound('Setting');
  if (s.scope_type === 'company') throw conflict('cannot_retire_company', 'The company-wide rule is the base for everyone and cannot be retired. Publish a new version instead.');
  const from = effectiveFrom ?? tenantToday(ctx);
  await assertPublishDate(ctx, from);
  await ctx.db.tx(async (db) => {
    await db.query(`update setting_versions set status = 'archived', updated_at = now()
                     where setting_id = $1 and status = 'published' and effective_from >= $2`, [settingId, from]);
    await db.query(`update setting_versions set effective_to = $3, updated_at = now()
                     where setting_id = $1 and status = 'published' and effective_from < $2 and (effective_to is null or effective_to >= $2)`,
    [settingId, from, addDays(from, -1)]);
    await audit(db, ctx, { action: 'setting.retired', entityType: 'setting', entityId: settingId, meta: { key: s.key, effectiveFrom: from } });
  });
  invalidate(ctx.tenant.id, s.key);
}

/** Settings with their current / upcoming / draft versions. */
export async function listSettings(ctx, { key, subjectId } = {}) {
  const today = tenantToday(ctx);
  const { rows } = await ctx.db.query(
    `select s.id, s.key, s.subject_id, s.scope_type, s.scope_id, s.name,
            (select row_to_json(x) from (select id, version, value, effective_from, effective_to from setting_versions
               where setting_id = s.id and status = 'published' and effective_from <= $2
                 and (effective_to is null or effective_to >= $2) order by effective_from desc limit 1) x) as current,
            (select json_agg(x order by x.effective_from) from (select id, version, effective_from from setting_versions
               where setting_id = s.id and status = 'published' and effective_from > $2) x) as upcoming,
            (select row_to_json(x) from (select id, version, value, updated_at from setting_versions
               where setting_id = s.id and status = 'draft') x) as draft,
            (select count(*)::int from setting_versions where setting_id = s.id) as version_count
       from settings s
      where s.tenant_id = $1 and ($3::text is null or s.key = $3) and ($4::uuid is null or s.subject_id = $4)
      order by s.key, s.subject_id nulls first, array_position(array['company','department','employment_type','role','employee'], s.scope_type)`,
    [ctx.tenant.id, today, key ?? null, subjectId ?? null]);
  return rows;
}

export async function history(ctx, settingId) {
  const { rows } = await ctx.db.query(
    `select ${VERSION_COLUMNS} from setting_versions v join settings s on s.id = v.setting_id
      where v.setting_id = $1 and v.tenant_id = $2 order by v.version desc`, [settingId, ctx.tenant.id]);
  return rows;
}
