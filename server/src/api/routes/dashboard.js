import { attendanceCsv, employeeDashboard, hrDashboard, managerDashboard } from '../../services/dashboard.js';
import { exportSettings, importSettings } from '../../services/configTransfer.js';
import { forbidden } from '../../lib/errors.js';

export default async function dashboardRoutes(app) {
  app.get('/dashboard/employee', async (req) => employeeDashboard(req.ctx, req.query.employeeId ?? req.ctx.actor.employeeId, { month: req.query.month }));
  app.get('/dashboard/manager', async (req) => {
    if (!['manager', 'hr_admin'].includes(req.ctx.actor.accessLevel)) throw forbidden('The team dashboard is for managers.');
    return managerDashboard(req.ctx, { month: req.query.month });
  });
  app.get('/dashboard/hr', async (req) => hrDashboard(req.ctx, { month: req.query.month }));

  /** ?month=2026-10&detail=daily|summary — scoped to the people the caller can see. */
  app.get('/reports/attendance.csv', async (req, reply) => {
    const csv = await attendanceCsv(req.ctx, { month: req.query.month, detail: req.query.detail });
    const name = `attendance-${req.query.detail === 'summary' ? 'summary' : 'daily'}-${req.query.month ?? 'current'}.csv`;
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(`﻿${csv}`);
  });

  app.get('/settings-transfer/export', async (req, reply) => {
    const data = await exportSettings(req.ctx);
    return reply.header('content-disposition', `attachment; filename="settings-${req.ctx.tenant.slug}.json"`).send(data);
  });
  app.post('/settings-transfer/import', async (req) =>
    importSettings(req.ctx, req.body?.data, { dryRun: req.body?.dryRun !== false }));
}
