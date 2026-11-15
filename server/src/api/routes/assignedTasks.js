import { assignablePeople, assignTask, deleteTask, getTask, listTasks, myOpenTasks, postMessage, setStatus, updateTask } from '../../services/assignedTasks.js';

/** /api/assigned-tasks: tasks managers give to their people, with a discussion thread each. */
export default async function assignedTaskRoutes(app) {
  app.get('/', async (req) => listTasks(req.ctx, req.query));
  app.get('/people', async (req) => assignablePeople(req.ctx));
  app.get('/me', async (req) => myOpenTasks(req.ctx));
  app.post('/', async (req, reply) => reply.status(201).send(await assignTask(req.ctx, req.body ?? {})));
  app.get('/:id', async (req) => getTask(req.ctx, req.params.id));
  app.patch('/:id', async (req) => updateTask(req.ctx, req.params.id, req.body ?? {}));
  app.delete('/:id', async (req, reply) => { await deleteTask(req.ctx, req.params.id); return reply.status(204).send(); });
  app.post('/:id/status', async (req) => setStatus(req.ctx, req.params.id, req.body ?? {}));
  app.post('/:id/messages', async (req) => postMessage(req.ctx, req.params.id, req.body ?? {}));
}
