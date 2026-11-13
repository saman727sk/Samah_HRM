export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge for layered settings: objects merge, arrays/scalars replace. */
export function deepMerge(base, layer) {
  if (!isPlainObject(base) || !isPlainObject(layer)) return structuredClone(layer);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(layer)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Structural diff: [{ path, change: 'added' | 'removed' | 'changed', old, new }] */
export function diffValues(oldV, newV, prefix = '') {
  const changes = [];
  if (isPlainObject(oldV) && isPlainObject(newV)) {
    const keys = [...new Set([...Object.keys(oldV), ...Object.keys(newV)])].sort();
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in oldV)) changes.push({ path: p, change: 'added', old: undefined, new: newV[k] });
      else if (!(k in newV)) changes.push({ path: p, change: 'removed', old: oldV[k], new: undefined });
      else changes.push(...diffValues(oldV[k], newV[k], p));
    }
  } else if (!deepEqual(oldV, newV)) {
    const change = oldV === undefined ? 'added' : newV === undefined ? 'removed' : 'changed';
    changes.push({ path: prefix || '(root)', change, old: oldV, new: newV });
  }
  return changes;
}

export const round2 = (n) => Math.round(n * 100) / 100;
/** Round to the nearest multiple of `step` (e.g. 0.5 days). */
export const roundToStep = (n, step) => (step > 0 ? Math.round(n / step) * step : n);
