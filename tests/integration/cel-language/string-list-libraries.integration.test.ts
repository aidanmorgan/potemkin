/**
 * string-list-libraries.integration.test.ts
 *
 * End-to-end integration tests for CEL string and list library functions,
 * exercised at the direct evaluator level and through real DSL.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { runCelFixture } from './_helpers/dsl-builder.js';

const cel = createCelEvaluator();
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, CelPhase.Behavior);

// ── String library — direct evaluator ─────────────────────────────────────────

describe('string library: matches()', () => {
  it('matches email-like pattern', () => {
    expect(ev('"user@example.com".matches("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-zA-Z]{2,}")')).toBe(true);
  });

  it('does not match when pattern is wrong', () => {
    expect(ev('"not-an-email".matches("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-zA-Z]{2,}")')).toBe(false);
  });

  it('matches UUID-like pattern', () => {
    expect(ev('"550e8400-e29b-41d4-a716-446655440000".matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")')).toBe(true);
  });

  it('matches with alternation in pattern', () => {
    expect(ev('"ACTIVE".matches("ACTIVE|DRAFT|SETTLED")')).toBe(true);
    expect(ev('"UNKNOWN".matches("ACTIVE|DRAFT|SETTLED")')).toBe(false);
  });

  it('anchored pattern (full match required when using ^ and $)', () => {
    expect(ev('"LOAN-12345".matches("^LOAN-[0-9]+")')).toBe(true);
    expect(ev('"NOT-LOAN-12345".matches("^LOAN-[0-9]+")')).toBe(false);
  });
});

describe('string library: replace()', () => {
  it('replaces all occurrences', () => {
    expect(ev('"aabbcc".replace("b", "X")')).toBe('aaXXcc');
  });

  it('replaces only n occurrences', () => {
    expect(ev('"aaaa".replace("a", "b", 2)')).toBe('bbaa');
  });

  it('replace on empty string returns empty string', () => {
    expect(ev('"".replace("a", "b")')).toBe('');
  });
});

describe('string library: split()', () => {
  it('splits by comma', () => {
    expect(ev('"a,b,c".split(",")')).toEqual(['a', 'b', 'c']);
  });

  it('splits by space', () => {
    expect(ev('"hello world foo".split(" ")')).toEqual(['hello', 'world', 'foo']);
  });

  it('single element string split returns single-element list', () => {
    expect(ev('"hello".split(",")')).toEqual(['hello']);
  });

  it('empty string split on comma returns list with one empty string', () => {
    expect(ev('"".split(",")')).toEqual(['']);
  });
});

describe('string library: substring(), indexOf(), lastIndexOf(), charAt()', () => {
  it('substring(start) extracts suffix', () => {
    expect(ev('"hello world".substring(6)')).toBe('world');
  });

  it('substring(start, end) extracts slice', () => {
    expect(ev('"hello world".substring(0, 5)')).toBe('hello');
  });

  it('indexOf returns first occurrence index', () => {
    expect(ev('"abcabc".indexOf("b")')).toBe(1);
  });

  it('indexOf returns -1 when not found', () => {
    expect(ev('"abcabc".indexOf("z")')).toBe(-1);
  });

  it('lastIndexOf returns last occurrence index', () => {
    expect(ev('"abcabc".lastIndexOf("b")')).toBe(4);
  });

  it('charAt returns single character', () => {
    expect(ev('"hello".charAt(0)')).toBe('h');
    expect(ev('"hello".charAt(4)')).toBe('o');
  });
});

describe('string library: case and whitespace', () => {
  it('lowerAscii() lowercases all ASCII', () => {
    expect(ev('"HELLO WORLD".lowerAscii()')).toBe('hello world');
  });

  it('upperAscii() uppercases all ASCII', () => {
    expect(ev('"hello world".upperAscii()')).toBe('HELLO WORLD');
  });

  it('trim() strips leading and trailing whitespace', () => {
    expect(ev('"  hello  ".trim()')).toBe('hello');
  });

  it('trimStart() strips only leading whitespace', () => {
    expect(ev('"  hello  ".trimStart()')).toBe('hello  ');
  });

  it('trimEnd() strips only trailing whitespace', () => {
    expect(ev('"  hello  ".trimEnd()')).toBe('  hello');
  });
});

describe('string library: cross-combination', () => {
  it('"hello world".split(" ").map(s, s.upperAscii()) → ["HELLO", "WORLD"]', () => {
    expect(ev('"hello world".split(" ").map(s, s.upperAscii())')).toEqual(['HELLO', 'WORLD']);
  });

  it('split + join round-trip', () => {
    expect(ev('"a,b,c".split(",").join("-")')).toBe('a-b-c');
  });

  it('split + filter: keep only words starting with "b"', () => {
    expect(ev('"apple banana blueberry".split(" ").filter(s, s.startsWith("b"))')).toEqual([
      'banana',
      'blueberry',
    ]);
  });

  it('trim + lowerAscii for normalisation', () => {
    expect(ev('"  HELLO  ".trim().lowerAscii()')).toBe('hello');
  });

  it('unicode string: size counts UTF-16 code units', () => {
    // ASCII chars are single code units
    expect(ev('"hello".size()')).toBe(5);
  });
});

// ── List library — direct evaluator ───────────────────────────────────────────

describe('list library: contains, indexOf, lastIndexOf', () => {
  it('contains(v) returns true when v is in list', () => {
    expect(ev('[1, 2, 3].contains(2)')).toBe(true);
  });

  it('contains(v) returns false when v is not in list', () => {
    expect(ev('[1, 2, 3].contains(9)')).toBe(false);
  });

  it('indexOf(v) returns first index', () => {
    expect(ev('[10, 20, 10].indexOf(10)')).toBe(0);
  });

  it('indexOf(v) returns -1 when not found', () => {
    expect(ev('[1, 2, 3].indexOf(99)')).toBe(-1);
  });

  it('lastIndexOf(v) returns last index', () => {
    expect(ev('[10, 20, 10].lastIndexOf(10)')).toBe(2);
  });
});

describe('list library: sort, reverse', () => {
  it('sort() returns ascending order for numbers', () => {
    expect(ev('[3, 1, 4, 1, 5].sort()')).toEqual([1, 1, 3, 4, 5]);
  });

  it('sort() returns ascending order for strings', () => {
    expect(ev('["cherry", "apple", "banana"].sort()')).toEqual(['apple', 'banana', 'cherry']);
  });

  it('reverse() reverses the list', () => {
    expect(ev('[1, 2, 3].reverse()')).toEqual([3, 2, 1]);
  });

  it('empty list sort() returns []', () => {
    expect(ev('[].sort()')).toEqual([]);
  });

  it('empty list reverse() returns []', () => {
    expect(ev('[].reverse()')).toEqual([]);
  });
});

describe('list library: join, flatten, distinct', () => {
  it('join() with separator', () => {
    expect(ev('["a", "b", "c"].join(",")')).toBe('a,b,c');
  });

  it('join() with empty separator', () => {
    expect(ev('["a", "b", "c"].join("")')).toBe('abc');
  });

  it('flatten() one-level', () => {
    expect(ev('[[1, 2], [3, 4], [5]].flatten()')).toEqual([1, 2, 3, 4, 5]);
  });

  it('flatten() on already-flat list returns same', () => {
    expect(ev('[1, 2, 3].flatten()')).toEqual([1, 2, 3]);
  });

  it('distinct() removes duplicates preserving first occurrence', () => {
    expect(ev('[1, 2, 1, 3, 2].distinct()')).toEqual([1, 2, 3]);
  });

  it('distinct() on unique list is identity', () => {
    expect(ev('[1, 2, 3].distinct()')).toEqual([1, 2, 3]);
  });

  it('distinct() on empty list returns []', () => {
    expect(ev('[].distinct()')).toEqual([]);
  });
});

// ── End-to-end DSL integration tests ─────────────────────────────────────────

describe('string library: DSL behavior condition using matches()', () => {
  it('behavior fires when entity label matches LOAN- prefix pattern', async () => {
    const { result } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+")',
      phase: 'condition',
      initialEntity: { id: nextUuidv7(), label: 'LOAN-12345', status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
    expect(result.events).toHaveLength(1);
  });

  it('behavior blocked for label not matching LOAN- prefix (→ 422)', async () => {
    const { result } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+")',
      phase: 'condition',
      initialEntity: { id: nextUuidv7(), label: 'GRANT-999', status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('string library: DSL reducer assign — derive normalized name', () => {
  it('reducer assigns trimmed+lowerAscii name to normalizedName field', async () => {
    const { state } = await runCelFixture({
      expression: 'state.label.trim().lowerAscii()',
      phase: 'reducer',
      initialEntity: { id: nextUuidv7(), label: '  HELLO WORLD  ', status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(state!['computed']).toBe('hello world');
  });
});

describe('list library: DSL reducer assign — distinct tags', () => {
  it('reducer deduplicates tags via distinct()', async () => {
    const { state } = await runCelFixture({
      expression: 'state.tags.distinct()',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        tags: ['vip', 'standard', 'vip', 'premium', 'standard'],
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(state!['computed']).toEqual(['vip', 'standard', 'premium']);
  });
});

describe('string+list cross-combo: DSL payload template', () => {
  it('payload contains split-and-upper-mapped words', async () => {
    const { events } = await runCelFixture({
      expression: 'state.label.split(" ").map(s, s.upperAscii()).join("-")',
      phase: 'payload',
      initialEntity: { id: nextUuidv7(), label: 'hello world', status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(events).toHaveLength(1);
    // Expect "HELLO-WORLD" since we split, upperAscii, then join with "-"
    expect(events[0]!.payload['computed']).toBe('HELLO-WORLD');
  });
});
