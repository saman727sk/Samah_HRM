import { requireHr } from '../../services/access.js';
import { listFlags, setFlag } from '../../services/features.js';

export default async function miscRoutes(app) {
  app.get('/features', async (req) => listFlags(req.ctx));
  app.put('/features/:module', async (req) => setFlag(req.ctx, req.params.module, req.body ?? {}));

  app.get('/audit', async (req) => {
    requireHr(req.ctx);
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    return (await app.db.query(
      `select * from audit_log where tenant_id = $1 and ($2::text is null or entity_type = $2) and ($3::text is null or entity_id = $3)
        order by id desc limit $4`, [req.ctx.tenant.id, req.query.entityType ?? null, req.query.entityId ?? null, limit])).rows;
  });

  /** Merged texts for a locale: product defaults, overridden by the tenant's renames. */
  app.get('/i18n/:locale', async (req) => {
    const { rows } = await app.db.query(
      `select key, value from translations where locale = $2 and (tenant_id is null or tenant_id = $1) order by (tenant_id is not null)`,
      [req.ctx.tenant.id, req.params.locale]);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
}
