import type { DomainEvent } from '../types.js';

export interface EventStore {
  /** Atomically append a block of events to the ledger. */
  append(events: readonly DomainEvent[]): void;

  /** Return all events in insertion order. */
  all(): readonly DomainEvent[];

  /** Return all events for a specific aggregate, in insertion order. */
  byAggregate(aggregateId: string): readonly DomainEvent[];

  /**
   * Return the highest sequenceVersion for the given aggregate.
   * Returns 0 if no events exist for that aggregate.
   */
  currentSequenceVersion(aggregateId: string): number;

  /** Discard all events (used during reset). */
  purge(): void;

  /** Return the total number of events in the store. */
  size(): number;
}

export function createEventStore(): EventStore {
  throw new Error('NotImplemented: eventstore/store.createEventStore');
}
