import type { OpenApiDoc } from '../../../src/contract/loader.js';
import { deriveRuntimeFixtures } from '../../../src/http/runtimeFixtures.js';
import type { RuntimeSystem } from '../../../src/runtime/system.js';
import type { DomainEvent } from '../../../src/contracts/domain.js';
import {
  AggregateId,
  boundaryName,
  eventId,
  eventType,
  sequenceVersion,
} from '../../../src/domain/references.js';

function testSystem(
  paths: OpenApiDoc['paths'],
  boundaries: readonly { boundary: string; contractPath: string }[],
  events: readonly DomainEvent[],
): RuntimeSystem {
  const byBoundaryName = new Map(
    boundaries.map((boundary) => [boundary.boundary, boundary] as const),
  );
  return {
    openapi: { raw: {}, paths },
    program: { boundaries, byBoundaryName },
    engine: { snapshot: () => ({ events }) },
  } as unknown as RuntimeSystem;
}

function baselineEvent(
  boundary: string,
  aggregateId: string,
  payload: DomainEvent['payload'],
): DomainEvent {
  return {
    eventId: eventId(`baseline-${aggregateId}`),
    boundary: boundaryName(boundary),
    aggregateId: AggregateId.parse(aggregateId),
    type: eventType('Created'),
    payload,
    timestamp: '1970-01-01T00:00:00.000Z',
    sequenceVersion: sequenceVersion(1),
    causedBy: null,
  };
}

describe('deriveRuntimeFixtures', () => {
  it('projects object baselines for the matching OpenAPI by-id route', () => {
    const system = testSystem(
      {
        '/orders/search': { get: {} },
        '/orders/{orderId}': { get: {} },
        '/orders/{withoutGet}': {},
        '/other/{id}': { get: {} },
      },
      [{ boundary: 'Order', contractPath: '/orders' }],
      [
        baselineEvent('Order', 'order-1', { id: 'order-1', state: 'READY' }),
        baselineEvent('Order', 'order-2', [] as unknown as DomainEvent['payload']),
        {
          ...baselineEvent('Unknown', 'unknown-1', { id: 'unknown-1' }),
          eventId: eventId('baseline-unknown-1'),
        },
        { ...baselineEvent('Order', 'live-1', { id: 'live-1' }), eventId: eventId('live-1') },
      ],
    );

    expect(deriveRuntimeFixtures(system)).toEqual([
      {
        httpRequest: { method: 'GET', path: '/orders/order-1' },
        httpResponse: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { id: 'order-1', state: 'READY' },
        },
        source: {
          boundary: 'Order',
          aggregateId: 'order-1',
          contractPath: '/orders/{orderId}',
        },
      },
    ]);
  });

  it('does not create fixtures for a boundary without a by-id GET route', () => {
    const system = testSystem(
      { '/orders': { get: {} } },
      [{ boundary: 'Order', contractPath: '/orders' }],
      [baselineEvent('Order', 'order-1', { id: 'order-1' })],
    );

    expect(deriveRuntimeFixtures(system)).toEqual([]);
  });
});
