/**
 * Assigned tasks: a manager (or HR) gives work to the people under them and both sides discuss it.
 *
 *   manager   assigns tasks to anyone in their reporting line; sees, edits and discusses those tasks
 *   hr_admin  can do the same for everyone in the company
 *   employee  sees their own tasks, moves them to in progress / done / blocked, and writes in the thread
 *
 * Status: todo -> in_progress -> done (or blocked, which needs a reason). The assignee or a manager
 * above them can change it; a manager can reopen a done task.
 * Notifications: the person is told when a task is assigned or changed (in the app and by email),
 * gets one "your tasks for today" reminder each morning (see sendDailyDigests), and both sides are
 * told about new messages and status changes.
 */
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, isYmd, localTime } from '../lib/dates.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { isHr, isSystem, reportIds } from './access.js';
import { isEnabled, requireModule } from './features.js';
import { notify, userOfEmployee } from './notifications.js';

export const STATUSES = ['todo', 'in_progress', 'done', 'blocked'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUS_LABEL = { todo: 'to do', in_progress: 'in progress', done: 'done', blocked: 'blocked' };
const MAX_PEOPLE = 200;
const MAX_DAYS_AHEAD = 366;
/** The morning reminder goes out on the first job run at or after this local time. */
export const DIGEST_TIME = '08:00';

const clean = (s) => (typeof s === 'string' ? s.trim() : '');
const preview = (s) => (s.length > 140 ? `${s.slice(0, 137)}...` : s);
/** 'today', 'tomorrow' or 'Thu 5 Mar' for notifications. */
function dueText(ctx, ymd) {
  const today = tenantToday(ctx);
  if (ymd === today) return 'today';
  if (ymd === addDays(today, 1)) return 'tomorrow';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${ymd}T00:00:00Z`));
}

const me = (ctx) => {
  if (!ctx.actor?.employeeId && !isHr(ctx)) throw forbidden('Only employees can use tasks.');
  return ctx.actor?.employeeId ?? null;
};

async function actorName(ctx) {
  if (!ctx.actor?.employeeId) return 'HR';
  return (await ctx.db.one('select full_name from employees where id = $1', [ctx.actor.employeeId]))?.full_name ?? 'HR';
}

/** Can the signed-in person assign work to / manage the tasks of this employee? */
async function canManageEmployee(ctx, employeeId) {
  if (isHr(ctx) || isSystem(ctx)) return true;
  if (!ctx.actor?.employeeId || ctx.actor.employeeId === employeeId) return false;
  return (await reportIds(ctx, ctx.actor.employeeId)).includes(employeeId);
}

const TASK_SELECT = `
  select t.*, e.full_name as employee_name, e.employee_code, e.user_id as employee_user_id, d.name as department,
         coalesce(ab.full_name, case when t.assigned_by is null then 'Former employee' else 'HR' end) as assigned_by_name,
         ab.id as assigned_by_employee_id,
         (select count(*)::int from task_messages m where m.task_id = t.id and m.kind = 'message') as messages
    from assigned_tasks t
    join employees e on e.id = t.employee_id
    left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
    left join employees ab on ab.user_id = t.assigned_by and ab.tenant_id = t.tenant_id`;

async function load(ctx, id) {
  const t = await ctx.db.one(`${TASK_SELECT} where t.tenant_id = $1 and t.id = $2`, [ctx.tenant.id, id])
    .catch((err) => { if (err.code === '22P02') return null; throw err; });
  if (!t) throw notFound('Task');
  return t;
}

/** Assignee, the person who assigned it, a manager above the assignee, or HR. */
async function access(ctx, t) {
  const own = ctx.actor?.employeeId === t.employee_id;
  const manage = (ctx.actor?.userId && t.assigned_by === ctx.actor.userId) || await canManageEmployee(ctx, t.employee_id);
  if (!own && !manage) throw notFound('Task');
  return { own, manage };
}

/** The people a new message or status change should reach: assignee and assigner (or the assignee's manager). */
async function participants(ctx, t) {
  let boss = t.assigned_by;
  if (!boss) {
    const { manager_id } = await ctx.db.one('select manager_id from employees where id = $1', [t.employee_id]);
    boss = await userOfEmployee(ctx, manager_id);
  }
  return [t.employee_user_id, boss].filter((u) => u && u !== ctx.actor?.userId);
}

function validateFields(ctx, input, before = null) {
  const v = {
    title: input.title !== undefined ? clean(input.title) : before?.title,
    description: (input.description !== undefined ? clean(input.description) : before?.description) || null,
    due_date: input.dueDate ?? before?.due_date ?? tenantToday(ctx),
    priority: input.priority ?? before?.priority ?? 'normal',
  };
  const today = tenantToday(ctx);
  const errors = [];
  if (!v.title) errors.push('Give the task a title.');
  else if (v.title.length > 200) errors.push('Keep the title under 200 characters.');
  if (v.description && v.description.length > 5000) errors.push('Keep the description under 5000 characters.');
  if (!isYmd(v.due_date)) errors.push('Choose the due date.');
  else if (v.due_date < today && v.due_date !== before?.due_date) errors.push("The due date can't be in the past.");
  else if (v.due_date > addDays(today, MAX_DAYS_AHEAD)) errors.push('Choose a due date within the next year.');
  if (!PRIORITIES.includes(v.priority)) errors.push(`Priority must be one of: ${PRIORITIES.join(', ')}.`);
  if (errors.length) throw badRequest('task_invalid', errors.join(' '), { details: { errors } });
  return v;
}

/** People the signed-in person can give tasks to (HR: everyone active; manager: their reporting line). */
export async function assignablePeople(ctx) {
  await requireModule(ctx, 'tasks');
  let ids = null;
  if (!isHr(ctx)) {
    if (!ctx.actor?.employeeId) throw forbidden('Only managers and HR can assign tasks.');
    ids = await reportIds(ctx, ctx.actor.employeeId);
    if (!ids.length) return [];
  }
  const { rows } = await ctx.db.query(
    `select e.id, e.full_name, e.employee_code, d.name as department, r.name as role
       from employees e left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
       left join roles r on r.id = e.role_id and r.tenant_id = e.tenant_id
      where e.tenant_id = $1 and e.status = 'active' and ($2::uuid[] is null or e.id = any($2))
      order by e.full_name`, [ctx.tenant.id, ids]);
  return rows;
}

/**
 * Gives a task to one or more people (one task each, so each person tracks their own).
 * input: { employeeIds: [...], title, description?, dueDate?, priority? }
 */
export async function assignTask(ctx, input = {}) {
  await requireModule(ctx, 'tasks');
  me(ctx);
  const ids = [...new Set(Array.isArray(input.employeeIds) ? input.employeeIds : input.employeeId ? [input.employeeId] : [])];
  if (!ids.length) throw badRequest('task_invalid', 'Choose who should do the task.');
  if (ids.length > MAX_PEOPLE) throw badRequest('task_invalid', `Choose at most ${MAX_PEOPLE} people at once.`);
  const v = validateFields(ctx, input);
  const allowed = new Map((await assignablePeople(ctx)).map((p) => [p.id, p]));
  const notAllowed = ids.filter((id) => !allowed.has(id));
  if (notAllowed.length) {
    throw forbidden(isHr(ctx) ? 'Some of the chosen people are not active employees of this company.'
      : 'You can only assign tasks to people who report to you.');
  }
  const by = await actorName(ctx);
  const tasks = await ctx.db.tx(async (db) => {
    const out = [];
    let { n } = await db.one('select coalesce(max(number), 0) as n from assigned_tasks where tenant_id = $1', [ctx.tenant.id]);
    for (const employeeId of ids) {
      n += 1;
      const t = await db.one(
        `insert into assigned_tasks (tenant_id, number, employee_id, assigned_by, title, description, due_date, priority)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [ctx.tenant.id, n, employeeId, ctx.actor?.userId ?? null, v.title, v.description, v.due_date, v.priority]);
      out.push(t);
    }
    await audit(db, ctx, { action: 'task.assigned', entityType: 'assigned_task', entityId: out[0].id,
      meta: { title: v.title, dueDate: v.due_date, people: ids.length, numbers: out.map((t) => t.number) } });
    for (const t of out) {
      await notify({ ...ctx, db }, { userIds: [await userOfEmployee({ ...ctx, db }, t.employee_id)].filter((u) => u !== ctx.actor?.userId),
        event: 'task_assigned', channels: ['in_app', 'email'],
        params: { taskId: t.id, title: t.title, by, due: dueText(ctx, t.due_date), priority: t.priority } });
    }
    return out;
  });
  return { assigned: tasks.length, tasks };
}

/**
 * query: { view: 'mine' | 'team', status: 'open' | 'done' | 'all' | <status>, employeeId?, q? }
 * mine = tasks given to me; team = tasks I gave or that belong to my reporting line (HR: everyone's).
 */
export async function listTasks(ctx, { view = 'mine', status = 'open', employeeId = null, q = null } = {}) {
  await requireModule(ctx, 'tasks');
  const myId = me(ctx);
  let where = '';
  const params = [ctx.tenant.id];
  if (view === 'team') {
    if (!isHr(ctx)) {
      const ids = myId ? await reportIds(ctx, myId) : [];
      params.push(ids, ctx.actor.userId);
      where += ` and (t.employee_id = any($${params.length - 1}) or t.assigned_by = $${params.length})`;
    }
  } else {
    if (!myId) return { tasks: [], counts: {}, today: tenantToday(ctx) };
    params.push(myId);
    where += ` and t.employee_id = $${params.length}`;
  }
  if (employeeId) { params.push(employeeId); where += ` and t.employee_id = $${params.length}`; }
  const term = clean(q);
  if (term) { params.push(term); where += ` and (t.title ilike '%' || $${params.length} || '%' or e.full_name ilike '%' || $${params.length} || '%' or t.number::text = $${params.length})`; }
  const base = where;
  if (status === 'open') where += ` and t.status <> 'done'`;
  else if (STATUSES.includes(status)) { params.push(status); where += ` and t.status = $${params.length}`; }
  else if (status !== 'all') throw badRequest('task_invalid', 'Unknown status.');
  const today = tenantToday(ctx);
  const { rows } = await ctx.db.query(
    `${TASK_SELECT} where t.tenant_id = $1 ${where}
      order by (t.status = 'done'), case when t.status = 'done' then null else t.due_date end,
               array_position(array['urgent','high','normal','low'], t.priority), t.completed_at desc nulls last, t.number desc
      limit 500`, params);
  const countParams = params.slice(0, params.length - (STATUSES.includes(status) ? 1 : 0));
  countParams.push(today);
  const c = await ctx.db.one(
    `select count(*) filter (where t.status <> 'done' and t.due_date < $${countParams.length})::int as overdue,
            count(*) filter (where t.status <> 'done' and t.due_date = $${countParams.length})::int as today,
            count(*) filter (where t.status <> 'done' and t.due_date > $${countParams.length})::int as upcoming,
            count(*) filter (where t.status = 'blocked')::int as blocked,
            count(*) filter (where t.status = 'done')::int as done
       from assigned_tasks t join employees e on e.id = t.employee_id where t.tenant_id = $1 ${base}`, countParams);
  return { tasks: rows.map((t) => ({ ...t, overdue: t.status !== 'done' && t.due_date < today })), counts: c, today };
}

/** One task with its discussion. */
export async function getTask(ctx, id) {
  await requireModule(ctx, 'tasks');
  const t = await load(ctx, id);
  const can = await access(ctx, t);
  const { rows: messages } = await ctx.db.query(
    `select m.id, m.kind, m.body, m.created_at, m.author_user_id, coalesce(e.full_name, case when u.access_level = 'hr_admin' then 'HR' else 'Former employee' end) as author,
            (m.author_user_id = $3) as mine
       from task_messages m left join users u on u.id = m.author_user_id
       left join employees e on e.user_id = m.author_user_id and e.tenant_id = m.tenant_id
      where m.tenant_id = $1 and m.task_id = $2 order by m.created_at, m.id`, [ctx.tenant.id, id, ctx.actor?.userId ?? null]);
  const today = tenantToday(ctx);
  return { ...t, overdue: t.status !== 'done' && t.due_date < today, messages, canManage: can.manage, isMine: can.own };
}

/** Edit the title, description, due date or priority (whoever can manage the task). */
export async function updateTask(ctx, id, input = {}) {
  await requireModule(ctx, 'tasks');
  const before = await load(ctx, id);
  const can = await access(ctx, before);
  if (!can.manage) throw forbidden('Only the person who assigned this task, their manager or HR can change it.');
  const v = validateFields(ctx, input, before);
  const by = await actorName(ctx);
  const t = await ctx.db.tx(async (db) => {
    const row = await db.one(
      `update assigned_tasks set title = $3, description = $4, due_date = $5, priority = $6, updated_at = now()
        where id = $1 and tenant_id = $2 returning *`, [id, ctx.tenant.id, v.title, v.description, v.due_date, v.priority]);
    await audit(db, ctx, { action: 'task.updated', entityType: 'assigned_task', entityId: id,
      oldValue: { title: before.title, description: before.description, dueDate: before.due_date, priority: before.priority },
      newValue: { title: v.title, description: v.description, dueDate: v.due_date, priority: v.priority } });
    const changed = before.title !== v.title || before.description !== v.description || before.due_date !== v.due_date || before.priority !== v.priority;
    if (changed && before.employee_user_id !== ctx.actor?.userId) {
      await notify({ ...ctx, db }, { userIds: [before.employee_user_id], event: 'task_changed', channels: ['in_app', 'email'],
        params: { taskId: id, title: v.title, by, due: dueText(ctx, v.due_date) } });
    }
    return row;
  });
  return t;
}

/**
 * Move a task along. The assignee can set any status; a manager can too (e.g. reopen a done task).
 * Blocked needs a note saying why. The note is added to the thread.
 */
export async function setStatus(ctx, id, { status, note } = {}) {
  await requireModule(ctx, 'tasks');
  const t = await load(ctx, id);
  await access(ctx, t);
  if (!STATUSES.includes(status)) throw badRequest('task_invalid', `Status must be one of: ${STATUSES.join(', ')}.`);
  const text = clean(note);
  if (status === 'blocked' && !text) throw badRequest('task_invalid', 'Say what is blocking you, so your manager can help.');
  if (text.length > 5000) throw badRequest('task_invalid', 'Keep the note under 5000 characters.');
  if (status === t.status && !text) return getTask(ctx, id);
  const name = await actorName(ctx);
  await ctx.db.tx(async (db) => {
    await db.query(
      `update assigned_tasks set status = $3, updated_at = now(),
              completed_at = case when $3 = 'done' then coalesce(completed_at, now()) else null end,
              last_message_at = now()
        where id = $1 and tenant_id = $2`, [id, ctx.tenant.id, status]);
    const body = `Marked as ${STATUS_LABEL[status]}${text ? `: ${text}` : '.'}`;
    await db.query(`insert into task_messages (tenant_id, task_id, author_user_id, kind, body) values ($1, $2, $3, 'status', $4)`,
      [ctx.tenant.id, id, ctx.actor?.userId ?? null, body]);
    if (status !== t.status) {
      await notify({ ...ctx, db }, { userIds: await participants({ ...ctx, db }, t), event: 'task_status',
        channels: status === 'blocked' ? ['in_app', 'email'] : ['in_app'],
        params: { taskId: id, title: t.title, name, status: STATUS_LABEL[status], note: text ? ` "${preview(text)}"` : '' } });
    }
  });
  return getTask(ctx, id);
}

/** A message in the task's thread; the other side is notified. */
export async function postMessage(ctx, id, { body } = {}) {
  await requireModule(ctx, 'tasks');
  const t = await load(ctx, id);
  await access(ctx, t);
  const text = clean(body);
  if (!text) throw badRequest('message_invalid', 'Write a message.');
  if (text.length > 5000) throw badRequest('message_invalid', 'Keep the message under 5000 characters.');
  const name = await actorName(ctx);
  await ctx.db.tx(async (db) => {
    await db.query(`insert into task_messages (tenant_id, task_id, author_user_id, body) values ($1, $2, $3, $4)`,
      [ctx.tenant.id, id, ctx.actor?.userId ?? null, text]);
    await db.query('update assigned_tasks set last_message_at = now() where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
    await notify({ ...ctx, db }, { userIds: await participants({ ...ctx, db }, t), event: 'task_message', channels: ['in_app', 'email'],
      params: { taskId: id, title: t.title, name, preview: preview(text) } });
  });
  return getTask(ctx, id);
}

/** Remove a task given by mistake (whoever can manage it). Its messages go with it. */
export async function deleteTask(ctx, id) {
  await requireModule(ctx, 'tasks');
  const t = await load(ctx, id);
  const can = await access(ctx, t);
  if (!can.manage) throw forbidden('Only the person who assigned this task, their manager or HR can delete it.');
  await ctx.db.tx(async (db) => {
    await db.query('delete from assigned_tasks where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
    await audit(db, ctx, { action: 'task.deleted', entityType: 'assigned_task', entityId: id,
      oldValue: { number: t.number, title: t.title, employeeId: t.employee_id, dueDate: t.due_date, status: t.status } });
  });
}

/** For the dashboard: my open tasks that are overdue, due today or due in the next 7 days. */
export async function myOpenTasks(ctx) {
  await requireModule(ctx, 'tasks');
  if (!ctx.actor?.employeeId) return { today: tenantToday(ctx), tasks: [] };
  const today = tenantToday(ctx);
  const { rows } = await ctx.db.query(
    `${TASK_SELECT} where t.tenant_id = $1 and t.employee_id = $2 and t.status <> 'done' and t.due_date <= $3
      order by t.due_date, array_position(array['urgent','high','normal','low'], t.priority), t.number limit 50`,
    [ctx.tenant.id, ctx.actor.employeeId, addDays(today, 7)]);
  return { today, tasks: rows.map((t) => ({ ...t, overdue: t.due_date < today })) };
}

/**
 * Background job, once per company per day (after DIGEST_TIME local time): each person with open
 * tasks due today or overdue gets one "your tasks for today" notification listing them.
 */
export async function sendDailyDigests(ctx) {
  if (!(await isEnabled(ctx, 'tasks'))) return 0;
  if (localTime(ctx.clock.now(), ctx.tenant.timezone) < DIGEST_TIME) return 0;
  const today = tenantToday(ctx);
  return ctx.db.tx(async (db) => {
    const claimed = await db.one(
      `insert into task_digests (tenant_id, day) values ($1, $2) on conflict do nothing returning day`, [ctx.tenant.id, today]);
    if (!claimed) return 0;
    const { rows } = await db.query(
      `select t.employee_id, e.user_id, t.title, t.due_date, t.priority from assigned_tasks t
         join employees e on e.id = t.employee_id
        where t.tenant_id = $1 and t.status <> 'done' and t.due_date <= $2 and e.status = 'active' and e.user_id is not null
        order by t.employee_id, t.due_date, array_position(array['urgent','high','normal','low'], t.priority)`, [ctx.tenant.id, today]);
    const byPerson = new Map();
    for (const r of rows) {
      if (!byPerson.has(r.user_id)) byPerson.set(r.user_id, []);
      byPerson.get(r.user_id).push(r);
    }
    for (const [userId, list] of byPerson) {
      const lines = list.slice(0, 6).map((r) => `• ${r.title}${r.due_date < today ? ` (overdue, was due ${dueText(ctx, r.due_date)})` : ''}${r.priority === 'urgent' || r.priority === 'high' ? ` [${r.priority}]` : ''}`);
      if (list.length > 6) lines.push(`…and ${list.length - 6} more`);
      await notify({ ...ctx, db }, { userIds: [userId], event: 'tasks_today', channels: ['in_app', 'email'],
        params: { count: list.length, list: lines.join('\n') } });
    }
    await db.query('update task_digests set sent = $3 where tenant_id = $1 and day = $2', [ctx.tenant.id, today, byPerson.size]);
    return byPerson.size;
  });
}
