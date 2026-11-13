/** The signed-in company's own profile and logo (HR admins edit; everyone reads). */
import { companyProfile, hasPayroll, removeLogo, setLogo, updateCompanyProfile } from '../../services/company.js';

export default async function companyRoutes(app) {
  app.get('/', async (req) => ({ ...companyProfile(req.ctx.tenant), currencyLocked: await hasPayroll(app.db, req.ctx.tenant.id) }));
  app.patch('/', async (req) => updateCompanyProfile(req.ctx, req.body ?? {}));
  app.put('/logo', async (req) => setLogo(req.ctx, req.body ?? {}));
  app.delete('/logo', async (req) => removeLogo(req.ctx));
}
