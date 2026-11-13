import * as settings from '../../services/settings.js';

export default async function settingRoutes(app) {
  app.get('/settings/definitions', async () => settings.definitions());
  app.get('/settings', async (req) => settings.list(req.ctx, { key: req.query.key, subjectId: req.query.subjectId }));
  app.get('/settings/resolve', async (req) => settings.resolveFor(req.ctx, {
    key: req.query.key, subjectId: req.query.subjectId ?? null,
    employeeId: req.query.employeeId ?? req.ctx.actor.employeeId, date: req.query.date,
  }));
  app.get('/settings/templates', async (req) => settings.templates(req.ctx, req.query.key));
  app.post('/settings/templates/:id/draft', async (req, reply) =>
    reply.status(201).send(await settings.draftFromTemplate(req.ctx, req.params.id, req.body ?? {})));
  app.get('/settings/:id/versions', async (req) => settings.history(req.ctx, req.params.id));
  app.post('/settings/:id/retire', async (req, reply) => {
    await settings.retire(req.ctx, req.params.id, req.body ?? {});
    return reply.status(204).send();
  });

  app.post('/setting-versions', async (req, reply) => reply.status(201).send(await settings.createDraft(req.ctx, req.body ?? {})));
  app.get('/setting-versions/:id', async (req) => settings.getVersion(req.ctx, req.params.id));
  app.patch('/setting-versions/:id', async (req) => settings.updateDraft(req.ctx, req.params.id, req.body ?? {}));
  app.delete('/setting-versions/:id', async (req, reply) => {
    await settings.discardDraft(req.ctx, req.params.id);
    return reply.status(204).send();
  });
  app.post('/setting-versions/:id/validate', async (req) => settings.validate(req.ctx, req.params.id, { date: req.body?.effectiveFrom }));
  app.post('/setting-versions/:id/preview', async (req) => settings.preview(req.ctx, req.params.id, req.body ?? {}));
  app.post('/setting-versions/:id/publish', async (req) => settings.publish(req.ctx, req.params.id, req.body ?? {}));
  app.post('/setting-versions/:id/restore', async (req, reply) =>
    reply.status(201).send(await settings.restoreAsDraft(req.ctx, req.params.id, req.body ?? {})));
  app.get('/setting-versions/:id/diff', async (req) => settings.diff(req.ctx, req.params.id, req.query.against));
}
