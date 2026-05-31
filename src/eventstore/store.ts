/**
 * EventStore — append-only in-memory event ledger.
 *
 * Metric emission is the UoW's responsibility (separation of concerns); standalone
 * store use is unmetered by design. The `eventsAppendedTotal` metric is incremented
 * in `uow.ts` after a successful commit, not here.
 */
import type { DomainEvent, EventResponseSnapshot } from '../types.js';
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

  /** Attach a response snapshot retroactively to the named events. */
  attachResponse(eventIds: readonly string[], response: EventResponseSnapshot): void;

  /**
   * Capture an opaque snapshot of the current ledger so a caller can later roll
   * back to exactly this state. Used to give multi-item transactional batches
   * (bulk-transactional) all-or-nothing semantics without a real DB transaction.
   */
  snapshot(): EventStoreSnapshot;

  /** Restore the ledger to a previously-captured snapshot, discarding later appends. */
  restore(snapshot: EventStoreSnapshot): void;
}

/** Opaque, immutable capture of EventStore contents for transactional rollback. */
export interface EventStoreSnapshot {
  /** Frozen events as of capture, in insertion order. */
  readonly events: readonly DomainEvent[];
}

const logger = createLogger({ name: 'eventstore' });

export function createEventStore(): EventStore {
  const events: DomainEvent[] = [];
  const byAggMap = new Map<string, DomainEvent[]>();
  const seqByAgg = new Map<string, number>();
  // S-1: Global set of all seen eventIds; ensures uniqueness across separate append() calls.
  const eventIdSet = new Set<string>();

  function validate(incoming: readonly DomainEvent[]): void {
    // Build a local view of current sequences so we can validate a whole batch
    const localSeq = new Map<string, number>(seqByAgg);
    // Local set of eventIds within this batch plus already-seen IDs
    const localSeen = new Set<string>(eventIdSet);

    for (const event of incoming) {
      if (!event.eventId) {
        throw new InternalExecutionError('Event missing eventId', { eventId: event.eventId ?? null });
      }
      if (!event.aggregateId) {
        throw new InternalExecutionError('Event missing aggregateId', { aggregateId: event.aggregateId ?? null });
      }

      // S-1: Reject duplicate eventId across separate append() calls or within a batch.
      if (localSeen.has(event.eventId)) {
        throw new InternalExecutionError('Duplicate eventId', {
          code: 'EVENT_DUPLICATE_ID',
          eventId: event.eventId,
        });
      }
      localSeen.add(event.eventId);

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
        // S-1: Record the eventId as seen so future appends can detect duplicates.
        eventIdSet.add(frozen.eventId);
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
      // S-1: Clear the duplicate-detection set on purge so reset is clean.
      eventIdSet.clear();
      logger.info('Event store purged');
    },

    size(): number {
      return events.length;
    },

    attachResponse(eventIds: readonly string[], response: EventResponseSnapshot): void {
      if (eventIds.length === 0) return;
      const idSet = new Set(eventIds);
      const frozen = Object.freeze({ ...response }) as EventResponseSnapshot;

      const rewriteList = (list: DomainEvent[]): void => {
        for (let i = 0; i < list.length; i++) {
          const event = list[i]!;
          if (!idSet.has(event.eventId)) continue;
          list[i] = Object.freeze({ ...event, response: frozen }) as DomainEvent;
        }
      };

      rewriteList(events);
      for (const [aggId, list] of byAggMap) {
        rewriteList(list);
        byAggMap.set(aggId, list);
      }
    },

    snapshot(): EventStoreSnapshot {
      // Events are already individually frozen; a shallow copy of the array is a
      // faithful, side-effect-free capture.
      return Object.freeze({ events: Object.freeze([...events]) });
    },

    restore(snap: EventStoreSnapshot): void {
      // Rebuild the ledger and all derived indices from the captured events,
      // discarding anything appended after the snapshot was taken.
      events.length = 0;
      byAggMap.clear();
      seqByAgg.clear();
      eventIdSet.clear();

      for (const event of snap.events) {
        events.push(event);
        const aggList = byAggMap.get(event.aggregateId);
        if (aggList) aggList.push(event);
        else byAggMap.set(event.aggregateId, [event]);
        const prevSeq = seqByAgg.get(event.aggregateId) ?? 0;
        if (event.sequenceVersion > prevSeq) seqByAgg.set(event.aggregateId, event.sequenceVersion);
        eventIdSet.add(event.eventId);
      }

      logger.info({ count: snap.events.length }, 'Event store restored to snapshot');
    },
  };
}
