/**
 * Property-based tests for the CEL evaluator.
 */

import * as fc from 'fast-check';
import { createCelEvaluator } from '../../src/cel/evaluator';
import { CelPhase } from '../../src/cel/phases';

const RUN_COUNT = 200;
const SEED = 42;

const cel = createCelEvaluator();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function evalWith(expr: string, ctx: Record<string, unknown>): unknown {
  return cel.evaluate(expr, ctx, CelPhase.Behavior);
}

// ---------------------------------------------------------------------------
// Arithmetic and boolean operator properties
// ---------------------------------------------------------------------------

describe('CEL arithmetic properties', () => {
  // P1: Commutativity of addition on numbers
  it('integer addition is commutative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (a, b) => {
          const ab = evalWith('a + b', { a, b }) as number;
          const ba = evalWith('b + a', { b, a }) as number;
          expect(ab).toBe(ba);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: Commutativity of multiplication on numbers
  it('integer multiplication is commutative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        (a, b) => {
          const ab = evalWith('a * b', { a, b }) as number;
          const ba = evalWith('b * a', { b, a }) as number;
          expect(ab).toBe(ba);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P3: Subtraction identity: a - 0 == a
  it('a - 0 equals a', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10000, max: 10000 }), (a) => {
        const result = evalWith('a - 0', { a }) as number;
        expect(result).toBe(a);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P4: Multiplication by 1 is identity
  it('a * 1 equals a', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10000, max: 10000 }), (a) => {
        const result = evalWith('a * 1', { a }) as number;
        expect(result).toBe(a);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

describe('CEL boolean properties', () => {
  // P5: Idempotence of &&: a && a == a (as boolean)
  it('boolean && is idempotent', () => {
    fc.assert(
      fc.property(fc.boolean(), (a) => {
        const result = evalWith('a && a', { a }) as unknown;
        expect(!!result).toBe(a);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P6: Idempotence of ||: a || a == a (as boolean)
  it('boolean || is idempotent', () => {
    fc.assert(
      fc.property(fc.boolean(), (a) => {
        const result = evalWith('a || a', { a }) as unknown;
        expect(!!result).toBe(a);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P7: Double negation: !!a == a
  it('double negation is identity', () => {
    fc.assert(
      fc.property(fc.boolean(), (a) => {
        const result = evalWith('!(!a)', { a }) as boolean;
        expect(result).toBe(a);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P8: a && false == false
  it('a && false is always false', () => {
    fc.assert(
      fc.property(fc.boolean(), (a) => {
        const result = evalWith('a && false', { a });
        expect(result).toBe(false);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P9: a || true == true
  it('a || true is always true', () => {
    fc.assert(
      fc.property(fc.boolean(), (a) => {
        const result = evalWith('a || true', { a });
        expect(result).toBe(true);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// $concat properties
// ---------------------------------------------------------------------------

describe('CEL $concat properties', () => {
  // P10: $concat(a, b) === String(a) + String(b) for arbitrary scalars
  it('$concat(a, b) matches a.toString() + b.toString() for integers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9999, max: 9999 }),
        fc.integer({ min: -9999, max: 9999 }),
        (a, b) => {
          const result = evalWith('$concat(a, b)', { a, b }) as string;
          expect(result).toBe(String(a) + String(b));
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('$concat(a, b) matches a.toString() + b.toString() for strings', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (a, b) => {
          const result = evalWith('$concat(a, b)', { a, b }) as string;
          expect(result).toBe(a + b);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('$concat(a, b) matches a.toString() + b.toString() for booleans', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (a, b) => {
        const result = evalWith('$concat(a, b)', { a, b }) as string;
        expect(result).toBe(String(a) + String(b));
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// Phase ban properties
// ---------------------------------------------------------------------------

describe('CEL phase ban properties', () => {
  // P11: $uuidv7 throws in Reducer phase, not in Behavior phase
  it('$uuidv7 throws in Reducer phase', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_i) => {
        expect(() => {
          cel.evaluate('$uuidv7()', {}, CelPhase.Reducer);
        }).toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('$uuidv7 does NOT throw in Behavior phase', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_i) => {
        expect(() => {
          cel.evaluate('$uuidv7()', {}, CelPhase.Behavior);
        }).not.toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P12: $now throws in Reducer phase, not in Behavior phase
  it('$now throws in Reducer phase', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_i) => {
        expect(() => {
          cel.evaluate('$now()', {}, CelPhase.Reducer);
        }).toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('$now does NOT throw in Behavior phase', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_i) => {
        expect(() => {
          cel.evaluate('$now()', {}, CelPhase.Behavior);
        }).not.toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P13: $uuidv7 is ALLOWED in EventHydration phase (per design §8: "Behavior, Event Hydration")
  it('$uuidv7 does NOT throw in EventHydration phase', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_i) => {
        expect(() => {
          cel.evaluate('$uuidv7()', {}, CelPhase.EventHydration);
        }).not.toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// Parse round-trip property
// ---------------------------------------------------------------------------

describe('CEL parse round-trip', () => {
  // P14: literal values parse and evaluate to themselves
  it('integer literals round-trip through parse+eval', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10000, max: 10000 }), (n) => {
        const result = cel.evaluate(String(n), {}, CelPhase.Behavior);
        expect(result).toBe(n);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('boolean literals round-trip through parse+eval', () => {
    fc.assert(
      fc.property(fc.boolean(), (b) => {
        const result = cel.evaluate(b ? 'true' : 'false', {}, CelPhase.Behavior);
        expect(result).toBe(b);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('string literals round-trip through parse+eval', () => {
    fc.assert(
      fc.property(
        // Limit strings to safe characters that don't confuse the tokenizer
        fc.string({ maxLength: 20 }).filter(s => !s.includes('"') && !s.includes("'") && !s.includes('\\')),
        (s) => {
          const result = cel.evaluate(`"${s}"`, {}, CelPhase.Behavior);
          expect(result).toBe(s);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
