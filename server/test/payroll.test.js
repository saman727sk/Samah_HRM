/**
 * Phase 4: payroll runs end to end.
 *
 * February 2026 has 28 days and 19 working days (Kashmir Day on Thu 5 Feb).
 * Ali (E003): BASIC 80,000 + HRA 24,000 + MEDICAL 8,000 = 112,000 a month,
 * so DAILY_RATE = 112,000 / 28 = 4,000 and HOURLY_RATE = 4,000 / 9 h.
 * In February he is absent once, late 3 times, takes 1 unpaid leave day,
 * has 2 approved overtime hours and a 4,000 loan installment.
 * Hamza (E007) joined on Mon 2 Feb on 56,000: pro-rated 27/28 = 54,000.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import * as att from '../src/services/attendance.js';
import * as leave from '../src/services/leave.js';
import * as payroll from '../src/services/payroll.js';
import * as salary from '../src/services/salary.js';
import * as overtime from '../src/services/overtime.js';
import * as settings from '../src/services/settings.js';
import { setFlag } from '../src/services/features.js';
import { renderPayslipPdf } from '../src/services/payslipPdf.js';

const FEB_WORKING = ['02', '03', '04', '06', '09', '10', '11', '12', '13', '16', '17', '18', '19', '20', '23', '24', '25', '26', '27'].map((d) => `2026-02-${d}`);

async function work(t, code, dates, inAt = '08:55', outAt = '18:05') {
  for (const d of dates) {
    for (const [type, time] of [['in', inAt], ['out', outAt]]) {
      const at = new Date(`${d}T${time}:00+05:00`);
      await t.db.query(
        `insert into attendance_events (tenant_id, employee_id, event_type, server_time, punch_time, work_date, method)
         values ($1, $2, $3, $4, $4, $5, 'office_manual')`, [t.tenant.id, t.emp(code), type, at, d]);
    }
  }
}

const line = (slip, code) => slip.summary.lines.find((l) => l.code === code);
const amount = (slip, code) => line(slip, code)?.amount ?? 0;
const employeeRow = (t, code) => t.db.one('select * from employees where id = $1', [t.emp(code)]);

async function scenario(t) {
  await setFlag(t.hr, 'overtime', { enabled: true });
  await setFlag(t.hr, 'loans', { enabled: true });
  await salary.addStructure(t.hr, t.emp('E003'), { effectiveFrom: '2026-01-01', lines: { BASIC: 80000, HRA: 24000, MEDICAL: 8000 } });
  await salary.addStructure(t.hr, t.emp('E007'), { effectiveFrom: '2026-02-02', lines: { BASIC: 56000 } });
  await salary.setPaymentDetails(t.hr, t.emp('E003'), { bankName: 'Standard Chartered', accountTitle: 'Ali Raza', iban: 'PK36 SCBL 0000 0011 2345 6702' });

  // Unpaid leave on 12 Feb, applied with notice and approved by the manager.
  t.at('2026-02-02 10:00');
  const { request } = await leave.createLeaveRequest(await t.as('E003'), { employeeId: t.emp('E003'), leaveTypeId: t.demo.leaveTypes.UNPAID, startDate: '2026-02-12' });
  await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });

  const late = ['2026-02-16', '2026-02-17', '2026-02-18'];
  const normal = FEB_WORKING.filter((d) => !['2026-02-11', '2026-02-12', '2026-02-19', ...late].includes(d)); // 11th: absent
  await work(t, 'E003', normal);
  await work(t, 'E003', late, '09:30', '18:35');
  await work(t, 'E003', ['2026-02-19'], '08:55', '20:00'); // 125 min overtime
  await work(t, 'E007', FEB_WORKING.filter((d) => d >= '2026-02-02'));

  t.at('2026-03-04 10:00');
  const { claim } = await overtime.createOvertimeClaim(await t.as('E003'), { employeeId: t.emp('E003'), workDate: '2026-02-19', minutes: 120, reason: 'Client release' });
  await overtime.decideOvertimeClaim(await t.as('E002'), claim.id, { decision: 'approved' });
  await salary.createLoan(t.hr, { employeeId: t.emp('E003'), kind: 'loan', principal: 10000, installmentAmount: 4000, startPeriod: '2026-02' });
}

describe('payroll run: absent, late, unpaid leave, overtime, joiner, loans', () => {
  let t;
  let run;
  before(async () => {
    t = await setup();
    await scenario(t);
    run = await payroll.createRun(t.hr, { period: '2026-02' });
  });
  after(() => t.close());

  const slipOf = async (code) => payroll.getPayslip(t.hr, run.payslips.find((p) => p.employee_id === t.emp(code)).id);

  test('the draft run has payslips for employees with a salary, and warns about the rest', async () => {
    assert.equal(run.status, 'draft');
    assert.equal(run.payslips.length, 2);
    assert.equal(run.totals.employees, 2);
    assert.equal(run.warnings.filter((w) => w.code === 'no_salary_structure').length, 10);
    assert.ok(run.warnings.some((w) => w.code === 'no_bank_details' && w.message.includes('Hamza')));
    assert.deepEqual(run.actions, ['recalculate', 'submit', 'delete']);
  });

  test('attendance inputs', async () => {
    const i = (await slipOf('E003')).summary.inputs;
    assert.equal(i.CALENDAR_DAYS, 28);
    assert.equal(i.WORKING_DAYS, 19);
    assert.equal(i.PRESENT_DAYS, 17);
    assert.equal(i.ABSENT_DAYS, 1);
    assert.equal(i.LATE_COUNT, 3);
    assert.equal(i.UNPAID_LEAVE_DAYS, 1);
    assert.equal(i.PAID_LEAVE_DAYS, 0);
    assert.equal(i.OT_HOURS, 2);
    assert.equal(i.SHIFT_HOURS, 9);
    assert.equal(i.MONTHLY_SALARY, 112000);
    assert.equal(i.LOAN_INSTALLMENT, 4000);
  });

  test('absent, late, unpaid leave and overtime amounts', async () => {
    const slip = await slipOf('E003');
    assert.equal(amount(slip, 'ABSENT'), 4000);       // 1 day x 4,000
    assert.equal(amount(slip, 'LATE'), 4000);         // 3 lates = 1 day
    assert.equal(amount(slip, 'UNPAID_LEAVE'), 4000); // 1 day
    assert.equal(amount(slip, 'OVERTIME'), 1333);     // 2 h x 4,000/9 x 1.5
    assert.equal(amount(slip, 'TAX'), 433);           // (105,333 - 12,000) x 12 = 1,119,996 -> 1% over 600k / 12
    assert.equal(amount(slip, 'EOBI'), 400);
    assert.equal(amount(slip, 'LOAN'), 4000);
    assert.equal(amount(slip, 'EOBI_ER'), 2000);
    assert.equal(Number(slip.gross), 113333);
    assert.equal(Number(slip.deductions), 4000 * 3 + 433 + 400 + 4000);
    assert.equal(Number(slip.net), 96500);
    assert.equal(Number(slip.employer_cost), 2000);
  });

  test('each line explains itself: formula, values used and setting versions', async () => {
    const slip = await slipOf('E003');
    const late = line(slip, 'LATE');
    assert.equal(late.formula, 'round(floor(LATE_COUNT / 3) * DAILY_RATE)');
    assert.deepEqual(late.inputs, { LATE_COUNT: 3, DAILY_RATE: 4000 });
    assert.deepEqual(line(slip, 'BASIC').inputs, { full: 80000, proRated: true, PRORATE: 1 });
    const items = (await t.db.query('select * from payroll_items where payroll_run_id = $1 and employee_id = $2', [run.id, t.emp('E003')])).rows;
    assert.ok(items.every((it) => it.setting_version_ids.length >= 1));
  });

  test('a joiner is pro-rated for the days employed', async () => {
    const slip = await slipOf('E007');
    assert.equal(slip.summary.inputs.EMPLOYED_DAYS, 27);
    assert.equal(slip.summary.inputs.ABSENT_DAYS, 0);
    assert.equal(amount(slip, 'BASIC'), 54000); // 56,000 x 27/28
    assert.equal(amount(slip, 'TAX'), 40);       // 648,000 a year -> 1% of 48,000 / 12
    assert.equal(Number(slip.net), 54000 - 40 - 400);
  });

  test('draft runs recalculate from live data', async () => {
    await salary.addStructure(t.hr, t.emp('E007'), { effectiveFrom: '2026-02-16', lines: { BASIC: 84000 } });
    run = await payroll.recalculateRun(t.hr, run.id);
    // 2-15 Feb at 56,000 (14 days) + 16-28 Feb at 84,000 (13 days)
    assert.equal(amount(await slipOf('E007'), 'BASIC'), Math.round((56000 * 14 + 84000 * 13) / 28 * 100) / 100);
  });

  test('approval flow, maker-checker and exports', async () => {
    await assert.rejects(payroll.transitionRun(t.hr, run.id, 'approve'), { code: 'status_invalid' });
    await assert.rejects(payroll.bankCsv(t.hr, run.id), { code: 'payroll_not_approved' });
    run = await payroll.transitionRun(t.hr, run.id, 'submit');
    assert.equal(run.status, 'review');
    await assert.rejects(payroll.transitionRun(t.hr, run.id, 'reopen'), { code: 'reason_required' });
    run = await payroll.transitionRun(t.hr, run.id, 'approve');
    assert.equal(run.status, 'approved');

    const csv = await payroll.bankCsv(t.hr, run.id);
    assert.match(csv, /^Employee code,Name,Account title,Bank,IBAN,Amount,Currency,Reference\r\n/);
    assert.match(csv, /E003,Ali Raza,Ali Raza,Standard Chartered,PK36SCBL0000001123456702,96500\.00,PKR,Salary 2026-02/);
    const cost = await payroll.departmentCost(t.hr, run.id);
    const eng = cost.departments.find((d) => d.department === 'Engineering');
    assert.equal(eng.headcount, 1);
    assert.equal(eng.total_cost, eng.gross + eng.employer_cost);
  });

  test('approved payslips are frozen; employees only see them once locked', async () => {
    await assert.rejects(t.db.query(`update payslips set net = 1 where payroll_run_id = $1`, [run.id]), /can no longer change/);
    const slipId = run.payslips.find((p) => p.employee_id === t.emp('E003')).id;
    await assert.rejects(payroll.getPayslip(await t.as('E003'), slipId), { code: 'not_found' });
    run = await payroll.transitionRun(t.hr, run.id, 'lock');
    assert.equal(run.status, 'locked');
    const own = await payroll.getPayslip(await t.as('E003'), slipId);
    assert.equal(Number(own.net), 96500);
    await assert.rejects(payroll.getPayslip(await t.as('E002'), slipId), { code: 'not_found' }); // manager: no salary data
    await assert.rejects(payroll.getPayslip(await t.as('E004'), slipId), { code: 'not_found' });
    assert.equal((await payroll.myPayslips(await t.as('E003'))).length, 1);
    const n = await t.db.one(`select count(*)::int as n from notifications where template_key = 'payslip_ready'`);
    assert.ok(n.n >= 2);
    const pdf = await renderPayslipPdf(own);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });

  test('locking deducts the loan installment', async () => {
    const [loan] = await salary.listLoans(t.hr, { employeeId: t.emp('E003') });
    assert.equal(loan.recovered, 4000);
    assert.equal(loan.outstanding, 6000);
    assert.deepEqual(loan.installments.map((i) => [i.period_key, i.status]), [['2026-02', 'deducted'], ['2026-03', 'scheduled'], ['2026-04', 'scheduled']]);
  });

  test('a locked month can never change', async () => {
    await assert.rejects(payroll.recalculateRun(t.hr, run.id), { code: 'payroll_locked' });
    await assert.rejects(payroll.transitionRun(t.hr, run.id, 'reopen', { reason: 'oops' }), { code: 'payroll_locked' });
    await assert.rejects(payroll.deleteRun(t.hr, run.id), { code: 'status_invalid' });
    await assert.rejects(t.db.query(`update payroll_runs set status = 'draft' where id = $1`, [run.id]), /locked and can never change/);
    await assert.rejects(t.db.query(`delete from payroll_items where payroll_run_id = $1`, [run.id]), /can no longer change/);
    // ...nor can the data it was calculated from.
    await assert.rejects(att.requestCorrection(await t.as('E003'), { employeeId: t.emp('E003'), workDate: '2026-02-11', eventType: 'in',
      correctedTime: '2026-02-11T04:00:00Z', reason: 'Forgot to punch' }), { code: 'attendance_not_allowed' });
    await assert.rejects(leave.cancelLeave(t.hr, (await t.db.one(`select id from leave_requests where employee_id = $1`, [t.emp('E003')])).id),
      (err) => err.details.reasons[0].code === 'leave.period_locked');
    await assert.rejects(overtime.createOvertimeClaim(await t.as('E007'), { employeeId: t.emp('E007'), workDate: '2026-02-20' }),
      (err) => err.details.reasons[0].code === 'overtime.period_locked');
    await assert.rejects(salary.addStructure(t.hr, t.emp('E003'), { effectiveFrom: '2026-02-15', lines: { BASIC: 90000 } }), { code: 'payroll_locked' });
    await assert.rejects(salary.createLoan(t.hr, { employeeId: t.emp('E007'), principal: 5000, installmentAmount: 5000, startPeriod: '2026-02' }), { code: 'payroll_locked' });
  });

  test('a new rule applies from the next payroll and leaves the locked month untouched', async () => {
    const febBefore = await t.db.query('select employee_id, amount, label from payroll_items where payroll_run_id = $1 order by employee_id, label', [run.id]);
    // Minimum wage revised from today: EOBI 1% goes from 400 to 420.
    const current = (await settings.list(t.hr, { key: 'payroll.rules' }))[0].current.value;
    const draft = await settings.createDraft(t.hr, { key: 'payroll.rules', value: { ...current, variables: { ...current.variables, MIN_WAGE: 42000 } } });
    const preview = await settings.preview(t.hr, draft.id, { effectiveFrom: '2026-03-04' });
    assert.equal(preview.payrollImpact.available, true);
    assert.equal(preview.payrollImpact.period, '2026-03');
    const ali = preview.employees.find((e) => e.employeeId === t.emp('E003'));
    assert.equal(ali.metrics[0].new, ali.metrics[0].old - 20);
    const published = await settings.publish(t.hr, draft.id, { effectiveFrom: '2026-03-04' });

    const march = await payroll.createRun(t.hr, { period: '2026-03' });
    const marchSlip = await payroll.getPayslip(t.hr, march.payslips.find((p) => p.employee_id === t.emp('E003')).id);
    assert.equal(amount(marchSlip, 'EOBI'), 420);
    assert.ok(marchSlip.summary.versionIds.includes(published.version.id));
    assert.equal(amount(marchSlip, 'LOAN'), 4000);

    const febAfter = await t.db.query('select employee_id, amount, label from payroll_items where payroll_run_id = $1 order by employee_id, label', [run.id]);
    assert.deepEqual(febAfter.rows, febBefore.rows);
    const febSlip = await payroll.getPayslip(t.hr, run.payslips.find((p) => p.employee_id === t.emp('E003')).id);
    assert.equal(amount(febSlip, 'EOBI'), 400);
    assert.equal(Number(febSlip.net), 96500);
  });
});

describe('payroll configuration', () => {
  let t;
  before(async () => {
    t = await setup();
    await salary.addStructure(t.hr, t.emp('E003'), { effectiveFrom: '2026-01-01', lines: { BASIC: 80000, HRA: 24000, MEDICAL: 8000 } });
  });
  after(() => t.close());

  test('formulas are checked on publish: unknown names, loops and syntax', async () => {
    const hra = t.demo.salaryComponents.HRA;
    const rule = { enabled: true, calculation: 'formula', proRate: false, taxable: true, showIfZero: false };
    for (const [formula, message] of [
      ['BASIC * BONUS_RATE', /uses "BONUS_RATE", which is not a known value/],
      ['GROSS * 0.1', /loop/],
      ['BASIC * (0.45', /Expected "\)"/],
    ]) {
      const d = await settings.createDraft(t.hr, { key: 'payroll.component', subjectId: hra, value: { ...rule, formula } });
      await assert.rejects(settings.publish(t.hr, d.id, { effectiveFrom: '2026-03-04' }),
        (err) => err.code === 'validation_failed' && err.details.errors.some((e) => message.test(e.message)));
      await settings.discardDraft(t.hr, d.id);
    }
    const ok = await settings.createDraft(t.hr, { key: 'payroll.component', subjectId: hra, value: { ...rule, formula: 'round(BASIC * 0.45)' } });
    assert.equal((await settings.publish(t.hr, ok.id, { effectiveFrom: '2026-03-04' })).version.status, 'published');
  });

  test('formula builder: test a formula with an employee\'s real values', async () => {
    const r = await payroll.testFormula(t.hr, { formula: 'MONTHLY_SALARY / CALENDAR_DAYS', employeeId: t.emp('E003'), period: '2026-02' });
    assert.equal(r.ok, true);
    assert.equal(r.value, 4000);
    assert.deepEqual(r.values, { MONTHLY_SALARY: 112000, CALENDAR_DAYS: 28 });
    assert.match((await payroll.testFormula(t.hr, { formula: 'BASIC * NOPE' })).error, /Unknown value: NOPE/);
    const meta = await payroll.formulaMeta(t.hr);
    assert.ok(meta.inputs.ABSENT_DAYS && meta.functions.tax && meta.components.some((c) => c.code === 'BASIC'));
  });

  test('rule date "period start": a mid-month rule waits for the next payroll', async () => {
    const current = (await settings.list(t.hr, { key: 'payroll.rules' }))[0].current.value;
    const d = await settings.createDraft(t.hr, { key: 'payroll.rules', value: { ...current, ruleDate: 'period_start', variables: { ...current.variables, MIN_WAGE: 42000 } } });
    await settings.publish(t.hr, d.id, { effectiveFrom: '2026-03-04' });
    const ali = await employeeRow(t, 'E003');
    const march = await payroll.computeEmployee(t.hr, ali, payroll.periodBounds('2026-03'));
    const april = await payroll.computeEmployee(t.hr, ali, payroll.periodBounds('2026-04'));
    assert.equal(march.values.EOBI, 400);
    assert.equal(april.values.EOBI, 420);
  });

  test('scoped overrides: contract staff can be excluded from EOBI', async () => {
    // (The previous test switched to "period start" rules, so a rule from 4 March first applies in April.)
    const d = await settings.createDraft(t.hr, { key: 'payroll.component', subjectId: t.demo.salaryComponents.EOBI,
      scopeType: 'employment_type', scopeId: t.demo.employmentTypes.CONTRACT, value: { enabled: false } });
    await settings.publish(t.hr, d.id, { effectiveFrom: '2026-03-04' });
    await salary.addStructure(t.hr, t.emp('E011'), { effectiveFrom: '2026-03-01', lines: { BASIC: 60000 } });
    const kamran = await payroll.computeEmployee(t.hr, await employeeRow(t, 'E011'), payroll.periodBounds('2026-04'));
    assert.equal(kamran.lines.some((l) => l.code === 'EOBI'), false);
    const ali = await payroll.computeEmployee(t.hr, await employeeRow(t, 'E003'), payroll.periodBounds('2026-04'));
    assert.ok(ali.lines.some((l) => l.code === 'EOBI'));
  });

  test('salary data, codes and bank details are validated', async () => {
    await assert.rejects(salary.addStructure(t.hr, t.emp('E003'), { effectiveFrom: '2026-02-01', lines: { BASIC: -5 } }), { code: 'salary_invalid' });
    await assert.rejects(salary.addStructure(t.hr, t.emp('E003'), { effectiveFrom: '2026-02-01', lines: { NOPE: 5 } }), { code: 'salary_invalid' });
    await assert.rejects(salary.addStructure(t.hr, t.emp('E003'), { effectiveFrom: '2025-12-01', lines: { BASIC: 5 } }), { code: 'later_revision_exists' });
    await assert.rejects(salary.setPaymentDetails(t.hr, t.emp('E003'), { iban: 'PK36SCBL0000001123456703' }), { code: 'iban_invalid' });
    assert.equal(salary.isValidIban('GB82 WEST 1234 5698 7654 32'), true);
    const { createLookup } = await import('../src/services/lookups.js');
    await assert.rejects(createLookup(t.hr, 'salary-components', { code: 'fuel-allowance', name: 'Fuel', kind: 'earning' }), { code: 'lookup_invalid' });
    await assert.rejects(createLookup(t.hr, 'salary-components', { code: 'GROSS', name: 'Gross', kind: 'earning' }), { code: 'lookup_invalid' });
  });

  test('only HR runs payroll', async () => {
    await assert.rejects(payroll.createRun(await t.as('E002'), { period: '2026-02' }), { code: 'forbidden' });
    await assert.rejects(salary.salaryOf(await t.as('E003'), t.emp('E003')), { code: 'forbidden' });
    await assert.rejects(payroll.createRun(t.hr, { period: '2026-05' }), { code: 'period_in_future' });
    await assert.rejects(payroll.createRun(t.hr, { period: '2025-12' }), { code: 'before_go_live' });
  });

  test('overtime claims are checked against attendance', async () => {
    await assert.rejects(overtime.createOvertimeClaim(await t.as('E003'), { employeeId: t.emp('E003'), workDate: '2026-03-02' }), { code: 'module_disabled' });
    await setFlag(t.hr, 'overtime', { enabled: true });
    await work(t, 'E003', ['2026-03-02'], '08:55', '19:00'); // 65 min
    await work(t, 'E003', ['2026-03-03'], '08:55', '18:05'); // 10 min
    const claim = (args) => overtime.createOvertimeClaim(t.hr, { employeeId: t.emp('E003'), ...args });
    const reasons = (err) => err.details.reasons.map((r) => r.code);
    await assert.rejects(claim({ workDate: '2026-03-02', minutes: 90 }), (e) => reasons(e).includes('overtime.too_many_minutes'));
    await assert.rejects(claim({ workDate: '2026-03-03' }), (e) => reasons(e).includes('overtime.below_minimum'));
    await assert.rejects(claim({ workDate: '2026-03-09' }), (e) => reasons(e).includes('overtime.in_future'));
    const { claim: c } = await claim({ workDate: '2026-03-02' });
    assert.equal(c.minutes, 65);
    await assert.rejects(claim({ workDate: '2026-03-02' }), (e) => reasons(e).includes('overtime.already_claimed'));
    const inbox = await (await import('../src/services/workflow.js')).inbox(await t.as('E002'));
    assert.ok(inbox.some((x) => x.request.type === 'overtime' && /1h 05m overtime on 2026-03-02/.test(x.request.summary)));
  });
});

describe('payroll API', () => {
  let t, app;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, headers: res.headers, raw: res.rawPayload, body: res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : res.body };
  };
  before(async () => {
    t = await setup();
    const { buildApp } = await import('../src/api/app.js');
    const { DEMO_PASSWORD } = await import('../seed/demo.js');
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    for (const [who, email] of [['hr', 'hr@acme.test'], ['ali', 'ali@acme.test'], ['bilal', 'bilal@acme.test']]) {
      tokens[who] = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } })).body).token;
    }
  });
  after(async () => { await app.close(); await t.close(); });

  test('HR runs a month end to end over HTTP; the employee downloads their payslip PDF', async () => {
    assert.equal((await call('hr', 'POST', `/api/payroll/employees/${t.emp('E003')}/salary`, { effectiveFrom: '2026-01-01', lines: { BASIC: 100000 } })).status, 201);
    await work(t, 'E003', FEB_WORKING);
    const created = await call('hr', 'POST', '/api/payroll/runs', { period: '2026-02' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await call('hr', 'POST', '/api/payroll/runs', { period: '2026-02' })).body.error.code, 'run_exists');
    for (const action of ['submit', 'approve', 'lock']) assert.equal((await call('hr', 'POST', `/api/payroll/runs/${id}/${action}`)).status, 200);

    const bank = await call('hr', 'GET', `/api/payroll/runs/${id}/bank.csv`);
    assert.match(bank.headers['content-disposition'], /bank-transfer-2026-02\.csv/);
    const cost = await call('hr', 'GET', `/api/payroll/runs/${id}/department-cost.csv`);
    assert.match(cost.body, /Sales,1,/);

    const mine = await call('ali', 'GET', '/api/payroll/payslips/mine');
    assert.equal(mine.body.length, 1);
    const pdf = await call('ali', 'GET', `/api/payroll/payslips/${mine.body[0].id}/pdf`);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.raw.subarray(0, 5).toString(), '%PDF-');
  });

  test('employees and managers get no payroll data', async () => {
    assert.equal((await call('ali', 'GET', '/api/payroll/runs')).status, 403);
    assert.equal((await call('bilal', 'GET', `/api/payroll/employees/${t.emp('E003')}/salary`)).status, 403);
    assert.equal((await call('bilal', 'POST', '/api/payroll/formula/test', { formula: 'BASIC' })).status, 403);
    const slip = (await call('ali', 'GET', '/api/payroll/payslips/mine')).body[0];
    assert.equal((await call('bilal', 'GET', `/api/payroll/payslips/${slip.id}`)).status, 404);
  });
});
