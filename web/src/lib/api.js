/**
 * Fetch wrapper for the HRM API. Errors are thrown as ApiError carrying the
 * server's { code, message, details } so forms can show plain-language,
 * field-level messages.
 */
const TOKEN_KEY = 'hrm.token';

export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

export const getToken = () => storage.get(TOKEN_KEY);

// Firebase mode replaces this with () => currentUser.getIdToken() (refreshed automatically).
let tokenProvider = async () => getToken();
export const setTokenProvider = (fn) => { tokenProvider = fn; };
export const setToken = (t) => storage.set(TOKEN_KEY, t);

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
    this.params = body?.error?.params;
  }
  /** Human-readable reason list (policy reasons or validation errors). */
  get reasons() {
    const d = this.details ?? {};
    if (Array.isArray(d.reasons)) return d.reasons.map((r) => r.message ?? r.code);
    if (Array.isArray(d.errors)) return d.errors.map((e) => (typeof e === 'string' ? e : e.message));
    if (Array.isArray(d.results)) return d.results.flatMap((r) => r.reasons.map((x) => `${r.date}: ${x.message ?? x.code}`));
    return [];
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
let locale = 'en';
export const setApiLocale = (l) => { locale = l; };

export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'accept-language': locale };
  const token = await tokenProvider();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && path !== '/auth/login') onUnauthorized();
  if (raw && res.ok) return res;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const hint = (res.status === 404 || text?.includes('<!doctype') || text?.includes('<html'))
      ? 'Backend API not reachable. Please ensure the backend server is running and configured.'
      : (text?.slice(0, 150) || `Request failed (${res.status})`);
    throw new ApiError(res.status || 500, { error: { message: hint } });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });

/** Downloads an authenticated file (CSV/JSON export). */
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const str = s.toString();
  return str ? `?${str}` : '';
};
