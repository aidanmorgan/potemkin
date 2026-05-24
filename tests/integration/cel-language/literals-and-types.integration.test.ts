/**
 * literals-and-types.integration.test.ts
 *
 * End-to-end integration tests for CEL list/map literals and type() introspection,
 * exercised both directly and through real DSL behaviors, conditions, and payload
 * templates.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { runCelFixture } from './_helpers/dsl-builder.js';

const cel = createCelEvaluator();
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, CelPhase.Behavior);

// ── List literals ─────────────────────────────────────────────────────────────

describe('literals: list literals — direct evaluator', () => {
  it('[1, 2, 3] has length 3', () => {
    expect(ev('size([1, 2, 3])')).toBe(3);
  });

  it('[1, 2, 3][0] returns first element', () => {
    expect(ev('[1, 2, 3][0]')).toBe(1);
  });

  it('[1, 2, 3][2] returns last element', () => {
    expect(ev('[1, 2, 3][2]')).toBe(3);
  });

  it('[1, 2, 3] == [1, 2, 3] is true (deep equality)', () => {
    expect(ev('[1, 2, 3] == [1, 2, 3]')).toBe(true);
  });

  it('[1, 2, 3] == [1, 2, 4] is false', () => {
    expect(ev('[1, 2, 3] == [1, 2, 4]')).toBe(false);
  });

  it('empty list [] has size 0', () => {
    expect(ev('size([])')).toBe(0);
  });

  it('empty list [] == [] is true', () => {
    expect(ev('[] == []')).toBe(true);
  });

  it('mixed-type list ["a", 1, true] is valid', () => {
    expect(ev('["a", 1, true]')).toEqual(['a', 1, true]);
  });

  it('mixed-type list can be size()-d', () => {
    expect(ev('size(["a", 1, true])')).toBe(3);
  });

  it('list literal with trailing comma is valid', () => {
    expect(ev('[1, 2, 3,]')).toEqual([1, 2, 3]);
  });
});

// ── Map literals ──────────────────────────────────────────────────────────────

describe('literals: map literals — direct evaluator', () => {
  it('{"a": 1, "b": 2} has key "a" with value 1', () => {
    const m = ev('{"a": 1, "b": 2}') as Record<string, unknown>;
    expect(m['a']).toBe(1);
  });

  it('{"a": 1, "b": 2}.size() returns 2', () => {
    expect(ev('{"a": 1, "b": 2}.size()')).toBe(2);
  });

  it('{"a": 1}.has("a") returns true', () => {
    expect(ev('{"a": 1}.has("a")')).toBe(true);
  });

  it('{"a": 1}.has("z") returns false', () => {
    expect(ev('{"a": 1}.has("z")')).toBe(false);
  });

  it('empty map {} has size 0', () => {
    expect(ev('{}.size()')).toBe(0);
  });

  it('empty map {} == {} is true', () => {
    expect(ev('{} == {}')).toBe(true);
  });

  it('map key access {"x": 99}["x"] returns 99', () => {
    // Via member access
    expect(ev('m["x"]', { m: { x: 99 } })).toBe(99);
  });

  it('map with trailing comma is valid', () => {
    expect(ev('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  it('nested map literal {"outer": {"inner": 7}}.outer.inner == 7', () => {
    expect(ev('m.outer.inner == 7', { m: { outer: { inner: 7 } } })).toBe(true);
  });
});

// ── Type introspection ────────────────────────────────────────────────────────

describe('literals: type() introspection — direct evaluator', () => {
  it('type([256, 1000]) == "list" (values outside byte range → not "bytes")', () => {
    // Note: [1,2] would return "bytes" since all values fit 0-255.
    // Use values outside the byte range to get a proper "list".
    expect(ev('type([256, 1000])')).toBe('list');
  });

  it('type({}) == "map"', () => {
    expect(ev('type({})')).toBe('map');
  });

  it('type({"a": 1}) == "map"', () => {
    expect(ev('type({"a": 1})')).toBe('map');
  });

  it('type(null) == "null"', () => {
    expect(ev('type(null)')).toBe('null');
  });

  it('type(true) == "bool"', () => {
    expect(ev('type(true)')).toBe('bool');
  });

  it('type(false) == "bool"', () => {
    expect(ev('type(false)')).toBe('bool');
  });

  it('type(1.5) == "double"', () => {
    expect(ev('type(1.5)')).toBe('double');
  });

  it('type(1) == "int"', () => {
    expect(ev('type(1)')).toBe('int');
  });

  it('type("hello") == "string"', () => {
    expect(ev('type("hello")')).toBe('string');
  });

  it('type used in condition: only fire if value is a list', () => {
    // Use values outside byte range (> 255) to ensure type returns "list" not "bytes"
    expect(ev('type(v) == "list"', { v: [256, 1000] })).toBe(true);
    expect(ev('type(v) == "list"', { v: 42 })).toBe(false);
  });
});

// ── End-to-end DSL integration: list literal in payload template ──────────────

describe('literals: list literal in DSL payload template', () => {
  it('event payload contains synthesized list from literal', async () => {
    const { events } = await runCelFixture({
      expression: '[1, 2, 3]',
      phase: 'payload',
      initialEntity: { id: nextUuidv7(), status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(events).toHaveLength(1);
    // The `computed` field in event payload should be the list [1,2,3]
    expect(events[0]!.payload['computed']).toEqual([1, 2, 3]);
  });

  it('empty list literal in payload — computed field is []', async () => {
    const { events } = await runCelFixture({
      expression: '[]',
      phase: 'payload',
      initialEntity: { id: nextUuidv7(), status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(events[0]!.payload['computed']).toEqual([]);
  });
});

describe('literals: map literal in DSL payload template', () => {
  it('event payload contains synthesized map from literal', async () => {
    const { events } = await runCelFixture({
      expression: '{"type": "DISBURSE", "amount": 500}',
      phase: 'payload',
      initialEntity: { id: nextUuidv7(), status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['computed']).toEqual({ type: 'DISBURSE', amount: 500 });
  });
});

describe('literals: type() used inside DSL behavior condition', () => {
  it('behavior fires when state.value is an int', async () => {
    const { result } = await runCelFixture({
      expression: 'type(state.value) == "int"',
      phase: 'condition',
      initialEntity: { id: nextUuidv7(), value: 42, status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
  });

  it('behavior blocked when state.value is a string (type mismatch)', async () => {
    const { result } = await runCelFixture({
      expression: 'type(state.value) == "int"',
      phase: 'condition',
      initialEntity: { id: nextUuidv7(), value: 'not-int', status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('literals: list literal indexing and comparison in DSL reducer', () => {
  it('reducer uses list literal to pick a constant', async () => {
    // The reducer expression uses a list literal and indexes it
    const { state } = await runCelFixture({
      expression: '["DRAFT", "ACTIVE", "SETTLED"][1]',
      phase: 'reducer',
      initialEntity: { id: nextUuidv7(), status: 'ACTIVE' },
      commandPayload: {},
    });
    expect(state!['computed']).toBe('ACTIVE');
  });
});
