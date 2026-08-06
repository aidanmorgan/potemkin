import type { Actor, JwtValidationConfig } from '../../../src/contracts/identity.js';
import type { Command, DomainEvent, ExecutionResult } from '../../../src/contracts/domain.js';
import { isJsonObject, isJsonValue } from '../../../src/contracts/value.js';
import {
  aggregateId,
  boundaryName,
  commandId,
  eventId,
  eventType,
  httpMethod,
  sequenceVersion,
} from '../../../src/domain/references.js';

describe('foundation domain and identity contracts', () => {
  it('composes the canonical command, event, result, and actor shapes', () => {
    const actor: Actor = { id: 'alice', scopes: ['orders:read'] };
    const command: Command = {
      commandId: commandId('cmd-1'),
      boundary: boundaryName('Order'),
      intent: 'creation',
      targetId: null,
      payload: { sku: 'sku-1' },
      queryParams: {},
      httpMethod: httpMethod('POST'),
      path: '/orders',
      origin: 'inbound',
      depth: 0,
      actor,
    };
    const event: DomainEvent = {
      eventId: eventId('evt-1'),
      boundary: boundaryName(command.boundary),
      aggregateId: aggregateId('order-1'),
      type: eventType('OrderCreated'),
      payload: command.payload,
      timestamp: '2026-08-05T00:00:00.000Z',
      sequenceVersion: sequenceVersion(1),
      causedBy: command.commandId,
      intent: command.intent,
    };
    const result: ExecutionResult = {
      status: 201,
      body: { id: event.aggregateId },
      events: [event],
    };

    expect(result.events[0]).toEqual(event);
    expect(actor.scopes).toContain('orders:read');
  });

  it('keeps JWT validation configuration transport-neutral', () => {
    const configuration: JwtValidationConfig = {
      secret: 'test-secret',
      algorithm: 'HS256',
      subjectClaim: 'sub',
      scopesClaim: 'scope',
    };

    expect(configuration.algorithm).toBe('HS256');
  });

  it('accepts JSON values and rejects cyclic or non-plain objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class JsonRecord {
      readonly value = 'ok';
    }

    expect(isJsonValue({ nested: [true, null, 1] })).toBe(true);
    expect(isJsonObject({ nested: [true, null, 1] })).toBe(true);
    expect(isJsonValue(new JsonRecord())).toBe(true);
    expect(isJsonValue(cyclic)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
  });
});
