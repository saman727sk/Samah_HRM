/**
 * Daily tasks / work logs: what each person did today, how long it took,
 * whether it is done, in progress or blocked, with links and files.
 *
 * - Everyone logs their own work (never someone else's).
 * - Managers see their reporting line's logs; HR sees everyone's.
 * - A task marked blocked notifies the person's manager (or HR if none).
 * - Files (max 10 MB, PDF / Office / images / ZIP, checked by content)
 *   are stored as base64 in 512 KB chunks (see migration 018).
 */
import { audit } from '../lib/audit.js';
import { tenantToday } from '../lib/clock.js';
import { addDays, diffDays, isYmd } from '../lib/dates.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertCanView, isHr, isManager, isSystem, reportIds, requirePermission } from './access.js';
import { requireModule } from './features.js';
import { hrUserIds, notify, userOfEmployee } from './notifications.js';

export const TASK_STATUSES = ['completed', 'in_progress', 'blocked'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_TASK = 10;
const CHUNK_BYTES = 512 * 1024;
const MAX_RANGE_DAYS = 93;
const MAX_LINKS = 10;

const ZIP = (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
const OLE = (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
/** Allowed file types: extension -> [mime, does the content match?]. */
const FILE_TYPES = {
  pdf: ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  png: ['image/png', (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
  jpg: ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  jpeg: ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  gif: ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  webp: ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP],
  zip: ['application/zip', ZIP],
  doc: ['application/msword', OLE],
  xls: ['application/vnd.ms-excel', OLE],
};
export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

const myEmployeeId = (ctx) => {
  if (!ctx.actor?.employeeId) throw forbidden('Only employees can log tasks.');
  return ctx.actor.employeeId;
};

async function loadLog(ctx, id) {
  const row = await ctx.db.one('select * from work_logs where id = $1 and tenant_id = $2', [id, ctx.tenant.id])
    .catch((err) => { if (err.code === '22P02') return null; throw err; });
  if (!row) throw notFound('Task');
  return row;
}

const shape = (row, files = []) => ({ ...row, hours: Number(row.hours), files });

const assertOwner = (ctx, log) => {
  if (ctx.actor?.employeeId !== log.employee_id) throw forbidden('You can only change your own tasks.');
};

function cleanLinks(links) {
  if (links == null) return [];
  const list = (Array.isArray(links) ? links : String(links).split(/\s+/)).map((l) => String(l).trim()).filter(Boolean);
  if (list.length > MAX_LINKS) throw badRequest('task_invalid', `Add at most ${MAX_LINKS} links.`);
  for (const l of list) {
    let url;
    try { url = new URL(l); } catch { url = null; }
    if (!url || !['http:', 'https:'].includes(url.protocol) || l.length > 2000) {
      throw badRequest('task_invalid', `"${l.slice(0, 80)}" is not a web link (it must start with https:// or http://).`);
    }
  }
  return list;
}

/** Checks and normalises a task from a request (all fields; `before` fills the ones not sent on an edit). */
async function validate(ctx, input, employeeId, before = null) {
  const v = {
    work_date: input.workDate ?? before?.work_date,
    title: (input.title ?? before?.title ?? '').trim(),
    description: (input.description !== undefined ? input.description : before?.description)?.trim() || null,
    hours: Number(input.hours ?? before?.hours),
    status: input.status ?? before?.status ?? 'completed',
    blocker: (input.blocker !== undefined ? input.blocker : before?.blocker)?.trim() || null,
    links: input.links !== undefined ? cleanLinks(input.links) : (before?.links ?? []),
  };
  const errors = [];
  if (!isYmd(v.work_date)) errors.push('Choose the date.');
  else if (v.work_date > tenantToday(ctx)) errors.push("You can't log work for a future date.");
  if (!v.title) errors.push('Give the task a title.');
  if (v.title.length > 200) errors.push('Keep the title under 200 characters.');
  if (v.description && v.description.length > 5000) errors.push('Keep the description under 5000 characters.');
  if (!Number.isFinite(v.hours) || v.hours < 0 || v.hours > 24) errors.push('Hours must be between 0 and 24.');
  if (!TASK_STATUSES.includes(v.status)) errors.push(`Status must be one of: ${TASK_STATUSES.join(', ')}.`);
  if (v.status === 'blocked' && !v.blocker) errors.push('Say what is blocking you, so your manager can help.');
  if (v.status !== 'blocked') v.blocker = null;
  if (v.blocker && v.blocker.length > 2000) errors.push('Keep the blocker note under 2000 characters.');
  if (errors.length) throw badRequest('task_invalid', errors.join(' '), { details: { errors } });
  v.hours = Math.round(v.hours * 100) / 100;

  const employee = await ctx.db.one('select joining_date, exit_date from employees where id = $1 and tenant_id = $2', [employeeId, ctx.tenant.id]);
  if (v.work_date < employee.joining_date || (employee.exit_date && v.work_date > employee.exit_date)) {
    throw badRequest('task_invalid', 'That date is outside your employment dates.');
  }
  const { total } = await ctx.db.one(
    `select coalesce(sum(hours), 0)::float as total from work_logs
      where tenant_id = $1 and employee_id = $2 and work_date = $3 and ($4::uuid is null or id <> $4)`,
    [ctx.tenant.id, employeeId, v.work_date, before?.id ?? null]);
  if (total + v.hours > 24) {
    throw badRequest('task_invalid', `That makes more than 24 hours on ${v.work_date} (${total} h already logged).`);
  }
  return v;
}

async function notifyBlocked(ctx, log) {
  const employee = await ctx.db.one('select full_name, manager_id from employees where id = $1', [log.employee_id]);
  const manager = await userOfEmployee(ctx, employee.manager_id);
  await notify(ctx, { userIds: manager ? [manager] : await hrUserIds(ctx), event: 'task_blocked',
    params: { employeeName: employee.full_name, title: log.title, date: log.work_date, blocker: log.blocker } });
}

export async function createLog(ctx, input = {}) {
  await requireModule(ctx, 'tasks');
  const employeeId = myEmployeeId(ctx);
  const v = await validate(ctx, input, employeeId);
  const row = await ctx.db.one(
    `insert into work_logs (tenant_id, employee_id, work_date, title, description, hours, status, blocker, links)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [ctx.tenant.id, employeeId, v.work_date, v.title, v.description, v.hours, v.status, v.blocker, JSON.stringify(v.links)]);
  if (row.status === 'blocked') await notifyBlocked(ctx, row);
  return shape(row);
}

export async function updateLog(ctx, id, input = {}) {
  await requireModule(ctx, 'tasks');
  const before = await loadLog(ctx, id);
  assertOwner(ctx, before);
  const v = await validate(ctx, input, before.employee_id, before);
  const row = await ctx.db.one(
    `update work_logs set work_date = $3, title = $4, description = $5, hours = $6, status = $7, blocker = $8, links = $9, updated_at = now()
      where id = $1 and tenant_id = $2 returning *`,
    [id, ctx.tenant.id, v.work_date, v.title, v.description, v.hours, v.status, v.blocker, JSON.stringify(v.links)]);
  if (row.status === 'blocked' && (before.status !== 'blocked' || before.blocker !== row.blocker)) await notifyBlocked(ctx, row);
  return shape(row, (await filesOf(ctx, [id])).get(id) ?? []);
}

/** Owner, or HR (e.g. something posted by mistake). */
export async function deleteLog(ctx, id) {
  await requireModule(ctx, 'tasks');
  const log = await loadLog(ctx, id);
  if (!isHr(ctx)) assertOwner(ctx, log);
  await ctx.db.tx(async (db) => {
    await db.query('delete from work_logs where id = $1 and tenant_id = $2', [id, ctx.tenant.id]); // files + chunks cascade
    if (ctx.actor?.employeeId !== log.employee_id) {
      await audit(db, ctx, { action: 'task.deleted', entityType: 'work_log', entityId: id, oldValue: log });
    }
  });
}

async function filesOf(ctx, logIds) {
  const map = new Map();
  if (!logIds.length) return map;
  const { rows } = await ctx.db.query(
    `select id, work_log_id, file_name, mime, size_bytes, created_at from work_log_files
      where tenant_id = $1 and work_log_id = any($2::uuid[]) order by created_at`, [ctx.tenant.id, logIds]);
  for (const f of rows) {
    if (!map.has(f.work_log_id)) map.set(f.work_log_id, []);
    map.get(f.work_log_id).push(f);
  }
  return map;
}

/**
 * query: { scope: 'mine' | 'team' | 'all', employeeId?, from?, to?, status? }
 * team = everyone below a manager (HR: everyone else too); all = HR only.
 */
export async function listLogs(ctx, { scope = 'mine', employeeId, from, to, status } = {}) {
  await requireModule(ctx, 'tasks');
  const today = tenantToday(ctx);
  to ||= today;
  from ||= addDays(to, -6);
  if (!isYmd(from) || !isYmd(to) || to < from) throw badRequest('date_invalid', 'Choose a valid date range.');
  if (diffDays(from, to) >= MAX_RANGE_DAYS) throw badRequest('range_too_long', `Choose at most ${MAX_RANGE_DAYS} days.`);
  if (status && !TASK_STATUSES.includes(status)) throw badRequest('task_invalid', 'Unknown status.');
  let ids;
  if (employeeId) {
    await assertCanView(ctx, employeeId);
    ids = [employeeId];
  } else if (scope === 'all' || (scope === 'team' && (isHr(ctx) || isSystem(ctx)))) {
    if (!isHr(ctx) && !isSystem(ctx)) throw forbidden('Only HR can see everyone\'s tasks.');
    ids = null;
  } else if (scope === 'team') {
    if (!isManager(ctx) || !ctx.actor.employeeId) throw forbidden('Only managers can see team tasks.');
    requirePermission(ctx, 'team.tasks');
    ids = await reportIds(ctx, ctx.actor.employeeId);
    if (!ids.length) return { from, to, logs: [] };
  } else {
    ids = [myEmployeeId(ctx)];
  }
  const { rows } = await ctx.db.query(
    `select w.*, e.full_name as employee_name, e.employee_code, d.name as department_name
       from work_logs w join employees e on e.id = w.employee_id
       left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
      where w.tenant_id = $1 and ($2::uuid[] is null or w.employee_id = any($2)) and w.work_date between $3 and $4
        and ($5::text is null or w.status = $5)
      order by w.work_date desc, e.full_name, w.created_at desc limit 1000`,
    [ctx.tenant.id, ids, from, to, status ?? null]);
  const files = await filesOf(ctx, rows.map((r) => r.id));
  return { from, to, logs: rows.map((r) => shape(r, files.get(r.id) ?? [])) };
}

/** input: { fileName, dataUrl: 'data:...;base64,...' (or plain base64) } */
export async function addFile(ctx, logId, { fileName, dataUrl } = {}) {
  await requireModule(ctx, 'tasks');
  const log = await loadLog(ctx, logId);
  assertOwner(ctx, log);
  const name = String(fileName ?? '').replace(/[\\/\r\n"]/g, '_').trim().slice(0, 200);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const type = FILE_TYPES[ext];
  if (!name || !type) throw badRequest('file_invalid', `Allowed files: ${ALLOWED_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`);
  const b64 = typeof dataUrl === 'string' ? dataUrl.replace(/^data:[^,]*;base64,/, '') : '';
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('file_invalid', 'The file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw badRequest('file_too_big', 'Files must be 10 MB or smaller.');
  if (!type[1](buf)) throw badRequest('file_invalid', `This doesn't look like a real .${ext} file.`);
  const { n } = await ctx.db.one('select count(*)::int as n from work_log_files where work_log_id = $1', [logId]);
  if (n >= MAX_FILES_PER_TASK) throw conflict('too_many_files', `A task can have at most ${MAX_FILES_PER_TASK} files.`);
  const chunks = Math.ceil(buf.length / CHUNK_BYTES);
  return ctx.db.tx(async (db) => {
    const file = await db.one(
      `insert into work_log_files (tenant_id, work_log_id, file_name, mime, size_bytes, chunk_count, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, work_log_id, file_name, mime, size_bytes, created_at`,
      [ctx.tenant.id, logId, name, type[0], buf.length, chunks, ctx.actor?.userId ?? null]);
    for (let i = 0; i < chunks; i += 1) {
      await db.query('insert into work_log_file_chunks (tenant_id, file_id, seq, data) values ($1, $2, $3, $4)',
        [ctx.tenant.id, file.id, i, buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64')]);
    }
    return file;
  });
}

async function loadFile(ctx, fileId) {
  const f = await ctx.db.one(
    `select f.*, w.employee_id from work_log_files f join work_logs w on w.id = f.work_log_id where f.id = $1 and f.tenant_id = $2`,
    [fileId, ctx.tenant.id]).catch((err) => { if (err.code === '22P02') return null; throw err; });
  if (!f) throw notFound('File');
  return f;
}

/** Whoever can see the task can download its files. Returns { name, mime, buffer }. */
export async function getFile(ctx, fileId) {
  await requireModule(ctx, 'tasks');
  const f = await loadFile(ctx, fileId);
  await assertCanView(ctx, f.employee_id);
  const { rows } = await ctx.db.query('select data from work_log_file_chunks where file_id = $1 and tenant_id = $2 order by seq', [f.id, ctx.tenant.id]);
  if (rows.length !== f.chunk_count) throw notFound('File');
  return { name: f.file_name, mime: f.mime, buffer: Buffer.concat(rows.map((r) => Buffer.from(r.data, 'base64'))) };
}

export async function deleteFile(ctx, fileId) {
  await requireModule(ctx, 'tasks');
  const f = await loadFile(ctx, fileId);
  if (!isHr(ctx) && ctx.actor?.employeeId !== f.employee_id) throw forbidden('You can only remove files from your own tasks.');
  await ctx.db.query('delete from work_log_files where id = $1 and tenant_id = $2', [fileId, ctx.tenant.id]);
}
