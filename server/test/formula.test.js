/**
 * Formula language and payroll engine (pure, no database).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FormulaError, evaluate, parse, syntaxError, variablesOf } from '../src/engines/formula.js';
import { computePayslip, plan, slabTax } from '../src/engines/payroll.js';

const calc = (src, vars = {}) => evaluate(parse(src), { vars });

describe('formula language', () => {
  test('arithmetic follows normal precedence', () => {
    assert.equal(calc('2 + 3 * 4'), 14);
    assert.equal(calc('(2 + 3) * 4'), 20);
    assert.equal(calc('-2 ^ 2'), -4);
    assert.equal(calc('2 ^ 3 ^ 2'), 512);
    assert.equal(calc('10 % 4 + 1_000'), 1002);
    assert.equal(calc('BASIC * 0.45', { BASIC: 100000 }), 45000);
  });

  test('comparisons and logic return 1 / 0; if() only runs the branch taken', () => {
    assert.equal(calc('LATE_COUNT > 3', { LATE_COUNT: 4 }), 1);
    assert.equal(calc('LATE_COUNT > 3 and ABSENT_DAYS == 0', { LATE_COUNT: 4, ABSENT_DAYS: 1 }), 0);
    assert.equal(calc('not (A || B)', { A: 0, B: 0 }), 1);
    assert.equal(calc('if(DAYS > 0, 100 / DAYS, 0)', { DAYS: 0 }), 0); // the division never runs
  });

  test('functions', () => {
    assert.equal(calc('min(3, 1, 2) + max(4, 9)'), 10);
    assert.equal(calc('round(1333.333)'), 1333);
    assert.equal(calc('round(2.345, 2)'), 2.35);
    assert.equal(calc('floor(7 / 3) + ceil(0.1) + abs(-2)'), 5);
    assert.equal(calc('clamp(150, 0, 100)'), 100);
  });

  test('lists the variables a formula reads', () => {
    assert.deepEqual([...variablesOf(parse('round((ABSENT_DAYS + HALF_DAYS * 0.5) * DAILY_RATE)'))].sort(), ['ABSENT_DAYS', 'DAILY_RATE', 'HALF_DAYS']);
  });

  test('plain-language syntax errors with a position', () => {
    assert.equal(syntaxError('BASIC * 0.45'), null);
    assert.match(syntaxError('BASIC * (0.45'), /Expected "\)" at the end/);
    assert.match(syntaxError('BASIC ** 2'), /Unexpected "\*" \(at character 8\)/);
    assert.match(syntaxError('sqrt(4)'), /Unknown function "sqrt"/);
    assert.match(syntaxError('round()'), /round\(\) takes 1 to 2 value/);
    assert.match(syntaxError(''), /empty/);
    assert.match(syntaxError('1+'.repeat(600)), /too long/);
  });

  test('sandboxed: no property access, no code, unknown names fail', () => {
    assert.throws(() => calc('constructor'), FormulaError);
    assert.throws(() => calc('__proto__ + 1'), FormulaError);
    assert.match(syntaxError('process.exit(1)'), /Unexpected "\."/);
    assert.match(syntaxError('a = 1'), /Unexpected "="/);
    assert.match(syntaxError('"text"'), /Unexpected/);
    assert.throws(() => calc('1 / 0'), /Division by zero/);
    assert.throws(() => calc('10 ^ 1000'), /too large/);
  });
});

describe('payroll engine', () => {
  const comp = (code, kind, rule, structure = null) => ({ id: code, code, name: code, kind, rule: { enabled: true, ...rule }, structure });

  test('evaluates in dependency order regardless of definition order', () => {
    const r = computePayslip({
      components: [
        comp('TAX', 'deduction', { calculation: 'formula', formula: 'round(tax(TAXABLE_EARNINGS * 12) / 12)' }),
        comp('HRA', 'earning', { calculation: 'formula', formula: 'BASIC * 0.45' }),
        comp('BASIC', 'earning', { calculation: 'structure' }, { amount: 100000, full: 100000 }),
      ],
      inputs: { CALENDAR_DAYS: 30 },
      taxSlabs: [{ above: 0, fixed: 0, rate: 0 }, { above: 600000, fixed: 0, rate: 10 }],
    });
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.equal(r.values.HRA, 45000);
    assert.equal(r.gross, 145000);
    assert.equal(r.values.TAX, Math.round(((145000 * 12 - 600000) * 0.1) / 12));
    assert.equal(r.net, 145000 - r.values.TAX);
    assert.deepEqual(r.lines.find((l) => l.code === 'HRA').inputs, { BASIC: 100000 });
  });

  test('reports loops with the full path, and unknown names', () => {
    const { errors } = plan({
      components: [
        comp('HRA', 'earning', { calculation: 'formula', formula: 'GROSS * 0.1' }),
        comp('BONUS', 'earning', { calculation: 'formula', formula: 'BASIC_PAY * 2' }),
      ],
    });
    assert.ok(errors.some((e) => /loop: (HRA → GROSS → HRA|GROSS → HRA → GROSS)/.test(e.message)), JSON.stringify(errors));
    assert.ok(errors.some((e) => /uses "BASIC_PAY", which is not a known value/.test(e.message)));
  });

  test('variables from payroll rules; disabled components count as 0', () => {
    const r = computePayslip({
      components: [
        comp('BASIC', 'earning', { calculation: 'structure' }, { amount: 90000, full: 90000 }),
        comp('PF', 'deduction', { calculation: 'formula', formula: 'BASIC * 0.1', enabled: false }),
        comp('ABSENT', 'deduction', { calculation: 'formula', formula: 'round(ABSENT_DAYS * DAILY_RATE + PF)' }),
      ],
      inputs: { CALENDAR_DAYS: 30, ABSENT_DAYS: 2, MONTHLY_SALARY: 90000 },
      variables: { DAILY_RATE: 'MONTHLY_SALARY / CALENDAR_DAYS' },
    });
    assert.ok(r.ok);
    assert.equal(r.values.ABSENT, 6000);
    assert.equal(r.lines.some((l) => l.code === 'PF'), false);
  });

  test('a negative result is set to 0 with a warning', () => {
    const r = computePayslip({ components: [comp('X', 'earning', { calculation: 'formula', formula: '-5' })], inputs: {} });
    assert.equal(r.values.X, 0);
    assert.equal(r.warnings[0].code, 'negative_component');
  });

  test('slab tax', () => {
    const slabs = [{ above: 0, fixed: 0, rate: 0 }, { above: 600000, fixed: 0, rate: 1 }, { above: 1200000, fixed: 6000, rate: 11 }];
    assert.equal(slabTax(slabs, 500000), 0);
    assert.equal(slabTax(slabs, 1000000), 4000);
    assert.equal(slabTax(slabs, 1500000), 6000 + 33000);
    assert.equal(slabTax([], 1500000), 0);
  });
});
