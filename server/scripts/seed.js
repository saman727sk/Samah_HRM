/**
 * Prepares the database (migrations). Test data only when asked for:
 *   npm run seed                    tables only, no test data
 *   npm run seed -- --demo          add the test companies and logins (not for a live system)
 *   npm run seed -- --reset wipe the data first. In Firebase mode this also
 *                           deletes everything under FIREBASE_DB_ROOT in
 *                           Realtime Database (stop the API first).
 */
import { rm } from 'node:fs/promises';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { setupFirebase } from '../src/firebase/bootstrap.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';
import { DEMO_COMPANIES, seedSaasDemo } from '../seed/saas-demo.js';

const reset = process.argv.includes('--reset');
const demoData = process.argv.includes('--demo');
const dataDir = process.env.PGLITE_DIR ?? './.data/pglite';
if (reset && !process.env.DATABASE_URL) await rm(dataDir, { recursive: true, force: true });

const db = await createDb({ dataDir });
await migrate(db);
const sync = await setupFirebase({ db, log: (m) => console.log(`[firebase] ${m}`) });
if (sync) {
  if (reset) {
    await sync.acquireLease(); // refuses while the API is running against the same database
    await sync.wipeRemote();
    console.log('[firebase] Cleared the Realtime Database data.');
  }
  await sync.start(); // pulls existing Firebase data, or uploads the (empty) local copy
}

if (!demoData) {
  console.log('Database is ready. No test data was added (use `npm run seed -- --demo` to add test companies).');
} else if (await db.one(`select 1 from tenants where slug = 'acme'`)) {
  console.log('Demo company already exists. Use `npm run seed -- --reset` to start over.');
} else {
  const demo = await seedDemo(db, { withHistory: true });
  console.log(`Seeded "${demo.tenant.name}" with ${Object.keys(demo.employees).length} employees, ${demo.activity.events} attendance events (since the start of last month) and ${demo.activity.pending} pending requests.`);
  console.log(`Payroll: salaries for everyone, bank details for all but one; ${demo.activity.payroll.lockedPeriod} is run and locked (${demo.activity.payroll.payslips} payslips).`);
  const demoOwner = await db.one(`select 1 from users where access_level = 'super_admin' and lower(email) = 'owner@hrm.test'`);
  console.log(`Logins (password "${DEMO_PASSWORD}"): ${demoOwner ? 'owner@hrm.test (super admin), ' : ''}hr@acme.test (HR), bilal@acme.test (manager), ali@acme.test (employee)${sync ? ' (Firebase accounts)' : ''}`);
}
// Dummy companies in every subscription situation (skips the ones that exist).
const extra = demoData ? await seedSaasDemo(db) : [];
if (extra.length) {
  console.log('Test companies (password "' + DEMO_PASSWORD + '"): hr@<slug>.test (HR admin) and staff@<slug>.test (employee) for',
    DEMO_COMPANIES.map((c) => c.slug).join(', '));
}
if (sync) {
  await sync.stop(); // sends everything to Firebase before exiting
  console.log('[firebase] All data is in Realtime Database.');
}
await db.close();
process.exit(0);
