/** Validates values against HR-defined custom fields for an entity. */
import { isYmd } from '../lib/dates.js';
import { badRequest } from '../lib/errors.js';

export async function validateCustomFields(ctx, entity, values = {}) {
  const { rows: defs } = await ctx.db.query(
    `select field_key, label, field_type, options, required from custom_fields where tenant_id = $1 and entity = $2 and is_active`,
    [ctx.tenant.id, entity]);
  const errors = [];
  const known = new Set(defs.map((d) => d.field_key));
  for (const key of Object.keys(values ?? {})) if (!known.has(key)) errors.push(`"${key}" is not a field on this form.`);
  for (const d of defs) {
    const v = values?.[d.field_key];
    if (v == null || v === '') { if (d.required) errors.push(`${d.label} is required.`); continue; }
    if (d.field_type === 'number' && typeof v !== 'number') errors.push(`${d.label} must be a number.`);
    if (d.field_type === 'date' && !isYmd(v)) errors.push(`${d.label} must be a date.`);
    if (d.field_type === 'dropdown' && !d.options.includes(v)) errors.push(`${d.label} must be one of: ${d.options.join(', ')}.`);
    if ((d.field_type === 'text' || d.field_type === 'file') && typeof v !== 'string') errors.push(`${d.label} must be text.`);
  }
  if (errors.length) throw badRequest('custom_fields_invalid', errors.join(' '), { details: { errors } });
  return values ?? {};
}
