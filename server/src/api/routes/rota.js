/** Rota planner (managers for their people, HR for everyone) and each person's own upcoming shifts. */
import { copyWeek, getRota, myRota, saveRota } from '../../services/rota.js';

export default async function rotaRoutes(app) {
  app.get('/', async (req) => getRota(req.ctx, { week: req.query.week, departmentId: req.query.departmentId || null }));
  app.put('/', async (req) => saveRota(req.ctx, req.body ?? {}));
  app.post('/copy', async (req) => copyWeek(req.ctx, req.body ?? {}));
  app.get('/me', async (req) => myRota(req.ctx, { from: req.query.from, days: req.query.days }));
}
