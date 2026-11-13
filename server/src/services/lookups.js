/**
 * Generic CRUD for HR-managed lookup lists (no hardcoded enums).
 * Guardrails: codes are unique per tenant; anything already referenced by
 * records or settings cannot be deleted — it must be disabled instead.
 */
import { invalidate } from '../config/resolver.js';
import { audit } from '../lib/audit.js';
import { isYmd } from '../lib/dates.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { invalidateTranslations } from '../lib/i18n.js';
import { IDENTIFIER_RE, isReservedName } from '../engines/payroll.js';
import { assertInTenant, requireHr } from './access.js';

const base = ['code', 'name', 'is_active', 'sort_order'];
export const LOOKUPS = {
  departments: { columns: [...base, 'parent_id'], label: 'Department', refs: { parent_id: ['departments', 'parent department'] } },
  roles: { columns: base, label: 'Role' },
  'employment-types': { table: 'employment_types', columns: base, label: 'Employment type' },
  locations: { columns: [...base, 'address', 'lat', 'lng', 'radius_m'], label: 'Office location', validate: validateLocation },
  shifts: { columns: base, label: 'Shift' },
  'leave-types': { table: 'leave_types', columns: [...base, 'color'], label: 'Leave type' },
  'holiday-calendars': { table: 'holiday_calendars', columns: [...base, 'is_default'], label: 'Holiday calendar' },
  holidays: { columns: ['calendar_id', 'date', 'name', 'is_optional', 'note', 'is_active'], label: 'Holiday', noCode: true, validate: validateHoliday,
    refs: { calendar_id: ['holiday_calendars', 'holiday calendar'] } },
  'salary-components': { table: 'salary_components', columns: [...base, 'kind'], label: 'Salary component', validate: validateComponent },
  'custom-fields': { table: 'custom_fields', columns: ['entity', 'field_key', 'label', 'field_type', 'options', 'required', 'is_active', 'sort_order'], label: 'Custom field', noCode: true },
  translations: { columns: ['locale', 'key', 'value'], label: 'Translation', noCode: true, onChange: (ctx) => invalidateTranslations(ctx.tenant.id) },
};

function validateLocation(row) {
  const errors = [];
  if (row.lat != null && (row.lat < -90 || row.lat > 90)) errors.push('Latitude must be between -90 and 90.');
  if (row.lng != null && (row.lng < -180 || row.lng > 180)) errors.push('Longitude must be between -180 and 180.');
  if (row.radius_m != null && !(row.radius_m > 0 && row.radius_m <= 5000)) errors.push('Geofence radius must be between 1 and 5000 metres.');
  return errors;
}

/** Component codes are formula variables (BASIC, HRA...), so they must be valid names. */
function validateComponent(row) {
  const errors = [];
  if (row.code && !IDENTIFIER_RE.test(row.code)) errors.push('A salary component code must start with a capital letter and use only capitals, digits and _ (it is used in formulas).');
  else if (row.code && isReservedName(row.code)) errors.push(`"${row.code}" is a built-in payroll value; choose another code.`);
  if (!['earning', 'deduction', 'employer'].includes(row.kind)) errors.push('Kind must be earning, deduction or employer contribution.');
  return errors;
}

function validateHoliday(row) {
  const errors = [];
  if (!isYmd(row.date)) errors.push('Holiday date must be a date like 2026-08-14.');
  if (!row.name?.trim()) errors.push('Holiday name is required.');
  return errors;
}

function spec(entity) {
  const s = LOOKUPS[entity];
  if (!s) throw notFound('List');
  return { table: s.table ?? entity, ...s };
}

export async function listLookup(ctx, entity, { includeInactive = true } = {}) {
  const s = spec(entity);
  const order = s.columns.includes('sort_order') ? 'sort_order, ' : '';
  const label = s.noCode ? (s.columns.includes('date') ? 'date' : 'created_at') : 'name';
  const { rows } = await ctx.db.query(
    `select * from ${s.table} where tenant_id = $1 ${includeInactive || !s.columns.includes('is_active') ? '' : 'and is_active'}
      order by ${order}${label}`, [ctx.tenant.id]);
  return rows;
}

// Arrays/objects go to jsonb columns; drivers would otherwise send JS arrays as Postgres arrays.
const toParam = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

function pick(s, input) {
  return Object.fromEntries(s.columns.filter((c) => input[c] !== undefined).map((c) => [c, input[c]]));
}

function check(s, row) {
  const errors = [];
  if (!s.noCode) {
    if (!row.code?.trim()) errors.push('Code is required.');
    else if (!/^[A-Za-z0-9_-]{1,40}$/.test(row.code)) errors.push('Code may only contain letters, numbers, - and _ (max 40).');
    if (!row.name?.trim()) errors.push('Name is required.');
  }
  errors.push(...(s.validate?.(row) ?? []));
  if (errors.length) throw badRequest('lookup_invalid', errors.join(' '), { details: { errors } });
}

/** Referenced rows (parent department, holiday calendar) must be in the same company. */
async function checkRefs(ctx, s, data) {
  for (const [column, [table, label]] of Object.entries(s.refs ?? {})) {
    if (data[column]) await assertInTenant(ctx, table, data[column], label);
  }
}

function rethrowUnique(err, s) {
  if (err.code === '23505') throw conflict('duplicate', `A ${s.label.toLowerCase()} with this code already exists.`);
  throw err;
}

export async function createLookup(ctx, entity, input) {
  requireHr(ctx);
  const s = spec(entity);
  const data = pick(s, input);
  check(s, data);
  await checkRefs(ctx, s, data);
  const cols = Object.keys(data);
  let row;
  try {
    row = await ctx.db.one(
      `insert into ${s.table} (tenant_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
      [ctx.tenant.id, ...cols.map((c) => toParam(data[c]))]);
  } catch (err) { rethrowUnique(err, s); }
  await audit(ctx.db, ctx, { action: `${s.table}.created`, entityType: s.table, entityId: row.id, newValue: row });
  s.onChange?.(ctx);
  return row;
}

export async function updateLookup(ctx, entity, id, input) {
  requireHr(ctx);
  const s = spec(entity);
  const before = await ctx.db.one(`select * from ${s.table} where id = $1 and tenant_id = $2`, [id, ctx.tenant.id]);
  if (!before) throw notFound(s.label);
  const data = pick(s, input);
  if (!s.noCode && data.code !== undefined && data.code !== before.code && ['leave_types', 'shifts', 'salary_components'].includes(s.table)) {
    throw conflict('code_immutable', `A ${s.label.toLowerCase()}'s code can't change once created (it is referenced by history). Rename it instead.`);
  }
  check(s, { ...before, ...data });
  await checkRefs(ctx, s, data);
  const cols = Object.keys(data);
  if (!cols.length) return before;
  let row;
  try {
    row = await ctx.db.one(
      `update ${s.table} set ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and tenant_id = $2 returning *`,
      [id, ctx.tenant.id, ...cols.map((c) => toParam(data[c]))]);
  } catch (err) { rethrowUnique(err, s); }
  await audit(ctx.db, ctx, { action: `${s.table}.updated`, entityType: s.table, entityId: id, oldValue: before, newValue: row });
  s.onChange?.(ctx);
  return row;
}

/** Deletes only if nothing references the row; otherwise asks HR to disable it. */
export async function deleteLookup(ctx, entity, id) {
  requireHr(ctx);
  const s = spec(entity);
  const before = await ctx.db.one(`select * from ${s.table} where id = $1 and tenant_id = $2`, [id, ctx.tenant.id]);
  if (!before) throw notFound(s.label);
  const inUseMsg = `This ${s.label.toLowerCase()} is already used in records or settings, so it can't be deleted. Disable it instead.`;
  const usedBySettings = await ctx.db.one('select 1 from settings where tenant_id = $1 and (subject_id = $2 or scope_id = $2) limit 1', [ctx.tenant.id, id]);
  if (usedBySettings) throw conflict('in_use', inUseMsg);
  try {
    await ctx.db.tx(async (db) => {
      await db.query(`delete from ${s.table} where id = $1 and tenant_id = $2`, [id, ctx.tenant.id]);
      await audit(db, ctx, { action: `${s.table}.deleted`, entityType: s.table, entityId: id, oldValue: before });
    });
  } catch (err) {
    if (err.code === '23503') throw conflict('in_use', inUseMsg);
    throw err;
  }
  if (['leave_types', 'shifts', 'salary_components'].includes(s.table)) invalidate(ctx.tenant.id);
  s.onChange?.(ctx);
}
