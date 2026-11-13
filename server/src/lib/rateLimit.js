/**
 * In-memory sliding-window limiter for public endpoints (login, sign-up).
 * Per API process: with several instances, put the limit in front of them
 * (reverse proxy) or move it to Redis.
 */
import { AppError } from './errors.js';

export function rateLimiter({ limit, windowMs, message = 'Too many attempts. Please wait a few minutes and try again.' }) {
  const hits = new Map(); // key -> timestamps
  return function hit(key, now = Date.now()) {
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= limit) throw new AppError(429, 'rate_limited', message);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) {
      for (const [k, list] of hits) if (list.every((t) => t <= now - windowMs)) hits.delete(k);
    }
  };
}
