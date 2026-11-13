/**
 * Settings export / import (JSON).
 *
 * Records are referenced by CODE, not id, so an export from one company can
 * be imported into another (or restored into the same one). Ids inside rule
 * values (e.g. WFH allowed roles) are converted to codes and back.
 * Import upserts lookup lists and creates DRAFTS for rules — nothing goes
 * live until HR reviews and publishes them. dryRun runs everything inside a
 * transaction that is rolled back, and returns the same report.
 */
import { refsOf } from '../config/registry.js';
import { createDraft } from '../config/store.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { badRequest } from '../lib/errors.js';
import { invalidateTranslations } from '../lib/i18n.js';
import { deepEqual, getPath, isPlainObject } from '../lib/util.js';
import { requireHr } from './access.js';

export const FORMAT = 'hrm-settings/1';

const LOOKUPS = [
  { entity: 'departments', table: 'departments', cols: ['name', 'is_active', 'sort_order'] },
  { entity: 'roles', table: 'roles', cols: ['name', 'is_active', 'sort_order'] },
  { entity: 'employment-types', table: 'employment_types', cols: ['name', 'is_active', 'sort_order'] },
  { entity: 'locations', table: 'locations', cols: ['name', 'address', 'lat', 'lng', 'radius_m', 'is_active', 'sort_order'] },
  { entity: 'shifts', table: 'shifts', cols: ['name', 'is_active', 'sort_order'] },
  { entity: 'leave-types', table: 'leave_types', cols: ['name', 'color', 'is_active', 'sort_order'] },
  { entity: 'holiday-calendars', table: 'holiday_calendars', cols: ['name', 'is_default', 'is_active', 'sort_order'] },
  { entity: 'salary-components', table: 'salary_components', cols: ['name', 'kind', 'is_active', 'sort_order'] },
];
const TABLE_OF = Object.fromEntries(LOOKUPS.map((l) => [l.entity, l.table]));
const SCOPE_TABLE = { department: 'departments', employment_type: 'employment_types', role: 'roles', employee: 'employees' };
const SUBJECT_TABLE = { 'leave.type': 'leave_types', 'shift.rules': 'shifts', 'payroll.component': 'salary_components' };

async function codeMaps(db, tenantId) {
  const byTable = {};
  for (const table of [...Object.values(TABLE_OF), 'employees']) {
    const col = table === 'employees' ? 'employee_code' : 'code';
    const { rows } = await db.query(`select id, ${col} as code from ${table} where tenant_id = $1`, [tenantId]);
    byTable[table] = { idToCode: new Map(rows.map((r) => [r.id, r.code])), codeToId: new Map(rows.map((r) => [r.code, r.id])) };
  }
  return byTable;
}

/** Replaces ids at the key's ref paths using `map` (id->code or code->id); returns missing entries. */
function mapRefs(key, value, maps, direction) {
  const out = structuredClone(value);
  const missing = [];
  for (const [path, entity] of Object.entries(refsOf(key))) {
    const list = getPath(out, path);
    if (!Array.isArray(list)) continue;
    const m = maps[TABLE_OF[entity]][direction];
    const parts = path.split('.');
    const parent = parts.slice(0, -1).reduce((o, k) => o[k], out);
    parent[parts.at(-1)] = list.map((x) => { const y = m.get(x); if (y == null) missing.push(`${entity}:${x}`); return y ?? x; });
  }
  return { value: out, missing };
}

export async function exportSettings(ctx) {
  requireHr(ctx);
  const db = ctx.db;
  const tid = ctx.tenant.id;
  const maps = await codeMaps(db, tid);
  const lookups = {};
  for (const l of LOOKUPS) {
    lookups[l.entity] = (await db.query(`select code, ${l.cols.join(', ')} from ${l.table} where tenant_id = $1 order by sort_order, code`, [tid])).rows;
  }
  const { rows: holidays } = await db.query(
    `select c.code as calendar, h.date, h.name, h.is_optional, h.note, h.is_active from holidays h join holiday_calendars c on c.id = h.calendar_id
      where h.tenant_id = $1 order by h.date`, [tid]);
  lookups.holidays = holidays;
  lookups['custom-fields'] = (await db.query(
    `select entity, field_key, label, field_type, options, required, is_active, sort_order from custom_fields where tenant_id = $1`, [tid])).rows;
  lookups.translations = (await db.query(`select locale, key, value from translations where tenant_id = $1 order by locale, key`, [tid])).rows;
  const featureFlags = (await db.query(`select module_key, enabled, config from feature_flags where tenant_id = $1 order by module_key`, [tid])).rows;

  const today = tenantToday(ctx);
  const { rows: current } = await db.query(
    `select distinct on (s.id) s.key, s.subject_id, s.scope_type, s.scope_id, v.value, v.version, v.effective_from
       from settings s join setting_versions v on v.setting_id = s.id
      where s.tenant_id = $1 and v.status = 'published' and (v.effective_to is null or v.effective_to >= $2)
      order by s.id, (v.effective_from <= $2) desc, v.effective_from desc`, [tid, today]);
  const settings = current.map((s) => ({
    key: s.key,
    subject: s.subject_id ? maps[SUBJECT_TABLE[s.key]].idToCode.get(s.subject_id) : null,
    scope: s.scope_type === 'company' ? { type: 'company' } : { type: s.scope_type, code: maps[SCOPE_TABLE[s.scope_type]].idToCode.get(s.scope_id) },
    value: mapRefs(s.key, s.value, maps, 'idToCode').value,
    version: s.version, effectiveFrom: s.effective_from,
  }));
  await audit(db, ctx, { action: 'settings.exported', entityType: 'tenant', entityId: tid, meta: { settings: settings.length } });
  return { format: FORMAT, exportedAt: ctx.clock.now().toISOString(), company: ctx.tenant.name, lookups, featureFlags, settings };
}

class DryRun extends Error {}

export async function importSettings(ctx, data, { dryRun = true } = {}) {
  requireHr(ctx);
  if (!isPlainObject(data) || data.format !== FORMAT) throw badRequest('import_invalid', `This is not a settings export (expected format "${FORMAT}").`);
  const report = { dryRun, lookups: { created: 0, updated: 0 }, holidays: 0, featureFlags: 0, drafts: [], unchanged: 0, skipped: [] };
  try {
    await ctx.db.tx(async (db) => {
      const tctx = { ...ctx, db };
      const tid = ctx.tenant.id;
      for (const l of LOOKUPS) {
        for (const row of data.lookups?.[l.entity] ?? []) {
          if (!row?.code) continue;
          const vals = l.cols.map((c) => row[c] ?? null);
          const existing = await db.one(`select id, ${l.cols.join(', ')} from ${l.table} where tenant_id = $1 and code = $2`, [tid, row.code]);
          if (!existing) {
            await db.query(`insert into ${l.table} (tenant_id, code, ${l.cols.join(', ')}) values ($1, $2, ${l.cols.map((_, i) => `$${i + 3}`).join(', ')})`,
              [tid, row.code, ...l.cols.map((c) => row[c] ?? (c === 'is_active' ? true : c === 'sort_order' ? 0 : c === 'is_default' ? false : null))]);
            report.lookups.created += 1;
          } else if (l.cols.some((c, i) => row[c] !== undefined && String(existing[c]) !== String(vals[i]))) {
            const cols = l.cols.filter((c) => row[c] !== undefined);
            await db.query(`update ${l.table} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [existing.id, ...cols.map((c) => row[c])]);
            report.lookups.updated += 1;
          }
        }
      }
      for (const h of data.lookups?.holidays ?? []) {
        const cal = await db.one('select id from holiday_calendars where tenant_id = $1 and code = $2', [tid, h.calendar]);
        if (!cal) { report.skipped.push({ item: `holiday ${h.date}`, reason: `Holiday calendar "${h.calendar}" not found.` }); continue; }
        const { rows } = await db.query(
          `insert into holidays (tenant_id, calendar_id, date, name, is_optional, note, is_active) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (calendar_id, date) do nothing returning id`, [tid, cal.id, h.date, h.name, h.is_optional ?? false, h.note ?? null, h.is_active ?? true]);
        report.holidays += rows.length;
      }
      for (const f of data.lookups?.['custom-fields'] ?? []) {
        await db.query(
          `insert into custom_fields (tenant_id, entity, field_key, label, field_type, options, required, is_active, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (tenant_id, entity, field_key) do update set label = excluded.label,
             field_type = excluded.field_type, options = excluded.options, required = excluded.required, is_active = excluded.is_active`,
          [tid, f.entity, f.field_key, f.label, f.field_type, JSON.stringify(f.options ?? []), f.required ?? false, f.is_active ?? true, f.sort_order ?? 0]);
      }
      for (const tr of data.lookups?.translations ?? []) {
        await db.query(`insert into translations (tenant_id, locale, key, value) values ($1, $2, $3, $4)
                        on conflict (tenant_id, locale, key) do update set value = excluded.value`, [tid, tr.locale, tr.key, tr.value]);
      }
      for (const f of data.featureFlags ?? []) {
        await db.query(`insert into feature_flags (tenant_id, module_key, enabled, config) values ($1, $2, $3, $4)
                        on conflict (tenant_id, module_key) do update set enabled = excluded.enabled, config = excluded.config`,
        [tid, f.module_key, f.enabled, f.config ?? {}]);
        report.featureFlags += 1;
      }

      const maps = await codeMaps(db, tid);
      const today = tenantToday(ctx);
      for (const s of data.settings ?? []) {
        const label = `${s.key}${s.subject ? ` (${s.subject})` : ''} @ ${s.scope?.type}${s.scope?.code ? ` ${s.scope.code}` : ''}`;
        const subjectId = s.subject ? maps[SUBJECT_TABLE[s.key]]?.codeToId.get(s.subject) : null;
        if (s.subject && !subjectId) { report.skipped.push({ item: label, reason: `"${s.subject}" does not exist here.` }); continue; }
        const scopeType = s.scope?.type ?? 'company';
        const scopeId = scopeType === 'company' ? null : maps[SCOPE_TABLE[scopeType]]?.codeToId.get(s.scope.code);
        if (scopeType !== 'company' && !scopeId) { report.skipped.push({ item: label, reason: `${scopeType} "${s.scope?.code}" does not exist here.` }); continue; }
        const { value, missing } = mapRefs(s.key, s.value, maps, 'codeToId');
        if (missing.length) { report.skipped.push({ item: label, reason: `Unknown references: ${missing.join(', ')}.` }); continue; }
        const current = await db.one(
          `select v.value from settings st join setting_versions v on v.setting_id = st.id
            where st.tenant_id = $1 and st.key = $2 and st.subject_id is not distinct from $3 and st.scope_type = $4
              and st.scope_id is not distinct from $5 and v.status = 'published' and v.effective_from <= $6
              and (v.effective_to is null or v.effective_to >= $6)`, [tid, s.key, subjectId, scopeType, scopeId, today]);
        if (current && deepEqual(current.value, value)) { report.unchanged += 1; continue; }
        try {
          const draft = await createDraft(tctx, { key: s.key, subjectId, scopeType, scopeId, value, changeNote: `Imported from "${data.company ?? 'export'}"` });
          report.drafts.push({ item: label, versionId: draft.id });
        } catch (err) {
          report.skipped.push({ item: label, reason: err.message });
        }
      }
      await audit(db, tctx, { action: 'settings.imported', entityType: 'tenant', entityId: tid,
        meta: { from: data.company, exportedAt: data.exportedAt, drafts: report.drafts.length, lookups: report.lookups } });
      if (dryRun) throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    report.drafts = report.drafts.map(({ item }) => ({ item }));
  }
  if (!dryRun) invalidateTranslations(ctx.tenant.id);
  return report;
}

