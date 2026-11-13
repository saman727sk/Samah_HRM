/**
 * Formula language for payroll (sandboxed: parsed to a tree and walked,
 * never handed to eval/Function, so a formula can only do arithmetic on
 * the variables and functions we pass in).
 *
 *   numbers      1500, 0.45, 1_000_000
 *   variables    BASIC, DAILY_RATE, ABSENT_DAYS   (letters, digits, _)
 *   operators    + - * / % ^   < <= > >= == !=   and or not  (also && || !)
 *   functions    min max round floor ceil abs clamp if, plus any the
 *                caller adds (payroll adds tax()).
 *
 * Comparisons and logic return 1 / 0, so `if(LATE_COUNT > 3, 500, 0)` and
 * `(LATE_COUNT > 3) * 500` both work. if() only evaluates the branch taken.
 */

export class FormulaError extends Error {
  constructor(message, pos = null) {
    super(message);
    this.pos = pos;
  }
}

const MAX_LENGTH = 1000;
const MAX_NODES = 400;
const MAX_DEPTH = 40;

export const FUNCTIONS = {
  min: { args: [1, Infinity], help: 'Smallest value: min(a, b, ...)', fn: (...a) => Math.min(...a) },
  max: { args: [1, Infinity], help: 'Largest value: max(a, b, ...)', fn: (...a) => Math.max(...a) },
  round: {
    args: [1, 2], help: 'Round to N decimals: round(x) or round(x, 2)',
    fn: (x, d = 0) => { const f = 10 ** Math.max(0, Math.min(6, Math.trunc(d))); return Math.round((x + Number.EPSILON) * f) / f; },
  },
  floor: { args: [1, 1], help: 'Round down: floor(x)', fn: Math.floor },
  ceil: { args: [1, 1], help: 'Round up: ceil(x)', fn: Math.ceil },
  abs: { args: [1, 1], help: 'Absolute value: abs(x)', fn: Math.abs },
  clamp: { args: [3, 3], help: 'Keep x between lo and hi: clamp(x, lo, hi)', fn: (x, lo, hi) => Math.min(Math.max(x, lo), hi) },
  if: { args: [3, 3], help: 'if(condition, value when true, value when false)', lazy: true },
};

// ---------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------
const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '<', '>', '!', '(', ')', ','];
const WORD_OPS = { and: '&&', or: '||', not: '!' };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:\d[\d_]*)?(?:\.\d+)?/.exec(src.slice(i));
      if (!m[0] || m[0] === '.') throw new FormulaError(`Unexpected "${ch}"`, i);
      tokens.push({ type: 'num', value: Number(m[0].replaceAll('_', '')), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const [word] = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (WORD_OPS[word.toLowerCase()]) tokens.push({ type: 'op', value: WORD_OPS[word.toLowerCase()], pos: i });
      else tokens.push({ type: 'id', value: word, pos: i });
      i += word.length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected "${ch}"`, i);
    tokens.push({ type: 'op', value: op, pos: i });
    i += op.length;
  }
  tokens.push({ type: 'end', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------
// Parser (recursive descent, lowest to highest precedence)
//   or > and > not > comparison > + - > * / % > unary - > ^ > primary
// ---------------------------------------------------------------------
export function parse(src, { functions = FUNCTIONS } = {}) {
  if (typeof src !== 'string' || !src.trim()) throw new FormulaError('The formula is empty.');
  if (src.length > MAX_LENGTH) throw new FormulaError(`The formula is too long (max ${MAX_LENGTH} characters).`);
  const tokens = tokenize(src);
  let p = 0;
  let nodes = 0;
  const peek = () => tokens[p];
  const isOp = (...ops) => peek().type === 'op' && ops.includes(peek().value);
  const node = (n, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new FormulaError('The formula is too complex.');
    if (depth > MAX_DEPTH) throw new FormulaError('The formula is nested too deeply.');
    return n;
  };
  const expect = (op) => {
    if (!isOp(op)) {
      const t = peek();
      throw new FormulaError(t.type === 'end' ? `Expected "${op}" at the end` : `Expected "${op}" but found "${t.value}"`, t.pos);
    }
    p += 1;
  };
  const binary = (next, ops) => (d) => {
    let left = next(d + 1);
    while (isOp(...ops)) {
      const op = tokens[p++].value;
      left = node({ type: 'bin', op, left, right: next(d + 1) }, d);
    }
    return left;
  };

  const primary = (d) => {
    const t = peek();
    if (t.type === 'num') { p += 1; return node({ type: 'num', value: t.value }, d); }
    if (t.type === 'id') {
      p += 1;
      if (!isOp('(')) return node({ type: 'var', name: t.value, pos: t.pos }, d);
      const fn = functions[t.value];
      if (!fn) throw new FormulaError(`Unknown function "${t.value}"`, t.pos);
      p += 1;
      const args = [];
      if (!isOp(')')) {
        do { args.push(or(d + 1)); } while (isOp(',') && ++p);
      }
      expect(')');
      const [lo, hi] = fn.args;
      if (args.length < lo || args.length > hi) {
        throw new FormulaError(`${t.value}() takes ${lo === hi ? lo : hi === Infinity ? `at least ${lo}` : `${lo} to ${hi}`} value(s)`, t.pos);
      }
      return node({ type: 'call', name: t.value, args, pos: t.pos }, d);
    }
    if (isOp('(')) {
      p += 1;
      const inner = or(d + 1);
      expect(')');
      return inner;
    }
    throw new FormulaError(t.type === 'end' ? 'The formula ends too early' : `Unexpected "${t.value}"`, t.pos);
  };
  const power = (d) => {
    const base = primary(d + 1);
    if (isOp('^')) { p += 1; return node({ type: 'bin', op: '^', left: base, right: unary(d + 1) }, d); }
    return base;
  };
  const unary = (d) => {
    if (isOp('-', '+')) {
      const op = tokens[p++].value;
      const arg = unary(d + 1);
      return op === '-' ? node({ type: 'neg', arg }, d) : arg;
    }
    return power(d);
  };
  const mul = binary(unary, ['*', '/', '%']);
  const add = binary(mul, ['+', '-']);
  const cmp = (d) => {
    const left = add(d + 1);
    if (isOp('<', '<=', '>', '>=', '==', '!=')) {
      const op = tokens[p++].value;
      return node({ type: 'bin', op, left, right: add(d + 1) }, d);
    }
    return left;
  };
  const not = (d) => {
    if (isOp('!')) { p += 1; return node({ type: 'not', arg: not(d + 1) }, d); }
    return cmp(d);
  };
  const and = binary(not, ['&&']);
  const or = binary(and, ['||']);

  const ast = or(0);
  if (peek().type !== 'end') throw new FormulaError(`Unexpected "${peek().value}"`, peek().pos);
  return ast;
}

/** Variable names a parsed formula reads. */
export function variablesOf(ast, out = new Set()) {
  if (ast.type === 'var') out.add(ast.name);
  if (ast.type === 'bin') { variablesOf(ast.left, out); variablesOf(ast.right, out); }
  if (ast.type === 'neg' || ast.type === 'not') variablesOf(ast.arg, out);
  if (ast.type === 'call') for (const a of ast.args) variablesOf(a, out);
  return out;
}

// ---------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------
const truthy = (v) => v !== 0;

export function evaluate(ast, { vars = {}, functions = FUNCTIONS } = {}) {
  const get = (name) => {
    const v = typeof vars === 'function' ? vars(name) : vars[name];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new FormulaError(`Unknown value "${name}"`);
    return v;
  };
  const run = (n) => {
    switch (n.type) {
      case 'num': return n.value;
      case 'var': return get(n.name);
      case 'neg': return -run(n.arg);
      case 'not': return truthy(run(n.arg)) ? 0 : 1;
      case 'call': {
        const fn = functions[n.name];
        if (n.name === 'if') return truthy(run(n.args[0])) ? run(n.args[1]) : run(n.args[2]);
        const result = fn.fn(...n.args.map(run));
        if (!Number.isFinite(result)) throw new FormulaError(`${n.name}() did not return a number`);
        return result;
      }
      case 'bin': {
        if (n.op === '&&') return truthy(run(n.left)) && truthy(run(n.right)) ? 1 : 0;
        if (n.op === '||') return truthy(run(n.left)) || truthy(run(n.right)) ? 1 : 0;
        const a = run(n.left);
        const b = run(n.right);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': if (b === 0) throw new FormulaError('Division by zero'); return a / b;
          case '%': if (b === 0) throw new FormulaError('Division by zero'); return a % b;
          case '^': { const r = a ** b; if (!Number.isFinite(r)) throw new FormulaError('The result is too large'); return r; }
          case '<': return a < b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '==': return Math.abs(a - b) < 1e-9 ? 1 : 0;
          case '!=': return Math.abs(a - b) < 1e-9 ? 0 : 1;
          default: throw new FormulaError(`Unknown operator ${n.op}`);
        }
      }
      default: throw new FormulaError('Invalid formula');
    }
  };
  return run(ast);
}

/** Parse problems as a plain sentence (null when the formula is fine). */
export function syntaxError(src, opts) {
  try {
    parse(src, opts);
    return null;
  } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    return err.pos == null ? `${err.message}.` : `${err.message} (at character ${err.pos + 1}).`;
  }
}
