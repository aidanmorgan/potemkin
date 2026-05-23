/**
 * Property-based tests for StateGraph, deepClone, deepFreeze, deepMerge.
 */

import * as fc from 'fast-check';
import { deepClone, deepFreeze, deepMerge, createStateGraph } from '../../src/stategraph/graph';
import type { JsonObject, JsonValue } from '../../src/types';

const RUN_COUNT = 200;
const SEED = 42;

// ---------------------------------------------------------------------------
// Arbitrary generators — JSON-safe objects only
// ---------------------------------------------------------------------------

/** Filter keys that could cause prototype pollution */
function isSafeKey(k: string): boolean {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

const arbJsonScalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const arbJsonObject: fc.Arbitrary<JsonObject> = fc
  .dictionary(
    fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
    arbJsonScalar,
    { maxKeys: 8 },
  )
  .map((d) => d as JsonObject);

const arbJsonObjectDeep: fc.Arbitrary<JsonObject> = fc
  .dictionary(
    fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
    fc.oneof(arbJsonScalar, arbJsonObject),
    { maxKeys: 6 },
  )
  .map((d) => d as JsonObject);

// ---------------------------------------------------------------------------
// deepClone properties
// ---------------------------------------------------------------------------

describe('deepClone properties', () => {
  // P1: structural equality after clone
  it('deepClone produces a structurally equal value', () => {
    fc.assert(
      fc.property(arbJsonObjectDeep, (v) => {
        const clone = deepClone(v);
        expect(JSON.stringify(clone)).toBe(JSON.stringify(v));
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: no shared references — mutating clone does not affect original
  it('mutating the deepClone does not affect the original', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
          original: arbJsonObject,
        }),
        ({ key, original }) => {
          const clone = deepClone(original) as Record<string, unknown>;
          const originalStr = JSON.stringify(original);
          clone[key] = 'MUTATED_VALUE_PROP_TEST';
          expect(JSON.stringify(original)).toBe(originalStr);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// deepFreeze properties
// ---------------------------------------------------------------------------

describe('deepFreeze properties', () => {
  // P3: property assignment on deep-frozen object throws in strict mode
  it('deepFreeze prevents mutation (throws in strict mode)', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
          obj: arbJsonObject,
        }),
        ({ key, obj }) => {
          const frozen = deepFreeze(deepClone(obj));
          expect(() => {
            (frozen as Record<string, unknown>)[key] = 'should-throw';
          }).toThrow();
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// deepMerge properties
// ---------------------------------------------------------------------------

describe('deepMerge properties', () => {
  // P4: associativity with disjoint keys: (a∪b)∪c ≡ a∪(b∪c)
  it('deepMerge is associative for disjoint-key objects', () => {
    fc.assert(
      fc.property(
        // Three objects with deliberately different keys to keep them disjoint
        fc.tuple(
          fc
            .dictionary(
              fc.string({ minLength: 1, maxLength: 5 }).filter(isSafeKey),
              arbJsonScalar,
              { minKeys: 1, maxKeys: 4 },
            )
            .map((d) => d as JsonObject),
          fc
            .dictionary(
              fc.string({ minLength: 6, maxLength: 10 }).filter(isSafeKey),
              arbJsonScalar,
              { minKeys: 1, maxKeys: 4 },
            )
            .map((d) => d as JsonObject),
          fc
            .dictionary(
              fc.string({ minLength: 11, maxLength: 15 }).filter(isSafeKey),
              arbJsonScalar,
              { minKeys: 1, maxKeys: 4 },
            )
            .map((d) => d as JsonObject),
        ),
        ([a, b, c]) => {
          const lhs = deepMerge(deepMerge(a, b), c);
          const rhs = deepMerge(a, deepMerge(b, c));
          expect(JSON.stringify(lhs)).toBe(JSON.stringify(rhs));
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P5: right-biased for overlapping scalar keys (last write wins)
  it('deepMerge is right-biased for overlapping scalar keys', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
          leftVal: arbJsonScalar,
          rightVal: arbJsonScalar,
        }),
        ({ key, leftVal, rightVal }) => {
          const a = { [key]: leftVal } as JsonObject;
          const b = { [key]: rightVal } as JsonObject;
          const merged = deepMerge(a, b);
          expect(merged[key]).toEqual(rightVal);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P6: arrays in source replace arrays in target
  it('deepMerge replaces arrays (no concat)', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
          leftArr: fc.array(arbJsonScalar, { maxLength: 5 }),
          rightArr: fc.array(arbJsonScalar, { maxLength: 5 }),
        }),
        ({ key, leftArr, rightArr }) => {
          const target = { [key]: leftArr } as JsonObject;
          const source = { [key]: rightArr } as JsonObject;
          const merged = deepMerge(target, source);
          expect(merged[key]).toEqual(rightArr);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// StateGraph properties
// ---------------------------------------------------------------------------

describe('StateGraph properties', () => {
  // P7: set then get returns a deep-equal copy
  it('get returns a deep-equal copy after set', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 20 }).filter(isSafeKey),
          obj: arbJsonObjectDeep,
        }),
        ({ key, obj }) => {
          const graph = createStateGraph();
          graph.set(key, obj);
          const retrieved = graph.get(key);
          expect(retrieved).not.toBeNull();
          expect(JSON.stringify(retrieved)).toBe(JSON.stringify(obj));
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P8: mutating the returned value does not change the next get result
  it('mutating returned value does not affect subsequent get', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 20 }).filter(isSafeKey),
          obj: arbJsonObject,
          mutKey: fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
        }),
        ({ key, obj, mutKey }) => {
          const graph = createStateGraph();
          graph.set(key, obj);
          const first = graph.get(key);
          // The returned value should be frozen; any mutation attempt should throw
          expect(() => {
            (first as Record<string, unknown>)[mutKey] = 'mutation-attempt';
          }).toThrow();
          // get again — should still equal original
          const second = graph.get(key);
          expect(JSON.stringify(second)).toBe(JSON.stringify(obj));
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
