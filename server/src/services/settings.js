/**
 * HR-facing settings service: RBAC + preview/simulation + post-publish
 * effects on top of the configuration store.
 */
import { resolve } from '../config/resolver.js';
import * as store from '../config/store.js';
import { dayName } from '../config/checker.js';
import { listDefinitions } from '../config/registry.js';
import { entitlementFor, isLimited, leaveYearOf } from '../engines/leave.js';
import { tenantToday } from '../lib/clock.js';
import { maxDate, minDate } from '../lib/dates.js';
import { notFound } from '../lib/errors.js';
import { deepEqual, diffValues, round2 } from '../lib/util.js';
import { assertCanView, requireHr } from './access.js';
import { employeesInScope, getEmployee } from './employees.js';
import { leaveYearConfig, syncLedger, typeBalance } from './leave.js';
import { previewNetPay } from './payroll.js';
import { quotaFor } from './wfh.js';

export const definitions = () => listDefinitions();

export async function list(ctx, filters) { requireHr(ctx); return store.listSettings(ctx, filters); }
export async function history(ctx, settingId) { requireHr(ctx); return store.history(ctx, settingId); }
export async function getVersion(ctx, id) { requireHr(ctx); return store.getVersion(ctx, id); }
export async function createDraft(ctx, input) { requireHr(ctx); return store.createDraft(ctx, input); }
export async function updateDraft(ctx, id, input) { requireHr(ctx); return store.updateDraft(ctx, id, input); }
export async function discardDraft(ctx, id) { requireHr(ctx); return store.discardDraft(ctx, id); }
export async function validate(ctx, id, opts) { requireHr(ctx); return store.validateVersion(ctx, id, opts); }
export async function restoreAsDraft(ctx, id, opts) { requireHr(ctx); return store.restoreAsDraft(ctx, id, opts); }
export async function diff(ctx, fromId, toId) { requireHr(ctx); return store.diffVersions(ctx, fromId, toId); }
export async function retire(ctx, settingId, opts) { requireHr(ctx); return store.retire(ctx, settingId, opts); }

export async function publish(ctx, id, opts) {
  requireHr(ctx);
  const result = await store.publish(ctx, id, opts);
  await afterPublish(ctx, result.version);
  return result;
}

/** Effects that keep derived data in step with a newly published rule. */
async function afterPublish(ctx, v) {
  if (v.key === 'leave.type') {
    const today = tenantToday(ctx);
    for (const emp of await employeesInScope(ctx, v.scope_type, v.scope_id)) {
      const year = leaveYearOf(today, await leaveYearConfig(ctx, today));
      await syncLedger(ctx, emp, v.subject_id, year);
    }
  }
}

/** Effective value for one employee, with which version supplied each layer. */
export async function resolveFor(ctx, { key, subjectId = null, employeeId, date }) {
  const on = date ?? tenantToday(ctx);
  let employee = null;
  if (employeeId) { await assertCanView(ctx, employeeId); employee = await getEmployee(ctx, employeeId); } else requireHr(ctx);
  return resolve(ctx.db, { tenantId: ctx.tenant.id, key, subjectId, employee, date: on });
}

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------
export async function templates(ctx, key) {
  requireHr(ctx);
  return (await ctx.db.query(
    `select * from setting_templates where (tenant_id is null or tenant_id = $1) and is_active and ($2::text is null or key = $2)
      order by key, name`, [ctx.tenant.id, key ?? null])).rows;
}

export async function draftFromTemplate(ctx, templateId, { subjectId = null, scopeType = 'company', scopeId = null }) {
  requireHr(ctx);
  const t = await ctx.db.one('select * from setting_templates where id = $1 and (tenant_id is null or tenant_id = $2)', [templateId, ctx.tenant.id]);
  if (!t) throw notFound('Template');
  return store.createDraft(ctx, { key: t.key, subjectId, scopeType, scopeId, value: t.value, changeNote: `From template "${t.name}"` });
}

// ---------------------------------------------------------------------
// Preview / simulation
// ---------------------------------------------------------------------
const payrollMetric = (ctx, emp, date, sim, oldR, newR, v) => previewNetPay(ctx, emp, date, sim, v);

const METRICS = {
  'payroll.rules': payrollMetric,
  'payroll.component': payrollMetric,
  'payroll.tax': payrollMetric,
  async 'wfh.policy'(ctx, emp, date, sim) {
    const before = await quotaFor(ctx, emp, date);
    const after = await quotaFor(ctx, emp, date, { simulate: sim });
    return [
      { key: 'wfhWeekRemaining', label: 'WFH days left this week', old: before.week.remaining, new: after.week.remaining },
      { key: 'wfhMonthRemaining', label: 'WFH days left this month', old: before.month.remaining, new: after.month.remaining },
    ];
  },
  async 'leave.type'(ctx, emp, date, sim, oldR, newR, v) {
    const lt = await ctx.db.one('select * from leave_types where id = $1', [v.subject_id]);
    const year = leaveYearOf(date, await leaveYearConfig(ctx, date));
    const asOf = maxDate(year.start, emp.joining_date, minDate(date, year.end));
    const ent = (r) => (r?.found && isLimited(r.value) ? entitlementFor({ rule: r.value, employee: emp, year, asOf }).days : null);
    const oldEnt = ent(oldR);
    const newEnt = ent(newR);
    // Syncing only posts entries already due under the *published* rules
    // (idempotent), so the preview starts from the true current balance.
    const bal = await typeBalance(ctx, emp, lt, { date });
    const shift = oldEnt != null && newEnt != null && !newR.value.accrual?.enabled ? round2(newEnt - oldEnt) : 0;
    return [
      { key: 'entitlement', label: `${lt.name} entitlement ${year.year}`, old: oldEnt, new: newEnt },
      { key: 'available', label: `${lt.name} available`, old: bal.available, new: bal.available == null ? null : round2(bal.available + shift) },
    ];
  },
};

function describe(key, value, emp) {
  const who = `${emp.full_name}${emp.department_name ? ` (${emp.department_name})` : ''}`;
  if (key === 'wfh.policy') {
    if (!value.enabled) return `With this policy, ${who} cannot work from home.`;
    return `With this policy, ${who} can work from home on ${value.allowedWeekdays.map((d) => dayName(d).slice(0, 3)).join(', ') || 'no days'}, ` +
      `up to ${value.maxPerWeek} per week and ${value.maxPerMonth} per month, with ${value.requests.minNoticeDays} day(s) notice ` +
      `(${value.requests.approval === 'manager' ? 'manager approval' : 'auto-approved within limits'}).`;
  }
  return null;
}

/** Totals the per-employee net-pay metrics of a payroll rule preview. */
function payrollImpact(key, affected, date) {
  if (!key.startsWith('payroll.')) return { available: false, note: 'This rule does not change pay directly.' };
  const nets = affected.map((e) => e.metrics.find((m) => m.key === 'net')).filter((m) => m && m.old != null && m.new != null);
  const before = round2(nets.reduce((t, m) => t + m.old, 0));
  const after = round2(nets.reduce((t, m) => t + m.new, 0));
  return {
    available: true, period: date.slice(0, 7), employees: nets.length, before, after, difference: round2(after - before),
    note: nets.length
      ? `Net pay for ${date.slice(0, 7)} across ${nets.length} employee(s) with a salary: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} (${after - before >= 0 ? '+' : ''}${round2(after - before).toLocaleString('en-US')}).`
      : 'No affected employee has a salary for this month, so pay does not change.',
  };
}

/**
 * Simulates publishing a draft on `effectiveFrom` without saving anything:
 * who is affected (overrides at higher scopes shadow the change), what
 * changes in their effective rule, and key numbers before/after.
 */
export async function preview(ctx, versionId, { effectiveFrom, limit = 50 } = {}) {
  requireHr(ctx);
  const v = await store.getVersion(ctx, versionId);
  const date = effectiveFrom ?? tenantToday(ctx);
  const validation = await store.validateVersion(ctx, v, { date });
  const sim = { settingId: v.setting_id, scopeType: v.scope_type, scopeId: v.scope_id, value: v.value, effectiveFrom: date, versionId: v.id, version: v.version };
  const inScope = await employeesInScope(ctx, v.scope_type, v.scope_id);
  const affected = [];
  let affectedCount = 0;
  let sentence = null;
  for (const emp of inScope) {
    const args = { tenantId: ctx.tenant.id, key: v.key, subjectId: v.subject_id, employee: emp, date };
    const oldR = await resolve(ctx.db, args);
    const newR = await resolve(ctx.db, { ...args, simulate: sim });
    if (oldR.found && deepEqual(oldR.value, newR.value)) continue;
    affectedCount += 1;
    sentence ??= describe(v.key, newR.value, emp);
    if (affected.length >= limit) continue;
    affected.push({
      employeeId: emp.id, name: emp.full_name, department: emp.department_name,
      changes: diffValues(oldR.value ?? {}, newR.value),
      metrics: validation.ok && METRICS[v.key] ? await METRICS[v.key](ctx, emp, date, sim, oldR, newR, v) : [],
    });
  }
  const shadowed = inScope.length - affectedCount;
  return {
    versionId: v.id, key: v.key, effectiveFrom: date, validation,
    inScopeCount: inScope.length, affectedCount, shadowedCount: shadowed,
    summary: [
      `This change affects ${affectedCount} employee${affectedCount === 1 ? '' : 's'} from ${date}.`,
      ...(shadowed > 0 ? [`${shadowed} employee${shadowed === 1 ? ' is' : 's are'} in scope but keep their current rule (a more specific override applies or nothing changes for them).`] : []),
      ...(sentence ? [sentence] : []),
    ],
    employees: affected,
    payrollImpact: payrollImpact(v.key, affected, date),
  };
}
