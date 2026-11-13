/**
 * Switches the server to Firebase when server/.env configures it.
 *   service account only, or DATABASE_URL set
 *       Firebase Authentication for logins; PostgreSQL holds the data
 *       (the production / multi-company setup).
 *   service account + FIREBASE_DATABASE_URL, no DATABASE_URL
 *       Firebase Authentication, and Realtime Database as the system of
 *       record (single API instance, see sync.js).
 * Returns the sync (call start()/stop()), or null when there is none.
 */
import { firebaseProvider, setIdentityProvider } from '../auth/identity.js';
import { adminAuth, firebaseAuthConfigured, firebaseConfigured } from './admin.js';
import { createFirebaseSync } from './sync.js';

export async function setupFirebase({ db, log = console.log }) {
  if (!firebaseAuthConfigured()) return null;
  setIdentityProvider(firebaseProvider(adminAuth()));
  if (process.env.DATABASE_URL || !firebaseConfigured()) {
    log('Firebase Authentication on; data stays in PostgreSQL (Realtime Database sync is off).');
    return null;
  }
  return createFirebaseSync({ db, log });
}
