/**
 * Background jobs, run by the scheduler in src/index.js (and on demand by HR):
 * auto-close forgotten sessions, escalate overdue approvals, billing, send emails.
 * Importing this module also registers every workflow request handler.
 */
import { autoCloseSessions } from './attendance.js';
import { runBillingJobs } from './billing.js';
import { purgeExpiredSignups } from './signup.js';
import { dispatchEmails } from './notifications.js';
import { runEscalations } from './workflow.js';
import './leave.js';
import './wfh.js';
import './overtime.js';
import './payroll.js';

const systemCtx = (db, clock, tenant, jwtSecret) => ({ db, clock, tenant, jwtSecret, actor: { system: true }, locale: tenant.default_locale });

export async function runTenantJobs(db, clock, tenant) {
  const ctx = systemCtx(db, clock, tenant);
  return { autoClosed: await autoCloseSessions(ctx), escalated: await runEscalations(ctx) };
}

export async function runAllJobs(db, clock, { transport } = {}) {
  const { rows: tenants } = await db.query(`select * from tenants where status = 'active'`);
  const results = {};
  for (const t of tenants) results[t.slug] = await runTenantJobs(db, clock, t);
  // Trials, renewals and overdue invoices (idempotent; queues billing emails sent below).
  results.billing = await runBillingJobs(db, clock);
  results.expiredSignupsRemoved = await purgeExpiredSignups(db, clock);
  if (transport) results.emailsSent = await dispatchEmails(db, transport);
  return results;
}
