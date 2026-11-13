/**
 * Firebase Admin SDK, configured from server/.env:
 *   FIREBASE_SERVICE_ACCOUNT       path to the service-account JSON file
 *                                  (or FIREBASE_SERVICE_ACCOUNT_JSON with its contents)
 *   FIREBASE_DATABASE_URL          Realtime Database URL
 *   FIREBASE_DB_ROOT               path inside the database (default "hrm")
 * Without these the server runs in local mode (embedded Postgres + passwords).
 */
import { readFileSync } from 'node:fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

function serviceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf8'));
  return null;
}

/** A service account is enough for Firebase Authentication. */
export const firebaseAuthConfigured = () => !!(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

/** Realtime Database as the system of record also needs its URL. */
export const firebaseConfigured = () => firebaseAuthConfigured() && !!process.env.FIREBASE_DATABASE_URL;

let app = null;
export function firebaseApp() {
  if (app) return app;
  if (!firebaseAuthConfigured()) throw new Error('Firebase is not configured (set FIREBASE_SERVICE_ACCOUNT in server/.env).');
  const account = serviceAccount();
  app = getApps()[0] ?? initializeApp({ credential: cert(account), databaseURL: process.env.FIREBASE_DATABASE_URL || undefined, projectId: account.project_id });
  return app;
}

export const adminAuth = () => getAuth(firebaseApp());
export const rtdb = () => getDatabase(firebaseApp());
export const dbRoot = () => (process.env.FIREBASE_DB_ROOT ?? 'hrm').replace(/^\/+|\/+$/g, '');
