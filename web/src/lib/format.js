/** Display helpers. Times are shown in the company's timezone. */

export const fmtTime = (iso, tz) =>
  iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '—';

export const fmtDate = (ymd, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  ymd ? new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`)) : '—';

export const fmtDay = (ymd) => fmtDate(ymd, { weekday: 'short', day: 'numeric', month: 'short' });

export const hm = (minutes) => {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
};

export const todayIn = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const monthOf = (ymd) => ymd.slice(0, 7);

/** 123456.5 -> "123,456.5"; with a currency, "PKR 123,456.5" (up to that currency's decimals: JPY 0, KWD 3). */
const decimals = new Map();
const decimalsOf = (currency) => {
  if (!decimals.has(currency)) {
    try { decimals.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits); }
    catch { decimals.set(currency, 2); }
  }
  return decimals.get(currency);
};

export const fmtMoney = (n, currency) => {
  if (n == null || n === '') return '—';
  const s = Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: currency ? decimalsOf(currency) : 2 });
  return currency ? `${currency} ${s}` : s;
};

export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Last day of a 'YYYY-MM' month as 'YYYY-MM-DD'. */
export const monthEnd = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const monthLabel =(month) => fmtDate(`${month}-01`, { month: 'long', year: 'numeric' });

/** 'auto_within_limits' -> 'Auto within limits' */
export const humanize = (s) => (s == null ? '' : String(s).replace(/[_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Immutable set at a dotted path; `undefined` removes the key and prunes empty parents. */
export function setPath(obj, path, value) {
  const [head, ...rest] = path.split('.');
  const out = { ...(obj ?? {}) };
  if (!rest.length) {
    if (value === undefined) delete out[head]; else out[head] = value;
  } else {
    const child = setPath(out[head], rest.join('.'), value);
    if (child === undefined || Object.keys(child).length === 0) delete out[head]; else out[head] = child;
  }
  return out;
}
