/**
 * math-and-conversions.integration.test.ts
 *
 * End-to-end integration tests for CEL math functions and type-conversion functions.
 * Exercises features both at the direct evaluator level and wired through real DSL.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { runCelFixture } from './_helpers/dsl-builder.js';

const cel = createCelEvaluator();
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, CelPhase.Behavior);

// ── Math functions — direct evaluator ─────────────────────────────────────────

describe('math: abs()', () => {
  it('abs(-5) returns 5', () => {
    expect(ev('abs(-5)')).toBe(5);
  });

  it('abs(5) returns 5', () => {
    expect(ev('abs(5)')).toBe(5);
  });

  it('abs(0) returns 0', () => {
    expect(ev('abs(0)')).toBe(0);
  });

  it('abs(-3.14) returns 3.14', () => {
    expect(ev('abs(-3.14)')).toBeCloseTo(3.14);
  });

  it('abs() of non-number throws CEL_TYPE_ERROR', () => {
    expect(() => ev('abs("oops")')).toThrow(/CEL_TYPE_ERROR/);
  });
});

describe('math: min() and max()', () => {
  it('min(3, 1, 2) returns 1', () => {
    expect(ev('min(3, 1, 2)')).toBe(1);
  });

  it('max(3, 1, 2) returns 3', () => {
    expect(ev('max(3, 1, 2)')).toBe(3);
  });

  it('min with a single list argument', () => {
    expect(ev('min([10, 5, 8, 1])')).toBe(1);
  });

  it('max with a single list argument', () => {
    expect(ev('max([10, 5, 8, 1])')).toBe(10);
  });

  it('min of single value returns that value', () => {
    expect(ev('min(42)')).toBe(42);
  });

  it('max of single value returns that value', () => {
    expect(ev('max(42)')).toBe(42);
  });
});

describe('math: floor(), ceil(), round()', () => {
  it('floor(1.7) returns 1', () => {
    expect(ev('floor(1.7)')).toBe(1);
  });

  it('floor(-1.7) returns -2', () => {
    expect(ev('floor(-1.7)')).toBe(-2);
  });

  it('ceil(1.2) returns 2', () => {
    expect(ev('ceil(1.2)')).toBe(2);
  });

  it('ceil(-1.2) returns -1', () => {
    expect(ev('ceil(-1.2)')).toBe(-1);
  });

  it('round(1.5) returns 2', () => {
    expect(ev('round(1.5)')).toBe(2);
  });

  it('round(1.4) returns 1', () => {
    expect(ev('round(1.4)')).toBe(1);
  });

  it('round(-1.5) returns -1 (JavaScript rounding semantics)', () => {
    // JavaScript Math.round(-1.5) == -1 (rounds towards +Infinity)
    expect(ev('round(-1.5)')).toBe(-1);
  });
});

describe('math: pow(), sqrt()', () => {
  it('pow(2, 10) returns 1024', () => {
    expect(ev('pow(2, 10)')).toBe(1024);
  });

  it('pow(3, 3) returns 27', () => {
    expect(ev('pow(3, 3)')).toBe(27);
  });

  it('pow(x, 0) returns 1', () => {
    expect(ev('pow(5, 0)')).toBe(1);
  });

  it('sqrt(16) returns 4', () => {
    expect(ev('sqrt(16)')).toBe(4);
  });

  it('sqrt(2) returns approximately 1.414', () => {
    expect(ev('sqrt(2)')).toBeCloseTo(1.4142135, 5);
  });

  it('sqrt(0) returns 0', () => {
    expect(ev('sqrt(0)')).toBe(0);
  });

  it('sqrt(-1) throws CEL_RUNTIME_ERROR', () => {
    expect(() => ev('sqrt(-1)')).toThrow(/CEL_RUNTIME_ERROR/);
  });
});

// ── Type conversion functions — direct evaluator ──────────────────────────────

describe('conversions: int()', () => {
  it('int("42") returns 42', () => {
    expect(ev('int("42")')).toBe(42);
  });

  it('int(3.9) truncates to 3', () => {
    expect(ev('int(3.9)')).toBe(3);
  });

  it('int(-3.9) truncates to -3', () => {
    expect(ev('int(-3.9)')).toBe(-3);
  });

  it('int(true) returns 1', () => {
    expect(ev('int(true)')).toBe(1);
  });

  it('int(false) returns 0', () => {
    expect(ev('int(false)')).toBe(0);
  });

  it('int("not-a-number") throws CEL_TYPE_ERROR', () => {
    expect(() => ev('int("not-a-number")')).toThrow(/CEL_TYPE_ERROR/);
  });
});

describe('conversions: double()', () => {
  it('double("3.14") returns 3.14', () => {
    expect(ev('double("3.14")')).toBeCloseTo(3.14);
  });

  it('double(42) returns 42.0', () => {
    expect(ev('double(42)')).toBe(42);
  });

  it('double(true) returns 1', () => {
    expect(ev('double(true)')).toBe(1);
  });

  it('double(false) returns 0', () => {
    expect(ev('double(false)')).toBe(0);
  });
});

describe('conversions: string()', () => {
  it('string(42) returns "42"', () => {
    expect(ev('string(42)')).toBe('42');
  });

  it('string(3.14) returns "3.14"', () => {
    expect(ev('string(3.14)')).toBe('3.14');
  });

  it('string(true) returns "true"', () => {
    expect(ev('string(true)')).toBe('true');
  });

  it('string(false) returns "false"', () => {
    expect(ev('string(false)')).toBe('false');
  });

  it('string(null) returns "null"', () => {
    expect(ev('string(null)')).toBe('null');
  });
});

describe('conversions: bool()', () => {
  it('bool("true") returns true', () => {
    expect(ev('bool("true")')).toBe(true);
  });

  it('bool("false") returns false', () => {
    expect(ev('bool("false")')).toBe(false);
  });

  it('bool(1) returns true', () => {
    expect(ev('bool(1)')).toBe(true);
  });

  it('bool(0) returns false', () => {
    expect(ev('bool(0)')).toBe(false);
  });

  it('bool("maybe") throws CEL_TYPE_ERROR', () => {
    expect(() => ev('bool("maybe")')).toThrow(/CEL_TYPE_ERROR/);
  });
});

describe('conversions: bytes()', () => {
  it('bytes("abc") returns [97, 98, 99]', () => {
    expect(ev('bytes("abc")')).toEqual([97, 98, 99]);
  });

  it('bytes("") returns empty list', () => {
    expect(ev('bytes("")')).toEqual([]);
  });

  it('bytes() on non-string throws CEL_TYPE_ERROR', () => {
    expect(() => ev('bytes(42)')).toThrow(/CEL_TYPE_ERROR/);
  });
});

// ── End-to-end DSL integration ────────────────────────────────────────────────

describe('math: DSL behavior condition — principal validation', () => {
  it('behavior fires when principal > 0 and <= max derived from risk band', async () => {
    // max_loan_amount per risk band: LOW=10000, MED=5000, HIGH=1000
    // Using abs() and min() in a guard condition
    const { result } = await runCelFixture({
      expression:
        'state.value > 0 && state.value <= min(10000, abs(state.riskScore))',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        value: 500,
        riskScore: 1000,
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
    expect(result.events).toHaveLength(1);
  });

  it('behavior blocked when value exceeds risk-band maximum', async () => {
    const { result } = await runCelFixture({
      expression:
        'state.value > 0 && state.value <= min(10000, abs(state.riskScore))',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        value: 5000,
        riskScore: 1000, // abs(1000) = 1000; min(10000, 1000) = 1000
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('math: DSL reducer assign — compute risk score using math', () => {
  it('reducer computes pow(2, state.value) and stores it', async () => {
    const { state } = await runCelFixture({
      expression: 'pow(2, state.value)',
      phase: 'reducer',
      initialEntity: { id: nextUuidv7(), value: 8, status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(state!['computed']).toBe(256);
  });

  it('reducer computes floor(sqrt(state.value))', async () => {
    const { state } = await runCelFixture({
      expression: 'floor(sqrt(state.value))',
      phase: 'reducer',
      initialEntity: { id: nextUuidv7(), value: 10, status: 'ACTIVE' },
      commandPayload: {},
    });
    // floor(sqrt(10)) = floor(3.162...) = 3
    expect(state!['computed']).toBe(3);
  });
});

describe('conversions: DSL reducer assign — int() conversion', () => {
  it('reducer converts string-based value to int via int()', async () => {
    // In reducer phase, `command` is not available — only `state` and `event`.
    // Here, state.value holds a numeric value; int() truncates it.
    const { state } = await runCelFixture({
      expression: 'int(state.value)',
      phase: 'reducer',
      initialEntity: { id: nextUuidv7(), value: 3.9 },
      commandPayload: {},
    });
    // int(3.9) truncates to 3
    expect(state!['computed']).toBe(3);
  });
});
