/**
 * Salary data: effective-dated salary structures, bank details and loans.
 * HR only (an employee sees their own figures on their payslips).
 *
 * Guardrail shared by everything here: nothing may change inside an
 * approved or locked payroll period. A revision for a past month that is
 * already paid goes in from the next open month instead.
 */
import { audit } from '../lib/audit.js';
import { addDays, isYmd, monthEnd } from '../lib/dates.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { round2 } from '../lib/util.js';
import { isHr, requirePermission } from './access.js';

/** HR, or payroll staff (people HR gave the "payroll" right). */
const requireHr = (ctx) => requirePermission(ctx, 'payroll');
/** Payroll staff who are not HR can't change their own pay, bank details or loans. */
function notOwnPay(ctx, employeeId) {
  if (!isHr(ctx) && employeeId && employeeId === ctx.actor?.employeeId) {
    throw forbidden("You can't change your own salary, bank details or loans. Ask HR.");
  }
}
import { getEmployee } from './employees.js';
import { isEnabled, requireModule } from './features.js';

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const nextPeriod = (key) => addDays(monthEnd(`${key}-01`), 1).slice(0, 7);

/** The last day covered by an approved or locked payroll (null if none). */
export async function frozenUntil(ctx) {
  const row = await ctx.db.one(
    `select max(period_end) as until from payroll_runs where tenant_id = $1 and status in ('approved', 'locked')`, [ctx.tenant.id]);
  return row?.until ?? null;
}

async function assertAfterFrozen(ctx, date, what) {
  const until = await frozenUntil(ctx);
  if (until && date <= until) {
    throw conflict('payroll_locked', `${what} can't start on ${date}: payroll up to ${until} is already approved or locked. Choose ${addDays(until, 1)} or later.`,
      { params: { after: until } });
  }
}

// ---------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------
async function structuresWithLines(ctx, employeeId, { from, to } = {}) {
  const { rows } = await ctx.db.query(
    `select s.id, s.effective_from, s.effective_to, s.note, s.created_at,
            coalesce(json_agg(json_build_object('componentId', c.id, 'code', c.code, 'name', c.name, 'kind', c.kind, 'amount', l.amount)
                       order by c.sort_order) filter (where l.id is not null), '[]') as lines
       from salary_structures s
       left join salary_structure_lines l on l.structure_id = s.id
       left join salary_components c on c.id = l.component_id
      where s.tenant_id = $1 and s.employee_id = $2
        and ($3::date is null or s.effective_to is null or s.effective_to >= $3)
        and ($4::date is null or s.effective_from <= $4)
      group by s.id order by s.effective_from`, [ctx.tenant.id, employeeId, from ?? null, to ?? null]);
  return rows.map((r) => ({ ...r, lines: r.lines.map((l) => ({ ...l, amount: Number(l.amount) })) }));
}

/** Structures overlapping a date range (used by the payroll engine). */
export const structuresBetween = (ctx, employeeId, from, to) => structuresWithLines(ctx, employeeId, { from, to });

export async function salaryOf(ctx, employeeId) {
  requireHr(ctx);
  const employee = await getEmployee(ctx, employeeId);
  return {
    employee: { id: employee.id, name: employee.full_name, code: employee.employee_code, joiningDate: employee.joining_date },
    structures: (await structuresWithLines(ctx, employee.id)).reverse(),
    payment: await paymentDetails(ctx, employee.id),
    loans: await listLoans(ctx, { employeeId: employee.id }),
    frozenUntil: await frozenUntil(ctx),
  };
}

/**
 * Adds a salary revision from `effectiveFrom`; the running structure is
 * closed the day before. lines: { CODE: amount } (or [{ componentId, amount }]).
 */
export async function addStructure(ctx, employeeId, { effectiveFrom, lines, note = null }) {
  requireHr(ctx);
  notOwnPay(ctx, employeeId);
  await requireModule(ctx, 'payroll');
  const employee = await getEmployee(ctx, employeeId);
  if (!isYmd(effectiveFrom)) throw badRequest('date_invalid', 'Effective date must be a date like 2026-04-01.');
  if (effectiveFrom < employee.joining_date) throw badRequest('before_joining', `The salary can't start before the joining date (${employee.joining_date}).`);
  await assertAfterFrozen(ctx, effectiveFrom, 'A salary revision');

  const { rows: components } = await ctx.db.query('select id, code, name, is_active from salary_components where tenant_id = $1', [ctx.tenant.id]);
  const entries = Array.isArray(lines) ? lines.map((l) => [l.componentId, l.amount]) : Object.entries(lines ?? {});
  const parsed = [];
  const errors = [];
  for (const [ref, amount] of entries) {
    const c = components.find((x) => x.id === ref || x.code === ref);
    if (!c) { errors.push(`Unknown salary component "${ref}".`); continue; }
    if (!c.is_active) errors.push(`${c.name} is disabled.`);
    if (amount == null || amount === '') continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) { errors.push(`${c.name}: enter an amount of 0 or more.`); continue; }
    parsed.push({ componentId: c.id, amount: round2(amount) });
  }
  if (!parsed.length && !errors.length) errors.push('Enter at least one amount.');
  if (errors.length) throw badRequest('salary_invalid', errors.join(' '), { details: { errors } });

  const id = await ctx.db.tx(async (db) => {
    const later = await db.one('select effective_from from salary_structures where employee_id = $1 and effective_from > $2 order by effective_from limit 1',
      [employee.id, effectiveFrom]);
    if (later) throw conflict('later_revision_exists', `A later salary revision starts on ${later.effective_from}. Remove it first or choose a later date.`);
    const same = await db.one('select id from salary_structures where employee_id = $1 and effective_from = $2', [employee.id, effectiveFrom]);
    let structureId = same?.id;
    if (same) {
      await db.query('delete from salary_structure_lines where structure_id = $1', [same.id]);
      await db.query('update salary_structures set note = $2 where id = $1', [same.id, note]);
    } else {
      await db.query(`update salary_structures set effective_to = $3 where employee_id = $1 and effective_from < $2
                        and (effective_to is null or effective_to >= $2)`, [employee.id, effectiveFrom, addDays(effectiveFrom, -1)]);
      structureId = (await db.one(
        `insert into salary_structures (tenant_id, employee_id, effective_from, note, created_by) values ($1, $2, $3, $4, $5) returning id`,
        [ctx.tenant.id, employee.id, effectiveFrom, note, ctx.actor?.userId ?? null])).id;
    }
    for (const l of parsed) {
      await db.query('insert into salary_structure_lines (tenant_id, structure_id, component_id, amount) values ($1, $2, $3, $4)',
        [ctx.tenant.id, structureId, l.componentId, l.amount]);
    }
    await audit(db, ctx, { action: 'salary.revised', entityType: 'employee', entityId: employee.id,
      newValue: { effectiveFrom, lines: parsed, note }, meta: { structureId, replaced: !!same } });
    return structureId;
  });
  return (await structuresWithLines(ctx, employee.id)).find((s) => s.id === id);
}

/** Removes the latest revision (if it isn't paid yet); the previous one runs on again. */
export async function deleteStructure(ctx, structureId) {
  requireHr(ctx);
  const s = await ctx.db.one('select * from salary_structures where id = $1 and tenant_id = $2', [structureId, ctx.tenant.id]);
  if (!s) throw notFound('Salary revision');
  notOwnPay(ctx, s.employee_id);
  await assertAfterFrozen(ctx, s.effective_from, 'This revision is used by a paid payroll, so it');
  const later = await ctx.db.one('select 1 from salary_structures where employee_id = $1 and effective_from > $2', [s.employee_id, s.effective_from]);
  if (later) throw conflict('not_latest', 'Only the latest salary revision can be removed.');
  await ctx.db.tx(async (db) => {
    await db.query('delete from salary_structure_lines where structure_id = $1', [s.id]);
    await db.query('delete from salary_structures where id = $1', [s.id]);
    await db.query(`update salary_structures set effective_to = null where employee_id = $1 and effective_to = $2`, [s.employee_id, addDays(s.effective_from, -1)]);
    await audit(db, ctx, { action: 'salary.revision_removed', entityType: 'employee', entityId: s.employee_id, oldValue: s });
  });
}

// ---------------------------------------------------------------------
// Bank details
// ---------------------------------------------------------------------
/** ISO 13616 check: country, check digits, mod-97 = 1. */
export function isValidIban(raw) {
  const iban = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

export async function paymentDetails(ctx, employeeId) {
  return ctx.db.one('select bank_name, account_title, iban, updated_at from employee_payment_details where employee_id = $1 and tenant_id = $2',
    [employeeId, ctx.tenant.id]);
}

export async function setPaymentDetails(ctx, employeeId, { bankName, accountTitle, iban }) {
  requireHr(ctx);
  notOwnPay(ctx, employeeId);
  const employee = await getEmployee(ctx, employeeId);
  const clean = iban ? String(iban).replace(/\s+/g, '').toUpperCase() : null;
  if (clean && !isValidIban(clean)) throw badRequest('iban_invalid', 'This IBAN is not valid. Check it for typos (Pakistani IBANs look like PK36SCBL0000001123456702).');
  const before = await paymentDetails(ctx, employee.id);
  const row = await ctx.db.one(
    `insert into employee_payment_details (tenant_id, employee_id, bank_name, account_title, iban, updated_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (employee_id) do update set bank_name = excluded.bank_name, account_title = excluded.account_title,
       iban = excluded.iban, updated_by = excluded.updated_by, updated_at = now()
     returning bank_name, account_title, iban, updated_at`,
    [ctx.tenant.id, employee.id, bankName?.trim() || null, accountTitle?.trim() || null, clean, ctx.actor?.userId ?? null]);
  // Only the last 4 digits go to the audit log.
  const mask = (r) => r && { ...r, iban: r.iban ? `…${r.iban.slice(-4)}` : null };
  await audit(ctx.db, ctx, { action: 'payment_details.updated', entityType: 'employee', entityId: employee.id, oldValue: mask(before), newValue: mask(row) });
  return row;
}

// ---------------------------------------------------------------------
// Loans and advances: a schedule of monthly installments that payroll
// deducts (LOAN_INSTALLMENT) and marks as deducted when the run is locked.
// ---------------------------------------------------------------------
export async function listLoans(ctx, { employeeId, status } = {}) {
  requireHr(ctx);
  const { rows } = await ctx.db.query(
    `select l.*, e.full_name as employee_name, e.employee_code,
            coalesce((select sum(amount) from loan_installments i where i.loan_id = l.id and i.status = 'deducted'), 0) as recovered,
            (select json_agg(i order by i.period_key) from loan_installments i where i.loan_id = l.id) as installments
       from loans l join employees e on e.id = l.employee_id
      where l.tenant_id = $1 and ($2::uuid is null or l.employee_id = $2) and ($3::text is null or l.status = $3)
      order by l.created_at desc`, [ctx.tenant.id, employeeId ?? null, status ?? null]);
  return rows.map((r) => ({ ...r, outstanding: round2(r.principal - r.recovered), installments: r.installments ?? [] }));
}

export async function createLoan(ctx, { employeeId, kind = 'loan', principal, installmentAmount, startPeriod, note = null }) {
  requireHr(ctx);
  notOwnPay(ctx, employeeId);
  await requireModule(ctx, 'loans');
  const employee = await getEmployee(ctx, employeeId);
  const errors = [];
  if (!['loan', 'advance'].includes(kind)) errors.push('Choose loan or advance.');
  if (!(typeof principal === 'number' && principal > 0)) errors.push('Enter the amount given.');
  if (!(typeof installmentAmount === 'number' && installmentAmount > 0)) errors.push('Enter the monthly installment.');
  if (!PERIOD_RE.test(startPeriod ?? '')) errors.push('Choose the first month to deduct, like 2026-11.');
  if (errors.length) throw badRequest('loan_invalid', errors.join(' '), { details: { errors } });
  if (installmentAmount > principal) throw badRequest('loan_invalid', 'The installment is larger than the amount given.');
  await assertAfterFrozen(ctx, `${startPeriod}-01`, 'Deductions');
  const count = Math.ceil(round2(principal) / round2(installmentAmount));
  if (count > 120) throw badRequest('loan_invalid', 'A loan can be spread over at most 120 installments.');

  const id = await ctx.db.tx(async (db) => {
    const loan = await db.one(
      `insert into loans (tenant_id, employee_id, kind, principal, installment_amount, start_period, status, note, created_by)
       values ($1, $2, $3, $4, $5, $6, 'active', $7, $8) returning *`,
      [ctx.tenant.id, employee.id, kind, round2(principal), round2(installmentAmount), startPeriod, note, ctx.actor?.userId ?? null]);
    let period = startPeriod;
    let left = round2(principal);
    while (left > 0) {
      const amount = Math.min(left, round2(installmentAmount));
      await db.query(`insert into loan_installments (tenant_id, loan_id, period_key, amount, status) values ($1, $2, $3, $4, 'scheduled')`,
        [ctx.tenant.id, loan.id, period, round2(amount)]);
      left = round2(left - amount);
      period = nextPeriod(period);
    }
    await audit(db, ctx, { action: 'loan.created', entityType: 'loan', entityId: loan.id, newValue: loan });
    return loan.id;
  });
  return (await listLoans(ctx, { employeeId: employee.id })).find((l) => l.id === id);
}

async function loadLoan(ctx, id) {
  const loan = await ctx.db.one('select * from loans where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!loan) throw notFound('Loan');
  return loan;
}

/** Stops future deductions; installments already deducted stay as history. */
export async function cancelLoan(ctx, id, { reason = null } = {}) {
  requireHr(ctx);
  const loan = await loadLoan(ctx, id);
  notOwnPay(ctx, loan.employee_id);
  if (loan.status !== 'active') throw conflict('loan_not_active', 'Only an active loan can be cancelled.');
  const until = await frozenUntil(ctx);
  await ctx.db.tx(async (db) => {
    await db.query(`update loan_installments set status = 'skipped' where loan_id = $1 and status = 'scheduled' and ($2::text is null or period_key > $2)`,
      [loan.id, until?.slice(0, 7) ?? null]);
    await db.query(`update loans set status = 'cancelled', closed_at = now() where id = $1`, [loan.id]);
    await audit(db, ctx, { action: 'loan.cancelled', entityType: 'loan', entityId: loan.id, oldValue: loan, meta: { reason } });
  });
}

/** Moves one installment to the end of the schedule (e.g. a hardship month). */
export async function skipInstallment(ctx, installmentId) {
  requireHr(ctx);
  const inst = await ctx.db.one('select * from loan_installments where id = $1 and tenant_id = $2', [installmentId, ctx.tenant.id]);
  if (!inst) throw notFound('Installment');
  notOwnPay(ctx, (await ctx.db.one('select employee_id from loans where id = $1', [inst.loan_id]))?.employee_id);
  if (inst.status !== 'scheduled') throw conflict('installment_not_scheduled', 'Only an upcoming installment can be skipped.');
  await assertAfterFrozen(ctx, `${inst.period_key}-01`, 'This installment');
  await ctx.db.tx(async (db) => {
    const { last } = await db.one('select max(period_key) as last from loan_installments where loan_id = $1', [inst.loan_id]);
    await db.query(`update loan_installments set status = 'skipped' where id = $1`, [inst.id]);
    await db.query(`insert into loan_installments (tenant_id, loan_id, period_key, amount, status) values ($1, $2, $3, $4, 'scheduled')`,
      [ctx.tenant.id, inst.loan_id, nextPeriod(last), inst.amount]);
    await audit(db, ctx, { action: 'loan.installment_skipped', entityType: 'loan', entityId: inst.loan_id, meta: { period: inst.period_key } });
  });
}

/** Installments a payroll period deducts. */
export async function installmentsDue(ctx, employeeId, periodKey) {
  if (!(await isEnabled(ctx, 'loans'))) return { total: 0, items: [] };
  const { rows } = await ctx.db.query(
    `select i.id, i.amount, l.kind, l.id as loan_id from loan_installments i join loans l on l.id = i.loan_id
      where l.tenant_id = $1 and l.employee_id = $2 and l.status = 'active' and i.period_key = $3 and i.status = 'scheduled'`,
    [ctx.tenant.id, employeeId, periodKey]);
  return { total: round2(rows.reduce((s, r) => s + r.amount, 0)), items: rows };
}

/** Called inside the lock transaction. */
export async function markInstallmentsDeducted(db, ctx, run) {
  const { rows } = await db.query(
    `update loan_installments i set status = 'deducted', payroll_run_id = $3
       from loans l, payslips p
      where l.id = i.loan_id and l.tenant_id = $1 and i.period_key = $2 and i.status = 'scheduled'
        and p.payroll_run_id = $3 and p.employee_id = l.employee_id
      returning i.loan_id`, [ctx.tenant.id, run.period_key, run.id]);
  const loanIds = [...new Set(rows.map((r) => r.loan_id))];
  for (const id of loanIds) {
    await db.query(`update loans set status = 'closed', closed_at = now()
                     where id = $1 and status = 'active' and not exists (select 1 from loan_installments where loan_id = $1 and status = 'scheduled')`, [id]);
  }
  return rows.length;
}
