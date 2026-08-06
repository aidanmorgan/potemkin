import { eventsThroughVersion, nextSequenceVersion } from '../../../src/domain/eventSourcing.js';
import type { DomainEvent } from '../../../src/contracts/domain.js';
import {
  AggregateId,
  boundaryName,
  eventId,
  eventType,
  SequenceVersion,
} from '../../../src/domain/references.js';

const event = (sequenceVersion: number, aggregateId = 'order-1'): DomainEvent => ({
  eventId: eventId(`event-${sequenceVersion}`),
  boundary: boundaryName('Orders'),
  aggregateId: AggregateId.parse(aggregateId),
  type: eventType('OrderUpdated'),
  payload: { sequenceVersion },
  timestamp: '2026-01-01T00:00:00.000Z',
  sequenceVersion: SequenceVersion.parse(sequenceVersion),
  causedBy: null,
});

describe('event-sourcing domain invariants', () => {
  it('allocates monotonic versions across persisted and transaction-local events', () => {
    expect(nextSequenceVersion(2, [event(3), event(4), event(1, 'other')], 'order-1')).toBe(5);
    expect(nextSequenceVersion(0, [], 'order-1')).toBe(1);
  });

  it('replays only the requested aggregate and version without mutating history', () => {
    const history = [event(2), event(1), event(1, 'other')];
    const replayed = eventsThroughVersion(history, 'order-1', 1);

    expect(replayed.map((item) => item.sequenceVersion)).toEqual([1]);
    expect(history.map((item) => item.sequenceVersion)).toEqual([2, 1, 1]);
  });

  it('rejects invalid aggregate and committed sequence values', () => {
    expect(() => nextSequenceVersion(0, [event(0)], 'order-1')).toThrow(
      /committed-sequence-version/,
    );
    expect(() => eventsThroughVersion([event(1)], '', 1)).toThrow(/aggregate-id/);
    expect(() => eventsThroughVersion([event(1), event(1)], 'order-1', 2)).toThrow(
      /duplicate event sequence versions/,
    );
  });
});
