import {
  bankCsv, createRun, deleteRun, departmentCost, departmentCostCsv, formulaMeta, getPayslip, getRun, listRuns, myPayslips,
  recalculateRun, testFormula, transitionRun,
} from '../../services/payroll.js';
import { renderPayslipPdf } from '../../services/payslipPdf.js';
import { logoOf } from '../../services/company.js';
import {
  addStructure, cancelLoan, createLoan, deleteStructure, listLoans, salaryOf, setPaymentDetails, skipInstallment,
} from '../../services/salary.js';
import { cancelOvertimeClaim, createOvertimeClaim, listOvertimeClaims } from '../../services/overtime.js';

const csv = (reply, name, body) =>
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(`﻿${body}`);

export default async function payrollRoutes(app) {
  // Runs: Draft > Review > Approved > Locked
  app.get('/payroll/runs', async (req) => listRuns(req.ctx));
  app.post('/payroll/runs', async (req, reply) => reply.status(201).send(await createRun(req.ctx, { period: req.body?.period })));
  app.get('/payroll/runs/:id', async (req) => getRun(req.ctx, req.params.id));
  app.post('/payroll/runs/:id/recalculate', async (req) => recalculateRun(req.ctx, req.params.id));
  for (const action of ['submit', 'approve', 'lock', 'reopen']) {
    app.post(`/payroll/runs/:id/${action}`, async (req) => transitionRun(req.ctx, req.params.id, action, { reason: req.body?.reason }));
  }
  app.delete('/payroll/runs/:id', async (req, reply) => { await deleteRun(req.ctx, req.params.id); return reply.status(204).send(); });
  app.get('/payroll/runs/:id/department-cost', async (req) => departmentCost(req.ctx, req.params.id));
  app.get('/payroll/runs/:id/department-cost.csv', async (req, reply) => {
    const run = await getRun(req.ctx, req.params.id);
    return csv(reply, `department-cost-${run.period_key}.csv`, await departmentCostCsv(req.ctx, run.id));
  });
  app.get('/payroll/runs/:id/bank.csv', async (req, reply) => {
    const body = await bankCsv(req.ctx, req.params.id);
    const run = await getRun(req.ctx, req.params.id);
    return csv(reply, `bank-transfer-${run.period_key}.csv`, body);
  });

  // Payslips (HR: any; employee: own, once locked)
  app.get('/payroll/payslips/mine', async (req) => myPayslips(req.ctx));
  app.get('/payroll/payslips/:id', async (req) => getPayslip(req.ctx, req.params.id));
  app.get('/payroll/payslips/:id/pdf', async (req, reply) => {
    const p = await getPayslip(req.ctx, req.params.id);
    const pdf = await renderPayslipPdf(p, { logo: await logoOf(app.db, req.ctx.tenant.id) });
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="payslip-${p.summary.employee.code}-${p.period_key}.pdf"`).send(pdf);
  });

  // Formula builder
  app.get('/payroll/formula/meta', async (req) => formulaMeta(req.ctx));
  app.post('/payroll/formula/test', async (req) => testFormula(req.ctx, req.body ?? {}));

  // Salary structures, bank details, loans
  app.get('/payroll/employees/:id/salary', async (req) => salaryOf(req.ctx, req.params.id));
  app.post('/payroll/employees/:id/salary', async (req, reply) => reply.status(201).send(await addStructure(req.ctx, req.params.id, req.body ?? {})));
  app.delete('/payroll/salary-structures/:id', async (req, reply) => { await deleteStructure(req.ctx, req.params.id); return reply.status(204).send(); });
  app.put('/payroll/employees/:id/payment', async (req) => setPaymentDetails(req.ctx, req.params.id, req.body ?? {}));
  app.get('/payroll/loans', async (req) => listLoans(req.ctx, { employeeId: req.query.employeeId, status: req.query.status }));
  app.post('/payroll/loans', async (req, reply) => reply.status(201).send(await createLoan(req.ctx, req.body ?? {})));
  app.post('/payroll/loans/:id/cancel', async (req, reply) => { await cancelLoan(req.ctx, req.params.id, req.body ?? {}); return reply.status(204).send(); });
  app.post('/payroll/loan-installments/:id/skip', async (req, reply) => { await skipInstallment(req.ctx, req.params.id); return reply.status(204).send(); });

  // Overtime claims (approval runs through the generic approvals inbox)
  app.get('/overtime/claims', async (req) =>
    listOvertimeClaims(req.ctx, { employeeId: req.query.employeeId, status: req.query.status, from: req.query.from, to: req.query.to }));
  app.post('/overtime/claims', async (req, reply) =>
    reply.status(201).send(await createOvertimeClaim(req.ctx, { ...req.body, employeeId: req.body?.employeeId ?? req.ctx.actor.employeeId })));
  app.post('/overtime/claims/:id/cancel', async (req, reply) => { await cancelOvertimeClaim(req.ctx, req.params.id); return reply.status(204).send(); });
}
