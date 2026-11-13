/** Writes one row to the append-only audit log. */
export async function audit(db, ctx, { action, entityType, entityId, oldValue = null, newValue = null, meta = {} }) {
  await db.query(
    `insert into audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, old_value, new_value, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenant?.id ?? null, ctx.actor?.userId ?? null, action, entityType, entityId == null ? null : String(entityId),
      oldValue, newValue, meta],
  );
}
