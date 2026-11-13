import { identity } from '../auth/identity.js';
import { audit } from '../lib/audit.js';
import { isYmd } from '../lib/dates.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { validateCustomFields } from './customFields.js';
import { assertCanView, assertInTenant, isHr, isManager, isSystem, reportIds, requireHr } from './access.js';
import { assertWithinLimit } from './billing.js';

/** Reference columns and the tenant table each must point into. */
const REFERENCES = {
  department_id: ['departments', 'department'], role_id: ['roles', 'role'], employment_type_id: ['employment_types', 'employment type'],
  manager_id: ['employees', 'manager'], shift_id: ['shifts', 'shift'], location_id: ['locations', 'office location'],
  holiday_calendar_id: ['holiday_calendars', 'holiday calendar'],
};

async function assertReferences(ctx, data) {
  for (const [column, [table, label]] of Object.entries(REFERENCES)) {
    if (data[column]) await assertInTenant(ctx, table, data[column], label);
  }
}

const EDITABLE = ['employee_code', 'full_name', 'email', 'phone', 'department_id', 'role_id', 'employment_type_id', 'manager_id',
  'shift_id', 'location_id', 'holiday_calendar_id', 'joining_date', 'probation_end_date', 'exit_date', 'status', 'custom_fields'];

export async function getEmployee(ctx, id, { check = true } = {}) {
  if (check) await assertCanView(ctx, id);
  const e = await ctx.db.one('select * from employees where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!e) throw notFound('Employee');
  return e;
}

export async function listEmployees(ctx, { departmentId, status = 'active' } = {}) {
  let ids = null;
  if (!isHr(ctx) && !isSystem(ctx)) {
    ids = [ctx.actor.employeeId].filter(Boolean);
    if (isManager(ctx) && ctx.actor.employeeId) ids.push(...(await reportIds(ctx, ctx.actor.employeeId)));
  }
  const { rows } = await ctx.db.query(
    `select e.*, d.name as department_name, r.name as role_name, m.full_name as manager_name
       from employees e
       left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
       left join roles r on r.id = e.role_id and r.tenant_id = e.tenant_id
       left join employees m on m.id = e.manager_id and m.tenant_id = e.tenant_id
      where e.tenant_id = $1 and ($2::uuid[] is null or e.id = any($2)) and ($3::uuid is null or e.department_id = $3)
        and ($4::text is null or e.status = $4)
      order by e.full_name`, [ctx.tenant.id, ids, departmentId ?? null, status === 'all' ? null : status]);
  return rows;
}

/** Employees a setting scope applies to (used by previews / post-publish jobs). */
export async function employeesInScope(ctx, scopeType, scopeId) {
  const column = { company: null, department: 'department_id', employment_type: 'employment_type_id', role: 'role_id', employee: 'id' }[scopeType];
  const { rows } = await ctx.db.query(
    `select e.*, d.name as department_name from employees e left join departments d on d.id = e.department_id and d.tenant_id = e.tenant_id
      where e.tenant_id = $1 and e.status = 'active' ${column ? `and e.${column} = $2` : ''} order by e.full_name`,
    column ? [ctx.tenant.id, scopeId] : [ctx.tenant.id]);
  return rows;
}

/**
 * Next employee code, following the company's existing pattern: the most
 * used prefix with the highest number + 1, keeping the zero padding
 * (E012 -> E013, TX-0099 -> TX-0100). Starts at E001.
 */
export async function nextEmployeeCode(ctx, db = ctx.db) {
  const { rows } = await db.query('select employee_code from employees where tenant_id = $1', [ctx.tenant.id]);
  const groups = new Map();
  for (const { employee_code: code } of rows) {
    const m = /^(.*?)(\d+)$/.exec(code ?? '');
    if (!m) continue;
    const g = groups.get(m[1]) ?? { count: 0, max: 0, width: 0 };
    g.count += 1;
    g.max = Math.max(g.max, Number(m[2]));
    g.width = Math.max(g.width, m[2].length);
    groups.set(m[1], g);
  }
  if (!groups.size) return 'E001';
  const [prefix, g] = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || b[1].max - a[1].max)[0];
  const taken = new Set(rows.map((r) => r.employee_code));
  let n = g.max + 1;
  while (taken.has(`${prefix}${String(n).padStart(g.width, '0')}`)) n += 1;
  return `${prefix}${String(n).padStart(g.width, '0')}`;
}

function validateEmployee(e) {
  const errors = [];
  if (!e.full_name?.trim()) errors.push('Full name is required.');
  if (!e.employee_code?.trim()) errors.push('Employee code is required.');
  if (!isYmd(e.joining_date)) errors.push('Joining date must be a date.');
  if (e.probation_end_date && e.probation_end_date < e.joining_date) errors.push('Probation end cannot be before the joining date.');
  if (e.exit_date && e.exit_date < e.joining_date) errors.push('Exit date cannot be before the joining date.');
  if (errors.length) throw badRequest('employee_invalid', errors.join(' '), { details: { errors } });
}

const LOGIN_LEVELS = ['employee', 'manager', 'hr_admin'];

/**
 * Creates the sign-in account for an employee: a bcrypt hash locally, or a
 * Firebase Authentication user (the password never touches our database).
 * `created` collects Firebase UIDs so they can be removed if the transaction fails.
 * `existing` ({ passwordHash, firebaseUid }) is an account made earlier (verified sign-up).
 */
async function createLogin(db, ctx, { email, password, accessLevel = 'employee' }, displayName, created, existing = null) {
  if (!email?.includes('@')) throw badRequest('login_invalid', 'Enter a valid email for the login.');
  if (!existing && (!password || password.length < 8)) throw badRequest('login_invalid', 'The password must be at least 8 characters.');
  if (!LOGIN_LEVELS.includes(accessLevel)) throw badRequest('login_invalid', `Access level must be one of: ${LOGIN_LEVELS.join(', ')}.`);
  if (accessLevel === 'hr_admin') await assertWithinLimit({ ...ctx, db }, 'admins');
  await assertEmailFree(db, email, ctx.tenant.id);
  const account = existing ?? await identity().createAccount({ email: email.toLowerCase(), password, displayName });
  if (account.firebaseUid && !existing) created.push(account.firebaseUid);
  try {
    return await db.one('insert into users (tenant_id, email, password_hash, firebase_uid, access_level) values ($1, $2, $3, $4, $5) returning id',
      [ctx.tenant.id, email.toLowerCase(), account.passwordHash, account.firebaseUid, accessLevel]);
  } catch (err) {
    if (err.code === '23505') throw conflict('login_exists', 'This company already has a login with this email.');
    throw err;
  }
}

/**
 * Which emails can't get a login in `tenantId`: one already used in that
 * company, or a super admin's (the software owner signs in without choosing
 * a company). Other companies may use the same email: each is a separate
 * account with its own password. Firebase mode has one Firebase account per
 * email, so there an email can belong to one login only.
 */
export async function emailTaken(db, email, tenantId) {
  const row = await db.one(
    `select bool_or(tenant_id = $2) as company, bool_or(access_level = 'super_admin') as owner, count(*)::int as n
       from users where lower(email) = lower($1)`, [email, tenantId ?? null]);
  if (row.company) return 'company';
  if (row.owner) return 'owner';
  if (identity().name === 'firebase' && row.n > 0) return 'firebase';
  return null;
}

export async function assertEmailFree(db, email, tenantId) {
  const taken = await emailTaken(db, email, tenantId);
  if (taken) {
    throw conflict('login_exists', {
      company: 'This company already has a login with this email.',
      owner: 'This email is reserved for the platform owner. Use another email.',
      firebase: 'A login with this email already exists (with Firebase sign-in an email can have one login only).',
    }[taken]);
  }
}

/** `account`: internal only (never from a request body), see createLogin. */
export async function createEmployee(ctx, input, { account = null } = {}) {
  requireHr(ctx);
  const data = Object.fromEntries(EDITABLE.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  if (!data.employee_code?.trim()) data.employee_code = await nextEmployeeCode(ctx); // left empty: generate it
  validateEmployee(data);
  await assertReferences(ctx, data);
  if ((data.status ?? 'active') === 'active') await assertWithinLimit(ctx, 'employees');
  await validateCustomFields(ctx, 'employee', data.custom_fields);
  const createdUids = [];
  return ctx.db.tx(async (db) => {
    if (input.login) data.user_id = (await createLogin(db, ctx, input.login, data.full_name, createdUids, account)).id;
    const cols = Object.keys(data);
    let row;
    try {
      row = await db.one(
        `insert into employees (tenant_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
        [ctx.tenant.id, ...cols.map((c) => data[c])]);
    } catch (err) {
      if (err.code === '23505') throw conflict('duplicate', 'An employee with this code already exists.');
      throw err;
    }
    await audit(db, ctx, { action: 'employee.created', entityType: 'employee', entityId: row.id, newValue: row, meta: { login: !!input.login } });
    return row;
  }).catch(async (err) => {
    for (const uid of createdUids) await identity().removeAccount(uid); // don't leave an orphan Firebase user
    throw err;
  });
}

export async function updateEmployee(ctx, id, input) {
  requireHr(ctx);
  const before = await getEmployee(ctx, id);
  const data = Object.fromEntries(EDITABLE.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  validateEmployee({ ...before, ...data });
  await assertReferences(ctx, data);
  if (data.status === 'active' && before.status !== 'active') await assertWithinLimit(ctx, 'employees');
  if (data.custom_fields) await validateCustomFields(ctx, 'employee', data.custom_fields);
  if (data.manager_id === id) throw badRequest('employee_invalid', 'An employee cannot be their own manager.');
  if (data.manager_id && (await reportIds(ctx, id)).includes(data.manager_id)) {
    throw badRequest('employee_invalid', 'That person reports to this employee, so they cannot be their manager (it would create a loop).');
  }
  const cols = Object.keys(data);
  if (!cols.length) return before;
  return ctx.db.tx(async (db) => {
    const row = await db.one(
      `update employees set ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now()
        where id = $1 and tenant_id = $2 returning *`, [id, ctx.tenant.id, ...cols.map((c) => data[c])]);
    // Deactivating / exiting an employee also disables their sign-in.
    if (row.user_id && data.status) {
      const u = await db.one('update users set is_active = $2 where id = $1 and tenant_id = $3 returning firebase_uid',
        [row.user_id, row.status === 'active', ctx.tenant.id]);
      await identity().setDisabled(u?.firebase_uid, row.status !== 'active');
    }
    await audit(db, ctx, { action: 'employee.updated', entityType: 'employee', entityId: id, oldValue: before, newValue: row });
    return row;
  });
}
