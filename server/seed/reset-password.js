/**
 * Sets a new password for an existing login, from the server (for when you are locked out).
 *   npm run reset-password -- you@yourcompany.com "a new long password"
 * Stop `npm run dev` first: the local database can only be opened by one process at a time.
 * Local sign-in only (bcrypt hash); Firebase sign-in mode is not covered.
 */
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { identity } from '../src/auth/identity.js';

const [email, password] = process.argv.slice(2);
if (!email?.includes('@') || !password || password.length < 8) {
  console.error('Usage: npm run reset-password -- you@yourcompany.com "a new password of at least 8 characters"');
  process.exit(1);
}

const db = await createDb();
try {
  await migrate(db);
  const { passwordHash } = await identity().createAccount({ password });
  const rows = await db.query('update users set password_hash = $2 where lower(email) = lower($1) returning id', [email, passwordHash]);
  const count = rows.rows.length;
  if (!count) {
    console.error(`No login with ${email} exists. Nothing was changed.`);
    process.exitCode = 1;
  } else {
    console.log(`Password updated for ${email}${count > 1 ? ` (${count} logins)` : ''}. Start the server again and sign in.`);
  }
} finally {
  await db.close();
}
