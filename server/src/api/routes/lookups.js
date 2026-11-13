import { createLookup, deleteLookup, listLookup, updateLookup } from '../../services/lookups.js';

export default async function lookupRoutes(app) {
  app.get('/:entity', async (req) => listLookup(req.ctx, req.params.entity, { includeInactive: req.query.includeInactive !== 'false' }));
  app.post('/:entity', async (req, reply) => reply.status(201).send(await createLookup(req.ctx, req.params.entity, req.body ?? {})));
  app.patch('/:entity/:id', async (req) => updateLookup(req.ctx, req.params.entity, req.params.id, req.body ?? {}));
  app.delete('/:entity/:id', async (req, reply) => {
    await deleteLookup(req.ctx, req.params.entity, req.params.id);
    return reply.status(204).send();
  });
}
