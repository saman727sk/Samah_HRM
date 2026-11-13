import { todayIn } from './dates.js';

/** Injectable clock so tests (and the demo) can pin "now". */
export function systemClock() {
  return { now: () => new Date() };
}

export function fixedClock(iso) {
  let current = new Date(iso);
  return { now: () => new Date(current), set: (next) => { current = new Date(next); } };
}

export const tenantToday = (ctx) => todayIn(ctx.tenant.timezone, ctx.clock.now());
