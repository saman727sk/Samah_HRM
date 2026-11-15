/** Help desk: employees ask HR, HR answers in a thread. */
import { getTicket, listTickets, openCount, openTicket, replyTicket, setTicketStatus } from '../../services/helpdesk.js';

export default async function helpdeskRoutes(app) {
  app.get('/', async (req) => listTickets(req.ctx, { status: req.query.status || null, q: req.query.q || null }));
  app.get('/open-count', async (req) => openCount(req.ctx));
  app.post('/', async (req, reply) => reply.status(201).send(await openTicket(req.ctx, req.body ?? {})));
  app.get('/:id', async (req) => getTicket(req.ctx, req.params.id));
  app.post('/:id/messages', async (req) => replyTicket(req.ctx, req.params.id, req.body ?? {}));
  app.post('/:id/status', async (req) => setTicketStatus(req.ctx, req.params.id, req.body ?? {}));
}
