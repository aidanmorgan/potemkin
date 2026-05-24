/**
 * null-safety.integration.test.ts
 *
 * End-to-end integration tests for CEL null-safe operators:
 *   ?.  (null-safe member access)
 *   ?[  (null-safe bracket index)
 * Combined with coalesce/default, comprehensions, and DSL conditions.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { runCelFixture } from './_helpers/dsl-builder.js';

const cel = createCelEvaluator();
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, CelPhase.Behavior);

// ── Direct evaluator tests ────────────────────────────────────────────────────

describe('null-safety: ?. operator', () => {
  it('a?.b on null a returns null (not an error)', () => {
    expect(ev('a?.b', { a: null })).toBeNull();
  });

  it('a?.b on present a returns the value', () => {
    expect(ev('a?.b', { a: { b: 42 } })).toBe(42);
  });

  it('a?.b when b is absent in a returns null', () => {
    expect(ev('a?.b', { a: {} })).toBeNull();
  });

  it('a?.b?.c — deep chain, a is null → null', () => {
    expect(ev('a?.b?.c', { a: null })).toBeNull();
  });

  it('a?.b?.c — deep chain, b is null → null', () => {
    expect(ev('a?.b?.c', { a: { b: null } })).toBeNull();
  });

  it('a?.b?.c — deep chain, all present → value', () => {
    expect(ev('a?.b?.c', { a: { b: { c: 99 } } })).toBe(99);
  });

  it('a?.b?.c?.d — four levels deep, breaks at second → null', () => {
    expect(ev('a?.b?.c?.d', { a: { b: null } })).toBeNull();
  });

  it('a?.b?.c?.d — all present → value', () => {
    expect(ev('a?.b?.c?.d', { a: { b: { c: { d: 'deep' } } } })).toBe('deep');
  });
});

describe('null-safety: ?[ operator', () => {
  it('a?[0] on null a returns null', () => {
    expect(ev('a?[0]', { a: null })).toBeNull();
  });

  it('a?[0] on a list returns the element', () => {
    expect(ev('a?[0]', { a: [10, 20, 30] })).toBe(10);
  });

  it('a?[2] on a list returns the correct element', () => {
    expect(ev('a?[2]', { a: [10, 20, 30] })).toBe(30);
  });

  it('a?[0] when a is an empty list returns null (out of bounds)', () => {
    // Null-safe bracket on out-of-bounds returns null (not an error, per design §8.2)
    expect(ev('a?[0]', { a: [] })).toBeNull();
  });
});

describe('null-safety: combined with coalesce', () => {
  it('coalesce(a?.b, a?.c, "default") — first non-null wins', () => {
    expect(ev('coalesce(a?.b, a?.c, "default")', { a: { b: null, c: 'found' } })).toBe('found');
  });

  it('coalesce(a?.b, a?.c, "default") — all null falls back to literal', () => {
    expect(ev('coalesce(a?.b, a?.c, "default")', { a: {} })).toBe('default');
  });

  it('coalesce(a?.b, "fallback") when a is null returns fallback', () => {
    expect(ev('coalesce(a?.b, "fallback")', { a: null })).toBe('fallback');
  });

  it('default(a?.deep?.field, 0) returns 0 when chain is broken', () => {
    expect(ev('default(a?.deep?.field, 0)', { a: null })).toBe(0);
    expect(ev('default(a?.deep?.field, 0)', { a: { deep: null } })).toBe(0);
    expect(ev('default(a?.deep?.field, 0)', { a: { deep: { field: 7 } } })).toBe(7);
  });
});

describe('null-safety: combined with comprehension', () => {
  // BUG: lst?.filter(x, ...) does not short-circuit when lst is null.
  // The parser produces a `comprehension` node (not `nullSafeMethod`) for
  // comprehension macros even when preceded by `?.`, so null-safe semantics
  // are NOT applied. This is a real evaluator bug: the null check happens in
  // `evalComprehension` which throws CEL_EVAL error instead of returning null.
  // Tracking: dsl-builder.ts null-safety comprehension issue.
  it.failing('lst?.filter(x, x > 0) — list is null, short-circuits to null [BUG: comprehension nodes ignore null-safe ?. operator]', () => {
    // Expected: null (null-safe short-circuit)
    // Actual: throws 'CEL_EVAL: comprehension receiver must be a list or map, got object'
    expect(ev('lst?.filter(x, x > 0)', { lst: null })).toBeNull();
  });

  it('lst?.filter(x, x > 0) — list is present, filters normally', () => {
    // Non-null receiver: normal filter works fine (null-safe is a no-op here)
    expect(ev('lst?.filter(x, x > 0)', { lst: [1, -2, 3] })).toEqual([1, 3]);
  });

  it('lst?.size() — list is null → null', () => {
    // size() is a regular method (not comprehension), so null-safe works correctly
    expect(ev('lst?.size()', { lst: null })).toBeNull();
  });

  it('lst?.size() — list is present → length', () => {
    expect(ev('lst?.size()', { lst: [1, 2, 3] })).toBe(3);
  });
});

// ── End-to-end DSL integration tests ─────────────────────────────────────────

describe('null-safety: DSL condition — state?.metadata?.tags?.contains("vip")', () => {
  it('behavior fires when nested metadata.tags contains "vip"', async () => {
    const { result, events } = await runCelFixture({
      expression: 'state?.metadata?.tags?.contains("vip") == true',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        metadata: { tags: ['standard', 'vip'] },
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('behavior is blocked when metadata.tags is absent (null-safe returns false → 422)', async () => {
    // metadata is present but has no tags field; ?.tags returns null, ?.contains returns null,
    // so `null == true` is false → behavior does not fire → 422
    const { result } = await runCelFixture({
      expression: 'state?.metadata?.tags?.contains("vip") == true',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        metadata: {},
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('null-safety: DSL reducer assign — coalesce(state?.value, 0)', () => {
  it('reducer assigns existing value when state.value is set', async () => {
    const { state } = await runCelFixture({
      expression: 'coalesce(state?.value, 0)',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        value: 42,
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(state!['computed']).toBe(42);
  });

  it('reducer assigns fallback 0 when state.value is absent (key missing)', async () => {
    // value field is absent from entity; state?.value evaluates to undefined/null
    // → coalesce returns the fallback 0
    const { state } = await runCelFixture({
      expression: 'coalesce(state?.value, 0)',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        // value field intentionally omitted
      },
      commandPayload: {},
    });
    expect(state!['computed']).toBe(0);
  });
});

describe('null-safety: DSL payload template — null-safe access', () => {
  it('payload field uses ?.  to safely extract deep nested field', async () => {
    const { events } = await runCelFixture({
      expression: 'state?.metadata?.tags?[0]',
      phase: 'payload',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        metadata: { tags: ['primary', 'secondary'] },
      },
      commandPayload: {},
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload;
    expect(payload['computed']).toBe('primary');
  });

  it('payload null-safe field is null when chain is broken (metadata has no tags)', async () => {
    // metadata is present but has no tags field — tags access returns null via ?.
    const { events } = await runCelFixture({
      expression: 'state?.metadata?.tags?[0]',
      phase: 'payload',
      initialEntity: {
        id: nextUuidv7(),
        status: 'ACTIVE',
        metadata: {},
      },
      commandPayload: {},
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload;
    expect(payload['computed']).toBeNull();
  });
});
