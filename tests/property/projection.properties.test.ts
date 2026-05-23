/**
 * Property-based tests for event projection.
 *
 * Tests:
 *  - deepMerge idempotence via System.GenericUpdateEvent (leaf-scalar patches)
 *  - Arrays in patches replace arrays in target
 */

import * as fc from 'fast-check';
import { createStateGraph } from '../../src/stategraph/graph';
import { createCelEvaluator } from '../../src/cel/evaluator';
import { projectEvent } from '../../src/engine/projection';
import type { DomainEvent, JsonObject, JsonValue } from '../../src/types';
import { makeCustomerBoundaryConfig } from './_helpers/fixtures';

const RUN_COUNT = 200;
const SEED = 42;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function isSafeKey(k: string): boolean {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && k.length > 0;
}

const arbJsonScalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer({ min: -9999, max: 9999 }),
  fc.boolean(),
);

// Flat objects with only scalar leaf values (for idempotence tests)
const arbLeafScalarObject: fc.Arbitrary<JsonObject> = fc
  .dictionary(
    fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
    arbJsonScalar,
    { minKeys: 1, maxKeys: 6 },
  )
  .map((d) => d as JsonObject);

// Arrays of scalars
const arbScalarArray: fc.Arbitrary<JsonValue[]> = fc.array(arbJsonScalar, { minLength: 1, maxLength: 5 });

function makeGenericUpdateEvent(aggregateId: string, seqVersion: number, payload: JsonObject): DomainEvent {
  return {
    eventId: `00000000-0000-7001-8000-${String(seqVersion).padStart(12, '0')}`,
    boundary: 'Customer',
    aggregateId,
    type: 'System.GenericUpdateEvent',
    payload,
    timestamp: '1970-01-01T00:00:00.000Z',
    sequenceVersion: seqVersion,
    causedBy: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Projection properties', () => {
  const cel = createCelEvaluator();
  const boundary = makeCustomerBoundaryConfig();

  // P1: Applying the same leaf-scalar patch twice equals applying it once (idempotence)
  it('applying a leaf-scalar GenericUpdateEvent twice is idempotent', () => {
    fc.assert(
      fc.property(arbLeafScalarObject, (patch) => {
        const graph1 = createStateGraph();
        const aggId = 'agg-idemp';

        const evt1 = makeGenericUpdateEvent(aggId, 1, patch);
        projectEvent({ event: evt1, boundary, graph: graph1, cel });
        const afterFirst = JSON.stringify(graph1.get(aggId));

        // Apply a second time (must create new event with new seqVersion;
        // the graph stores by aggregateId, seq version is on event only)
        const graph2 = createStateGraph();
        projectEvent({ event: evt1, boundary, graph: graph2, cel });
        // Apply same patch again
        const evt2 = makeGenericUpdateEvent(aggId, 2, patch);
        projectEvent({ event: evt2, boundary, graph: graph2, cel });
        const afterSecond = JSON.stringify(graph2.get(aggId));

        expect(afterFirst).toBe(afterSecond);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: Arrays in the patch replace arrays in the target (no concat)
  it('array values in GenericUpdateEvent patch replace existing arrays', () => {
    fc.assert(
      fc.property(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 10 }).filter(isSafeKey),
          initialArray: arbScalarArray,
          patchArray: arbScalarArray,
        }),
        ({ key, initialArray, patchArray }) => {
          const graph = createStateGraph();
          const aggId = 'agg-array-replace';

          // Set initial state with an array
          const initEvt = makeGenericUpdateEvent(aggId, 1, { [key]: initialArray } as JsonObject);
          projectEvent({ event: initEvt, boundary, graph, cel });

          // Apply patch with a different array
          const patchEvt = makeGenericUpdateEvent(aggId, 2, { [key]: patchArray } as JsonObject);
          projectEvent({ event: patchEvt, boundary, graph, cel });

          const state = graph.get(aggId);
          expect(state).not.toBeNull();
          // The result array should equal patchArray (not concat with initialArray)
          expect(state![key]).toEqual(patchArray);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P3: Multiple GenericUpdateEvent patches with disjoint keys accumulate correctly
  it('multiple GenericUpdateEvent patches with disjoint keys accumulate', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 5 }).filter(isSafeKey),
            arbJsonScalar,
            { minKeys: 1, maxKeys: 3 },
          ).map(d => d as JsonObject),
          fc.dictionary(
            fc.string({ minLength: 6, maxLength: 10 }).filter(isSafeKey),
            arbJsonScalar,
            { minKeys: 1, maxKeys: 3 },
          ).map(d => d as JsonObject),
        ),
        ([patch1, patch2]) => {
          const graph = createStateGraph();
          const aggId = 'agg-disjoint';

          const evt1 = makeGenericUpdateEvent(aggId, 1, patch1);
          const evt2 = makeGenericUpdateEvent(aggId, 2, patch2);
          projectEvent({ event: evt1, boundary, graph, cel });
          projectEvent({ event: evt2, boundary, graph, cel });

          const state = graph.get(aggId);
          expect(state).not.toBeNull();

          // All keys from patch1 and patch2 should be present
          for (const [k, v] of Object.entries(patch1)) {
            expect(state![k]).toEqual(v);
          }
          for (const [k, v] of Object.entries(patch2)) {
            expect(state![k]).toEqual(v);
          }
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P4: BaselineEntityCreatedEvent replaces state entirely
  it('BaselineEntityCreatedEvent replaces entire state', () => {
    fc.assert(
      fc.property(
        fc.tuple(arbLeafScalarObject, arbLeafScalarObject),
        ([initial, baseline]) => {
          const graph = createStateGraph();
          const aggId = 'agg-baseline';

          // First set some initial state
          const initEvt = makeGenericUpdateEvent(aggId, 1, initial);
          projectEvent({ event: initEvt, boundary, graph, cel });

          // Then apply a baseline creation event
          const baselineEvt: DomainEvent = {
            eventId: '00000000-0000-7001-8000-000000000002',
            boundary: 'Customer',
            aggregateId: aggId,
            type: 'BaselineEntityCreatedEvent',
            payload: baseline,
            timestamp: '1970-01-01T00:00:00.000Z',
            sequenceVersion: 2,
            causedBy: null,
          };
          projectEvent({ event: baselineEvt, boundary, graph, cel });

          const state = graph.get(aggId);
          expect(JSON.stringify(state)).toBe(JSON.stringify(baseline));
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
