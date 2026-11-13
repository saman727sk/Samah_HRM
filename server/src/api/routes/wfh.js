import { cancelWfh, checkWfh, createOverride, createWfhRequest, decideWfh, getWfhQuota } from '../../services/wfh.js';
import { localizeReasons } from '../app.js';

const withEmployee = (req) => ({ ...req.body, employeeId: req.body?.employeeId ?? req.ctx.actor.employeeId });

export default async function wfhRoutes(app) {
  app.post('/check', async (req) => localizeReasons(req, await checkWfh(req.ctx, withEmployee(req))));
  app.post('/requests', async (req, reply) => {
    const result = await createWfhRequest(req.ctx, withEmployee(req));
    await localizeReasons(req, result.evaluation);
    return reply.status(201).send(result);
  });
  app.post('/requests/:groupId/decision', async (req) => decideWfh(req.ctx, req.params.groupId, req.body ?? {}));
  app.post('/requests/:groupId/cancel', async (req) => ({ cancelled: await cancelWfh(req.ctx, req.params.groupId, req.body ?? {}) }));
  app.get('/quota', async (req) => getWfhQuota(req.ctx, req.query.employeeId ?? req.ctx.actor.employeeId, { date: req.query.date }));
  app.post('/overrides', async (req, reply) => reply.status(201).send(await createOverride(req.ctx, req.body ?? {})));
}
