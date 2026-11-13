/**
 * Tiny validation helper that produces plain-language messages for HR.
 *
 * `partial: true` is used for department/role/employee overrides, which only
 * contain the fields they change: missing fields are fine, but any field that
 * IS present must be valid. The merged (effective) value is validated in full
 * separately.
 */
import { isYmd } from '../lib/dates.js';
import { syntaxError } from '../engines/formula.js';
import { getPath, isPlainObject } from '../lib/util.js';

export { dayName } from '../lib/dates.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checker(value, { partial = false } = {}) {
  const errors = [];
  const warnings = [];
  const present = (path) => getPath(value, path) !== undefined;

  /** Runs `test` on a field; handles required / nullable / partial. */
  function field(path, label, test, { nullable = false, optional = false } = {}) {
    const v = getPath(value, path);
    if (v === undefined) {
      if (!partial && !optional) errors.push({ path, message: `${label} is required.` });
      return;
    }
    if (v === null) {
      if (!nullable) errors.push({ path, message: `${label} cannot be empty.` });
      return;
    }
    const problem = test(v);
    if (problem) errors.push({ path, message: `${label} ${problem}` });
  }

  const c = {
    errors,
    warnings,
    present,
    get: (path) => getPath(value, path),
    bool: (path, label, opts) => field(path, label, (v) => (typeof v === 'boolean' ? null : 'must be yes or no.'), opts),
    int: (path, label, { min = -Infinity, max = Infinity, ...opts } = {}) =>
      field(path, label, (v) => (Number.isInteger(v) && v >= min && v <= max ? null : rangeText('a whole number', min, max)), opts),
    num: (path, label, { min = -Infinity, max = Infinity, ...opts } = {}) =>
      field(path, label, (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? null : rangeText('a number', min, max)), opts),
    oneOf: (path, label, options, opts) =>
      field(path, label, (v) => (options.includes(v) ? null : `must be one of: ${options.join(', ')}.`), opts),
    text: (path, label, { max = 500, ...opts } = {}) =>
      field(path, label, (v) => (typeof v === 'string' && v.trim() && v.length <= max ? null : `must be text of up to ${max} characters.`), opts),
    date: (path, label, opts) => field(path, label, (v) => (isYmd(v) ? null : 'must be a date like 2026-03-23.'), opts),
    time: (path, label, opts) =>
      field(path, label, (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'must be a time like 09:00.'), opts),
    weekdays: (path, label, opts) =>
      field(path, label, (v) =>
        Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && new Set(v).size === v.length
          ? null : 'must be a list of distinct weekdays (0 = Sunday ... 6 = Saturday).', opts),
    subset: (path, label, options, { min = 0, ...opts } = {}) =>
      field(path, label, (v) =>
        Array.isArray(v) && v.every((x) => options.includes(x)) && new Set(v).size === v.length && v.length >= min
          ? null : `must be ${min ? `at least ${min} of` : 'any of'}: ${options.join(', ')}.`, opts),
    ids: (path, label, opts) =>
      field(path, label, (v) => (Array.isArray(v) && v.every((x) => UUID_RE.test(x)) ? null : 'must be a list of record ids.'), opts),
    list: (path, label, itemTest, opts) =>
      field(path, label, (v) => {
        if (!Array.isArray(v)) return 'must be a list.';
        for (let i = 0; i < v.length; i++) {
          const p = itemTest(v[i], i);
          if (p) return `item ${i + 1}: ${p}`;
        }
        return null;
      }, opts),
    object: (path, label, opts) => field(path, label, (v) => (isPlainObject(v) ? null : 'must be a group of settings.'), opts),
    /** A formula (see engines/formula.js); `functions` lists the callable functions. */
    formula: (path, label, { functions, ...opts } = {}) =>
      field(path, label, (v) => (typeof v !== 'string' ? 'must be a formula.' : syntaxError(v, { functions })), opts),
    /** Named formulas: { NAME: 'formula' | number }. */
    formulaMap: (path, label, { functions, nameRe = /^[A-Z][A-Z0-9_]{0,39}$/, ...opts } = {}) =>
      field(path, label, (v) => {
        if (!isPlainObject(v)) return 'must be a list of named formulas.';
        for (const [name, f] of Object.entries(v)) {
          if (!nameRe.test(name)) return `"${name}" is not a valid name (use capital letters, digits and _).`;
          if (typeof f === 'number' && Number.isFinite(f)) continue;
          const problem = typeof f === 'string' ? syntaxError(f, { functions }) : 'must be a formula.';
          if (problem) return `${name}: ${problem}`;
        }
        return null;
      }, opts),
    /** Flags unknown keys so typos ("maxPerWek") don't silently do nothing. */
    allowKeys(path, keys) {
      const obj = path ? getPath(value, path) : value;
      if (!isPlainObject(obj)) return;
      for (const k of Object.keys(obj)) {
        if (!keys.includes(k)) errors.push({ path: path ? `${path}.${k}` : k, message: `"${k}" is not a known setting here.` });
      }
    },
    rule(ok, path, message) { if (!ok) errors.push({ path, message }); },
    warn(cond, path, message) { if (cond) warnings.push({ path, message }); },
    result: () => ({ ok: errors.length === 0, errors, warnings }),
  };
  return c;
}

/**
 * Runs a definition's validate() against a recorder instead of a value and
 * returns the field list in declaration order. The web app renders setting
 * forms from this, so a form can never drift from its validation rules.
 */
export function describeFields(validate, { refs = {}, listItems = {}, help = {} } = {}) {
  const fields = [];
  const groups = {};
  const add = (type) => (path, label, a = {}, b = {}) => {
    const opts = Array.isArray(a) ? { ...b, options: a } : typeof a === 'function' ? b : a;
    if (type === 'object') { groups[path] = label; return; }
    fields.push({
      path, label, type: refs[path] ? 'refs' : type, entity: refs[path], options: opts.options, min: opts.min, max: opts.max,
      nullable: !!opts.nullable, columns: listItems[path], help: help[path], group: path.includes('.') ? path.split('.')[0] : null,
    });
  };
  const recorder = {
    errors: [], warnings: [], present: () => false, get: () => undefined,
    bool: add('bool'), int: add('int'), num: add('num'), oneOf: add('select'), text: add('text'), date: add('date'), time: add('time'),
    weekdays: add('weekdays'), ids: add('ids'), subset: add('multi'), object: add('object'),
    formula: add('formula'), formulaMap: add('formula-map'),
    list: (path, label, _test, opts) => add('rows')(path, label, opts),
    allowKeys() {}, rule() {}, warn() {}, result: () => ({}),
  };
  validate(recorder);
  return fields.map((f) => ({ ...f, groupLabel: f.group ? groups[f.group] : null }));
}

function rangeText(kind, min, max) {
  if (min > -Infinity && max < Infinity) return `must be ${kind} between ${min} and ${max}.`;
  if (min > -Infinity) return `must be ${kind} of at least ${min}.`;
  if (max < Infinity) return `must be ${kind} of at most ${max}.`;
  return `must be ${kind}.`;
}
