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
