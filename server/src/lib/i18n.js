/**
 * Screen and message texts come from the translations table.
 * Lookup order: tenant override (locale) > product default (locale) >
 * tenant override (en) > product default (en) > the code itself.
 * Templates use {param} slots.
 */
const cache = new Map(); // `${tenantId}:${locale}` -> Map(key -> template)

export function invalidateTranslations(tenantId) {
  for (const k of cache.keys()) if (k.startsWith(`${tenantId}:`)) cache.delete(k);
}

async function load(db, tenantId, locale) {
  const ck = `${tenantId}:${locale}`;
  if (!cache.has(ck)) {
    // Tenant rows sort last so they overwrite product defaults in the Map.
    const { rows } = await db.query(
      `select key, value from translations
        where locale = $2 and (tenant_id is null or tenant_id = $1)
        order by (tenant_id is not null)`,
      [tenantId, locale],
    );
    cache.set(ck, new Map(rows.map((r) => [r.key, r.value])));
  }
  return cache.get(ck);
}

export const format = (template, params = {}) =>
  template.replace(/\{(\w+)\}/g, (m, k) => String(params[k] ?? m));

export async function translator(db, tenantId, locale = 'en') {
  const primary = await load(db, tenantId, locale);
  const fallback = locale === 'en' ? primary : await load(db, tenantId, 'en');
  return (code, params) => {
    const template = primary.get(code) ?? fallback.get(code);
    return template ? format(template, params) : code;
  };
}

/** Adds a rendered `message` to every { code, params } item. */
export async function localize(db, tenantId, locale, items) {
  const t = await translator(db, tenantId, locale);
  return items.map((i) => ({ ...i, message: t(i.code, i.params) }));
}
