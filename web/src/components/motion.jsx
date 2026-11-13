/* eslint-disable react/only-export-components */
/**
 * Decorative motion shared by the sign-in pages and the platform dashboard:
 * twinkling glitter and numbers that count up. Everything stays still for
 * visitors whose system asks for reduced motion.
 */
import { useEffect, useRef, useState } from 'react';

export const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// Fixed "random" layout per seed, so the glitter sits in the same places on every render.
function seeded(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
const layouts = new Map();
function glitterLayout(count, seed) {
  const key = `${count}:${seed}`;
  if (!layouts.has(key)) {
    const rand = seeded(seed);
    layouts.set(key, Array.from({ length: count }, (_, i) => ({
      key: i,
      left: `${(rand() * 100).toFixed(2)}%`,
      top: `${(rand() * 100).toFixed(2)}%`,
      size: 4 + Math.round(rand() * 10),
      delay: `${(rand() * 6).toFixed(2)}s`,
      twinkle: `${(2.4 + rand() * 3).toFixed(2)}s`,
      drift: `${(9 + rand() * 10).toFixed(2)}s`,
      star: rand() > 0.55,
    })));
  }
  return layouts.get(key);
}

/** Golden glitter spread over the nearest positioned parent (decorative). */
export function GlitterField({ count = 30, seed = 20261105, className = '' }) {
  return (
    <div className={`glitter-field ${className}`} aria-hidden="true">
      {glitterLayout(count, seed).map((g) => (
        <span key={g.key} className={`glitter ${g.star ? 'star' : ''}`}
          style={{ left: g.left, top: g.top, width: g.size, height: g.size, '--delay': g.delay, '--twinkle': g.twinkle, '--drift': g.drift }} />
      ))}
    </div>
  );
}

/** Counts up to `value` when it appears or changes; `format` turns the number into text. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString('en-US'), duration = 1100 }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? target : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (prefersReducedMotion()) { from.current = target; const id = requestAnimationFrame(() => setShown(target)); return () => cancelAnimationFrame(id); }
    const start = performance.now();
    const begin = from.current;
    let id;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3; // ease-out
      const v = t === 1 ? target : begin + (target - begin) * eased;
      from.current = v;
      setShown(v);
      if (t < 1) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [target, duration]);
  return <span className="count-up">{format(shown)}</span>;
}
