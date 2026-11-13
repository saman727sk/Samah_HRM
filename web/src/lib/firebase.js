/**
 * Firebase client. Config comes from web/.env (VITE_FIREBASE_*), never from
 * source. Without a config the app runs as before and firebaseApp is null.
 *
 * Note: Firebase web config is not a secret (it ships in the browser bundle).
 * Keeping it in .env keeps it out of git; real protection comes from
 * Firebase Security Rules and API-key restrictions in the Google Cloud console.
 */
import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported, logEvent } from 'firebase/analytics';
import { getAuth } from 'firebase/auth';

const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const firebaseApp = config.apiKey && config.projectId && config.appId ? initializeApp(config) : null;

/** Firebase Authentication (email/password), used when the API runs in Firebase mode. */
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;

// Analytics needs a browser with cookies/IndexedDB; skip quietly where it isn't available.
const analytics = firebaseApp && config.measurementId
  ? isSupported().then((ok) => (ok ? getAnalytics(firebaseApp) : null)).catch(() => null)
  : Promise.resolve(null);

/** Records an analytics event if analytics is running; never throws. */
export function track(event, params) {
  analytics.then((a) => a && logEvent(a, event, params)).catch(() => {});
}
