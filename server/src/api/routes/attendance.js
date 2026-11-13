import {
  cancelCorrection, daySummaries, listCorrections, punch, recordManual, requestCorrection, timeAnchor, todayStatus,
} from '../../services/attendance.js';
import { requireHr } from '../../services/access.js';
import { runTenantJobs } from '../../services/jobs.js';

const me = (req, id) => id ?? req.ctx.actor.employeeId;

export default async function attendanceRoutes(app) {
  app.get('/time-anchor', async (req) => timeAnchor(req.ctx));
  app.post('/punch', async (req, reply) => {
    // Client IP is taken from the connection, never from the body.
    const result = await punch(req.ctx, { ...req.body, employeeId: me(req, req.body?.employeeId), ip: req.ip });
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });
  app.get('/today', async (req) => todayStatus(req.ctx, me(req, req.query.employeeId)));
  app.get('/days', async (req) => daySummaries(req.ctx, me(req, req.query.employeeId), { from: req.query.from, to: req.query.to }));

  /** HR / a manager records attendance for someone else (forgot to check in, phone broken...). */
  app.post('/manual', async (req, reply) => reply.status(201).send(await recordManual(req.ctx, req.body ?? {})));

  app.get('/corrections', async (req) => listCorrections(req.ctx, { employeeId: req.query.employeeId, status: req.query.status }));
  app.post('/corrections', async (req, reply) =>
    reply.status(201).send(await requestCorrection(req.ctx, { ...req.body, employeeId: me(req, req.body?.employeeId) })));
  app.post('/corrections/:id/cancel', async (req, reply) => { await cancelCorrection(req.ctx, req.params.id); return reply.status(204).send(); });

  /** Runs auto-close + escalation now for this company (also scheduled). */
  app.post('/jobs/run', async (req) => { requireHr(req.ctx); return runTenantJobs(app.db, app.clock, req.ctx.tenant); });
}
