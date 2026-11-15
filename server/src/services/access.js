/**
 * Data-visibility rules:
 *   employee -> own record only
 *   manager  -> own record + everyone reporting to them (directly or indirectly)
 *   hr_admin -> whole tenant
 * Salary data is further restricted to HR and the employee (see payroll).
 */
import { badRequest, forbidden, notFound } from '../lib/errors.js';

export const isHr = (ctx) => ctx.actor?.accessLevel === 'hr_admin';
export const isManager = (ctx) => ctx.actor?.accessLevel === 'manager';
/** Internal jobs/seed run with a system actor. */
export const isSystem = (ctx) => ctx.actor?.system === true;

export function requireHr(ctx) {
  if (!isHr(ctx) && !isSystem(ctx)) throw forbidden('Only HR admins can do this.');
}

/** Ids of everyone below `managerId` in the reporting line. */
export async function reportIds(ctx, managerId) {
  const { rows } = await ctx.db.query(
    `with recursive team as (
       select id from employees where tenant_id = $1 and manager_id = $2
       union
       select e.id from employees e join team t on e.manager_id = t.id where e.tenant_id = $1
     ) select id from team`, [ctx.tenant.id, managerId]);
  return rows.map((r) => r.id);
}

export async function canView(ctx, employeeId) {
  if (isHr(ctx) || isSystem(ctx)) return true;
  if (ctx.actor?.employeeId === employeeId) return true;
  if (can(ctx, 'payroll')) return true; // payroll staff work with everyone's records
  if (isManager(ctx) && ctx.actor.employeeId) return (await reportIds(ctx, ctx.actor.employeeId)).includes(employeeId);
  return false;
}

export async function assertCanView(ctx, employeeId) {
  if (!(await canView(ctx, employeeId))) throw forbidden("You can't view this employee's data.");
}

/**
 * Ids sent by the client (employeeId, departmentId, leaveTypeId...) must
 * belong to the caller's tenant. Checked before any write that stores them.
 * Tables are fixed names from code, never from the request.
 */
export async function assertInTenant(ctx, table, id, label = 'record') {
  if (id == null) return;
  const ok = await ctx.db.one(`select 1 from ${table} where id = $1 and tenant_id = $2`, [id, ctx.tenant.id]).catch((err) => {
    if (err.code === '22P02') return null; // not a uuid
    throw err;
  });
  if (!ok) throw badRequest('reference_invalid', `The selected ${label} does not exist.`);
}

/** Approve / act on behalf of an employee: HR, or a manager above them. */
export async function assertCanManage(ctx, employeeId) {
  if (isHr(ctx) || isSystem(ctx)) {
    // HR may act on anyone, but only inside its own company.
    const ok = employeeId && await ctx.db.one('select 1 from employees where id = $1 and tenant_id = $2', [employeeId, ctx.tenant.id])
      .catch((err) => { if (err.code === '22P02') return null; throw err; });
    if (!ok) throw notFound('Employee');
    return;
  }
  if (isManager(ctx) && ctx.actor.employeeId && ctx.actor.employeeId !== employeeId &&
      (await reportIds(ctx, ctx.actor.employeeId)).includes(employeeId)) return;
  throw forbidden("You can't act on this employee's requests.");
}

/**
 * Per-person rights (employees.permissions, set by HR on "Teams & access"). HR admins and system
 * jobs have them all. null = the defaults of the access level. Team rights only mean something
 * for managers / team leads; company areas (help desk, payroll) can be given to anyone.
 */
export const PERMISSIONS = [
  { key: 'team.approve', group: 'team', label: 'Approve requests', help: 'Approve leave, WFH and overtime of their team.' },
  { key: 'team.rota', group: 'team', label: 'Plan the rota', help: "Set their team's shifts and days off." },
  { key: 'team.tasks', group: 'team', label: 'Assign tasks', help: 'Give tasks to their team and read their work logs.' },
  { key: 'team.attendance', group: 'team', label: 'Record attendance', help: 'Enter a check-in or check-out for someone in their team.' },
  { key: 'team.access', group: 'team', label: 'Choose team features', help: 'Decide which features (leave, WFH, payslips, tasks...) each person in their team can use.' },
  { key: 'helpdesk', group: 'area', label: 'Help desk', help: "Read and answer everyone's help desk requests, like HR (e.g. a support manager)." },
  { key: 'payroll', group: 'area', label: 'Payroll', help: 'Run payroll and manage salaries and loans for everyone (e.g. a payroll manager).' },
];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export const DEFAULT_MANAGER_PERMISSIONS = ['team.approve', 'team.rota', 'team.tasks', 'team.attendance'];

/** What a person may do, from their access level and their stored rights (null = defaults). */
export function effectivePermissions(accessLevel, stored) {
  if (accessLevel === 'hr_admin') return [...PERMISSION_KEYS];
  if (accessLevel === 'manager') return stored == null ? [...DEFAULT_MANAGER_PERMISSIONS] : stored.filter((k) => PERMISSION_KEYS.includes(k));
  return (stored ?? []).filter((k) => PERMISSION_KEYS.includes(k) && !k.startsWith('team.'));
}

export function can(ctx, key) {
  if (isHr(ctx) || isSystem(ctx)) return true;
  const list = ctx.actor?.permissions ?? effectivePermissions(ctx.actor?.accessLevel, null);
  return list.includes(key);
}

const DENIED = {
  'team.approve': "You don't have the right to approve your team's requests. Ask HR if you need it.",
  'team.rota': "You don't have the right to plan the rota. Ask HR if you need it.",
  'team.tasks': "You don't have the right to assign tasks to your team. Ask HR if you need it.",
  'team.attendance': "You don't have the right to record attendance for your team. Ask HR if you need it.",
  'team.access': "You don't have the right to choose your team's features. Ask HR if you need it.",
  helpdesk: 'Only HR and help desk staff can do this.',
  payroll: 'Only HR and payroll staff can do this.',
};
export function requirePermission(ctx, key) {
  if (!can(ctx, key)) throw forbidden(DENIED[key] ?? "You don't have access to this.");
}

/** Active logins (not HR) that were given this right, e.g. help desk staff to notify. */
export async function usersWithPermission(ctx, key) {
  const { rows } = await ctx.db.query(
    `select u.id, u.access_level, e.permissions from employees e join users u on u.id = e.user_id
      where e.tenant_id = $1 and u.is_active and u.access_level <> 'hr_admin' and e.status = 'active'`, [ctx.tenant.id]);
  return rows.filter((r) => effectivePermissions(r.access_level, r.permissions).includes(key)).map((r) => r.id);
}
