import { decide, inbox } from '../../services/workflow.js';
import { listNotifications, markRead } from '../../services/notifications.js';
import { consentStatus, listDevices, recordConsent, registerDevice, revokeDevice } from '../../services/privacy.js';
import { teamCalendar } from '../../services/leave.js';

export default async function workflowRoutes(app) {
  app.get('/approvals', async (req) => inbox(req.ctx, { all: req.query.all === 'true' }));
  app.post('/approvals/:taskId/decision', async (req) => decide(req.ctx, req.params.taskId, req.body ?? {}));

  app.get('/notifications', async (req) => listNotifications(req.ctx, { unreadOnly: req.query.unread === 'true' }));
  app.post('/notifications/:id/read', async (req, reply) => { await markRead(req.ctx, req.params.id); return reply.status(204).send(); });

  app.get('/consents', async (req) => consentStatus(req.ctx));
  app.post('/consents', async (req, reply) => reply.status(201).send(await recordConsent(req.ctx, req.body ?? {})));

  app.get('/devices', async (req) => listDevices(req.ctx, req.query.employeeId ?? req.ctx.actor.employeeId));
  app.post('/devices', async (req, reply) =>
    reply.status(201).send(await registerDevice(req.ctx, { ...req.body, employeeId: req.body?.employeeId ?? req.ctx.actor.employeeId })));
  app.delete('/devices/:id', async (req, reply) => { await revokeDevice(req.ctx, req.params.id); return reply.status(204).send(); });

  app.get('/team/calendar', async (req) => teamCalendar(req.ctx, { from: req.query.from, to: req.query.to, departmentId: req.query.departmentId }));
}
