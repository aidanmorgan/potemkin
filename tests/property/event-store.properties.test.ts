/**
 * Property-based tests for EventStore.
 */

import * as fc from 'fast-check';
import { createEventStore } from '../../src/eventstore/store';
import type { DomainEvent } from '../../src/types';
import { makeEvent } from './_helpers/fixtures';

const RUN_COUNT = 200;
const SEED = 42;

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

/** Generates a valid aggregateId string */
const arbAggregateId = fc.stringMatching(/^[a-z][a-z0-9-]{3,15}$/).filter(s => s.length >= 4);

/** Generate a monotonic sequence of N events for a given aggregateId */
function makeEventSequence(aggregateId: string, count: number): DomainEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({ aggregateId, sequenceVersion: i + 1 }),
  );
}

/** Arbitrary: aggregateId + non-empty sequence of events (1–20 events) */
const arbEventSequence = fc
  .tuple(arbAggregateId, fc.integer({ min: 1, max: 20 }))
  .map(([aggId, count]) => ({
    aggregateId: aggId,
    events: makeEventSequence(aggId, count),
  }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventStore properties', () => {
  // P1: currentSequenceVersion equals last appended seq for that aggregate
  it('currentSequenceVersion equals last appended sequence', () => {
    fc.assert(
      fc.property(arbEventSequence, ({ aggregateId, events }) => {
        const store = createEventStore();
        store.append(events);
        expect(store.currentSequenceVersion(aggregateId)).toBe(events.length);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: byAggregate returns events in append order
  it('byAggregate returns events in append order', () => {
    fc.assert(
      fc.property(arbEventSequence, ({ aggregateId, events }) => {
        const store = createEventStore();
        store.append(events);
        const fetched = store.byAggregate(aggregateId);
        expect(fetched.length).toBe(events.length);
        for (let i = 0; i < fetched.length; i++) {
          expect(fetched[i]!.sequenceVersion).toBe(events[i]!.sequenceVersion);
        }
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P3: all() is the concatenation in insertion order
  it('all() returns events in insertion order across multiple aggregates', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
        ),
        ([countA, countB]) => {
          const store = createEventStore();
          const eventsA = makeEventSequence('agg-alpha', countA);
          const eventsB = makeEventSequence('agg-beta', countB);
          store.append(eventsA);
          store.append(eventsB);
          const all = store.all();
          expect(all.length).toBe(countA + countB);
          // First countA events should be for agg-alpha
          for (let i = 0; i < countA; i++) {
            expect(all[i]!.aggregateId).toBe('agg-alpha');
          }
          // Next countB for agg-beta
          for (let i = 0; i < countB; i++) {
            expect(all[countA + i]!.aggregateId).toBe('agg-beta');
          }
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P4: purge() followed by re-append yields identical contents
  it('purge then re-append yields identical contents', () => {
    fc.assert(
      fc.property(arbEventSequence, ({ aggregateId, events }) => {
        const store = createEventStore();
        store.append(events);
        const before = [...store.all()];

        store.purge();
        expect(store.size()).toBe(0);
        expect(store.currentSequenceVersion(aggregateId)).toBe(0);

        store.append(events);
        const after = [...store.all()];

        expect(after.length).toBe(before.length);
        for (let i = 0; i < after.length; i++) {
          expect(after[i]!.eventId).toBe(before[i]!.eventId);
          expect(after[i]!.sequenceVersion).toBe(before[i]!.sequenceVersion);
          expect(after[i]!.aggregateId).toBe(before[i]!.aggregateId);
        }
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P5: Immutability — events returned by byAggregate / all() are frozen
  it('events returned by byAggregate are frozen', () => {
    fc.assert(
      fc.property(arbEventSequence, ({ aggregateId, events }) => {
        const store = createEventStore();
        store.append(events);
        const fetched = store.byAggregate(aggregateId);
        expect(fetched.length).toBeGreaterThan(0);
        const evt = fetched[0]!;
        expect(() => {
          (evt as unknown as Record<string, string>).type = 'tampered';
        }).toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('events returned by all() are frozen', () => {
    fc.assert(
      fc.property(arbEventSequence, ({ events }) => {
        const store = createEventStore();
        store.append(events);
        const all = store.all();
        expect(all.length).toBeGreaterThan(0);
        const evt = all[0]!;
        expect(() => {
          (evt as unknown as Record<string, string>).type = 'tampered';
        }).toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P6: Non-monotonic sequence version should throw
  it('appending non-monotonic sequence throws', () => {
    fc.assert(
      fc.property(arbAggregateId, (aggregateId) => {
        const store = createEventStore();
        const events = makeEventSequence(aggregateId, 3);
        store.append(events);
        // Try to append a duplicate sequenceVersion = 3 again
        expect(() => {
          store.append([makeEvent({ aggregateId, sequenceVersion: 3 })]);
        }).toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
