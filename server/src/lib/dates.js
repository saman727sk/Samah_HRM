/**
 * Business-date helpers. Business dates are 'YYYY-MM-DD' strings and all
 * arithmetic is done in UTC so DST/host timezone never shifts a day.
 * "Now" is always converted into the tenant's timezone first (todayIn).
 */
const DAY_MS = 86_400_000;

export const toUtc = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const fromUtc = (date) => date.toISOString().slice(0, 10);
export const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromUtc(toUtc(v)) === v;

export const addDays = (ymd, n) => fromUtc(new Date(toUtc(ymd).getTime() + n * DAY_MS));
export const diffDays = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS); // b - a
export const weekday = (ymd) => toUtc(ymd).getUTCDay(); // 0 = Sunday
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const dayName = (d) => DAY_NAMES[d];
export const minDate = (...d) => d.filter(Boolean).sort()[0];
export const maxDate = (...d) => d.filter(Boolean).sort().at(-1);

export function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return fromUtc(target);
}

export const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;
export const monthEnd = (ymd) => addDays(addMonths(monthStart(ymd), 1), -1);
export const monthKey = (ymd) => ymd.slice(0, 7);

export function startOfWeek(ymd, weekStartsOn = 1) {
  return addDays(ymd, -((weekday(ymd) - weekStartsOn + 7) % 7));
}

export function* eachDay(start, end) {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

/** Whole months completed between a and b (b >= a). */
export function fullMonthsBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let months = (by - ay) * 12 + (bm - am);
  if (bd < ad) months -= 1;
  return Math.max(0, months);
}

/** Offset (ms) of an IANA timezone from UTC at an instant. */
function tzOffsetMs(timeZone, instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant of a wall-clock time ('HH:MM') on a business date in a timezone. */
export function zonedInstant(ymd, hhmm, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(timeZone, new Date(guess));
  const second = guess - tzOffsetMs(timeZone, new Date(t)); // settles DST edges
  if (second !== t) t = second;
  return new Date(t);
}

/** Wall-clock 'HH:MM' of an instant in a timezone. */
export function localTime(instant, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
}

/** Calendar date in an IANA timezone for an instant. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
