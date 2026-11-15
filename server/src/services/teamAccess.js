/**
 * Teams & access.
 *
 *   HR       decides who is a manager / team lead, which people work under each one, and what each
 *            person may do (employees.permissions: team rights and company areas, see access.js).
 *   manager  with the "team.access" right, chooses which features (attendance, leave, WFH, payslips,
 *            tasks) each person in their team can use (employees.module_access).
 */
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  DEFAULT_MANAGER_PERMISSIONS, PERMISSIONS, PERMISSION_KEYS, effectivePermissions, isHr, reportIds, requireHr, requirePermission,
} from './access.js';
import { PERSONAL_MODULES, companyModules, normalizeModuleAccess } from './features.js';
import { addLogin } from './employees.js';
import { notify } from './notifications.js';

const LEVELS = ['employee', 'manager'];
const LABEL = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));
const MODULE_LABEL = { attendance: 'Attendance', wfh: 'Work from home', leave: 'Leave', payroll: 'Payslips', tasks: 'Daily tasks' };

async function actorName(ctx) {
  return ctx.actor?.employeeId
    ? (await ctx.db.one('select full_name from employees where id = $1', [ctx.actor.employeeId]))?.full_name ?? 'HR' : 'HR';
}

async function person(ctx, id) {
  const p = await ctx.db.one(
    `select e.id, e.full_name, e.user_id, e.manager_id, e.permissions, e.module_access, e.status, u.access_level
       from employees e left join users u on u.id = e.user_id where e.id = $1 and e.tenant_id = $2`, [id, ctx.tenant.id])
    .catch((err) => { if (err.code === '22P02') return null; throw err; });
  if (!p) throw notFound('Employee');
  return p;
}

/** HR: everyone with their level, manager, team size, rights and features; plus the catalogues. */
export async function accessOverview(ctx) {
  requireHr(ctx);
  const { rows } = await ctx.db.query(
    `select e.id, e.full_name, e.employee_code, e.email, e.manager_id, e.permissions, e.module_access, e.status,
            d.name as department, r.name as role, u.access_level, m.full_name as manager_name,
            (select count(*)::int from employees x where x.tenant_id = e.tenant_id and x.manager_id = e.id and x.status = 'active') as team_size
       from employees e
       left join users u on u.id = e.user_id
       left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
       left join roles r on r.id = e.role_id and r.tenant_id = e.tenant_id
       left join employees m on m.id = e.manager_id and m.tenant_id = e.tenant_id
      where e.tenant_id = $1 and e.status = 'active'
      order by e.full_name`, [ctx.tenant.id]);
  return {
    people: rows.map((p) => ({ ...p, effective: p.access_level ? effectivePermissions(p.access_level, p.permissions) : [], custom: p.permissions != null })),
    permissions: PERMISSIONS,
    defaultManagerPermissions: DEFAULT_MANAGER_PERMISSIONS,
    modules: (await companyModules(ctx)).filter((m) => PERSONAL_MODULES.includes(m)).map((m) => ({ key: m, label: MODULE_LABEL[m] ?? m })),
  };
}

/**
 * HR changes someone's level (employee <-> manager / team lead) and/or rights.
 * input: { accessLevel?, permissions?: [...] | null (null = defaults) }
 * Taking away "approve requests" moves that person's pending approvals to HR, so nothing gets stuck.
 */
export async function setAccess(ctx, employeeId, { accessLevel, permissions, email, password } = {}) {
  requireHr(ctx);
  let p = await person(ctx, employeeId);
  let login = null;
  // No login yet: create one at the chosen level with the password HR set (input.email, or their work email).
  if (accessLevel !== undefined && !p.user_id && LEVELS.includes(accessLevel)) {
    login = await addLogin(ctx, employeeId, { email, accessLevel, password });
    p = await person(ctx, employeeId);
  }
  if (p.user_id && p.user_id === ctx.actor?.userId) throw forbidden("You can't change your own access.");
  if (p.access_level === 'hr_admin') throw conflict('access_hr', `${p.full_name} is an HR admin and can do everything. Change their access level on their employee record first.`);
  const level = accessLevel ?? p.access_level;
  if (accessLevel !== undefined) {
    if (!LEVELS.includes(accessLevel)) throw badRequest('access_invalid', 'Choose Employee or Manager / team lead.');
    if (!p.user_id) throw conflict('no_login', `${p.full_name} has no login yet. Create one on their employee record first.`);
  }
  let stored = p.permissions;
  if (permissions !== undefined) {
    if (permissions !== null && (!Array.isArray(permissions) || permissions.some((k) => !PERMISSION_KEYS.includes(k)))) {
      throw badRequest('access_invalid', `Rights must be chosen from: ${PERMISSION_KEYS.join(', ')}.`);
    }
    stored = permissions === null ? null : PERMISSION_KEYS.filter((k) => permissions.includes(k) && (level === 'manager' || !k.startsWith('team.')));
  }
  const before = p.access_level ? effectivePermissions(p.access_level, p.permissions) : [];
  const after = level ? effectivePermissions(level, stored) : [];
  const by = await actorName(ctx);
  await ctx.db.tx(async (db) => {
    if (accessLevel !== undefined && accessLevel !== p.access_level) {
      await db.query('update users set access_level = $2 where id = $1 and tenant_id = $3', [p.user_id, accessLevel, ctx.tenant.id]);
    }
    await db.query('update employees set permissions = $2, updated_at = now() where id = $1 and tenant_id = $3',
      [employeeId, stored == null ? null : JSON.stringify(stored), ctx.tenant.id]);
    let moved = 0;
    if (before.includes('team.approve') && !after.includes('team.approve')) {
      moved = (await db.query(
        `update approval_tasks set approver_kind = 'hr', approver_employee_id = null
          where tenant_id = $1 and status = 'pending' and approver_employee_id = $2 returning id`, [ctx.tenant.id, employeeId])).rows.length;
    }
    await audit(db, ctx, { action: 'access.changed', entityType: 'employee', entityId: employeeId,
      oldValue: { accessLevel: p.access_level, permissions: p.permissions }, newValue: { accessLevel: level, permissions: stored }, meta: { approvalsMovedToHr: moved } });
    const added = after.filter((k) => !before.includes(k)).map((k) => `+ ${LABEL[k]}`);
    const removed = before.filter((k) => !after.includes(k)).map((k) => `− ${LABEL[k]}`);
    const levelText = level !== p.access_level ? [level === 'manager' ? 'you are now a manager / team lead' : 'you are no longer a manager'] : [];
    const summary = [...levelText, ...added, ...removed];
    if (summary.length && p.user_id) {
      await notify({ ...ctx, db }, { userIds: [p.user_id], event: 'access_changed', params: { by, summary: summary.join(', ') } });
    }
  });
  return { ...(await accessOverview(ctx)).people.find((x) => x.id === employeeId), login };
}

/**
 * HR puts people under a manager / team lead, or takes them out (they then have no manager).
 * input: { add: [employeeIds], remove: [employeeIds] }
 */
export async function setTeam(ctx, managerId, { add = [], remove = [] } = {}) {
  requireHr(ctx);
  const mgr = await person(ctx, managerId);
  if (!['manager', 'hr_admin'].includes(mgr.access_level)) {
    throw conflict('not_manager', `${mgr.full_name} is not a manager or team lead yet. Make them one first.`);
  }
  if (!Array.isArray(add) || !Array.isArray(remove)) throw badRequest('team_invalid', 'Send lists of people to add and remove.');
  const above = new Set();
  for (let cur = mgr.manager_id, hops = 0; cur && hops < 100; hops += 1) {
    above.add(cur);
    cur = (await ctx.db.one('select manager_id from employees where id = $1', [cur]))?.manager_id;
  }
  const errors = [];
  const toAdd = [];
  for (const id of new Set(add)) {
    const p = await person(ctx, id).catch(() => null);
    if (!p) { errors.push('One of the chosen people does not exist.'); continue; }
    if (id === managerId) errors.push(`${p.full_name} can't be in their own team.`);
    else if (above.has(id)) errors.push(`${p.full_name} is above ${mgr.full_name} in the reporting line, so they can't also work under them.`);
    else if (p.manager_id !== managerId) toAdd.push(p);
  }
  if (errors.length) throw badRequest('team_invalid', errors.join(' '), { details: { errors } });
  const by = await actorName(ctx);
  let removed = 0;
  await ctx.db.tx(async (db) => {
    for (const p of toAdd) {
      await db.query('update employees set manager_id = $2, updated_at = now() where id = $1 and tenant_id = $3', [p.id, managerId, ctx.tenant.id]);
    }
    if (remove.length) {
      removed = (await db.query(
        `update employees set manager_id = null, updated_at = now() where tenant_id = $1 and manager_id = $2 and id = any($3::uuid[]) returning id`,
        [ctx.tenant.id, managerId, remove])).rows.length;
    }
    await audit(db, ctx, { action: 'team.changed', entityType: 'employee', entityId: managerId,
      meta: { added: toAdd.map((p) => p.id), removed: remove } });
    if (toAdd.length && mgr.user_id) {
      await notify({ ...ctx, db }, { userIds: [mgr.user_id], event: 'access_changed',
        params: { by, summary: `${toAdd.map((p) => p.full_name).join(', ')} now ${toAdd.length === 1 ? 'works' : 'work'} under you` } });
    }
  });
  return { added: toAdd.length, removed };
}

/** A manager's people (or everyone, for HR) with the features each can use. */
export async function teamFeatures(ctx) {
  requirePermission(ctx, 'team.access');
  const ids = isHr(ctx) ? null : await reportIds(ctx, ctx.actor.employeeId);
  if (ids && !ids.length) return { people: [], modules: [] };
  const { rows } = await ctx.db.query(
    `select e.id, e.full_name, e.employee_code, e.module_access, e.manager_id, m.full_name as manager_name, d.name as department, r.name as role
       from employees e left join employees m on m.id = e.manager_id
       left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
       left join roles r on r.id = e.role_id and r.tenant_id = e.tenant_id
      where e.tenant_id = $1 and e.status = 'active' and ($2::uuid[] is null or e.id = any($2)) order by e.full_name`, [ctx.tenant.id, ids]);
  const modules = (await companyModules(ctx)).filter((m) => PERSONAL_MODULES.includes(m)).map((m) => ({ key: m, label: MODULE_LABEL[m] ?? m }));
  return { people: rows, modules };
}

/** A manager (with "team.access") or HR sets which features one person can use. modules: [...] or null = all. */
export async function setTeamFeatures(ctx, employeeId, { modules } = {}) {
  requirePermission(ctx, 'team.access');
  const p = await person(ctx, employeeId);
  if (!isHr(ctx)) {
    if (employeeId === ctx.actor?.employeeId) throw forbidden("You can't change your own features. Ask HR.");
    if (!(await reportIds(ctx, ctx.actor.employeeId)).includes(employeeId)) throw forbidden(`${p.full_name} doesn't work under you.`);
  }
  if (p.access_level === 'hr_admin') throw conflict('access_hr', 'HR admins always have every feature.');
  const list = normalizeModuleAccess(modules ?? null);
  const by = await actorName(ctx);
  await ctx.db.tx(async (db) => {
    await db.query('update employees set module_access = $2, updated_at = now() where id = $1 and tenant_id = $3',
      [employeeId, list == null ? null : JSON.stringify(list), ctx.tenant.id]);
    await audit(db, ctx, { action: 'features.changed', entityType: 'employee', entityId: employeeId,
      oldValue: { moduleAccess: p.module_access }, newValue: { moduleAccess: list } });
    const text = list == null ? 'all features are on' : list.length ? `you can use ${list.map((m) => MODULE_LABEL[m]).join(', ')}` : 'all personal features are off';
    if (p.user_id && JSON.stringify(p.module_access) !== JSON.stringify(list)) {
      await notify({ ...ctx, db }, { userIds: [p.user_id], event: 'access_changed', params: { by, summary: text } });
    }
  });
  return { id: employeeId, module_access: list };
}

