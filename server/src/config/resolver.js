/**
 * Resolves the effective value of a setting for an employee on a date.
 *
 * Layers, lowest to highest priority (higher layers override field by field):
 *   company > department > employment_type > role > employee
 * (Temporary per-employee overrides such as wfh_overrides sit above all of
 * these and are applied by the engine that owns them.)
 *
 * Within one layer the published version whose [effective_from,
 * effective_to] window contains the date wins. Drafts never apply.
 *
 * Published version lists are cached per (tenant, key, subject) and the
 * cache is dropped the moment a version is published or retired.
 * NOTE: the cache is per process. With several API instances, broadcast
 * invalidate() over Redis pub/sub or Postgres LISTEN/NOTIFY.
 */
import { addDays } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { deepMerge } from '../lib/util.js';

export const SCOPE_ORDER = ['company', 'department', 'employment_type', 'role', 'employee'];
const EMPLOYEE_SCOPE_FIELD = { department: 'department_id', employment_type: 'employment_type_id', role: 'role_id', employee: 'id' };

const cache = new Map();
const cacheKey = (tenantId, key, subjectId) => `${tenantId}|${key}|${subjectId ?? ''}`;

export function invalidate(tenantId, key) {
  const prefix = key ? `${tenantId}|${key}|` : `${tenantId}|`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

async function loadPublished(db, tenantId, key, subjectId) {
  const { rows } = await db.query(
    `select v.id as version_id, v.setting_id, v.version, v.value, v.effective_from, v.effective_to,
            s.scope_type, s.scope_id
       from setting_versions v
       join settings s on s.id = v.setting_id
      where v.tenant_id = $1 and s.key = $2 and s.subject_id is not distinct from $3
        and v.status = 'published'`,
    [tenantId, key, subjectId],
  );
  return rows;
}

async function publishedVersions(db, tenantId, key, subjectId) {
  // Never cache reads made inside a transaction: they may see uncommitted rows.
  if (db.inTransaction) return loadPublished(db, tenantId, key, subjectId);
  const ck = cacheKey(tenantId, key, subjectId);
  if (!cache.has(ck)) {
    const p = loadPublished(db, tenantId, key, subjectId);
    cache.set(ck, p);
    p.catch(() => cache.delete(ck));
  }
  return cache.get(ck);
}

/**
 * Applies "publish" semantics to an in-memory list, used for previews:
 * versions of the same setting starting on/after the new date are
 * superseded; the one running at that date is closed the day before.
 */
export function applySimulation(versions, sim) {
  const out = [];
  for (const v of versions) {
    if (v.setting_id !== sim.settingId) { out.push(v); continue; }
    if (v.effective_from >= sim.effectiveFrom) continue;
    const dayBefore = addDays(sim.effectiveFrom, -1);
    out.push(v.effective_to && v.effective_to < dayBefore ? v : { ...v, effective_to: dayBefore });
  }
  out.push({
    version_id: sim.versionId ?? 'simulated', setting_id: sim.settingId, version: sim.version ?? 0, value: sim.value,
    effective_from: sim.effectiveFrom, effective_to: null, scope_type: sim.scopeType, scope_id: sim.scopeId ?? null,
  });
  return out;
}

function matchesScope(v, employee) {
  if (v.scope_type === 'company') return true;
  if (!employee) return false;
  return employee[EMPLOYEE_SCOPE_FIELD[v.scope_type]] === v.scope_id;
}

/**
 * @returns {{ found: boolean, value: object|null, sources: Array, versionIds: string[] }}
 */
export async function resolve(db, args) {
  const r = await resolveOn(db, args);
  return r.found ? r : (await resolveBeforeGoLive(db, args)) ?? r;
}

async function resolveOn(db, { tenantId, key, subjectId = null, employee = null, date, simulate = null }) {
  let versions = await publishedVersions(db, tenantId, key, subjectId);
  if (simulate) versions = applySimulation(versions, simulate);

  const active = versions.filter((v) =>
    v.effective_from <= date && (v.effective_to == null || date <= v.effective_to) && matchesScope(v, employee));

  let value = null;
  const sources = [];
  for (const scope of SCOPE_ORDER) {
    const candidates = active.filter((v) => v.scope_type === scope)
      .sort((a, b) => (a.effective_from === b.effective_from ? b.version - a.version : a.effective_from < b.effective_from ? 1 : -1));
    const v = candidates[0];
    if (!v) continue;
    value = value === null ? structuredClone(v.value) : deepMerge(value, v.value);
    sources.push({
      scopeType: v.scope_type, scopeId: v.scope_id, settingId: v.setting_id, versionId: v.version_id,
      version: v.version, effectiveFrom: v.effective_from, fields: Object.keys(v.value),
    });
  }
  return { found: sources.length > 0, value, sources, versionIds: sources.map((s) => s.versionId) };
}

/**
 * A company's default rules take effect on its go-live date (the day it was created), but month
 * views start on the 1st: a company created on the 10th has no rules for the 1st to the 9th, and
 * its dashboards failed for the whole first month. Days before go-live therefore use the rules it
 * started with. Only when nothing applies at all; a rule published for a later date still doesn't
 * apply earlier once the company is live.
 */
async function resolveBeforeGoLive(db, args) {
  const t = await db.one('select go_live_date from tenants where id = $1', [args.tenantId]);
  if (!t?.go_live_date || !(args.date < t.go_live_date)) return null;
  const r = await resolveOn(db, { ...args, date: t.go_live_date });
  return r.found ? r : null;
}

/** Like resolve() but throws a clear error when nothing is configured. */
export async function resolveRequired(db, args) {
  const r = await resolve(db, args);
  if (!r.found) {
    throw new AppError(422, 'setting_missing', `No published "${args.key}" setting applies on ${args.date}. Ask HR to publish one.`,
      { params: { key: args.key, date: args.date } });
  }
  return r;
}
