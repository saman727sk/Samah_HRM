/**
 * Help desk: an employee asks HR something and HR answers in a thread.
 *
 *   employee  opens requests, sees and replies to their own
 *   hr_admin  sees every request, replies, closes and reopens
 *
 * Status: open (waiting for HR) -> answered (HR replied, waiting for the employee) -> closed.
 * A reply from the employee puts it back to open, also after it was closed.
 * HR is notified of new requests and replies; the employee of HR's replies and of closing.
 */
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { isHr } from './access.js';
import { hrUserIds, notify, userOfEmployee } from './notifications.js';

export const CATEGORIES = ['payroll', 'leave', 'attendance', 'it', 'documents', 'other'];
const LABEL = { payroll: 'Salary & payslips', leave: 'Leave', attendance: 'Attendance', it: 'IT & access', documents: 'Letters & documents', other: 'Other' };

const clean = (s) => (typeof s === 'string' ? s.trim() : '');
const preview = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

async function ticketFor(ctx, id) {
  const t = await ctx.db.one(
    `select t.*, e.full_name as employee_name, e.employee_code, d.name as department from support_tickets t
       join employees e on e.id = t.employee_id left join departments d on d.id = e.department_id
      where t.tenant_id = $1 and t.id = $2`, [ctx.tenant.id, id]).catch(() => null);
  if (!t) throw notFound('Request');
  if (!isHr(ctx) && t.employee_id !== ctx.actor?.employeeId) throw notFound('Request');
  return t;
}

/** HR: everyone's requests (filter by status); others: their own. With counts per status. */
export async function listTickets(ctx, { status = null, q = null } = {}) {
  const mine = !isHr(ctx);
  if (mine && !ctx.actor?.employeeId) throw forbidden('Only employees can use the help desk.');
  const { rows } = await ctx.db.query(
    `select t.id, t.number, t.category, t.subject, t.status, t.created_at, t.last_message_at, t.employee_id,
            e.full_name as employee_name, e.employee_code,
            (select count(*)::int from support_messages m where m.ticket_id = t.id) as messages,
            (select m.from_hr from support_messages m where m.ticket_id = t.id order by m.created_at desc limit 1) as last_from_hr
       from support_tickets t join employees e on e.id = t.employee_id
      where t.tenant_id = $1 and ($2::uuid is null or t.employee_id = $2) and ($3::text is null or t.status = $3)
        and ($4::text is null or t.subject ilike '%' || $4 || '%' or e.full_name ilike '%' || $4 || '%' or t.number::text = $4)
      order by case t.status when 'open' then 0 when 'answered' then 1 else 2 end, t.last_message_at desc
      limit 500`, [ctx.tenant.id, mine ? ctx.actor.employeeId : null, status || null, clean(q) || null]);
  const { rows: counts } = await ctx.db.query(
    `select status, count(*)::int as n from support_tickets where tenant_id = $1 and ($2::uuid is null or employee_id = $2) group by status`,
    [ctx.tenant.id, mine ? ctx.actor.employeeId : null]);
  return { tickets: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), categories: CATEGORIES.map((c) => ({ value: c, label: LABEL[c] })) };
}

export async function getTicket(ctx, id) {
  const ticket = await ticketFor(ctx, id);
  const { rows: messages } = await ctx.db.query(
    `select m.id, m.body, m.from_hr, m.created_at, coalesce(e.full_name, case when m.from_hr then 'HR' else 'Employee' end) as author
       from support_messages m left join employees e on e.user_id = m.author_user_id and e.tenant_id = m.tenant_id
      where m.tenant_id = $1 and m.ticket_id = $2 order by m.created_at`, [ctx.tenant.id, id]);
  return { ...ticket, categoryLabel: LABEL[ticket.category], messages };
}

/** An employee opens a request (HR admins can ask too, for themselves). */
export async function openTicket(ctx, { category, subject, body } = {}) {
  if (!ctx.actor?.employeeId) throw forbidden('Only employees can use the help desk.');
  const errors = [];
  if (!CATEGORIES.includes(category)) errors.push('Choose what it is about.');
  if (clean(subject).length < 3) errors.push('Give it a short subject (at least 3 characters).');
  if (clean(subject).length > 150) errors.push('Keep the subject under 150 characters.');
  if (!clean(body)) errors.push('Write your question.');
  if (clean(body).length > 5000) errors.push('Keep the message under 5000 characters.');
  if (errors.length) throw badRequest('ticket_invalid', errors.join(' '), { details: { errors } });
  const ticket = await ctx.db.tx(async (db) => {
    const { n } = await db.one('select coalesce(max(number), 0) + 1 as n from support_tickets where tenant_id = $1', [ctx.tenant.id]);
    const t = await db.one(
      `insert into support_tickets (tenant_id, number, employee_id, category, subject, created_by) values ($1, $2, $3, $4, $5, $6) returning *`,
      [ctx.tenant.id, n, ctx.actor.employeeId, category, clean(subject), ctx.actor.userId]);
    await db.query(`insert into support_messages (tenant_id, ticket_id, author_user_id, from_hr, body) values ($1, $2, $3, false, $4)`,
      [ctx.tenant.id, t.id, ctx.actor.userId, clean(body)]);
    await audit(db, ctx, { action: 'helpdesk.opened', entityType: 'support_ticket', entityId: t.id, meta: { number: n, category } });
    return t;
  });
  const me = await ctx.db.one('select full_name from employees where id = $1', [ctx.actor.employeeId]);
  const hr = (await hrUserIds(ctx)).filter((u) => u !== ctx.actor.userId);
  await notify(ctx, { userIds: hr, event: 'ticket_new', channels: ['in_app', 'email'],
    params: { number: ticket.number, subject: ticket.subject, name: me.full_name, category: LABEL[category], ticketId: ticket.id } });
  return getTicket(ctx, ticket.id);
}

/** A reply: from HR it marks the request answered; from the employee it reopens it. */
export async function replyTicket(ctx, id, { body } = {}) {
  const ticket = await ticketFor(ctx, id);
  const text = clean(body);
  if (!text) throw badRequest('ticket_invalid', 'Write a reply.');
  if (text.length > 5000) throw badRequest('ticket_invalid', 'Keep the message under 5000 characters.');
  const fromHr = isHr(ctx) && ticket.employee_id !== ctx.actor.employeeId;
  await ctx.db.tx(async (db) => {
    await db.query(`insert into support_messages (tenant_id, ticket_id, author_user_id, from_hr, body) values ($1, $2, $3, $4, $5)`,
      [ctx.tenant.id, id, ctx.actor.userId, fromHr, text]);
    await db.query(`update support_tickets set status = $3, last_message_at = now(), closed_at = null where tenant_id = $1 and id = $2`,
      [ctx.tenant.id, id, fromHr ? 'answered' : 'open']);
  });
  const name = ctx.actor.employeeId ? (await ctx.db.one('select full_name from employees where id = $1', [ctx.actor.employeeId]))?.full_name : 'HR';
  const params = { number: ticket.number, subject: ticket.subject, name: name ?? 'HR', preview: preview(text), ticketId: id };
  if (fromHr) {
    const userId = await userOfEmployee(ctx, ticket.employee_id);
    if (userId) await notify(ctx, { userIds: [userId], event: 'ticket_reply', params, channels: ['in_app', 'email'] });
  } else {
    await notify(ctx, { userIds: (await hrUserIds(ctx)).filter((u) => u !== ctx.actor.userId), event: 'ticket_reply', params });
  }
  return getTicket(ctx, id);
}

/** Close (resolved) or reopen. HR can do both; the employee can close their own (e.g. "sorted, thanks"). */
export async function setTicketStatus(ctx, id, { status } = {}) {
  const ticket = await ticketFor(ctx, id);
  if (!['open', 'closed'].includes(status)) throw badRequest('ticket_invalid', 'Status must be open or closed.');
  if (status === ticket.status) return getTicket(ctx, id);
  await ctx.db.query(`update support_tickets set status = $3, closed_at = case when $3 = 'closed' then now() end where tenant_id = $1 and id = $2`,
    [ctx.tenant.id, id, status]);
  await audit(ctx.db, ctx, { action: `helpdesk.${status === 'closed' ? 'closed' : 'reopened'}`, entityType: 'support_ticket', entityId: id, meta: { number: ticket.number } });
  if (status === 'closed' && isHr(ctx) && ticket.employee_id !== ctx.actor.employeeId) {
    const userId = await userOfEmployee(ctx, ticket.employee_id);
    if (userId) await notify(ctx, { userIds: [userId], event: 'ticket_closed', params: { number: ticket.number, subject: ticket.subject, ticketId: id } });
  }
  return getTicket(ctx, id);
}

/** Requests waiting for HR (the sidebar badge). */
export async function openCount(ctx) {
  if (!isHr(ctx)) return { open: 0 };
  return ctx.db.one(`select count(*)::int as open from support_tickets where tenant_id = $1 and status = 'open'`, [ctx.tenant.id]);
}
