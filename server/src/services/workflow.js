/**
 * Generic approval workflow engine.
 *
 * Each request type ('leave', 'wfh', 'attendance_correction') registers a
 * handler; the steps, auto-approval, escalation and notification rules come
 * from the versioned 'workflow.<type>' setting resolved for the requester.
 * The resolved workflow is snapshotted on the tasks so later edits never
 * change requests already in flight.
 *
 * Handler contract:
 *   load(ctx, id)               -> { employeeId, status, summary }
 *   autoApprove?(req, wf)       -> boolean   (workflow-level auto-approval)
 *   beforeFinalApprove?(ctx,id) -> throws if the request can no longer be approved
 *   finalize(ctx, id, decision, { actorUserId, comment, auto })  (runs in a transaction)
 */
import { resolveRequired } from '../config/resolver.js';
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isHr } from './access.js';
import { getEmployee } from './employees.js';
import { hrUserIds, notify, userOfEmployee } from './notifications.js';

const handlers = new Map();

export function registerHandler(type, handler) {
  handlers.set(type, handler);
}

function handlerFor(type) {
  const h = handlers.get(type);
  if (!h) throw notFound(`Request type "${type}"`);
  return h;
}

export async function resolveWorkflow(ctx, type, employee) {
  return resolveRequired(ctx.db, { tenantId: ctx.tenant.id, key: `workflow.${type}`, employee, date: tenantToday(ctx) });
}

/** Turns configured steps into concrete approvers, skipping missing/self/duplicate ones. */
async function buildChain(ctx, employee, steps) {
  const managerOf = async (id) => (id ? (await ctx.db.one('select manager_id from employees where id = $1', [id]))?.manager_id : null);
  const chain = [];
  const seen = new Set();
  for (const step of steps) {
    let approver = null;
    if (step.approver === 'manager') approver = employee.manager_id;
    if (step.approver === 'skip_level_manager') approver = await managerOf(employee.manager_id);
    if (step.approver !== 'hr' && (!approver || approver === employee.id)) continue;
    const key = step.approver === 'hr' ? 'hr' : approver;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ approverKind: step.approver, approverEmployeeId: step.approver === 'hr' ? null : approver });
  }
  if (!chain.length) chain.push({ approverKind: 'hr', approverEmployeeId: null }); // nobody else can approve
  return chain;
}

const dueAt = (ctx, wf) =>
  wf.escalation?.afterDays ? new Date(ctx.clock.now().getTime() + wf.escalation.afterDays * 86_400_000) : null;

async function recipients(ctx, kinds, { employee, task }) {
  const ids = [];
  for (const kind of kinds) {
    if (kind === 'requester') ids.push(await userOfEmployee(ctx, employee.id));
    if (kind === 'manager') ids.push(await userOfEmployee(ctx, employee.manager_id));
    if (kind === 'hr') ids.push(...(await hrUserIds(ctx)));
    if (kind === 'approver' && task) {
      if (task.approver_kind === 'hr') ids.push(...(await hrUserIds(ctx)));
      else ids.push(await userOfEmployee(ctx, task.approver_employee_id));
    }
  }
  return ids.filter(Boolean);
}

async function notifyApprover(ctx, wf, params, employee, task) {
  if (!wf.notify.onSubmit.includes('approver')) return;
  await notify(ctx, { userIds: await recipients(ctx, ['approver'], { employee, task }), event: 'approval_needed', params, channels: wf.notify.channels });
}

const insertTask = (db, ctx, { type, requestId, stepNo, approverKind, approverEmployeeId, status, due, wf, escalatedFrom = null }) =>
  db.one(
    `insert into approval_tasks (tenant_id, request_type, request_id, step_no, approver_kind, approver_employee_id, status, due_at,
                                 workflow_snapshot, escalated_from)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [ctx.tenant.id, type, requestId, stepNo, approverKind, approverEmployeeId, status, due, wf, escalatedFrom]);

/** Starts the approval process for a freshly created request. */
export async function submit(ctx, type, requestId, { autoApprove = false } = {}) {
  const h = handlerFor(type);
  const req = await h.load(ctx, requestId);
  const employee = await getEmployee(ctx, req.employeeId, { check: false });
  const { value: wf, versionIds } = await resolveWorkflow(ctx, type, employee);
  const params = { requestType: type, requestId, employeeName: employee.full_name, summary: req.summary };

  if (autoApprove || h.autoApprove?.(req, wf)) {
    await ctx.db.tx(async (db) => {
      await h.finalize({ ...ctx, db }, requestId, 'approved', { actorUserId: null, comment: null, auto: true });
      await audit(db, ctx, { action: `${type}.auto_approved`, entityType: type, entityId: requestId, meta: { workflowVersionIds: versionIds } });
    });
    await notify(ctx, { userIds: await recipients(ctx, wf.notify.onDecision.filter((k) => k !== 'approver'), { employee }),
      event: 'request_approved', params, channels: wf.notify.channels });
    return { status: 'approved', autoApproved: true, tasks: [] };
  }

  const chain = await buildChain(ctx, employee, wf.steps);
  const snapshot = { ...wf, versionIds };
  const tasks = await ctx.db.tx(async (db) => {
    const out = [];
    for (const [i, step] of chain.entries()) {
      out.push(await insertTask(db, ctx, { type, requestId, stepNo: i + 1, ...step, status: i === 0 ? 'pending' : 'waiting',
        due: i === 0 ? dueAt(ctx, wf) : null, wf: snapshot }));
    }
    return out;
  });
  await notifyApprover(ctx, wf, params, employee, tasks[0]);
  const others = wf.notify.onSubmit.filter((k) => k !== 'approver');
  if (others.length) {
    await notify(ctx, { userIds: await recipients(ctx, others, { employee }), event: 'request_submitted', params, channels: wf.notify.channels });
  }
  return { status: 'pending', autoApproved: false, tasks };
}

async function canAct(ctx, task, req) {
  const assigned = task.approver_kind === 'hr' ? isHr(ctx) : task.approver_employee_id === ctx.actor?.employeeId;
  if (!assigned && !isHr(ctx)) throw forbidden("You can't decide this request.");
  if (ctx.actor?.employeeId === req.employeeId) {
    if (!isHr(ctx)) throw forbidden("You can't approve your own request.");
    const otherHr = (await hrUserIds(ctx)).filter((id) => id !== ctx.actor.userId);
    if (otherHr.length) throw forbidden('Another HR admin must decide your own request.');
  }
  return { hrActingForOther: !assigned };
}

/**
 * Approve / reject one step. `override` (HR only) completes the whole
 * request immediately, skipping any remaining steps.
 */
export async function decide(ctx, taskId, { decision, comment = null, override = false } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw badRequest('decision_invalid', 'Decision must be approved or rejected.');
  if (override && !isHr(ctx)) throw forbidden('Only HR can override a workflow.');
  const task = await ctx.db.one('select * from approval_tasks where id = $1 and tenant_id = $2', [taskId, ctx.tenant.id]);
  if (!task) throw notFound('Approval task');
  if (task.status !== 'pending') throw conflict('already_decided', `This step is already ${task.status}.`);
  const h = handlerFor(task.request_type);
  const req = await h.load(ctx, task.request_id);
  if (req.status !== 'pending') throw conflict('already_decided', `This request is already ${req.status}.`);
  const { hrActingForOther } = await canAct(ctx, task, req);
  const employee = await getEmployee(ctx, req.employeeId, { check: false });
  const wf = task.workflow_snapshot;
  const { rows: rest } = await ctx.db.query(
    `select * from approval_tasks where tenant_id = $1 and request_type = $2 and request_id = $3 and status = 'waiting' order by step_no`,
    [ctx.tenant.id, task.request_type, task.request_id]);
  const isFinal = decision === 'rejected' || override || rest.length === 0;
  if (decision === 'approved' && isFinal) await h.beforeFinalApprove?.(ctx, task.request_id);

  const next = await ctx.db.tx(async (db) => {
    await db.query(
      `update approval_tasks set status = $2, decided_by = $3, decided_at = now(), comment = $4, override = $5 where id = $1`,
      [task.id, decision, ctx.actor.userId, comment, override || hrActingForOther]);
    let nextTask = null;
    if (isFinal) {
      await db.query(`update approval_tasks set status = 'skipped' where tenant_id = $1 and request_type = $2 and request_id = $3
                       and status in ('waiting', 'pending')`, [ctx.tenant.id, task.request_type, task.request_id]);
      await h.finalize({ ...ctx, db }, task.request_id, decision, { actorUserId: ctx.actor.userId, comment });
    } else {
      nextTask = await db.one(`update approval_tasks set status = 'pending', due_at = $2 where id = $1 returning *`, [rest[0].id, dueAt(ctx, wf)]);
    }
    await audit(db, ctx, { action: 'approval.decided', entityType: task.request_type, entityId: task.request_id,
      newValue: { taskId, stepNo: task.step_no, decision, comment, override: override || hrActingForOther, final: isFinal } });
    return nextTask;
  });

  const params = { requestType: task.request_type, requestId: task.request_id, employeeName: employee.full_name, summary: req.summary, comment: comment ?? '' };
  if (isFinal) {
    await notify(ctx, { userIds: await recipients(ctx, wf.notify.onDecision.filter((k) => k !== 'approver'), { employee }),
      event: decision === 'approved' ? 'request_approved' : 'request_rejected', params, channels: wf.notify.channels });
  } else {
    await notifyApprover(ctx, wf, params, employee, next);
  }
  return { status: isFinal ? decision : 'pending', nextTask: next };
}

/** Decide whichever pending step of a request the actor may act on. */
export async function decideRequest(ctx, type, requestId, input) {
  const { rows } = await ctx.db.query(
    `select * from approval_tasks where tenant_id = $1 and request_type = $2 and request_id = $3 and status = 'pending' order by step_no`,
    [ctx.tenant.id, type, requestId]);
  if (!rows.length) throw conflict('already_decided', 'This request has no pending approval step.');
  return decide(ctx, rows[0].id, input);
}

/** Closes open steps when a request is cancelled (the handler updates the request itself). */
export async function closeTasks(db, ctx, type, requestId) {
  await db.query(`update approval_tasks set status = 'skipped' where tenant_id = $1 and request_type = $2 and request_id = $3
                   and status in ('waiting', 'pending')`, [ctx.tenant.id, type, requestId]);
}

export async function tasksFor(ctx, type, requestId) {
  return (await ctx.db.query(`select * from approval_tasks where tenant_id = $1 and request_type = $2 and request_id = $3 order by step_no, created_at`,
    [ctx.tenant.id, type, requestId])).rows;
}

/** The actor's approval inbox (HR can pass all=true to see every pending step). */
export async function inbox(ctx, { all = false } = {}) {
  const { rows } = await ctx.db.query(
    `select * from approval_tasks where tenant_id = $1 and status = 'pending'
        and ($2 or approver_employee_id = $3 or (approver_kind = 'hr' and $4))
      order by created_at`, [ctx.tenant.id, all && isHr(ctx), ctx.actor.employeeId ?? null, isHr(ctx)]);
  const out = [];
  for (const task of rows) {
    const req = await handlerFor(task.request_type).load(ctx, task.request_id);
    const employee = await getEmployee(ctx, req.employeeId, { check: false });
    out.push({ task, request: { type: task.request_type, id: task.request_id, employeeId: employee.id, employeeName: employee.full_name, ...req } });
  }
  return out;
}

/** Moves overdue steps to the configured escalation target. */
export async function runEscalations(ctx) {
  const { rows } = await ctx.db.query(
    `select * from approval_tasks where tenant_id = $1 and status = 'pending' and due_at is not null and due_at <= $2`,
    [ctx.tenant.id, ctx.clock.now()]);
  let escalated = 0;
  for (const task of rows) {
    const wf = task.workflow_snapshot;
    const req = await handlerFor(task.request_type).load(ctx, task.request_id);
    const employee = await getEmployee(ctx, req.employeeId, { check: false });
    let target = { approverKind: 'hr', approverEmployeeId: null };
    if (wf.escalation.to === 'skip_level_manager' && task.approver_employee_id) {
      const up = (await ctx.db.one('select manager_id from employees where id = $1', [task.approver_employee_id]))?.manager_id;
      if (up && up !== employee.id) target = { approverKind: 'skip_level_manager', approverEmployeeId: up };
    }
    if (task.approver_kind === 'hr' && target.approverKind === 'hr') {
      await ctx.db.query('update approval_tasks set due_at = null where id = $1', [task.id]); // nowhere higher to go
      continue;
    }
    const newTask = await ctx.db.tx(async (db) => {
      await db.query(`update approval_tasks set status = 'escalated', decided_at = now() where id = $1`, [task.id]);
      const t = await insertTask(db, ctx, { type: task.request_type, requestId: task.request_id, stepNo: task.step_no, ...target,
        status: 'pending', due: null, wf, escalatedFrom: task.id });
      await audit(db, ctx, { action: 'approval.escalated', entityType: task.request_type, entityId: task.request_id,
        newValue: { fromTaskId: task.id, toTaskId: t.id, to: target.approverKind } });
      return t;
    });
    const params = { requestType: task.request_type, requestId: task.request_id, employeeName: employee.full_name, summary: req.summary };
    await notify(ctx, { userIds: await recipients(ctx, wf.notify.onEscalation, { employee, task: newTask }), event: 'request_escalated', params, channels: wf.notify.channels });
    escalated += 1;
  }
  return escalated;
}
