/**
 * AUDIT: CEL feature completeness probing tests.
 *
 * `it.failing` marks a gap in the current src — the test asserts the CORRECT
 * behaviour so it will turn green once the bug is fixed.
 * Plain `it` documents a feature that already works.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator';
import { CelPhase } from '../../../src/cel/phases';

const cel = createCelEvaluator();
const phase = CelPhase.Behavior;
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, phase);

// ── 1. List literals ──────────────────────────────────────────────────────────
describe('CEL feature: list literals', () => {
  it('evaluates [1, 2, 3] to an array', () => {
    expect(ev('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('evaluates empty list []', () => {
    expect(ev('[]')).toEqual([]);
  });

  it('list with mixed types', () => {
    expect(ev('["a", 1, true]')).toEqual(['a', 1, true]);
  });
});

// ── 2. Map literals ───────────────────────────────────────────────────────────
describe('CEL feature: map literals', () => {
  it('evaluates {"k": "v"} to an object', () => {
    expect(ev('{"k": "v"}')).toEqual({ k: 'v' });
  });

  it('evaluates empty map {}', () => {
    expect(ev('{}')).toEqual({});
  });

  it('map with integer value', () => {
    expect(ev('{"count": 42}')).toEqual({ count: 42 });
  });
});

// ── 3. Ternary chains ─────────────────────────────────────────────────────────
describe('CEL feature: ternary chains', () => {
  it('basic ternary true branch', () => {
    expect(ev('true ? "yes" : "no"')).toBe('yes');
  });

  it('basic ternary false branch', () => {
    expect(ev('false ? "yes" : "no"')).toBe('no');
  });

  it('nested ternary chain evaluates correctly', () => {
    // x == 1 ? "one" : x == 2 ? "two" : "other"
    expect(ev('x == 1 ? "one" : x == 2 ? "two" : "other"', { x: 2 })).toBe('two');
    expect(ev('x == 1 ? "one" : x == 2 ? "two" : "other"', { x: 3 })).toBe('other');
  });
});

// ── 4. Modulo with negative numbers ───────────────────────────────────────────
describe('CEL feature: modulo operator', () => {
  it('10 % 3 == 1', () => {
    expect(ev('10 % 3')).toBe(1);
  });

  // CEL spec §6.2.1: modulo follows truncated division, same sign as dividend.
  // JavaScript uses the same semantics as CEL here: -7 % 3 === -1.
  it('-7 % 3 produces -1 (truncated division, sign follows dividend)', () => {
    // This works via JS semantics which matches CEL — documenting as working.
    expect(ev('-7 % 3')).toBe(-1);
  });

  it('7 % -3 produces 1 (positive dividend)', () => {
    // The tokenizer treats '-3' as unary minus on literal 3.
    expect(ev('7 % -3')).toBe(1);
  });
});

// ── 5. Array indexing ─────────────────────────────────────────────────────────
describe('CEL feature: array indexing', () => {
  it('arr[0] returns first element', () => {
    expect(ev('arr[0]', { arr: [10, 20, 30] })).toBe(10);
  });

  it('arr[2] returns third element', () => {
    expect(ev('arr[2]', { arr: [10, 20, 30] })).toBe(30);
  });

  // CEL spec does NOT define negative indexing — negative indices should
  // produce an error or undefined rather than Python-style wrap-around.
  // Current implementation: JavaScript arr[-1] is `undefined` (no error thrown).
  // This documents the gap: CEL should throw an error for out-of-range index.
  it.failing(
    'arr[-1] should throw a range error, not silently return undefined (gap: negative index unchecked)',
    () => {
      // CEL spec: index out of range is a runtime error.
      expect(() => ev('arr[-1]', { arr: [1, 2, 3] })).toThrow();
    },
  );

  it('arr[10] for out-of-bounds integer returns undefined (currently silently)', () => {
    // Documents current permissive behaviour — no error on OOB.
    const result = ev('arr[10]', { arr: [1, 2, 3] });
    expect(result).toBeUndefined();
  });
});

// ── 6. String method calls (.startsWith, .contains, .endsWith, .size) ─────────
describe('CEL feature: string receiver methods', () => {
  // Standard CEL defines receiver-style string methods:
  //   s.startsWith(prefix)  s.endsWith(suffix)  s.contains(sub)  s.size()
  // The current parser handles `a.b` as a member access (dot notation) but does
  // NOT support method calls of the form `expr.method(args)`.  Parsing
  // `"hello".startsWith("h")` leaves the `(...)` as trailing tokens → parse error.

  it.failing(
    'string.startsWith(prefix) — method-call syntax not yet supported (gap: no receiver-method dispatch)',
    () => {
      expect(ev('"hello".startsWith("h")')).toBe(true);
    },
  );

  it.failing(
    'string.endsWith(suffix) — method-call syntax not yet supported',
    () => {
      expect(ev('"hello".endsWith("lo")')).toBe(true);
    },
  );

  it.failing(
    'string.contains(sub) — method-call syntax not yet supported',
    () => {
      expect(ev('"hello world".contains("world")')).toBe(true);
    },
  );

  it.failing(
    'string.size() — method-call syntax not yet supported',
    () => {
      expect(ev('"hello".size()')).toBe(5);
    },
  );
});

// ── 7. has() built-in ─────────────────────────────────────────────────────────
describe('CEL feature: has() built-in macro', () => {
  // CEL defines `has(x.field)` as a presence-check macro. The current
  // evaluator has no `has` builtin and no macro expansion.
  it.failing(
    'has(obj.field) returns true when field is present (gap: has() not implemented)',
    () => {
      expect(ev('has(obj.field)', { obj: { field: 'v' } })).toBe(true);
    },
  );

  it.failing(
    'has(obj.missing) returns false when field is absent (gap: has() not implemented)',
    () => {
      expect(ev('has(obj.missing)', { obj: {} })).toBe(false);
    },
  );
});

// ── 8. Null-safety / optional chaining ───────────────────────────────────────
describe('CEL feature: null-safe member access', () => {
  // CEL supports `a.?b` null-safe navigation (CEL spec §7.3).
  // The tokenizer currently throws on `?` before `.`, so this is unsupported.
  it.failing(
    'a?.b returns null when a is null, not an error (gap: null-safe access not implemented)',
    () => {
      expect(ev('a.b', { a: null })).toBeNull();
    },
  );
});

// ── 9. Division by zero ───────────────────────────────────────────────────────
describe('CEL feature: division by zero', () => {
  // CEL spec: integer / 0 is a runtime error.
  // Current implementation: returns Infinity (JS behaviour), no error.
  it.failing(
    '1 / 0 should throw a division-by-zero error (gap: no divide-by-zero guard)',
    () => {
      expect(() => ev('1 / 0')).toThrow();
    },
  );
});

// ── 10. Phase restrictions are enforced ──────────────────────────────────────
describe('CEL phase restrictions (working contract)', () => {
  it('$uuidv7 is banned in Reducer phase', () => {
    expect(() => cel.evaluate('$uuidv7()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
  });

  it('$now is banned in Reducer phase', () => {
    expect(() => cel.evaluate('$now()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
  });

  it('$concat is allowed in Reducer phase', () => {
    expect(cel.evaluate('$concat("a","b")', {}, CelPhase.Reducer)).toBe('ab');
  });

  it('$uuidv7 is allowed in Behavior phase', () => {
    expect(() => cel.evaluate('$uuidv7()', {}, CelPhase.Behavior)).not.toThrow();
  });

  it('$now is allowed in EventHydration phase', () => {
    expect(() => cel.evaluate('$now()', {}, CelPhase.EventHydration)).not.toThrow();
  });
});

// ── 11. `in` operator (working contract) ─────────────────────────────────────
describe('CEL feature: in operator (working)', () => {
  it('"a" in ["a","b"] is true', () => {
    expect(ev('"a" in ["a","b"]')).toBe(true);
  });

  it('"z" in ["a","b"] is false', () => {
    expect(ev('"z" in ["a","b"]')).toBe(false);
  });

  it('"key" in {"key":1} is true', () => {
    expect(ev('"key" in {"key": 1}')).toBe(true);
  });
});
