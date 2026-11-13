/**
 * Demo company "Acme Technologies" for end-to-end demos and tests.
 * All logins use the password in DEMO_PASSWORD (default "Passw0rd!").
 */
import bcrypt from 'bcryptjs';
import { installGlobals, loadDefaults, provisionTenant, seedPublished } from '../src/services/tenants.js';
import { seedActivity } from './demo-activity.js';
import { identity } from '../src/auth/identity.js';
import { systemClock } from '../src/lib/clock.js';
import { addMonths, todayIn } from '../src/lib/dates.js';
import { setFlag } from '../src/services/features.js';
import { createRun, transitionRun } from '../src/services/payroll.js';
import { addStructure, createLoan, setPaymentDetails } from '../src/services/salary.js';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Passw0rd!';

const DEPARTMENTS = [['HR', 'Human Resources'], ['SALES', 'Sales'], ['ENG', 'Engineering'], ['FIN', 'Finance']];
const ROLES = [['HR_MGR', 'HR Manager'], ['HR_OFF', 'HR Officer'], ['SALES_MGR', 'Sales Manager'], ['SALES_EXEC', 'Sales Executive'],
  ['ENG_MGR', 'Engineering Manager'], ['SWE', 'Software Engineer'], ['QA', 'QA Engineer'], ['FIN_MGR', 'Finance Manager'], ['ACCT', 'Accountant']];
const LOCATIONS = [
  { code: 'LHR', name: 'Lahore HQ', address: 'Gulberg III, Lahore', lat: 31.5204, lng: 74.3587, radius_m: 150 },
  { code: 'KHI', name: 'Karachi Office', address: 'Shahrah-e-Faisal, Karachi', lat: 24.8607, lng: 67.0011, radius_m: 150 },
];
// code, name, email, access, dept, role, manager, joining, probation end, employment type, office
const EMPLOYEES = [
  ['E001', 'Sara Ahmed', 'hr@acme.test', 'hr_admin', 'HR', 'HR_MGR', null, '2019-04-01', null, 'PERM', 'LHR'],
  ['E002', 'Bilal Khan', 'bilal@acme.test', 'manager', 'SALES', 'SALES_MGR', null, '2018-07-15', null, 'PERM', 'LHR'],
  ['E003', 'Ali Raza', 'ali@acme.test', 'employee', 'SALES', 'SALES_EXEC', 'E002', '2022-02-01', null, 'PERM', 'LHR'],
  ['E004', 'Ayesha Siddiqui', 'ayesha@acme.test', 'employee', 'SALES', 'SALES_EXEC', 'E002', '2023-09-11', null, 'PERM', 'LHR'],
  ['E005', 'Usman Tariq', 'usman@acme.test', 'manager', 'ENG', 'ENG_MGR', null, '2017-01-09', null, 'PERM', 'LHR'],
  ['E006', 'Fatima Noor', 'fatima@acme.test', 'employee', 'ENG', 'SWE', 'E005', '2021-06-01', null, 'PERM', 'LHR'],
  ['E007', 'Hamza Malik', 'hamza@acme.test', 'employee', 'ENG', 'SWE', 'E005', '2026-02-02', '2026-07-31', 'PERM', 'LHR'],
  ['E008', 'Zainab Hussain', 'zainab@acme.test', 'employee', 'ENG', 'QA', 'E005', '2024-03-18', null, 'PERM', 'KHI'],
  ['E009', 'Omar Farooq', 'omar@acme.test', 'manager', 'FIN', 'FIN_MGR', null, '2020-10-05', null, 'PERM', 'LHR'],
  ['E010', 'Hira Javed', 'hira@acme.test', 'employee', 'FIN', 'ACCT', 'E009', '2025-01-06', null, 'PERM', 'LHR'],
  ['E011', 'Kamran Akhtar', 'kamran@acme.test', 'employee', 'ENG', 'SWE', 'E005', '2025-08-01', null, 'CONTRACT', 'KHI'],
  ['E012', 'Mehwish Iqbal', 'mehwish@acme.test', 'employee', 'HR', 'HR_OFF', 'E001', '2024-11-04', null, 'PERM', 'LHR'],
];

export async function seedDemo(db, { rounds = Number(process.env.BCRYPT_ROUNDS ?? 10), goLiveDate = '2026-01-01', slug = 'acme', withHistory = false } = {}) {
  const defaults = await loadDefaults();
  await installGlobals(db, defaults);
  // Local mode: one bcrypt hash for every demo login. Firebase mode: a Firebase account per login.
  const firebase = identity().name === 'firebase';
  const hash = firebase ? null : await bcrypt.hash(DEMO_PASSWORD, rounds);
  const account = async (email, displayName) =>
    (firebase ? identity().ensureAccount({ email, password: DEMO_PASSWORD, displayName }) : { passwordHash: hash, firebaseUid: null });

  // A real super admin already set up (own email and password): test data must not add a second
  // owner login with the well-known demo password, nor touch theirs.
  const realOwner = await db.one(
    `select id from users where access_level = 'super_admin' and lower(email) <> 'owner@hrm.test' order by created_at limit 1`);
  let superAdmin = realOwner;
  if (!realOwner) {
    const owner = await account('owner@hrm.test', 'SaaS owner');
    const existingOwner = await db.one(`select id from users where tenant_id is null and lower(email) = 'owner@hrm.test'`);
    superAdmin = existingOwner
      ? await db.one('update users set password_hash = $2, firebase_uid = $3 where id = $1 returning id', [existingOwner.id, owner.passwordHash, owner.firebaseUid])
      : await db.one(`insert into users (email, password_hash, firebase_uid, access_level) values ('owner@hrm.test', $1, $2, 'super_admin') returning id`,
        [owner.passwordHash, owner.firebaseUid]);
  }

  const { tenant, ids } = await provisionTenant(db, { name: 'Acme Technologies (Pvt) Ltd', slug, goLiveDate }, defaults);
  const ctx = { db, tenant, actor: { system: true } };
  let activity = null;
  const insertLookup = async (table, rows) => Object.fromEntries(await Promise.all(rows.map(async (r, i) => {
    const cols = Object.keys(r);
    const row = await db.one(`insert into ${table} (tenant_id, sort_order, ${cols.join(', ')})
      values ($1, $2, ${cols.map((_, j) => `$${j + 3}`).join(', ')}) returning id`, [tenant.id, i, ...cols.map((c) => r[c])]);
    return [r.code, row.id];
  })));
  const departments = await insertLookup('departments', DEPARTMENTS.map(([code, name]) => ({ code, name })));
  const roles = await insertLookup('roles', ROLES.map(([code, name]) => ({ code, name })));
  const locations = await insertLookup('locations', LOCATIONS);

  const employees = {};
  const users = {};
  for (const [code, name, email, access, dept, role, mgr, joining, probation, et, loc] of EMPLOYEES) {
    const login = slug === 'acme' ? email : email.replace('@', `+${slug}@`);
    const acc = await account(login, name);
    const user = await db.one('insert into users (tenant_id, email, password_hash, firebase_uid, access_level) values ($1, $2, $3, $4, $5) returning id',
      [tenant.id, login, acc.passwordHash, acc.firebaseUid, access]);
    users[code] = user.id;
    employees[code] = (await db.one(
      `insert into employees (tenant_id, user_id, employee_code, full_name, email, department_id, role_id, employment_type_id, manager_id,
                              shift_id, location_id, joining_date, probation_end_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [tenant.id, user.id, code, name, email, departments[dept], roles[role], ids.employmentTypes[et], mgr ? employees[mgr] : null,
        ids.shifts.GENERAL, locations[loc], joining, probation])).id;
  }

  // Scoped overrides showing the layering: Sales may WFH only Mon & Fri;
  // Engineering gets 3 days a week.
  await seedPublished(db, ctx, { key: 'wfh.policy', scopeType: 'department', scopeId: departments.SALES,
    value: { allowedWeekdays: [1, 5] }, effectiveFrom: goLiveDate });
  await seedPublished(db, ctx, { key: 'wfh.policy', scopeType: 'department', scopeId: departments.ENG,
    value: { maxPerWeek: 3, maxPerMonth: 12 }, effectiveFrom: goLiveDate });

  if (withHistory) {
    await seedHistory(db, tenant, { employees, users, leaveTypes: ids.leaveTypes });
    await setFlag(ctx, 'overtime', { enabled: true });
    await setFlag(ctx, 'loans', { enabled: true });
    activity = await seedActivity(db, tenant, { employees, users, leaveTypes: ids.leaveTypes });
    activity.payroll = await seedPayroll(db, tenant, { employees, goLiveDate, ids });
  }

  return { tenant, activity, superAdminId: superAdmin.id, departments, roles, locations, employees, users, ...ids };
}

/** A little approved leave history so balances aren't all untouched. */
async function seedHistory(db, tenant, { employees, users, leaveTypes }) {
  const history = [
    ['E006', 'ANNUAL', '2026-04-13', '2026-04-15', 3, 'Family trip'],
    ['E003', 'SICK', '2026-06-08', '2026-06-08', 1, 'Fever'],
    ['E004', 'CASUAL', '2026-07-20', '2026-07-21', 2, 'Personal work'],
    ['E010', 'ANNUAL', '2026-09-07', '2026-09-11', 5, 'Vacation'],
  ];
  for (const [emp, type, start, end, days, reason] of history) {
    const req = await db.one(
      `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, paid_days, status, reason,
                                   policy_snapshot, created_by, decided_by, decided_at)
       values ($1, $2, $3, $4, $5, $6, $6, 'approved', $7, $8, $9, $10, now()) returning id`,
      [tenant.id, employees[emp], leaveTypes[type], start, end, days, reason, { usageDays: days, seeded: true }, users[emp], users.E001]);
    await db.query(
      `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_date, kind, days, ref_type, ref_id, note)
       values ($1, $2, $3, 2026, $4, 'usage', $5, 'leave_request', $6, $7)`,
      [tenant.id, employees[emp], leaveTypes[type], start, -days, req.id, `Leave ${start} to ${end}`]);
  }
}

// Monthly basic salary (PKR); HRA is 45% and medical 10% of basic.
const BASIC = { E001: 220000, E002: 250000, E003: 110000, E004: 95000, E005: 300000, E006: 180000, E007: 120000,
  E008: 140000, E009: 260000, E010: 90000, E011: 150000, E012: 75000 };
const BANKS = [['Meezan Bank', 'MEZN'], ['HBL', 'HABB'], ['Standard Chartered', 'SCBL'], ['UBL', 'UNIL']];

/** A checksum-valid (but fictional) Pakistani IBAN. */
function demoIban(bankCode, n) {
  const account = String(1000000000000000 + n * 7919).padStart(16, '0');
  const numeric = `${bankCode}${account}PK00`.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + Number(d)) % 97;
  return `PK${String(98 - rem).padStart(2, '0')}${bankCode}${account}`;
}

/**
 * Salaries, bank details, one salary advance, contract staff excluded from
 * EOBI, and last month's payroll run and locked.
 */
async function seedPayroll(db, tenant, { employees, goLiveDate, ids }) {
  const clock = systemClock();
  const ctx = { db, tenant, clock, actor: { system: true }, locale: 'en' };
  for (const code of ['EOBI', 'EOBI_ER']) {
    await seedPublished(db, ctx, { key: 'payroll.component', subjectId: ids.salaryComponents[code], scopeType: 'employment_type',
      scopeId: ids.employmentTypes.CONTRACT, value: { enabled: false }, effectiveFrom: goLiveDate });
  }
  const codes = Object.keys(EMPLOYEES_BY_CODE);
  for (const [i, code] of codes.entries()) {
    const basic = BASIC[code];
    const joining = EMPLOYEES_BY_CODE[code].joining;
    await addStructure(ctx, employees[code], { effectiveFrom: joining > goLiveDate ? joining : goLiveDate,
      lines: { BASIC: basic, HRA: Math.round(basic * 0.45), MEDICAL: Math.round(basic * 0.1) }, note: 'Opening salary' });
    if (code === 'E011') continue; // leaves one "no bank details" warning to show
    const [bank, bankCode] = BANKS[i % BANKS.length];
    await setPaymentDetails(ctx, employees[code], { bankName: bank, accountTitle: EMPLOYEES_BY_CODE[code].name, iban: demoIban(bankCode, i + 1) });
  }
  const today = todayIn(tenant.timezone, clock.now());
  const lastMonth = addMonths(today, -1).slice(0, 7);
  await createLoan(ctx, { employeeId: employees.E010, kind: 'advance', principal: 30000, installmentAmount: 10000, startPeriod: lastMonth,
    note: 'Salary advance' });
  const run = await createRun(ctx, { period: lastMonth });
  for (const action of ['submit', 'approve', 'lock']) await transitionRun(ctx, run.id, action);
  return { lockedPeriod: lastMonth, payslips: run.payslips.length };
}

const EMPLOYEES_BY_CODE = Object.fromEntries(EMPLOYEES.map(([code, name, , , , , , joining]) => [code, { name, joining }]));
