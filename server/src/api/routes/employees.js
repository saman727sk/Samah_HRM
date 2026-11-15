import { createEmployee, deleteEmployee, getEmployee, listEmployees, nextEmployeeCode, updateEmployee } from '../../services/employees.js';
import { exportEmployees, importEmployees, TEMPLATE_HEADER } from '../../services/employeeImport.js';
import { requireHr } from '../../services/access.js';
import { toCsv } from '../../lib/csv.js';

export default async function employeeRoutes(app) {
  app.get('/', async (req) => listEmployees(req.ctx, { departmentId: req.query.departmentId, status: req.query.status }));
  app.get('/next-code', async (req) => { requireHr(req.ctx); return { code: await nextEmployeeCode(req.ctx) }; });
  /** A CSV template for the bulk import, with one example row. */
  app.get('/import-template.csv', async (req, reply) => {
    requireHr(req.ctx);
    const example = ['E101', 'Ayesha Khan', 'ayesha.khan@example.com', '0300 1234567', 'Sales', 'Sales Executive', 'Permanent', 'E001',
      '15/03/2024', '15/06/2024', 'Active', '', '', 'Yes', 'Employee'];
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="employees-template.csv"')
      .send(`﻿${toCsv(TEMPLATE_HEADER, [example])}`);
  });
  /** Every employee (?status=all for inactive and exited too) in the import template's columns. */
  app.get('/export.csv', async (req, reply) => {
    const { header, rows } = await exportEmployees(req.ctx, { status: req.query.status });
    const day = req.ctx.clock.now().toISOString().slice(0, 10);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="employees-${day}.csv"`)
      .send(`﻿${toCsv(header, rows)}`);
  });
  /** Bulk import from CSV text. dryRun (default) = preview: nothing is saved. */
  app.post('/import', { bodyLimit: 12 * 1024 * 1024 }, async (req) =>
    importEmployees({ ...req.ctx, mailer: app.mailer, appUrl: app.appUrl }, { ...(req.body ?? {}), dryRun: req.body?.dryRun !== false }));
  app.get('/:id', async (req) => getEmployee(req.ctx, req.params.id));
  app.post('/', async (req, reply) => reply.status(201).send(await createEmployee(req.ctx, req.body ?? {})));
  app.patch('/:id', async (req) => updateEmployee(req.ctx, req.params.id, req.body ?? {}));
  app.delete('/:id', async (req) => deleteEmployee(req.ctx, req.params.id));
}
