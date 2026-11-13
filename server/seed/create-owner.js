/**
 * Creates the super admin (software owner) login for a fresh database.
 *   npm run create-owner -- you@yourcompany.com "a long password"
 * Run it once, after `npm run seed`. The password is stored as a bcrypt hash
 * (local sign-in, the default; Firebase sign-in mode is not covered).
 */
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { identity } from '../src/auth/identity.js';

const [email, password] = process.argv.slice(2);
if (!email?.includes('@') || !password || password.length < 8) {
  console.error('Usage: npm run create-owner -- you@yourcompany.com "a password of at least 8 characters"');
  process.exit(1);
}

const db = await createDb();
try {
  await migrate(db);
  if (await db.one('select 1 from users where lower(email) = lower($1)', [email])) {
    console.error(`A login with ${email} already exists. Nothing was changed.`);
    process.exitCode = 1;
  } else {
    const account = await identity().createAccount({ email: email.toLowerCase(), password, displayName: 'Super admin' });
    await db.query(`insert into users (email, password_hash, firebase_uid, access_level) values ($1, $2, $3, 'super_admin')`,
      [email.toLowerCase(), account.passwordHash, account.firebaseUid]);
    console.log(`Super admin created: ${email}. Sign in with this email and password.`);
  }
} finally {
  await db.close();
}
