/**
 * Who owns passwords.
 *   password  local bcrypt hashes; the API issues its own JWTs (tests, offline dev)
 *   firebase  Firebase Authentication (email/password); the browser signs in
 *             with Firebase and sends its ID token, which the API verifies
 *
 * Users are linked to Firebase by UID only (stored when the account is
 * created here), never by email, so a self-registered Firebase account can't
 * take over an HRM login that happens to share its email.
 */
import bcrypt from 'bcryptjs';
import { conflict } from '../lib/errors.js';

export const passwordProvider = (rounds = Number(process.env.BCRYPT_ROUNDS ?? 10)) => ({
  name: 'password',
  async createAccount({ password }) {
    return { passwordHash: await bcrypt.hash(password, rounds), firebaseUid: null };
  },
  /** Same as createAccount for local passwords (seeding). */
  async ensureAccount({ password }) {
    return { passwordHash: await bcrypt.hash(password, rounds), firebaseUid: null };
  },
  async removeAccount() {},
  async setDisabled() {},
  /** Local logins keep email and hash in our own database only. */
  async updateAccount() {},
});

/** auth: a firebase-admin Auth instance (or a test double with the same methods). */
export const firebaseProvider = (auth) => ({
  name: 'firebase',
  async createAccount({ email, password, displayName }) {
    try {
      const u = await auth.createUser({ email, password, displayName: displayName || undefined });
      return { passwordHash: null, firebaseUid: u.uid };
    } catch (err) {
      if (err.code === 'auth/email-already-exists') throw conflict('login_exists', 'A Firebase account with this email already exists.');
      if (err.code === 'auth/invalid-password') throw conflict('login_invalid', 'Firebase rejected the password (at least 6 characters).');
      throw err;
    }
  },
  /** Creates the Firebase account, or resets the password of an existing one (seeding only). */
  async ensureAccount({ email, password, displayName }) {
    try {
      const u = await auth.getUserByEmail(email);
      await auth.updateUser(u.uid, { password, disabled: false });
      return { passwordHash: null, firebaseUid: u.uid };
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      const u = await auth.createUser({ email, password, displayName: displayName || undefined });
      return { passwordHash: null, firebaseUid: u.uid };
    }
  },
  async removeAccount(uid) {
    if (uid) await auth.deleteUser(uid).catch(() => {});
  },
  async setDisabled(uid, disabled) {
    if (uid) await auth.updateUser(uid, { disabled });
  },
  /** Changes the Firebase account's email and/or password (undefined = unchanged). */
  async updateAccount(uid, { email, password }) {
    const patch = Object.fromEntries(Object.entries({ email, password }).filter(([, v]) => v !== undefined));
    if (!uid || !Object.keys(patch).length) return;
    try {
      await auth.updateUser(uid, patch);
    } catch (err) {
      if (err.code === 'auth/email-already-exists') throw conflict('login_exists', 'A Firebase account with this email already exists.');
      if (err.code === 'auth/invalid-password') throw conflict('login_invalid', 'Firebase rejected the password (at least 6 characters).');
      throw err;
    }
  },
  /** -> { uid, email } or throws */
  verifyToken: (token) => auth.verifyIdToken(token),
});

let current = passwordProvider();
export const identity = () => current;
export function setIdentityProvider(p) {
  current = p;
}
