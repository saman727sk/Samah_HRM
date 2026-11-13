/* eslint-disable react/only-export-components */
/**
 * App-wide state: session (user, tenant, employee), texts/language, theme
 * and toasts. Screen texts come from the server's translations table
 * (GET /i18n/:locale) so HR can rename terms; the English fallback passed
 * to t() is used when no translation exists.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { firebaseAuth, track } from './firebase.js';
import { get, getToken, post, setApiLocale, setToken, setTokenProvider, setUnauthorizedHandler, storage } from './api.js';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const RTL = new Set(['ur', 'ar', 'fa']);

const format = (template, params) => template.replace(/\{(\w+)\}/g, (m, k) => (params?.[k] ?? m));

const FIREBASE_ERRORS = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/user-disabled': 'This account is disabled. Ask HR.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment or reset your password.',
  'auth/network-request-failed': 'No connection to Firebase. Check your internet.',
};
const friendly = (err) => new Error(FIREBASE_ERRORS[err.code] ?? err.message);

export function AppProvider({ children }) {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [locale, setLocale] = useState(() => storage.get('hrm.locale') ?? 'en');
  const [texts, setTexts] = useState({});
  const [theme, setTheme] = useState(() => storage.get('hrm.theme') ?? 'system');
  const [toasts, setToasts] = useState([]);
  const [provider, setProvider] = useState(null); // 'firebase' | 'password', from GET /auth/config
  const [signupEnabled, setSignupEnabled] = useState(false); // companies may register themselves

  const toast = useCallback((message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const logout = useCallback(() => {
    setToken(null); setSession(null);
    if (provider === 'firebase' && firebaseAuth) signOut(firebaseAuth).catch(() => {});
  }, [provider]);
  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  const loadSession = useCallback(async () => {
    // Returns the session (or null) so sign-in can greet with the company's name.
    try { const me = await get('/me'); setSession(me); return me; } catch { setToken(null); setSession(null); return null; } finally { setBooting(false); }
  }, []);

  // Ask the API how to sign in. Firebase mode: the Firebase user drives the session.
  useEffect(() => {
    let unsubscribe = () => {};
    get('/auth/config').catch(() => ({ provider: 'password' })).then(({ provider: p, signupEnabled: s }) => {
      setProvider(p);
      setSignupEnabled(!!s);
      if (p === 'firebase' && firebaseAuth) {
        setTokenProvider(async () => (firebaseAuth.currentUser ? firebaseAuth.currentUser.getIdToken() : null));
        unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
          if (user) loadSession(); else { setSession(null); setBooting(false); }
        });
      } else if (getToken()) loadSession();
      else setBooting(false);
    });
    return () => unsubscribe();
  }, [loadSession]);

  /** Local mode: a token the API issued directly (e.g. after confirming a sign-up email). */
  const signInWithToken = useCallback(async (token) => {
    setToken(token);
    return loadSession();
  }, [loadSession]);

  /** tenantId: the company chosen when the email has a login in several (error code 'choose_company'). */
  const login = useCallback(async (email, password, tenantId) => {
    if (provider === 'firebase') {
      if (!firebaseAuth) throw new Error('This server uses Firebase sign-in, but the web app has no Firebase config (web/.env).');
      try { await signInWithEmailAndPassword(firebaseAuth, email, password); } catch (err) { throw friendly(err); }
      track('login', { method: 'firebase' });
      try { setSession(await get('/me')); } catch (err) {
        await signOut(firebaseAuth).catch(() => {}); // e.g. a Firebase account with no HRM login
        throw err;
      }
      return;
    }
    const res = await post('/auth/login', { email, password, tenantId });
    // Two-step sign-in: no session yet; the page asks for the emailed code.
    if (res.otpRequired) return { otp: res };
    setToken(res.token);
    track('login', { method: 'password' });
    return loadSession();
  }, [loadSession, provider]);

  /** Second step of sign-in: the 6-digit code from the email. */
  const verifyOtp = useCallback(async (challenge, code) => {
    const { token } = await post('/auth/login/otp', { challenge, code });
    setToken(token);
    track('login', { method: 'password+otp' });
    return loadSession();
  }, [loadSession]);
  const resendOtp = useCallback((challenge) => post('/auth/login/otp/resend', { challenge }), []);

  /** Firebase mode only: emails a password-reset link. */
  const resetPassword = useCallback(async (email) => {
    try { await sendPasswordResetEmail(firebaseAuth, email); } catch (err) { throw friendly(err); }
  }, []);

  useEffect(() => {
    storage.set('hrm.locale', locale);
    setApiLocale(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = RTL.has(locale) ? 'rtl' : 'ltr';
    if (!session?.tenant) return;
    get(`/i18n/${locale}`).then(setTexts).catch(() => setTexts({}));
  }, [locale, session?.tenant]);

  useEffect(() => {
    storage.set('hrm.theme', theme);
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const t = useCallback((key, fallback, params) => format(texts[key] ?? fallback ?? key, params), [texts]);

  const value = useMemo(() => ({
    session, booting, login, verifyOtp, resendOtp, logout, resetPassword, provider, signupEnabled, signInWithToken, reloadSession: loadSession, t, locale, setLocale, theme, setTheme, toast,
    level: session?.user?.accessLevel, isHr: session?.user?.accessLevel === 'hr_admin',
    isManager: ['manager', 'hr_admin'].includes(session?.user?.accessLevel),
    tz: session?.tenant?.timezone ?? 'Asia/Karachi',
  }), [session, booting, login, verifyOtp, resendOtp, loadSession, t, locale, theme, toast, logout, resetPassword, provider, signupEnabled, signInWithToken]);

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => <div key={x.id} className={`toast ${x.kind}`}>{x.message}</div>)}
      </div>
    </AppContext.Provider>
  );
}

// ---------------------------------------------------------------------
// Minimal hash router: #/path?query
// ---------------------------------------------------------------------
const parse = () => {
  const [path, query = ''] = (window.location.hash.slice(1) || '/').split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
};

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (to) => { window.location.hash = to; };
