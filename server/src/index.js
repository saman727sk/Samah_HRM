/**
 * API server entry point.
 *   DATABASE_URL     Postgres connection string (omit to use embedded PGlite)
 *   PGLITE_DIR       where embedded data is stored (default ./.data/pglite)
 *   JWT_SECRET       token signing secret (required in production)
 *   PORT             default 4000
 *   JOBS_INTERVAL_S  background jobs interval in seconds (default 300, 0 = off)
 *   FIREBASE_*       Firebase Auth + Realtime Database (see src/firebase/admin.js)
 *   SMTP_*           outgoing email (see .env.example)
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   online card payments (Stripe Checkout)
 *   APP_URL          the web app's address, for email links and payment redirects
 */
import { buildApp } from './api/app.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { setupFirebase } from './firebase/bootstrap.js';
import { systemClock } from './lib/clock.js';
import { runAllJobs } from './services/jobs.js';
import { emailProvider, emailTransportFromEnv } from './services/notifications.js';
import { paymentProviderFromEnv } from './services/payments.js';

const production = process.env.NODE_ENV === 'production';
if (production && !process.env.JWT_SECRET) throw new Error('Set JWT_SECRET in production.');

const db = await createDb({ dataDir: process.env.PGLITE_DIR ?? './.data/pglite' });
// Say which database this is (never the password).
const dbUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const { v } = await db.one(`select split_part(version(), ' ', 2) as v`);
console.log(dbUrl
  ? `[db] PostgreSQL ${v}: database "${dbUrl.pathname.slice(1)}" on ${dbUrl.hostname}:${dbUrl.port || 5432} as ${decodeURIComponent(dbUrl.username)}`
  : `[db] embedded PGlite (Postgres ${v}) in ${process.env.PGLITE_DIR ?? './.data/pglite'}`);
await migrate(db);
// Firebase mode: logins via Firebase Auth, data written through to Realtime Database.
const sync = await setupFirebase({ db, log: (m) => console.log(`[firebase] ${m}`) });
if (sync) await sync.start();
const clock = systemClock();
// SMTP when configured; otherwise emails go to the log (with their text outside production, e.g. sign-up links).
const transport = await emailTransportFromEnv((m) => console.log(m), { showBody: !production });
const payments = await paymentProviderFromEnv();
const app = buildApp({ db, clock, jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me', logger: true, mailer: transport, payments });
await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
app.log.info(emailProvider() ? `emails are sent through ${emailProvider()}` : 'emails: only written to the log (set RESEND_API_KEY or SMTP_HOST)');
app.log.info(payments ? `online payments: ${payments.name}` : 'online payments: off (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)');

// Auto-close forgotten sessions, escalate overdue approvals, billing, send queued emails.
// With several API instances, run this in one worker only.
const intervalS = Number(process.env.JOBS_INTERVAL_S ?? 300);
if (intervalS > 0) {
  const tick = () => runAllJobs(db, clock, { transport })
    .then((r) => app.log.info({ jobs: r }, 'background jobs ran'))
    .catch((err) => app.log.error(err, 'background jobs failed'));
  setInterval(tick, intervalS * 1000).unref();
  tick();
}

// Send any unsent changes to Firebase and release the writer lease on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close().catch(() => {});
    if (sync) await sync.stop().catch((err) => console.error(`[firebase] ${err.message}`));
    await db.close();
    process.exit(0);
  });
}
