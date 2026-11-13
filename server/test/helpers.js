/**
 * Test fixture: a fresh in-memory Postgres (PGlite) with the demo company,
 * and a pinned clock. Default "now" is Wednesday 2026-03-04 10:00 in
 * Asia/Karachi, so next week (Mon 9 - Fri 13 March) is free of holidays.
 */
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { fixedClock } from '../src/lib/clock.js';
import { seedDemo } from '../seed/demo.js';
import * as settings from '../src/services/settings.js';
import '../src/services/jobs.js'; // registers workflow handlers

export const JWT_SECRET = 'test-secret';

export const NOW = '2026-03-04T05:00:00Z';

export async function setup({ now = NOW } = {}) {
  const db = await createDb();
  await migrate(db);
  // Most tests sign in with a password only; test/login-otp.test.js turns the emailed code back on.
  await db.query(`update platform_settings set value = value || '{"loginOtp": false}'::jsonb where id = 'billing'`);
  const demo = await seedDemo(db, { rounds: 4 });
  const tenant = await db.one('select * from tenants where id = $1', [demo.tenant.id]);
  const clock = fixedClock(now);

  /** Request context acting as the employee with this code (E001 = HR). */
  async function as(code) {
    const user = await db.one(
      'select u.id, u.access_level, e.id as employee_id from users u join employees e on e.user_id = u.id where e.id = $1', [demo.employees[code]]);
    return { db, tenant, clock, jwtSecret: JWT_SECRET, locale: 'en', actor: { userId: user.id, accessLevel: user.access_level, employeeId: user.employee_id, tenantId: tenant.id } };
  }
  const hr = await as('E001');
  const emp = (code) => demo.employees[code];

  /** HR shortcut: draft + publish a setting change in one go. */
  async function publishSetting({ key, subjectId = null, scopeType = 'company', scopeId = null, value, patch, effectiveFrom }) {
    let next = value;
    if (patch) {
      const current = (await settings.list(hr, { key, subjectId })).find((s) => s.scope_type === scopeType && (s.scope_id ?? null) === scopeId);
      next = { ...(current?.current?.value ?? {}), ...patch };
    }
    const draft = await settings.createDraft(hr, { key, subjectId, scopeType, scopeId, value: next });
    return settings.publish(hr, draft.id, { effectiveFrom });
  }

  /** Clock in tenant local time, e.g. at('2026-03-04 08:55'). */
  const at = (local) => clock.set(new Date(local.replace(' ', 'T') + ':00+05:00'));
  const system = { db, tenant, clock, jwtSecret: JWT_SECRET, locale: 'en', actor: { system: true } };

  return { db, demo, tenant, clock, at, as, hr, emp, system, publishSetting, close: () => db.close() };
}

export const codes = (reasons) => reasons.map((r) => r.code);
