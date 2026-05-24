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

  it('list with trailing comma', () => {
    expect(ev('[1, 2, 3,]')).toEqual([1, 2, 3]);
  });

  it('nested list literals', () => {
    expect(ev('[[1, 2], [3, 4]]')).toEqual([[1, 2], [3, 4]]);
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

  it('map with trailing comma', () => {
    expect(ev('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  it('nested map literal', () => {
    expect(ev('{"outer": {"inner": 99}}')).toEqual({ outer: { inner: 99 } });
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
  it(
    'arr[-1] should throw a range error, not silently return undefined',
    () => {
      // CEL spec: index out of range is a runtime error.
      expect(() => ev('arr[-1]', { arr: [1, 2, 3] })).toThrow();
    },
  );

  it('arr[10] for out-of-bounds integer throws a range error', () => {
    // CEL spec: out-of-bounds index access is a runtime error.
    expect(() => ev('arr[10]', { arr: [1, 2, 3] })).toThrow(/index out of range/);
  });
});

// ── 6. String method calls (.startsWith, .contains, .endsWith, .size) ─────────
describe('CEL feature: string receiver methods', () => {
  it(
    'string.startsWith(prefix) — receiver method dispatch',
    () => {
      expect(ev('"hello".startsWith("h")')).toBe(true);
    },
  );

  it(
    'string.endsWith(suffix) — receiver method dispatch',
    () => {
      expect(ev('"hello".endsWith("lo")')).toBe(true);
    },
  );

  it(
    'string.contains(sub) — receiver method dispatch',
    () => {
      expect(ev('"hello world".contains("world")')).toBe(true);
    },
  );

  it(
    'string.size() — receiver method dispatch',
    () => {
      expect(ev('"hello".size()')).toBe(5);
    },
  );
});

// ── 7. has() built-in ─────────────────────────────────────────────────────────
describe('CEL feature: has() built-in macro', () => {
  it(
    'has(obj.field) returns true when field is present',
    () => {
      expect(ev('has(obj.field)', { obj: { field: 'v' } })).toBe(true);
    },
  );

  it(
    'has(obj.missing) returns false when field is absent',
    () => {
      expect(ev('has(obj.missing)', { obj: {} })).toBe(false);
    },
  );
});

// ── 8. Null-safety / optional chaining ───────────────────────────────────────
describe('CEL feature: null-safe member access', () => {
  it(
    'a?.b returns null when a is null, not an error (gap: null-safe access not implemented)',
    () => {
      expect(ev('a?.b', { a: null })).toBeNull();
    },
  );

  it('a?.b returns the value when a is not null', () => {
    expect(ev('a?.b', { a: { b: 42 } })).toBe(42);
  });

  it('a?.b?.c chains null-safe access', () => {
    expect(ev('a?.b?.c', { a: null })).toBeNull();
    expect(ev('a?.b?.c', { a: { b: null } })).toBeNull();
    expect(ev('a?.b?.c', { a: { b: { c: 7 } } })).toBe(7);
  });

  it('null-safe index a?[0] returns null when a is null', () => {
    expect(ev('a?[0]', { a: null })).toBeNull();
  });

  it('null-safe index a?[0] returns value when a is a list', () => {
    expect(ev('a?[0]', { a: [10, 20] })).toBe(10);
  });
});

// ── 9. Division by zero ───────────────────────────────────────────────────────
describe('CEL feature: division by zero', () => {
  it(
    '1 / 0 throws a division-by-zero error',
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

  it('now() is banned in Reducer phase', () => {
    expect(() => cel.evaluate('now()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
  });

  it('timestamp() is banned in Reducer phase', () => {
    expect(() => cel.evaluate('timestamp("2024-01-01T00:00:00Z")', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
  });

  it('coalesce() is allowed in all phases including Reducer', () => {
    expect(cel.evaluate('coalesce(null, "fallback")', {}, CelPhase.Reducer)).toBe('fallback');
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

  it('"missing" in {"key":1} is false', () => {
    expect(ev('"missing" in {"key": 1}')).toBe(false);
  });

  it('in operator works with list from context', () => {
    expect(ev('x in items', { x: 3, items: [1, 2, 3, 4] })).toBe(true);
  });
});

// ── 12. Comprehensions ────────────────────────────────────────────────────────
describe('CEL feature: comprehensions', () => {
  describe('all()', () => {
    it('all items satisfy predicate returns true', () => {
      expect(ev('[1, 2, 3].all(x, x > 0)')).toBe(true);
    });

    it('not all items satisfy predicate returns false', () => {
      expect(ev('[1, -1, 3].all(x, x > 0)')).toBe(false);
    });

    it('all() on empty list returns true (vacuous truth)', () => {
      expect(ev('[].all(x, x > 0)')).toBe(true);
    });
  });

  describe('exists()', () => {
    it('at least one item satisfies predicate returns true', () => {
      expect(ev('[1, -1, 3].exists(x, x < 0)')).toBe(true);
    });

    it('no items satisfy predicate returns false', () => {
      expect(ev('[1, 2, 3].exists(x, x < 0)')).toBe(false);
    });

    it('exists() on empty list returns false', () => {
      expect(ev('[].exists(x, x > 0)')).toBe(false);
    });
  });

  describe('exists_one()', () => {
    it('exactly one match returns true', () => {
      expect(ev('[1, 2, 3].exists_one(x, x == 2)')).toBe(true);
    });

    it('no match returns false', () => {
      expect(ev('[1, 2, 3].exists_one(x, x == 9)')).toBe(false);
    });

    it('more than one match returns false', () => {
      expect(ev('[2, 2, 3].exists_one(x, x == 2)')).toBe(false);
    });
  });

  describe('filter()', () => {
    it('filters list by predicate', () => {
      expect(ev('[1, 2, 3, 4, 5].filter(x, x > 2)')).toEqual([3, 4, 5]);
    });

    it('filter returning empty list', () => {
      expect(ev('[1, 2, 3].filter(x, x > 10)')).toEqual([]);
    });

    it('filter on empty list returns empty list', () => {
      expect(ev('[].filter(x, true)')).toEqual([]);
    });
  });

  describe('map()', () => {
    it('maps list values', () => {
      expect(ev('[1, 2, 3].map(x, x * 2)')).toEqual([2, 4, 6]);
    });

    it('maps to strings', () => {
      expect(ev('[1, 2, 3].map(x, string(x))')).toEqual(['1', '2', '3']);
    });

    it('map on empty list returns empty list', () => {
      expect(ev('[].map(x, x * 2)')).toEqual([]);
    });
  });

  it('nested comprehensions', () => {
    // Flatten via nested map/filter
    expect(ev('[[1,2],[3,4]].map(row, row.map(x, x * 10))')).toEqual([[10, 20], [30, 40]]);
  });

  it('comprehension using context variable', () => {
    expect(ev('items.filter(x, x > threshold)', { items: [1, 5, 2, 8, 3], threshold: 4 })).toEqual([5, 8]);
  });
});

// ── 13. Type conversions ──────────────────────────────────────────────────────
describe('CEL feature: type conversions', () => {
  it('int("42") converts string to integer', () => {
    expect(ev('int("42")')).toBe(42);
  });

  it('int(3.7) truncates double to integer', () => {
    expect(ev('int(3.7)')).toBe(3);
  });

  it('int(true) returns 1', () => {
    expect(ev('int(true)')).toBe(1);
  });

  it('int(false) returns 0', () => {
    expect(ev('int(false)')).toBe(0);
  });

  it('double("3.14") converts string to double', () => {
    expect(ev('double("3.14")')).toBeCloseTo(3.14);
  });

  it('double(42) returns 42.0', () => {
    expect(ev('double(42)')).toBe(42);
  });

  it('string(42) converts number to string', () => {
    expect(ev('string(42)')).toBe('42');
  });

  it('string(true) converts bool to string', () => {
    expect(ev('string(true)')).toBe('true');
  });

  it('string(null) returns "null"', () => {
    expect(ev('string(null)')).toBe('null');
  });

  it('bool("true") converts string to true', () => {
    expect(ev('bool("true")')).toBe(true);
  });

  it('bool("false") converts string to false', () => {
    expect(ev('bool("false")')).toBe(false);
  });

  it('bool(1) converts non-zero to true', () => {
    expect(ev('bool(1)')).toBe(true);
  });

  it('bytes("abc") converts string to byte array', () => {
    expect(ev('bytes("abc")')).toEqual([97, 98, 99]);
  });
});

// ── 14. Math functions ────────────────────────────────────────────────────────
describe('CEL feature: math functions', () => {
  it('abs(-5) returns 5', () => {
    expect(ev('abs(-5)')).toBe(5);
  });

  it('abs(5) returns 5', () => {
    expect(ev('abs(5)')).toBe(5);
  });

  it('min(3, 1, 2) returns 1', () => {
    expect(ev('min(3, 1, 2)')).toBe(1);
  });

  it('max(3, 1, 2) returns 3', () => {
    expect(ev('max(3, 1, 2)')).toBe(3);
  });

  it('floor(3.7) returns 3', () => {
    expect(ev('floor(3.7)')).toBe(3);
  });

  it('ceil(3.2) returns 4', () => {
    expect(ev('ceil(3.2)')).toBe(4);
  });

  it('round(3.5) returns 4', () => {
    expect(ev('round(3.5)')).toBe(4);
  });

  it('pow(2, 8) returns 256', () => {
    expect(ev('pow(2, 8)')).toBe(256);
  });

  it('sqrt(9) returns 3', () => {
    expect(ev('sqrt(9)')).toBe(3);
  });

  it('sqrt of negative throws', () => {
    expect(() => ev('sqrt(-1)')).toThrow();
  });
});

// ── 15. Collection functions ──────────────────────────────────────────────────
describe('CEL feature: collection functions', () => {
  it('size("hello") returns 5', () => {
    expect(ev('size("hello")')).toBe(5);
  });

  it('size([1, 2, 3]) returns 3', () => {
    expect(ev('size([1, 2, 3])')).toBe(3);
  });

  it('size({}) returns 0', () => {
    expect(ev('size({})')).toBe(0);
  });

  it('size({"a": 1, "b": 2}) returns 2', () => {
    expect(ev('size({"a": 1, "b": 2})')).toBe(2);
  });

  it('keys({"a": 1, "b": 2}) returns key list', () => {
    expect(ev('keys({"a": 1, "b": 2})')).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('values({"a": 1, "b": 2}) returns value list', () => {
    expect(ev('values({"a": 1, "b": 2})')).toEqual(expect.arrayContaining([1, 2]));
  });

  it('range(5) returns [0,1,2,3,4]', () => {
    expect(ev('range(5)')).toEqual([0, 1, 2, 3, 4]);
  });

  it('range(2, 5) returns [2,3,4]', () => {
    expect(ev('range(2, 5)')).toEqual([2, 3, 4]);
  });

  it('range(0) returns empty list', () => {
    expect(ev('range(0)')).toEqual([]);
  });
});

// ── 16. Extended string methods ───────────────────────────────────────────────
describe('CEL feature: extended string methods', () => {
  it('s.matches(pattern) tests regex', () => {
    expect(ev('"hello123".matches("[a-z]+[0-9]+")')).toBe(true);
    expect(ev('"hello".matches("[0-9]+")')).toBe(false);
  });

  it('s.replace(old, new) replaces all occurrences', () => {
    expect(ev('"aabbcc".replace("b", "x")')).toBe('aaxxcc');
  });

  it('s.replace(old, new, n) replaces n occurrences', () => {
    expect(ev('"aaaa".replace("a", "b", 2)')).toBe('bbaa');
  });

  it('s.split(sep) splits string', () => {
    expect(ev('"a,b,c".split(",")')).toEqual(['a', 'b', 'c']);
  });

  it('s.substring(start) extracts suffix', () => {
    expect(ev('"hello".substring(2)')).toBe('llo');
  });

  it('s.substring(start, end) extracts slice', () => {
    expect(ev('"hello".substring(1, 4)')).toBe('ell');
  });

  it('s.indexOf(sub) returns first index', () => {
    expect(ev('"hello".indexOf("l")')).toBe(2);
    expect(ev('"hello".indexOf("z")')).toBe(-1);
  });

  it('s.lastIndexOf(sub) returns last index', () => {
    expect(ev('"hello".lastIndexOf("l")')).toBe(3);
  });

  it('s.lowerAscii() lowercases', () => {
    expect(ev('"HELLO".lowerAscii()')).toBe('hello');
  });

  it('s.upperAscii() uppercases', () => {
    expect(ev('"hello".upperAscii()')).toBe('HELLO');
  });

  it('s.trim() removes leading/trailing whitespace', () => {
    expect(ev('"  hello  ".trim()')).toBe('hello');
  });

  it('s.trimStart() removes leading whitespace', () => {
    expect(ev('"  hello  ".trimStart()')).toBe('hello  ');
  });

  it('s.trimEnd() removes trailing whitespace', () => {
    expect(ev('"  hello  ".trimEnd()')).toBe('  hello');
  });

  it('s.charAt(i) returns character at index', () => {
    expect(ev('"hello".charAt(1)')).toBe('e');
  });
});

// ── 17. List methods ──────────────────────────────────────────────────────────
describe('CEL feature: list methods', () => {
  it('lst.size() returns count', () => {
    expect(ev('[1, 2, 3].size()')).toBe(3);
  });

  it('lst.contains(x) returns true when element present', () => {
    expect(ev('[1, 2, 3].contains(2)')).toBe(true);
    expect(ev('[1, 2, 3].contains(9)')).toBe(false);
  });

  it('lst.indexOf(x) returns first index', () => {
    expect(ev('[10, 20, 10].indexOf(10)')).toBe(0);
    expect(ev('[1, 2, 3].indexOf(99)')).toBe(-1);
  });

  it('lst.lastIndexOf(x) returns last index', () => {
    expect(ev('[10, 20, 10].lastIndexOf(10)')).toBe(2);
  });

  it('lst.sort() returns sorted list', () => {
    expect(ev('[3, 1, 2].sort()')).toEqual([1, 2, 3]);
  });

  it('lst.sort() sorts strings', () => {
    expect(ev('["c", "a", "b"].sort()')).toEqual(['a', 'b', 'c']);
  });

  it('lst.reverse() returns reversed list', () => {
    expect(ev('[1, 2, 3].reverse()')).toEqual([3, 2, 1]);
  });

  it('lst.join(sep) joins with separator', () => {
    expect(ev('["a", "b", "c"].join(",")')).toBe('a,b,c');
  });

  it('lst.flatten() flattens one level', () => {
    expect(ev('[[1, 2], [3, 4]].flatten()')).toEqual([1, 2, 3, 4]);
  });

  it('lst.distinct() deduplicates', () => {
    expect(ev('[1, 2, 1, 3, 2].distinct()')).toEqual([1, 2, 3]);
  });
});

// ── 18. Map methods ───────────────────────────────────────────────────────────
describe('CEL feature: map methods', () => {
  it('m.size() returns number of entries', () => {
    expect(ev('{"a": 1, "b": 2}.size()')).toBe(2);
  });

  it('m.keys() returns key list', () => {
    expect(ev('{"x": 1, "y": 2}.keys()')).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('m.values() returns value list', () => {
    expect(ev('{"x": 1, "y": 2}.values()')).toEqual(expect.arrayContaining([1, 2]));
  });
});

// ── 19. Type introspection ────────────────────────────────────────────────────
describe('CEL feature: type()', () => {
  it('type("hello") returns "string"', () => {
    expect(ev('type("hello")')).toBe('string');
  });

  it('type(42) returns "int"', () => {
    expect(ev('type(42)')).toBe('int');
  });

  it('type(3.14) returns "double"', () => {
    expect(ev('type(3.14)')).toBe('double');
  });

  it('type(true) returns "bool"', () => {
    expect(ev('type(true)')).toBe('bool');
  });

  it('type(null) returns "null"', () => {
    expect(ev('type(null)')).toBe('null');
  });

  it('type([]) returns "list"', () => {
    expect(ev('type([])')).toBe('list');
  });

  it('type({}) returns "map"', () => {
    expect(ev('type({})')).toBe('map');
  });
});

// ── 20. Null helpers ──────────────────────────────────────────────────────────
describe('CEL feature: coalesce() and default()', () => {
  it('coalesce(null, "b", "c") returns first non-null', () => {
    expect(ev('coalesce(null, "b", "c")')).toBe('b');
  });

  it('coalesce(null, null, 42) returns 42', () => {
    expect(ev('coalesce(null, null, 42)')).toBe(42);
  });

  it('coalesce(null, null) returns null when all null', () => {
    expect(ev('coalesce(null, null)')).toBeNull();
  });

  it('default(null, "fallback") returns fallback', () => {
    expect(ev('default(null, "fallback")')).toBe('fallback');
  });

  it('default("value", "fallback") returns "value"', () => {
    expect(ev('default("value", "fallback")')).toBe('value');
  });

  it('coalesce with context variables', () => {
    expect(ev('coalesce(x, y, 0)', { x: null, y: null })).toBe(0);
    expect(ev('coalesce(x, y, 0)', { x: null, y: 5 })).toBe(5);
    expect(ev('coalesce(x, y, 0)', { x: 3, y: 5 })).toBe(3);
  });
});

// ── 21. Date/timestamp helpers ────────────────────────────────────────────────
describe('CEL feature: timestamp() and duration()', () => {
  it('timestamp() parses ISO-8601 and returns ISO string', () => {
    expect(ev('timestamp("2024-01-15T10:00:00Z")')).toBe('2024-01-15T10:00:00.000Z');
  });

  it('duration("30s") returns 30000ms', () => {
    expect(ev('duration("30s")')).toBe(30000);
  });

  it('duration("1m") returns 60000ms', () => {
    expect(ev('duration("1m")')).toBe(60000);
  });

  it('duration("2h") returns 7200000ms', () => {
    expect(ev('duration("2h")')).toBe(7200000);
  });

  it('duration("1d") returns 86400000ms', () => {
    expect(ev('duration("1d")')).toBe(86400000);
  });

  it('duration("P1D") parses ISO 8601 duration', () => {
    expect(ev('duration("P1D")')).toBe(86400000);
  });

  it('now() returns an ISO string in Behavior phase', () => {
    const result = cel.evaluate('now()', {}, CelPhase.Behavior);
    expect(typeof result).toBe('string');
    expect(() => new Date(result as string)).not.toThrow();
  });
});

// ── 22. Raw string literals ───────────────────────────────────────────────────
describe('CEL feature: raw string literals', () => {
  it("r'no\\nescape' treats backslash literally", () => {
    expect(ev("r'no\\\\nescape'")).toBe('no\\\\nescape');
  });

  it("raw strings work with regex patterns", () => {
    // Raw string: pattern stays as-is without double-escaping
    expect(ev('r"[0-9]+"')).toBe('[0-9]+');
  });
});

// ── 23. Deep equality for == ──────────────────────────────────────────────────
describe('CEL feature: deep equality for == operator', () => {
  it('[1, 2] == [1, 2] is true', () => {
    expect(ev('[1, 2] == [1, 2]')).toBe(true);
  });

  it('[1, 2] == [1, 3] is false', () => {
    expect(ev('[1, 2] == [1, 3]')).toBe(false);
  });

  it('{"a": 1} == {"a": 1} is true', () => {
    expect(ev('{"a": 1} == {"a": 1}')).toBe(true);
  });

  it('{"a": 1} != {"a": 2} is true', () => {
    expect(ev('{"a": 1} != {"a": 2}')).toBe(true);
  });
});

// ── 24. Null-fallback builtins (coalesce / default) — docs/cel.md:865 ────────
describe('CEL feature: null-fallback builtins', () => {
  it('coalesce(null, "fallback") returns "fallback"', () => {
    expect(ev('coalesce(null, "fallback")')).toBe('fallback');
  });

  it('coalesce("first", "fallback") returns "first" (first non-null wins)', () => {
    expect(ev('coalesce("first", "fallback")')).toBe('first');
  });

  it('coalesce(null, null, "third") returns "third"', () => {
    expect(ev('coalesce(null, null, "third")')).toBe('third');
  });

  it('default(null, "x") returns "x"', () => {
    expect(ev('default(null, "x")')).toBe('x');
  });

  it('default("value", "x") returns "value" (non-null input passes through)', () => {
    expect(ev('default("value", "x")')).toBe('value');
  });
});
