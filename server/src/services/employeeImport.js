/**
 * Bulk import of employees from a CSV file (People > Import).
 *
 *   - Column names are matched loosely ("Designation", "Job title" and "Role" all mean the role;
 *     "DOJ" and "Date of joining" the joining date...), so most existing spreadsheets work as they are.
 *   - Department, role, employment type, shift and office are matched by name or code; missing
 *     ones can be created. The manager is matched by employee code, email or (unique) name.
 *   - A row whose employee code already exists updates that employee (only the filled-in cells);
 *     otherwise a new employee is added. Every row goes through the normal createEmployee /
 *     updateEmployee checks, plan limits included.
 *   - dryRun (the preview) runs the whole import inside a transaction and rolls it back, so what
 *     it reports is exactly what the real import does. Rows with problems are skipped, never half-saved.
 *   - Optional logins: rows with an email (and "Login" = yes, or the "logins for everyone" option)
 *     get a sign-in; each person is emailed a link to choose their own password (valid 7 days).
 */
import { createHash, randomBytes } from 'node:crypto';
import { identity } from '../auth/identity.js';
import { audit } from '../lib/audit.js';
import { parseCsv } from '../lib/csv.js';
import { AppError, badRequest } from '../lib/errors.js';
import { PRODUCT_NAME } from '../lib/product.js';
import { requireHr } from './access.js';
import { createEmployee, updateEmployee } from './employees.js';
import { createLookup } from './lookups.js';

export const MAX_ROWS = 5000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Column → the header spellings it accepts (compared lowercase, letters and digits only). */
const COLUMNS = {
  employee_code: ['employeecode', 'code', 'empcode', 'employeeid', 'empid', 'employeeno', 'empno', 'employeenumber', 'staffid', 'staffno', 'id'],
  full_name: ['fullname', 'name', 'employeename', 'empname', 'staffname'],
  first_name: ['firstname', 'givenname'],
  last_name: ['lastname', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'workemail', 'officialemail', 'officeemail', 'mail', 'emailid'],
  phone: ['phone', 'mobile', 'phoneno', 'mobileno', 'phonenumber', 'mobilenumber', 'contact', 'contactno', 'contactnumber', 'cell', 'cellno'],
  department: ['department', 'dept', 'departmentname', 'division'],
  role: ['role', 'designation', 'jobtitle', 'title', 'position', 'jobrole', 'post'],
  employment_type: ['employmenttype', 'type', 'contracttype', 'employeetype', 'jobtype'],
  manager: ['manager', 'reportsto', 'linemanager', 'supervisor', 'managercode', 'manageremail', 'managername', 'reportingmanager', 'reportingto'],
  joining_date: ['joiningdate', 'dateofjoining', 'doj', 'joindate', 'hiredate', 'startdate', 'datejoined', 'joined', 'joining'],
  probation_end_date: ['probationend', 'probationenddate', 'probationenddate', 'probationends', 'confirmationdate'],
  exit_date: ['exitdate', 'leavingdate', 'dateofleaving', 'lastworkingday', 'lastworkingdate', 'resignationdate'],
  status: ['status', 'employmentstatus', 'employeestatus'],
  shift: ['shift', 'shiftname', 'shiftcode'],
  location: ['location', 'office', 'branch', 'worklocation', 'officelocation'],
  login: ['login', 'createlogin', 'signin', 'appaccess', 'access'],
  access_level: ['accesslevel', 'accessrole', 'permission', 'permissions', 'userrole', 'systemrole'],
};
const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS = new Map(Object.entries(COLUMNS).flatMap(([col, names]) => names.map((n) => [n, col])));

/** The columns of the downloadable template, in order. */
export const TEMPLATE_HEADER = ['Employee code', 'Full name', 'Email', 'Phone', 'Department', 'Role', 'Employment type', 'Manager',
  'Joining date', 'Probation end date', 'Status', 'Shift', 'Office', 'Login', 'Access level'];

const LEVEL_LABEL = { employee: 'Employee', manager: 'Manager', hr_admin: 'HR admin' };
const STATUS_LABEL = { active: 'Active', inactive: 'Inactive', exited: 'Exited' };

/**
 * Every employee as CSV rows in the import template's columns (plus Exit date), so the file can be
 * edited in a spreadsheet and imported back: the employee code matches each row to its person.
 * status: 'active' (default) or 'all'. The download is recorded in the audit log (it holds personal data).
 */
export async function exportEmployees(ctx, { status = 'active' } = {}) {
  requireHr(ctx);
  const { rows } = await ctx.db.query(
    `select e.employee_code, e.full_name, coalesce(e.email, u.email) as email, e.phone, d.name as department, r.name as role,
            et.name as employment_type, m.employee_code as manager, e.joining_date, e.probation_end_date, e.status,
            s.name as shift, l.name as office, u.id is not null as has_login, u.access_level, e.exit_date
       from employees e
       left join departments d on d.id = e.department_id left join roles r on r.id = e.role_id
       left join employment_types et on et.id = e.employment_type_id left join employees m on m.id = e.manager_id
       left join shifts s on s.id = e.shift_id left join locations l on l.id = e.location_id left join users u on u.id = e.user_id
      where e.tenant_id = $1 ${status === 'all' ? '' : `and e.status = 'active'`}
      order by e.employee_code`, [ctx.tenant.id]);
  await audit(ctx.db, ctx, { action: 'employees.exported', entityType: 'employee', entityId: null, meta: { count: rows.length, status } });
  return {
    header: [...TEMPLATE_HEADER, 'Exit date'],
    rows: rows.map((e) => [e.employee_code, e.full_name, e.email, e.phone, e.department, e.role, e.employment_type, e.manager,
      e.joining_date, e.probation_end_date, STATUS_LABEL[e.status] ?? e.status, e.shift, e.office, e.has_login ? 'Yes' : 'No',
      e.has_login ? LEVEL_LABEL[e.access_level] ?? e.access_level : '', e.exit_date]),
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
};
const fullYear = (y) => (y < 100 ? (y >= 50 ? 1900 + y : 2000 + y) : y);

/**
 * A date as people type it: 2024-03-15, 15/03/2024, 15-03-24, 15.03.2024, 15 Mar 2024, Mar 15, 2024,
 * 15-Mar-2024, or an Excel date number. Day comes first in 01/02/2024 (as in Pakistan) unless that
 * is impossible (03/15/2024). Returns 'YYYY-MM-DD' or null.
 */
export function parseDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], fullYear(+m[3])];
    return b > 12 && a <= 12 ? ymd(y, a, b) : ymd(y, b, a);
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{2,4})$/);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return ymd(fullYear(+m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return ymd(fullYear(+m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) { // Excel serial day number
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5).toISOString().slice(0, 10);
  }
  return null;
}

const STATUS = { active: 'active', working: 'active', current: 'active', yes: 'active', inactive: 'inactive', suspended: 'inactive', onhold: 'inactive',
  exited: 'exited', left: 'exited', resigned: 'exited', terminated: 'exited', exit: 'exited' };
const LEVEL = { employee: 'employee', staff: 'employee', manager: 'manager', hr: 'hr_admin', hradmin: 'hr_admin', admin: 'hr_admin', hr_admin: 'hr_admin' };
const yes = (v) => /^(y|yes|true|1|x|✓)$/i.test(String(v ?? '').trim());

/** Lookup lists matched by name or code, lowercase. */
const LISTS = [['department', 'departments', 'departments', 'department_id', 'Department'], ['role', 'roles', 'roles', 'role_id', 'Role'],
  ['employment_type', 'employment_types', 'employment-types', 'employment_type_id', 'Employment type'],
  ['shift', 'shifts', 'shifts', 'shift_id', 'Shift'], ['location', 'locations', 'locations', 'location_id', 'Office']];
const CREATABLE = new Set(['department', 'role', 'employment_type']);

class DryRun extends Error {}

/**
 * input: { csv, dryRun = true, createMissing = true, loginsForAll = false, sendInvites = true }
 * ctx: request context + mailer, appUrl
 */
export async function importEmployees(ctx, { csv, dryRun = true, createMissing = true, loginsForAll = false, sendInvites = true } = {}) {
  requireHr(ctx);
  if (typeof csv !== 'string' || !csv.trim()) throw badRequest('import_empty', 'Choose a CSV file with a header row and at least one employee.');
  const table = parseCsv(csv);
  if (table.length < 2) throw badRequest('import_empty', 'The file needs a header row and at least one employee row.');
  const [header, ...lines] = table;
  if (lines.length > MAX_ROWS) throw badRequest('import_too_big', `At most ${MAX_ROWS} employees per file. Split the file and import each part.`);
  const colOf = header.map((h) => ALIAS.get(norm(h)) ?? null);
  const ignored = header.filter((h, i) => h && !colOf[i]);
  const has = (c) => colOf.includes(c);
  if (!has('full_name') && !has('first_name')) {
    throw badRequest('import_no_name', `No name column found. Name one column "Full name" (found: ${header.filter(Boolean).join(', ')}).`);
  }
  const records = lines.map((cells, i) => {
    const r = { line: i + 2 };
    // Our exports put ' before cells starting with = + - @ (so spreadsheets don't run them as formulas): drop it again.
    colOf.forEach((c, j) => { if (c && cells[j] != null && cells[j] !== '' && r[c] == null) r[c] = cells[j].replace(/^'(?=[=+\-@])/, ''); });
    if (!r.full_name && (r.first_name || r.last_name)) r.full_name = [r.first_name, r.last_name].filter(Boolean).join(' ');
    return r;
  });

  const result = { dryRun, total: records.length, added: 0, updated: 0, failed: 0, logins: 0, rows: [], ignoredColumns: ignored,
    columns: header.map((h, i) => ({ header: h, field: colOf[i] })), created: {}, invitesSent: 0, invitesFailed: 0 };
  const invites = [];
  const run = async (db) => {
    const c = { ...ctx, db };
    // Lookup lists by lowercase name and code
    const lists = {};
    for (const [field, tbl] of LISTS) {
      const { rows } = await db.query(`select id, code, name from ${tbl} where tenant_id = $1`, [ctx.tenant.id]);
      lists[field] = new Map(rows.flatMap((r) => [[r.name.toLowerCase(), r.id], ...(r.code ? [[r.code.toLowerCase(), r.id]] : [])]));
    }
    let madeThisRow = [];
    const resolve = async (field, value, notes) => {
      if (!value) return undefined;
      const key = value.toLowerCase();
      if (lists[field].has(key)) return lists[field].get(key);
      const [, tbl, entity, , label] = LISTS.find((l) => l[0] === field);
      if (!createMissing || !CREATABLE.has(field)) throw badRequest('import_unknown', `${label} "${value}" doesn't exist. Add it under Settings > Lists & offices first.`);
      const base = value.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'ITEM';
      let code = base;
      for (let n = 2; (await db.one(`select 1 from ${tbl} where tenant_id = $1 and lower(code) = lower($2)`, [ctx.tenant.id, code])); n++) code = `${base}-${n}`;
      const row = await createLookup(c, entity, { code, name: value.trim() });
      lists[field].set(key, row.id);
      madeThisRow.push([field, key, value.trim()]);
      notes.push(`New ${label.toLowerCase()} "${value.trim()}" added`);
      return row.id;
    };

    const seen = new Set();
    const managerJobs = [];
    for (const r of records) {
      const out = { line: r.line, code: r.employee_code ?? null, name: r.full_name ?? null, notes: [] };
      madeThisRow = [];
      await db.query('savepoint import_row');
      try {
        if (!r.full_name) throw badRequest('import_row', 'Name is empty.');
        if (r.employee_code) {
          if (seen.has(r.employee_code.toLowerCase())) throw badRequest('import_row', `Employee code ${r.employee_code} appears twice in the file.`);
          seen.add(r.employee_code.toLowerCase());
        }
        if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) throw badRequest('import_row', `"${r.email}" is not a valid email.`);
        const input = { full_name: r.full_name.replace(/\s+/g, ' ') };
        if (r.employee_code) input.employee_code = r.employee_code;
        if (r.email) input.email = r.email.toLowerCase();
        if (r.phone) input.phone = r.phone;
        for (const [field, key] of [['joining_date', 'joining_date'], ['probation_end_date', 'probation_end_date'], ['exit_date', 'exit_date']]) {
          if (!r[field]) continue;
          const d = parseDate(r[field]);
          if (!d) throw badRequest('import_row', `"${r[field]}" is not a date I can read (use e.g. 15/03/2024 or 2024-03-15).`);
          input[key] = d;
        }
        if (r.status) {
          const st = STATUS[norm(r.status)];
          if (!st) throw badRequest('import_row', `Status "${r.status}" should be Active, Inactive or Exited.`);
          input.status = st;
        }
        for (const [field, , , column] of LISTS) {
          const id = await resolve(field, r[field], out.notes);
          if (id) input[column] = id;
        }
        const existing = r.employee_code
          ? await db.one('select id, user_id from employees where tenant_id = $1 and lower(employee_code) = lower($2)', [ctx.tenant.id, r.employee_code])
          : null;
        let emp;
        if (existing) {
          emp = await updateEmployee(c, existing.id, input);
          out.action = 'updated';
          result.updated += 1;
        } else {
          if (!input.joining_date) {
            input.joining_date = ctx.tenant.go_live_date;
            out.notes.push(`No joining date: ${ctx.tenant.go_live_date} (company start) used`);
          }
          const wantsLogin = r.email && (loginsForAll || yes(r.login));
          if (wantsLogin) {
            const level = r.access_level ? LEVEL[norm(r.access_level)] : 'employee';
            if (!level) throw badRequest('import_row', `Access level "${r.access_level}" should be Employee, Manager or HR admin.`);
            input.login = { email: input.email, password: randomBytes(18).toString('base64url'), accessLevel: level };
          }
          emp = await createEmployee(c, input);
          out.action = 'added';
          result.added += 1;
          if (wantsLogin) {
            result.logins += 1;
            out.notes.push('Login created');
            const u = await db.one('select id, email, password_hash from users where id = $1', [emp.user_id]);
            if (u.password_hash && sendInvites) {
              const token = randomBytes(32).toString('base64url');
              await db.query('insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, $3)',
                [u.id, createHash('sha256').update(token).digest('hex'), new Date(ctx.clock.now().getTime() + INVITE_TTL_MS)]);
              invites.push({ email: u.email, name: emp.full_name, token });
            } else if (!u.password_hash) {
              out.notes.push('They set their password with "Forgot password" on the sign-in page');
            }
          }
        }
        out.code = emp.employee_code;
        if (r.manager) managerJobs.push({ id: emp.id, manager: r.manager, out });
        await db.query('release savepoint import_row');
        for (const [field, , name] of madeThisRow) (result.created[field] ??= []).push(name);
      } catch (err) {
        await db.query('rollback to savepoint import_row');
        if (!(err instanceof AppError)) throw err;
        // Lists this row added were rolled back with it: forget them, so later rows don't point at them.
        for (const [field, key] of madeThisRow) lists[field].delete(key);
        out.action = 'failed';
        out.error = err.message;
        out.notes = [];
        result.failed += 1;
      }
      result.rows.push(out);
    }

    // Managers last, so a manager further down the file is found too.
    for (const job of managerJobs) {
      await db.query('savepoint import_row');
      try {
        const v = job.manager.trim();
        let { rows } = await db.query('select id from employees where tenant_id = $1 and lower(employee_code) = lower($2)', [ctx.tenant.id, v]);
        if (!rows.length) ({ rows } = await db.query('select id from employees where tenant_id = $1 and lower(email) = lower($2)', [ctx.tenant.id, v]));
        if (!rows.length) ({ rows } = await db.query(`select id from employees where tenant_id = $1 and lower(full_name) = lower($2) and status <> 'exited'`, [ctx.tenant.id, v.replace(/\s+/g, ' ')]));
        if (rows.length !== 1) throw badRequest('import_row', rows.length ? `Manager "${v}" matches ${rows.length} people; use their employee code.` : `Manager "${v}" not found.`);
        await updateEmployee(c, job.id, { manager_id: rows[0].id });
        await db.query('release savepoint import_row');
      } catch (err) {
        await db.query('rollback to savepoint import_row');
        if (!(err instanceof AppError)) throw err;
        job.out.notes.push(`Manager not set: ${err.message}`);
      }
    }
    await audit(db, c, { action: 'employees.imported', entityType: 'employee', entityId: null,
      meta: { added: result.added, updated: result.updated, failed: result.failed, logins: result.logins } });
    if (dryRun) throw new DryRun();
  };

  try {
    await ctx.db.tx(run);
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }

  // Emails go out only after the import is saved.
  if (!dryRun && invites.length) {
    for (const inv of invites) {
      try {
        await ctx.mailer.send({ to: inv.email, subject: `Your ${PRODUCT_NAME} account at ${ctx.tenant.name}`,
          text: `Hello ${inv.name},\n\n${ctx.tenant.name} has added you to ${PRODUCT_NAME}, where you check in, apply for leave and see your payslips.\n\n` +
            `Open this link to choose your password:\n\n${ctx.appUrl}/#/reset?token=${inv.token}\n\n` +
            `The link works once and expires in 7 days. After that, use "Forgot password" on the sign-in page with ${inv.email}.\n\n${PRODUCT_NAME}` });
        result.invitesSent += 1;
      } catch {
        result.invitesFailed += 1;
      }
    }
  }
  return result;
}

