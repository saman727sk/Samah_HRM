import { accessOverview, setAccess, setTeam, setTeamFeatures, teamFeatures } from '../../services/teamAccess.js';

/** /api/access: HR sets managers, teams and rights; managers choose their team's features. */
export default async function accessRoutes(app) {
  app.get('/', async (req) => accessOverview(req.ctx));
  app.get('/team', async (req) => teamFeatures(req.ctx));
  app.put('/team/:id/features', async (req) => setTeamFeatures(req.ctx, req.params.id, req.body ?? {}));
  app.put('/:id', async (req) => setAccess({ ...req.ctx, mailer: app.mailer, appUrl: app.appUrl }, req.params.id, req.body ?? {}));
  app.post('/:id/team', async (req) => setTeam(req.ctx, req.params.id, req.body ?? {}));
}
