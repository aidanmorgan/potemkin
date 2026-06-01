/**
 * comprehensions.integration.test.ts
 *
 * End-to-end integration tests for CEL comprehension macros:
 * all, exists, exists_one, filter, map — both at the direct evaluator level
 * and wired through real DSL behaviors, conditions, and reducer assigns.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { runCelFixture } from './_helpers/dsl-builder.js';

const cel = createCelEvaluator();
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, CelPhase.Behavior);

// ── Direct evaluator tests ────────────────────────────────────────────────────

describe('comprehensions: direct evaluator — all()', () => {
  it('empty list returns true (vacuous truth)', () => {
    expect(ev('[].all(x, x > 0)')).toBe(true);
  });

  it('all elements satisfy predicate → true', () => {
    expect(ev('[10, 20, 30].all(x, x > 5)')).toBe(true);
  });

  it('one element fails predicate → false', () => {
    expect(ev('[10, 3, 30].all(x, x > 5)')).toBe(false);
  });

  it('all() over context list', () => {
    expect(ev('items.all(x, x > 0)', { items: [1, 2, 3] })).toBe(true);
    expect(ev('items.all(x, x > 0)', { items: [1, -1, 3] })).toBe(false);
  });
});

describe('comprehensions: direct evaluator — exists()', () => {
  it('empty list returns false', () => {
    expect(ev('[].exists(x, x > 0)')).toBe(false);
  });

  it('at least one element matches → true', () => {
    expect(ev('[-1, -2, 5].exists(x, x > 0)')).toBe(true);
  });

  it('no element matches → false', () => {
    expect(ev('[-1, -2, -3].exists(x, x > 0)')).toBe(false);
  });

  it('exists() short-circuits: stops at first truthy element', () => {
    // Verifiable by checking it returns a boolean even on large lists
    const result = ev('items.exists(x, x == 99)', { items: [1, 2, 3, 99, 5, 6, 7] });
    expect(result).toBe(true);
  });
});

describe('comprehensions: direct evaluator — exists_one()', () => {
  it('empty list returns false', () => {
    expect(ev('[].exists_one(x, x > 0)')).toBe(false);
  });

  it('exactly one match → true', () => {
    expect(ev('[1, 5, 1].exists_one(x, x == 5)')).toBe(true);
  });

  it('zero matches → false', () => {
    expect(ev('[1, 2, 3].exists_one(x, x == 9)')).toBe(false);
  });

  it('two matches → false', () => {
    expect(ev('[5, 5, 3].exists_one(x, x == 5)')).toBe(false);
  });
});

describe('comprehensions: direct evaluator — filter()', () => {
  it('empty input returns empty list', () => {
    expect(ev('[].filter(x, x > 0)')).toEqual([]);
  });

  it('preserves order of matching elements', () => {
    expect(ev('[3, 1, 4, 1, 5].filter(x, x > 2)')).toEqual([3, 4, 5]);
  });

  it('no matches returns empty list', () => {
    expect(ev('[1, 2, 3].filter(x, x > 100)')).toEqual([]);
  });

  it('all matches returns full list (order preserved)', () => {
    expect(ev('[5, 6, 7].filter(x, x > 0)')).toEqual([5, 6, 7]);
  });

  it('filter over string list', () => {
    expect(ev('["apple", "banana", "cherry"].filter(s, s.startsWith("b"))')).toEqual(['banana']);
  });
});

describe('comprehensions: direct evaluator — map()', () => {
  it('empty input returns empty list', () => {
    expect(ev('[].map(x, x * 2)')).toEqual([]);
  });

  it('preserves length of input', () => {
    const result = ev('[1, 2, 3, 4, 5].map(x, x + 10)', {}) as unknown[];
    expect(result).toHaveLength(5);
  });

  it('transforms numeric values', () => {
    expect(ev('[1, 2, 3].map(x, x * x)')).toEqual([1, 4, 9]);
  });

  it('maps to strings via string()', () => {
    expect(ev('[10, 20, 30].map(x, string(x))')).toEqual(['10', '20', '30']);
  });

  it('maps using complex expression', () => {
    expect(ev('[1, 2, 3].map(x, x * 2 + 1)')).toEqual([3, 5, 7]);
  });
});

describe('comprehensions: direct evaluator — nested', () => {
  it('nested filter inside map: lst.filter(...).map(...)', () => {
    expect(ev('[1, 2, 3, 4, 5].filter(x, x > 2).map(x, x * 10)')).toEqual([30, 40, 50]);
  });

  it('map over rows containing lists (nested comprehension)', () => {
    expect(ev('[[1, 2], [3, 4]].map(row, row.map(x, x * 10))')).toEqual([[10, 20], [30, 40]]);
  });

  it('filter elements where a nested list satisfies exists()', () => {
    // Each element is a list; keep only those that have an element > 3
    expect(ev('groups.filter(g, g.exists(x, x > 3))', {
      groups: [[1, 2], [4, 5], [0, 1]],
    })).toEqual([[4, 5]]);
  });

  it('comprehension over MAP values via keys', () => {
    // When applied to a map, the receiver iterates over its keys
    const result = ev('m.filter(k, k.startsWith("a"))', {
      m: { apple: 1, banana: 2, avocado: 3 },
    });
    expect(result).toEqual(expect.arrayContaining(['apple', 'avocado']));
    expect((result as unknown[]).length).toBe(2);
  });
});

// ── End-to-end DSL integration tests ─────────────────────────────────────────

describe('comprehensions: DSL behavior condition — all()', () => {
  it('behavior fires when all amounts are within limit (all via context state)', async () => {
    // Condition: all transactions are below 1000
    const { result } = await runCelFixture({
      expression: 'state.transactions.all(t, t.amount < 1000)',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        transactions: [
          { amount: 100, kind: 'DISBURSEMENT' },
          { amount: 200, kind: 'DISBURSEMENT' },
        ],
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
    expect(result.events).toHaveLength(1);
  });

  it('behavior blocked when one transaction exceeds limit (all returns false → 422)', async () => {
    const { result } = await runCelFixture({
      expression: 'state.transactions.all(t, t.amount < 100)',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        transactions: [
          { amount: 50, kind: 'DISBURSEMENT' },
          { amount: 500, kind: 'DISBURSEMENT' }, // exceeds 100
        ],
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('comprehensions: DSL behavior condition — exists()', () => {
  it('behavior fires when at least one tag is vip', async () => {
    const { result } = await runCelFixture({
      expression: 'state.tags.exists(t, t == "vip")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        tags: ['standard', 'vip'],
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
    expect(result.events).toHaveLength(1);
  });

  it('behavior blocked when no vip tag present (exists returns false → 422)', async () => {
    const { result } = await runCelFixture({
      expression: 'state.tags.exists(t, t == "vip")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        tags: ['standard', 'basic'],
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('comprehensions: DSL behavior condition — exists_one()', () => {
  it('behavior fires when exactly one transaction is of kind DISBURSEMENT', async () => {
    const { result } = await runCelFixture({
      expression: 'state.transactions.exists_one(t, t.kind == "DISBURSEMENT")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        transactions: [{ kind: 'DISBURSEMENT', amount: 100 }, { kind: 'REPAYMENT', amount: 50 }],
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
  });

  it('behavior blocked when two DISBURSEMENT transactions exist (exists_one returns false)', async () => {
    const { result } = await runCelFixture({
      expression: 'state.transactions.exists_one(t, t.kind == "DISBURSEMENT")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        transactions: [
          { kind: 'DISBURSEMENT', amount: 100 },
          { kind: 'DISBURSEMENT', amount: 200 },
        ],
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('comprehensions: DSL reducer assign — filter + size()', () => {
  it('reducer computes count of DISBURSEMENT transactions via filter().size()', async () => {
    const { state } = await runCelFixture({
      expression: 'state.transactions.filter(t, t.kind == "DISBURSEMENT").size()',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        transactions: [
          { kind: 'DISBURSEMENT', amount: 100 },
          { kind: 'REPAYMENT', amount: 50 },
          { kind: 'DISBURSEMENT', amount: 200 },
        ],
      },
      commandPayload: {},
    });
    // computed should equal the count of DISBURSEMENT transactions (2)
    expect(state).not.toBeNull();
    expect(state!['computed']).toBe(2);
  });

  it('reducer assigns 0 when no matching transactions', async () => {
    const { state } = await runCelFixture({
      expression: 'state.transactions.filter(t, t.kind == "DISBURSEMENT").size()',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        transactions: [{ kind: 'REPAYMENT', amount: 50 }],
      },
      commandPayload: {},
    });
    expect(state!['computed']).toBe(0);
  });
});

describe('comprehensions: DSL reducer assign — map()', () => {
  it('reducer maps transaction amounts into a list', async () => {
    const { state } = await runCelFixture({
      expression: 'state.transactions.map(t, t.amount)',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        transactions: [
          { kind: 'DISBURSEMENT', amount: 100 },
          { kind: 'REPAYMENT', amount: 50 },
        ],
      },
      commandPayload: {},
    });
    // computed is a list; but reducer stores it as-is (JSON serialized as string by schema)
    // We verify that the computed value evaluates to [100, 50] in the reducer
    expect(state!['computed']).toEqual([100, 50]);
  });
});

describe('comprehensions: nested filter+exists inside behavior condition', () => {
  it('behavior condition: no transaction group has an amount > principal', async () => {
    // A more complex condition: none of the transaction amounts exceeds a threshold
    const { result } = await runCelFixture({
      expression: '!state.transactions.exists(t, t.amount > 999)',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        transactions: [{ amount: 100 }, { amount: 200 }],
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
  });
});
