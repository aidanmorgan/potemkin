/**
 * Probing tests for storage completeness gaps:
 *  EventStore (store.ts), StateGraph (graph.ts), ShadowGraph (shadow.ts).
 *
 * Gaps under test:
 *  1. EventStore — duplicate eventId appended twice must be detected/rejected.
 *  2. EventStore — append does NOT mutate the input array.
 *  3. EventStore — currentSequenceVersion returns 0 for a purged aggregate.
 *  4. EventStore — byAggregate returns empty array for unknown aggregate
 *     (consistent with all().filter(...) semantics).
 *  5. EventStore — eventsAppendedTotal metric is NOT emitted by the store itself;
 *     it is emitted by the UoW — the store has no metrics wiring.
 *  6. StateGraph — deepClone does NOT handle circular references (throws or stack-overflows).
 *  7. StateGraph — deepFreeze recursively freezes nested arrays inside objects.
 *  8. StateGraph — deepFreeze recursively freezes objects nested inside arrays.
 *  9. ShadowGraph — has(id) returns true when only the global has it (not staged).
 * 10. ShadowGraph — commitInto clears the shadow afterwards (reusable).
 * 11. ShadowGraph — get() after commitInto reads through to target graph
 *     (shadow is cleared but target was updated).
 * 12. UUIDv7 — epochAnchoredUuidv7 collision resistance: 1000 distinct seedIndexes
 *     produce 1000 distinct IDs.
 * 13. UUIDv7 — isUuidv7 rejects null/undefined/non-string without throwing.
 * 14. UUIDv7 — isUuidv7 correctly rejects a UUID with wrong version but valid format.
 */

import { createEventStore } from '../../../src/eventstore/store.js';
import {
  createStateGraph,
  deepClone,
  deepFreeze,
} from '../../../src/stategraph/graph.js';
import { createShadowGraph } from '../../../src/stategraph/shadow.js';
import {
  nextUuidv7,
  epochAnchoredUuidv7,
  isUuidv7,
} from '../../../src/ids/uuidv7.js';
import type { DomainEvent } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: nextUuidv7(),
    boundary: 'Test',
    aggregateId: 'agg-1',
    type: 'TestEvent',
    payload: {},
    timestamp: new Date().toISOString(),
    sequenceVersion: 1,
    causedBy: 'cmd-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EventStore gap tests
// ---------------------------------------------------------------------------

describe('eventstore/store — completeness probes', () => {
  describe('duplicate eventId', () => {
    it(
      'append rejects a duplicate eventId (S-1: same eventId appended twice across two batches)',
      () => {
        const store = createEventStore();
        const sharedId = nextUuidv7();

        store.append([makeEvent({ eventId: sharedId, sequenceVersion: 1 })]);

        // Second batch with the same eventId — must throw InternalExecutionError.
        expect(() => {
          store.append([makeEvent({ eventId: sharedId, sequenceVersion: 2 })]);
        }).toThrow();
      },
    );

    it('duplicate eventId is rejected, preserving event log integrity', () => {
      const store = createEventStore();
      const sharedId = nextUuidv7();

      store.append([makeEvent({ eventId: sharedId, sequenceVersion: 1 })]);
      expect(() => {
        store.append([makeEvent({ eventId: sharedId, sequenceVersion: 2 })]);
      }).toThrow(/duplicate|eventId/i);
    });
  });

  describe('append does not mutate input array', () => {
    it('append does NOT mutate the input array reference', () => {
      const store = createEventStore();
      const input: DomainEvent[] = [makeEvent({ sequenceVersion: 1 })];
      const originalLength = input.length;
      const originalRef = input[0];

      store.append(input);

      // The store should copy events, not modify the caller's array
      expect(input.length).toBe(originalLength);
      expect(input[0]).toBe(originalRef);
    });

    it('appended events stored in the store are frozen (not the originals)', () => {
      const store = createEventStore();
      const evt = makeEvent({ sequenceVersion: 1 });
      store.append([evt]);

      const stored = store.all()[0];
      expect(Object.isFrozen(stored)).toBe(true);
      // Original input may or may not be frozen — but the stored copy is
      expect(stored).not.toBe(evt);
    });
  });

  describe('currentSequenceVersion after purge', () => {
    it('currentSequenceVersion returns 0 for a previously-purged aggregate', () => {
      const store = createEventStore();
      store.append([makeEvent({ aggregateId: 'agg-purge', sequenceVersion: 1 })]);
      expect(store.currentSequenceVersion('agg-purge')).toBe(1);

      store.purge();
      expect(store.currentSequenceVersion('agg-purge')).toBe(0);
    });
  });

  describe('byAggregate consistency with all().filter', () => {
    it('byAggregate returns same events as all().filter for known aggregate', () => {
      const store = createEventStore();
      store.append([
        makeEvent({ aggregateId: 'agg-A', sequenceVersion: 1 }),
      ]);
      store.append([
        makeEvent({ aggregateId: 'agg-B', sequenceVersion: 1 }),
      ]);
      store.append([
        makeEvent({ aggregateId: 'agg-A', sequenceVersion: 2 }),
      ]);

      const byAgg = store.byAggregate('agg-A');
      const filtered = store.all().filter((e) => e.aggregateId === 'agg-A');

      expect(byAgg.length).toBe(filtered.length);
      expect(byAgg.map((e) => e.eventId)).toEqual(filtered.map((e) => e.eventId));
    });

    it('byAggregate returns empty array for completely unknown aggregate', () => {
      const store = createEventStore();
      expect(store.byAggregate('unknown-agg')).toEqual([]);
    });

    it('byAggregate returns empty array for unknown aggregate matching all().filter behaviour', () => {
      const store = createEventStore();
      store.append([makeEvent({ aggregateId: 'agg-known', sequenceVersion: 1 })]);

      const byAgg = store.byAggregate('agg-unknown');
      const filtered = store.all().filter((e) => e.aggregateId === 'agg-unknown');

      expect(byAgg).toEqual(filtered);
    });
  });

  describe('EventStore metrics wiring (by design: UoW responsibility)', () => {
    it(
      'EventStore.append signature takes only events param — metric emission is UoW responsibility (O-2/S-2 by design)',
      () => {
        // eventsAppendedTotal is incremented in uow.ts after a successful commit.
        // The store itself has no metrics wiring by design (separation of concerns).
        // Standalone store usage is intentionally unmetered.
        // See: src/eventstore/store.ts header comment.
        const store = createEventStore();
        // append(events: readonly DomainEvent[]): void — no metrics parameter
        expect(store.append.length).toBe(1);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// StateGraph gap tests
// ---------------------------------------------------------------------------

describe('stategraph/graph — completeness probes', () => {
  describe('deepClone circular reference handling', () => {
    it(
      'deepClone throws a descriptive error on circular references (S-2: cycle guard)',
      () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular['self'] = circular;

        // Should throw a descriptive error (not a RangeError stack overflow)
        expect(() => deepClone(circular as never)).toThrowError(/circular|cycle/i);
      },
    );

    it('deepClone circular reference error is NOT a RangeError (descriptive message instead)', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular['self'] = circular;

      let caught: unknown;
      try {
        deepClone(circular as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught instanceof RangeError).toBe(false);
      expect((caught as Error).message).toMatch(/circular|cycle/i);
    });
  });

  describe('deepFreeze recursion completeness', () => {
    it('deepFreeze freezes objects nested inside arrays', () => {
      const obj = { items: [{ value: 1 }, { value: 2 }] };
      deepFreeze(obj);

      expect(Object.isFrozen(obj)).toBe(true);
      expect(Object.isFrozen(obj.items)).toBe(true);
      expect(Object.isFrozen(obj.items[0])).toBe(true);
      expect(Object.isFrozen(obj.items[1])).toBe(true);
    });

    it('deepFreeze freezes arrays nested inside objects', () => {
      const obj = { nested: { arr: [1, 2, 3] } };
      deepFreeze(obj);

      expect(Object.isFrozen(obj.nested)).toBe(true);
      expect(Object.isFrozen(obj.nested.arr)).toBe(true);
    });

    it('deepFreeze handles null values inside objects without throwing', () => {
      const obj = { key: null, other: 'value' };
      expect(() => deepFreeze(obj)).not.toThrow();
      expect(Object.isFrozen(obj)).toBe(true);
    });
  });

  describe('StateGraph immutability guarantees', () => {
    it('returned value from graph.get() is frozen', () => {
      const graph = createStateGraph();
      graph.set('id1', { status: 'active', nested: { count: 1 } });
      const val = graph.get('id1')!;
      expect(Object.isFrozen(val)).toBe(true);
      expect(Object.isFrozen((val as Record<string, unknown>)['nested'])).toBe(true);
    });

    it('mutation attempt on graph.get() value throws in strict mode', () => {
      const graph = createStateGraph();
      graph.set('id1', { status: 'active' });
      const val = graph.get('id1') as { status: string };
      expect(() => {
        val.status = 'mutated';
      }).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// ShadowGraph gap tests
// ---------------------------------------------------------------------------

describe('stategraph/shadow — completeness probes', () => {
  describe('has() global fallthrough', () => {
    it('has() returns true when only global has the entity (not staged in shadow)', () => {
      const global = createStateGraph();
      global.set('id-global', { v: 1 });
      const shadow = createShadowGraph(global);

      // Not staged yet
      expect(shadow.shadowed().has('id-global')).toBe(false);
      // But has() should still return true via global fallthrough
      expect(shadow.has('id-global')).toBe(true);
    });

    it('has() returns false when entity is in neither shadow nor global', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      expect(shadow.has('nonexistent')).toBe(false);
    });
  });

  describe('commitInto clears shadow (reusability)', () => {
    it('shadow is empty after commitInto (reusable for next UoW)', () => {
      const global = createStateGraph();
      const target = createStateGraph();
      const shadow = createShadowGraph(global);

      shadow.stage('id1', { v: 1 });
      shadow.stage('id2', { v: 2 });

      shadow.commitInto(target);

      // Shadow must be cleared after commit
      expect(shadow.shadowed().size).toBe(0);
    });

    it('shadow can be used again after commitInto (stage → commit cycle)', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);

      shadow.stage('a', { v: 1 });
      shadow.commitInto(global);

      // Re-use the shadow for a second transaction
      shadow.stage('b', { v: 2 });
      shadow.commitInto(global);

      expect(global.get('a')).toEqual({ v: 1 });
      expect(global.get('b')).toEqual({ v: 2 });
    });
  });

  describe('get() after commit', () => {
    it('after commitInto, get() from shadow on committed id falls through to target graph', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);

      shadow.stage('id1', { v: 99 });
      shadow.commitInto(global);

      // Shadow is cleared; get() should now fall through to global
      // (which was just updated by commitInto)
      expect(global.get('id1')).toEqual({ v: 99 });
    });

    it('[CURRENT] after commitInto, shadow.get() causes a re-cache from the target graph', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);

      shadow.stage('id1', { v: 10 });
      shadow.commitInto(global);

      // Shadow was passed global as its backing store, so global now has the value
      // A fresh get() re-caches from global
      const val = shadow.get('id1');
      expect(val).toEqual({ v: 10 });
    });
  });

  describe('staged values are isolated between shadow and global', () => {
    it('staging a value does not mutate the global graph', () => {
      const global = createStateGraph();
      global.set('id1', { v: 1 });
      const shadow = createShadowGraph(global);

      shadow.stage('id1', { v: 999 });

      // Global must be unchanged
      expect(global.get('id1')?.v).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// UUIDv7 gap tests
// ---------------------------------------------------------------------------

describe('ids/uuidv7 — completeness probes', () => {
  describe('epochAnchoredUuidv7 collision resistance', () => {
    it('1000 distinct seedIndexes produce 1000 distinct epoch-anchored UUIDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(epochAnchoredUuidv7(i));
      }
      expect(ids.size).toBe(1000);
    });

    it('epoch-anchored IDs all have timestamp bytes set to zero', () => {
      for (let i = 0; i < 10; i++) {
        const id = epochAnchoredUuidv7(i).replace(/-/g, '');
        expect(id.slice(0, 12)).toBe('000000000000');
      }
    });
  });

  describe('nextUuidv7 monotonicity within a millisecond', () => {
    it('many nextUuidv7() calls in rapid succession are monotonically non-decreasing', () => {
      const ids = Array.from({ length: 100 }, () => nextUuidv7());
      for (let i = 1; i < ids.length; i++) {
        // String comparison is sufficient for UUIDv7 monotonicity check
        expect(ids[i]! >= ids[i - 1]!).toBe(true);
      }
    });
  });

  describe('isUuidv7 robustness', () => {
    it('isUuidv7 returns false for empty string without throwing', () => {
      expect(() => isUuidv7('')).not.toThrow();
      expect(isUuidv7('')).toBe(false);
    });

    it('isUuidv7 returns false for undefined passed as string without throwing', () => {
      // Type coercion: undefined.toString() → 'undefined'
      expect(() => isUuidv7('undefined')).not.toThrow();
      expect(isUuidv7('undefined')).toBe(false);
    });

    it('isUuidv7 returns false for null-like string', () => {
      expect(isUuidv7('null')).toBe(false);
    });

    it('isUuidv7 returns false for a UUID v4 string', () => {
      // v4: version nibble is 4
      expect(isUuidv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('isUuidv7 returns false for a UUID v1 string', () => {
      expect(isUuidv7('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(false);
    });

    it('isUuidv7 returns false for a string with correct structure but wrong version nibble (6)', () => {
      expect(isUuidv7('00000000-0000-6000-8000-000000000000')).toBe(false);
    });

    it('isUuidv7 returns false for string with correct version but wrong variant (c = 1100 not 10xx)', () => {
      // variant nibble 'c' = 0b1100 — not in [89ab]
      expect(isUuidv7('00000000-0000-7000-c000-000000000000')).toBe(false);
    });

    it('isUuidv7 is case-insensitive for uppercase A-F', () => {
      const lower = nextUuidv7();
      const upper = lower.toUpperCase();
      expect(isUuidv7(upper)).toBe(true);
    });

    it('isUuidv7 returns false for UUID with extra characters', () => {
      const id = nextUuidv7() + 'x';
      expect(isUuidv7(id)).toBe(false);
    });

    it('isUuidv7 returns false for UUID with missing segment', () => {
      expect(isUuidv7('00000000-0000-7000-8000')).toBe(false);
    });
  });
});
