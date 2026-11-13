/**
 * Payroll engine (pure functions — no database access).
 *
 * One payslip is a small dependency graph:
 *   inputs      numbers prepared from attendance, leave, salary structure,
 *               loans... (INPUTS below; read-only)
 *   variables   named formulas from 'payroll.rules' (DAILY_RATE, ...)
 *   components  salary components; each is either an amount from the
 *               employee's salary structure or a formula from its
 *               'payroll.component' rule
 *   totals      GROSS, TAXABLE_EARNINGS, TOTAL_DEDUCTIONS (sums of components)
 *
 * Everything is evaluated in dependency order, so formulas may reference
 * each other in any order; a loop (HRA uses GROSS, GROSS includes HRA) is
 * reported with the full path instead of being evaluated.
 */
import { FUNCTIONS, FormulaError, evaluate, parse, variablesOf } from './formula.js';
import { round2 } from '../lib/util.js';

/** Built-in input values available to every formula (shown in the formula builder). */
export const INPUTS = {
  CALENDAR_DAYS: 'Days in the payroll period',
  WORKING_DAYS: 'Working days in the period (excludes weekends and holidays)',
  EMPLOYED_DAYS: 'Calendar days the employee was employed in the period',
  EMPLOYED_WORKING_DAYS: 'Working days the employee was employed in the period',
  PRORATE: 'Share of the period the employee was employed (1 = full period)',
  PRESENT_DAYS: 'Days present in office or WFH (half days count 0.5)',
  WFH_DAYS: 'Days worked from home',
  ABSENT_DAYS: 'Working days absent without leave',
  HALF_DAYS: 'Days marked half day (late or short hours)',
  LATE_COUNT: 'Days checked in after the grace time',
  LATE_MINUTES: 'Total minutes late',
  MISSED_CHECKOUTS: 'Days with a forgotten check-out',
  PAID_LEAVE_DAYS: 'Approved paid leave days',
  UNPAID_LEAVE_DAYS: 'Approved unpaid leave days (including excess converted to unpaid)',
  OT_HOURS: 'Payable overtime hours on working days',
  OT_OFFDAY_HOURS: 'Payable overtime hours on weekends and holidays',
  SHIFT_HOURS: 'Scheduled hours in a shift',
  MONTHLY_SALARY: 'Full monthly salary: total of salary-structure earnings',
  MONTHS_OF_SERVICE: 'Completed months of service at period end',
  LOAN_INSTALLMENT: 'Loan / advance installments due this period',
};

/** Sums of component amounts. */
export const TOTALS = {
  GROSS: 'Total earnings',
  TAXABLE_EARNINGS: 'Total taxable earnings',
  TOTAL_DEDUCTIONS: 'Total deductions',
};

/** STRUCT_<CODE>: the full monthly structure amount, before pro-rating. */
export const structVar = (code) => `STRUCT_${code}`;

export const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
export const isReservedName = (name) => name in INPUTS || name in TOTALS || name.startsWith('STRUCT_');

/**
 * Annual slab tax: the highest slab whose `above` is below the amount
 * applies: fixed + (amount - above) * rate%.
 */
export function slabTax(slabs, amount) {
  if (!Array.isArray(slabs) || !slabs.length || amount <= 0) return 0;
  const slab = [...slabs].sort((a, b) => a.above - b.above).filter((s) => amount > s.above).at(-1);
  return slab ? slab.fixed + ((amount - slab.above) * slab.rate) / 100 : 0;
}

export function payrollFunctions({ taxSlabs = [] } = {}) {
  return {
    ...FUNCTIONS,
    tax: { args: [1, 1], help: 'Income tax on an annual amount, from the tax table: tax(TAXABLE_EARNINGS * 12)', fn: (x) => slabTax(taxSlabs, x) },
  };
}

/**
 * Builds the dependency graph and an evaluation order.
 * @returns {{ order: string[], nodes: Map, errors: Array<{code?, message}> }}
 */
export function plan({ components, variables = {}, inputNames = [], functions = payrollFunctions() }) {
  const errors = [];
  const nodes = new Map(); // name -> { kind, deps:Set, ast?, component? }
  const known = new Set([...Object.keys(INPUTS), ...inputNames]);
  for (const c of components) known.add(structVar(c.code));

  for (const [name, src] of Object.entries(variables)) {
    if (!IDENTIFIER_RE.test(name)) { errors.push({ message: `"${name}" is not a valid variable name (use capitals, digits and _).` }); continue; }
    if (isReservedName(name) || components.some((c) => c.code === name)) { errors.push({ message: `Variable "${name}" clashes with a built-in value or component code.` }); continue; }
    try {
      const ast = typeof src === 'number' ? { type: 'num', value: src } : parse(String(src), { functions });
      nodes.set(name, { kind: 'variable', ast, deps: variablesOf(ast), source: String(src) });
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      errors.push({ message: `Variable ${name}: ${err.message}.` });
    }
  }
  for (const c of components) {
    const rule = c.rule ?? {};
    if (rule.enabled === false || rule.calculation !== 'formula') {
      nodes.set(c.code, { kind: 'component', component: c, deps: new Set() });
      continue;
    }
    try {
      const ast = parse(rule.formula ?? '', { functions });
      nodes.set(c.code, { kind: 'component', component: c, ast, deps: variablesOf(ast), source: rule.formula });
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      errors.push({ code: c.code, message: `${c.name} (${c.code}): ${err.message}.` });
      nodes.set(c.code, { kind: 'component', component: c, deps: new Set(), broken: true });
    }
  }
  const member = (pred) => new Set(components.filter(pred).map((c) => c.code));
  nodes.set('GROSS', { kind: 'total', deps: member((c) => c.kind === 'earning') });
  nodes.set('TAXABLE_EARNINGS', { kind: 'total', deps: member((c) => c.kind === 'earning' && c.rule?.taxable !== false) });
  nodes.set('TOTAL_DEDUCTIONS', { kind: 'total', deps: member((c) => c.kind === 'deduction') });

  for (const [name, n] of nodes) {
    for (const d of n.deps) {
      if (!nodes.has(d) && !known.has(d)) {
        const where = n.kind === 'component' ? `${n.component.name} (${name})` : `Variable ${name}`;
        errors.push({ code: name, message: `${where} uses "${d}", which is not a known value.` });
      }
    }
  }

  // Depth-first topological sort; a grey node seen again is a loop.
  const order = [];
  const state = new Map();
  const visit = (name, path) => {
    if (!nodes.has(name)) return;
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'active') {
      const loop = [...path.slice(path.indexOf(name)), name].join(' → ');
      if (!errors.some((e) => e.loop === loop)) errors.push({ code: name, loop, message: `These formulas depend on each other in a loop: ${loop}.` });
      return;
    }
    state.set(name, 'active');
    for (const d of nodes.get(name).deps) visit(d, [...path, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of nodes.keys()) visit(name, []);
  return { order, nodes, errors };
}

/**
 * Computes one payslip.
 * @param {object} a
 * @param {Array}  a.components  [{ id, code, name, kind, sortOrder, rule, structure: { amount, full } | null, versionIds }]
 * @param {object} a.inputs      built-in input values (INPUTS) plus STRUCT_<CODE>
 * @param {object} a.variables   'payroll.rules'.variables
 * @param {Array}  a.taxSlabs    'payroll.tax'.annualSlabs
 */
export function computePayslip({ components, inputs, variables = {}, taxSlabs = [] }) {
  const functions = payrollFunctions({ taxSlabs });
  const { order, nodes, errors } = plan({ components, variables, inputNames: Object.keys(inputs), functions });
  if (errors.length) return { ok: false, errors, lines: [], values: {} };

  const values = { ...inputs };
  const warnings = [];
  const refsOf = (n) => Object.fromEntries([...n.deps].map((d) => [d, round2(values[d] ?? 0)]));
  const lines = [];
  for (const name of order) {
    const n = nodes.get(name);
    if (n.kind === 'total') {
      values[name] = round2([...n.deps].reduce((s, d) => s + (values[d] ?? 0), 0));
      continue;
    }
    let amount;
    try {
      amount = evaluate(n.ast ?? { type: 'num', value: 0 }, { vars: values, functions });
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      return { ok: false, errors: [{ code: name, message: `${n.kind === 'component' ? `${n.component.name} (${name})` : `Variable ${name}`}: ${err.message}.` }], lines: [], values };
    }
    if (n.kind === 'variable') { values[name] = amount; continue; }

    const c = n.component;
    const rule = c.rule ?? {};
    let calculation = rule.calculation ?? 'structure';
    if (rule.enabled === false) { amount = 0; calculation = 'disabled'; }
    else if (calculation === 'structure') amount = c.structure?.amount ?? 0;
    if (amount < 0) {
      warnings.push({ code: 'negative_component', params: { component: c.name, amount: round2(amount) } });
      amount = 0;
    }
    amount = round2(amount);
    values[name] = amount;
    if (rule.enabled === false) continue;
    lines.push({
      componentId: c.id, code: c.code, name: c.name, kind: c.kind, amount, calculation, sortOrder: c.sortOrder ?? 0,
      taxable: c.kind === 'earning' ? rule.taxable !== false : null, versionIds: c.versionIds ?? [],
      formula: calculation === 'formula' ? n.source : null,
      inputs: calculation === 'formula' ? refsOf(n)
        : { full: round2(c.structure?.full ?? 0), proRated: rule.proRate !== false, PRORATE: round2(inputs.PRORATE ?? 1) },
      hidden: amount === 0 && rule.showIfZero !== true,
    });
  }
  lines.sort((a, b) => a.sortOrder - b.sortOrder);
  const sum = (kind) => round2(lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amount, 0));
  const gross = sum('earning');
  const deductions = sum('deduction');
  const net = round2(gross - deductions);
  if (net < 0) warnings.push({ code: 'net_negative', params: { net } });
  return { ok: true, errors: [], warnings, lines, values, gross, deductions, net, employerCost: sum('employer') };
}
