import type { DomainEvent } from '../types.js';
import { InternalExecutionError } from '../errors.js';
import { createLogger } from '../observability/index.js';

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

const logger = createLogger({ name: 'eventstore' });

export function createEventStore(): EventStore {
  const events: DomainEvent[] = [];
  const byAggMap = new Map<string, DomainEvent[]>();
  const seqByAgg = new Map<string, number>();

  function validate(incoming: readonly DomainEvent[]): void {
    // Build a local view of current sequences so we can validate a whole batch
    const localSeq = new Map<string, number>(seqByAgg);

    for (const event of incoming) {
      if (!event.eventId) {
        throw new InternalExecutionError('Event missing eventId', { eventId: event.eventId ?? null });
      }
      if (!event.aggregateId) {
        throw new InternalExecutionError('Event missing aggregateId', { aggregateId: event.aggregateId ?? null });
      }

      const currentSeq = localSeq.get(event.aggregateId) ?? 0;
      const expectedSeq = currentSeq + 1;

      if (event.sequenceVersion !== expectedSeq) {
        throw new InternalExecutionError('Non-monotonic sequence version', {
          aggregateId: event.aggregateId,
          expected: expectedSeq,
          got: event.sequenceVersion,
        });
      }

      // Advance local sequence for subsequent events in the same batch
      localSeq.set(event.aggregateId, event.sequenceVersion);
    }
  }

  return {
    append(incoming: readonly DomainEvent[]): void {
      if (incoming.length === 0) return;

      // Validate all events before mutating state (atomicity)
      validate(incoming);

      const aggregatesTouched = new Set<string>();

      for (const event of incoming) {
        const frozen = Object.freeze({ ...event }) as DomainEvent;

        events.push(frozen);

        const aggList = byAggMap.get(frozen.aggregateId);
        if (aggList) {
          aggList.push(frozen);
        } else {
          byAggMap.set(frozen.aggregateId, [frozen]);
        }

        seqByAgg.set(frozen.aggregateId, frozen.sequenceVersion);
        aggregatesTouched.add(frozen.aggregateId);
      }

      logger.info(
        { count: incoming.length, aggregates: [...aggregatesTouched] },
        'Events appended',
      );
    },

    all(): readonly DomainEvent[] {
      return Object.freeze([...events]);
    },

    byAggregate(aggregateId: string): readonly DomainEvent[] {
      const list = byAggMap.get(aggregateId);
      return Object.freeze(list ? [...list] : []);
    },

    currentSequenceVersion(aggregateId: string): number {
      return seqByAgg.get(aggregateId) ?? 0;
    },

    purge(): void {
      events.length = 0;
      byAggMap.clear();
      seqByAgg.clear();
      logger.info('Event store purged');
    },

    size(): number {
      return events.length;
    },
  };
}
