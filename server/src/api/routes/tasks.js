import { addFile, createLog, deleteFile, deleteLog, getFile, listLogs, updateLog } from '../../services/tasks.js';

// A 10 MB file is about 13.4 MB as base64 JSON.
const UPLOAD_LIMIT = 15 * 1024 * 1024;

export default async function taskRoutes(app) {
  app.get('/', async (req) => listLogs(req.ctx, req.query));
  app.post('/', async (req, reply) => reply.status(201).send(await createLog(req.ctx, req.body ?? {})));
  app.patch('/:id', async (req) => updateLog(req.ctx, req.params.id, req.body ?? {}));
  app.delete('/:id', async (req, reply) => { await deleteLog(req.ctx, req.params.id); return reply.status(204).send(); });

  app.post('/:id/files', { bodyLimit: UPLOAD_LIMIT }, async (req, reply) =>
    reply.status(201).send(await addFile(req.ctx, req.params.id, req.body ?? {})));
  app.get('/files/:fileId', async (req, reply) => {
    const f = await getFile(req.ctx, req.params.fileId);
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_');
    return reply.header('content-type', f.mime).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('cache-control', 'private, no-store').send(f.buffer);
  });
  app.delete('/files/:fileId', async (req, reply) => { await deleteFile(req.ctx, req.params.fileId); return reply.status(204).send(); });
}
