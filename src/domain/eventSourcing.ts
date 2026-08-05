import type { DomainEvent } from '../contracts/domain.js';
import {
  aggregateId as validateAggregateId,
  committedSequenceVersion,
  sequenceVersion,
} from './references.js';

/**
 * Calculate the next version for an aggregate without depending on storage.
 * Persisted state supplies `currentVersion`; transaction-local events are
 * counted so a batch receives one monotonic version per emitted event.
 */
export function nextSequenceVersion(
  currentVersion: number,
  pendingEvents: readonly DomainEvent[],
  aggregate: string,
): number {
  const current = sequenceVersion(currentVersion);
  const aggregateId = validateAggregateId(aggregate);
  const pending = pendingEvents.filter(
    (event) => validateAggregateId(event.aggregateId) === aggregateId,
  );
  pending.forEach((event) => committedSequenceVersion(event.sequenceVersion));
  return committedSequenceVersion(current + pending.length + 1);
}

/** Return an aggregate's committed history at or before a requested version. */
export function eventsThroughVersion(
  events: readonly DomainEvent[],
  aggregate: string,
  version: number,
): readonly DomainEvent[] {
  const aggregateId = validateAggregateId(aggregate);
  const requested = sequenceVersion(version);
  const selected = events
    .filter(
      (event) =>
        validateAggregateId(event.aggregateId) === aggregateId &&
        committedSequenceVersion(event.sequenceVersion) <= requested,
    )
    .sort((left, right) => left.sequenceVersion - right.sequenceVersion);
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index]!.sequenceVersion <= selected[index - 1]!.sequenceVersion) {
      throw new Error(`Aggregate "${aggregate}" has duplicate event sequence versions`);
    }
  }
  return selected;
}
