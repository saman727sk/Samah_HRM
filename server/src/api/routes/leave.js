import { adjustBalance, cancelLeave, checkLeave, createLeaveRequest, decideLeave, getBalances, getLedger, leaveTypes } from '../../services/leave.js';
import { localizeReasons } from '../app.js';

const withEmployee = (req) => ({ ...req.body, employeeId: req.body?.employeeId ?? req.ctx.actor.employeeId });

export default async function leaveRoutes(app) {
  app.get('/types', async (req) => leaveTypes(req.ctx, { activeOnly: req.query.includeInactive !== 'true' }));
  app.get('/balances', async (req) => getBalances(req.ctx, req.query.employeeId ?? req.ctx.actor.employeeId, { date: req.query.date }));
  app.get('/ledger', async (req) =>
    getLedger(req.ctx, req.query.employeeId ?? req.ctx.actor.employeeId, req.query.leaveTypeId, { year: req.query.year }));
  app.post('/check', async (req) => localizeReasons(req, await checkLeave(req.ctx, withEmployee(req))));
  app.post('/requests', async (req, reply) => {
    const result = await createLeaveRequest(req.ctx, withEmployee(req));
    await localizeReasons(req, result);
    return reply.status(201).send(result);
  });
  app.post('/requests/:id/decision', async (req) => decideLeave(req.ctx, req.params.id, req.body ?? {}));
  app.post('/requests/:id/cancel', async (req, reply) => { await cancelLeave(req.ctx, req.params.id, req.body ?? {}); return reply.status(204).send(); });
  app.post('/adjustments', async (req, reply) => {
    const { employeeId, leaveTypeId, ...rest } = req.body ?? {};
    return reply.status(201).send(await adjustBalance(req.ctx, employeeId, leaveTypeId, rest));
  });
}
