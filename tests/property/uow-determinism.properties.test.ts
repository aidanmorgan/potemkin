/**
 * Property-based tests for Unit-of-Work determinism.
 *
 * These tests verify that replaying the same command sequence on freshly-booted
 * systems yields structurally identical event logs, and that sequence versions
 * remain monotonic throughout.
 */

import * as fc from 'fast-check';
import { createEventStore } from '../../src/eventstore/store';
import { createStateGraph } from '../../src/stategraph/graph';
import { createCelEvaluator } from '../../src/cel/evaluator';
import { projectEvent } from '../../src/engine/projection';
import type { DomainEvent, JsonObject } from '../../src/types';
import { makeCompiledDsl, makeCustomerBoundaryConfig } from './_helpers/fixtures';

const RUN_COUNT = 100;
const SEED = 42;

// UUID v7 pattern used for replacement
const UUID_V7_RE = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function normaliseEvent(evt: DomainEvent): Record<string, unknown> {
  const str = JSON.stringify(evt)
    .replace(UUID_V7_RE, '__UUID__')
    .replace(ISO_TS_RE, '__TS__');
  return JSON.parse(str) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers to run a simple "create customer" sequence
// ---------------------------------------------------------------------------

function buildCreateCustomerEvents(
  aggregateId: string,
  name: string,
  email: string,
  seqBase: number,
): DomainEvent[] {
  return [
    {
      eventId: `00000000-0000-7001-8000-${String(seqBase).padStart(12, '0')}`,
      boundary: 'Customer',
      aggregateId,
      type: 'Customer.Created',
      payload: { customerId: aggregateId, name, email } as JsonObject,
      timestamp: '1970-01-01T00:00:00.000Z',
      sequenceVersion: seqBase,
      causedBy: null,
    },
  ];
}

function runSequence(aggregateIds: string[]): { store: ReturnType<typeof createEventStore>; graph: ReturnType<typeof createStateGraph> } {
  const store = createEventStore();
  const graph = createStateGraph();
  const cel = createCelEvaluator();
  const dsl = makeCompiledDsl();
  const boundary = makeCustomerBoundaryConfig();

  for (let i = 0; i < aggregateIds.length; i++) {
    const aggId = aggregateIds[i]!;
    const events = buildCreateCustomerEvents(aggId, `Name-${i}`, `email${i}@test.com`, 1);
    store.append(events);
    for (const evt of events) {
      projectEvent({ event: evt, boundary, graph, cel });
    }
  }

  return { store, graph };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('UoW determinism properties', () => {
  const arbAggregateIds = fc.array(
    fc.stringMatching(/^[a-z][a-z0-9]{5,10}$/).filter(s => s.length >= 6),
    { minLength: 1, maxLength: 10 },
  ).filter(ids => new Set(ids).size === ids.length); // distinct ids

  // P1: Same command sequence on two independent systems yields identical normalised event logs
  it('identical command sequences produce identical normalised event logs on two independent systems', () => {
    fc.assert(
      fc.property(arbAggregateIds, (aggregateIds) => {
        const sys1 = runSequence(aggregateIds);
        const sys2 = runSequence(aggregateIds);

        const log1 = sys1.store.all().map(normaliseEvent);
        const log2 = sys2.store.all().map(normaliseEvent);

        expect(log1.length).toBe(log2.length);
        for (let i = 0; i < log1.length; i++) {
          expect(log1[i]).toEqual(log2[i]);
        }
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: reset followed by replay reproduces identical normalised state
  it('purge and re-append reproduces identical normalised state graph', () => {
    fc.assert(
      fc.property(arbAggregateIds, (aggregateIds) => {
        const cel = createCelEvaluator();
        const boundary = makeCustomerBoundaryConfig();

        const store = createEventStore();
        const graph = createStateGraph();

        // Initial run
        for (let i = 0; i < aggregateIds.length; i++) {
          const aggId = aggregateIds[i]!;
          const events = buildCreateCustomerEvents(aggId, `Name-${i}`, `e${i}@t.com`, 1);
          store.append(events);
          for (const evt of events) {
            projectEvent({ event: evt, boundary, graph, cel });
          }
        }

        const originalLog = [...store.all()];
        const originalState = Object.fromEntries(
          aggregateIds.map(id => [id, JSON.stringify(graph.get(id))])
        );

        // Reset
        store.purge();
        graph.purge();

        // Replay
        store.append(originalLog.map(e => ({ ...e, payload: JSON.parse(JSON.stringify(e.payload)) as JsonObject })));
        for (const evt of originalLog) {
          projectEvent({ event: evt, boundary, graph, cel });
        }

        // Compare
        for (const aggId of aggregateIds) {
          expect(JSON.stringify(graph.get(aggId))).toBe(originalState[aggId]);
        }
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P3: Monotonic sequence versions per aggregate hold throughout
  it('sequence versions are monotonically increasing per aggregate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (count) => {
          const store = createEventStore();
          const aggId = 'prop-test-mono-agg';

          for (let i = 1; i <= count; i++) {
            const evt: DomainEvent = {
              eventId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
              boundary: 'Customer',
              aggregateId: aggId,
              type: 'Customer.Created',
              payload: {} as JsonObject,
              timestamp: '1970-01-01T00:00:00.000Z',
              sequenceVersion: i,
              causedBy: null,
            };
            store.append([evt]);
            expect(store.currentSequenceVersion(aggId)).toBe(i);
          }

          const events = store.byAggregate(aggId);
          for (let i = 1; i < events.length; i++) {
            expect(events[i]!.sequenceVersion).toBeGreaterThan(events[i - 1]!.sequenceVersion);
          }
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
