import { createEventStore } from '../../../src/eventstore/store';
import { InternalExecutionError } from '../../../src/errors';
import type { DomainEvent } from '../../../src/types';

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1',
    boundary: 'B',
    aggregateId: 'agg-1',
    type: 'TestEvent',
    payload: {},
    timestamp: '2024-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: 'cmd-1',
    ...overrides,
  };
}

describe('eventstore/store', () => {
  describe('createEventStore', () => {
    it('creates an empty store with size 0', () => {
      const store = createEventStore();
      expect(store.size()).toBe(0);
    });

    it('all() returns empty array initially', () => {
      const store = createEventStore();
      expect(store.all()).toHaveLength(0);
    });
  });

  describe('append', () => {
    it('appends a single event', () => {
      const store = createEventStore();
      store.append([makeEvent()]);
      expect(store.size()).toBe(1);
    });

    it('appends multiple events in one call', () => {
      const store = createEventStore();
      store.append([
        makeEvent({ eventId: 'e1', sequenceVersion: 1 }),
        makeEvent({ eventId: 'e2', aggregateId: 'agg-2', sequenceVersion: 1 }),
      ]);
      expect(store.size()).toBe(2);
    });

    it('is a no-op for empty array', () => {
      const store = createEventStore();
      store.append([]);
      expect(store.size()).toBe(0);
    });

    it('throws InternalExecutionError when eventId is missing', () => {
      const store = createEventStore();
      expect(() =>
        store.append([makeEvent({ eventId: '' })]),
      ).toThrow(InternalExecutionError);
    });

    it('throws InternalExecutionError when aggregateId is missing', () => {
      const store = createEventStore();
      expect(() =>
        store.append([makeEvent({ aggregateId: '' })]),
      ).toThrow(InternalExecutionError);
    });

    it('throws InternalExecutionError for non-monotonic sequence version', () => {
      const store = createEventStore();
      store.append([makeEvent({ sequenceVersion: 1 })]);
      expect(() =>
        store.append([makeEvent({ eventId: 'e2', sequenceVersion: 3 })]),
      ).toThrow(InternalExecutionError);
    });

    it('throws InternalExecutionError for duplicate sequenceVersion in same batch', () => {
      const store = createEventStore();
      expect(() =>
        store.append([
          makeEvent({ eventId: 'e1', sequenceVersion: 1 }),
          makeEvent({ eventId: 'e2', sequenceVersion: 1 }),
        ]),
      ).toThrow(InternalExecutionError);
    });

    it('atomicity: no events appended when batch fails validation', () => {
      const store = createEventStore();
      store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
      expect(() =>
        store.append([
          makeEvent({ eventId: 'e2', sequenceVersion: 2 }),
          makeEvent({ eventId: 'e3', sequenceVersion: 1 }), // wrong
        ]),
      ).toThrow(InternalExecutionError);
      expect(store.size()).toBe(1); // only the first event from before the batch
    });

    it('freezes appended events (immutability)', () => {
      const store = createEventStore();
      store.append([makeEvent()]);
      const events = store.all();
      expect(Object.isFrozen(events[0])).toBe(true);
    });

    it('accepts second event for same aggregate with incrementing version', () => {
      const store = createEventStore();
      store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
      store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);
      expect(store.size()).toBe(2);
    });
  });

  describe('all', () => {
    it('returns events in insertion order', () => {
      const store = createEventStore();
      store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
      store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);
      const events = store.all();
      expect(events[0]?.eventId).toBe('e1');
      expect(events[1]?.eventId).toBe('e2');
    });

    it('returns a frozen snapshot (not the internal array)', () => {
      const store = createEventStore();
      store.append([makeEvent()]);
      const snap1 = store.all();
      store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);
      const snap2 = store.all();
      expect(snap1).toHaveLength(1);
      expect(snap2).toHaveLength(2);
    });
  });

  describe('byAggregate', () => {
    it('returns empty array for unknown aggregate', () => {
      const store = createEventStore();
      expect(store.byAggregate('unknown')).toHaveLength(0);
    });

    it('returns events for specific aggregate', () => {
      const store = createEventStore();
      store.append([makeEvent({ eventId: 'e1', aggregateId: 'agg-1', sequenceVersion: 1 })]);
      store.append([makeEvent({ eventId: 'e2', aggregateId: 'agg-2', sequenceVersion: 1 })]);
      const events = store.byAggregate('agg-1');
      expect(events).toHaveLength(1);
      expect(events[0]?.eventId).toBe('e1');
    });
  });

  describe('currentSequenceVersion', () => {
    it('returns 0 for unknown aggregate', () => {
      const store = createEventStore();
      expect(store.currentSequenceVersion('unknown')).toBe(0);
    });

    it('returns latest sequence version after appending', () => {
      const store = createEventStore();
      store.append([makeEvent({ sequenceVersion: 1 })]);
      store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);
      expect(store.currentSequenceVersion('agg-1')).toBe(2);
    });
  });

  describe('purge', () => {
    it('empties the store', () => {
      const store = createEventStore();
      store.append([makeEvent()]);
      store.purge();
      expect(store.size()).toBe(0);
    });

    it('resets sequence counters after purge', () => {
      const store = createEventStore();
      store.append([makeEvent({ sequenceVersion: 1 })]);
      store.purge();
      expect(store.currentSequenceVersion('agg-1')).toBe(0);
    });

    it('allows re-appending events with version 1 after purge', () => {
      const store = createEventStore();
      store.append([makeEvent({ sequenceVersion: 1 })]);
      store.purge();
      expect(() => store.append([makeEvent({ eventId: 'e2', sequenceVersion: 1 })])).not.toThrow();
    });
  });

  describe('snapshot / restore (transactional rollback)', () => {
    it('restore discards events appended after the snapshot was taken', () => {
      const store = createEventStore();
      store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
      const snap = store.snapshot();

      store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);
      expect(store.size()).toBe(2);

      store.restore(snap);
      expect(store.size()).toBe(1);
      expect(store.all().map((e) => e.eventId)).toEqual(['e1']);
    });

    it('restore rewinds the aggregate sequence so the next append is monotonic', () => {
      const store = createEventStore();
      store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
      const snap = store.snapshot();
      store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);

      store.restore(snap);
      expect(store.currentSequenceVersion('agg-1')).toBe(1);
      // After rollback, version 2 is once again the valid next append.
      expect(() => store.append([makeEvent({ eventId: 'e2b', sequenceVersion: 2 })])).not.toThrow();
    });

    it('restore frees eventIds appended after the snapshot for reuse', () => {
      const store = createEventStore();
      const snap = store.snapshot();
      store.append([makeEvent({ eventId: 'dup', sequenceVersion: 1 })]);
      store.restore(snap);
      // The eventId 'dup' was rolled back, so re-appending it must not collide.
      expect(() => store.append([makeEvent({ eventId: 'dup', sequenceVersion: 1 })])).not.toThrow();
      expect(store.size()).toBe(1);
    });

    it('restore to an empty snapshot empties the store', () => {
      const store = createEventStore();
      const empty = store.snapshot();
      store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
      store.restore(empty);
      expect(store.size()).toBe(0);
    });
  });
});
