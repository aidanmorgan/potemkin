/**
 * Inline fixture builder for property-based tests.
 * Used instead of tests/fixtures/index.ts (which does not exist in this worktree).
 */

import type { CompiledDsl, BoundaryConfig } from '../../../src/dsl/types';
import type { ObjectGraphSchemaRegistry, BoundarySchemas, ObjectGraphSchema } from '../../../src/schema/types';
import type { DomainEvent, JsonObject } from '../../../src/types';
import { createEventStore } from '../../../src/eventstore/store';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';

// ---------------------------------------------------------------------------
// Minimal schema for a "Customer" boundary
// ---------------------------------------------------------------------------

export const CUSTOMER_SCHEMA: ObjectGraphSchema = {
  name: 'Customer',
  kind: 'object',
  additionalProperties: false,
  properties: {
    customerId: { name: 'customerId', kind: 'string' },
    name: { name: 'name', kind: 'string' },
    email: { name: 'email', kind: 'string' },
    balance: { name: 'balance', kind: 'number' },
    active: { name: 'active', kind: 'boolean' },
    tags: {
      name: 'tags',
      kind: 'array',
      items: { name: 'tag', kind: 'string' },
    },
    address: {
      name: 'address',
      kind: 'object',
      additionalProperties: false,
      properties: {
        street: { name: 'street', kind: 'string' },
        city: { name: 'city', kind: 'string' },
      },
    },
  },
};

export const LOAN_SCHEMA: ObjectGraphSchema = {
  name: 'Lead',
  kind: 'object',
  additionalProperties: false,
  properties: {
    loanId: { name: 'loanId', kind: 'string' },
    customerId: { name: 'customerId', kind: 'string' },
    amount: { name: 'amount', kind: 'number' },
    status: {
      name: 'status',
      kind: 'string',
      enum: ['pending', 'active', 'closed'],
    },
  },
};

export function makeCrmRegistry(): ObjectGraphSchemaRegistry {
  const customerBoundary: BoundarySchemas = {
    boundary: 'Customer',
    entity: CUSTOMER_SCHEMA,
    arrayPaths: ['tags'],
  };
  const leadBoundary: BoundarySchemas = {
    boundary: 'Lead',
    entity: LOAN_SCHEMA,
    arrayPaths: [],
  };

  const map: Record<string, BoundarySchemas> = {
    Customer: customerBoundary,
    Lead: leadBoundary,
  };

  return {
    byBoundary: map,
    get(boundary: string) { return map[boundary]; },
  };
}

// ---------------------------------------------------------------------------
// Minimal CompiledDsl
// ---------------------------------------------------------------------------

export function makeCustomerBoundaryConfig(): BoundaryConfig {
  return {
    boundary: 'Customer',
    contractPath: '/customers',
    fallbackOverride: false,
    behaviors: [],
    reducers: [
      {
        on: 'Customer.Created',
        assign: {
          customerId: 'event.payload.customerId',
          name: 'event.payload.name',
          email: 'event.payload.email',
          balance: '0',
          active: 'true',
        },
      },
      {
        on: 'Customer.Updated',
        assign: {
          name: 'event.payload.name',
        },
      },
    ],
    eventCatalog: [
      { type: 'Customer.Created', payloadTemplate: {} },
      { type: 'Customer.Updated', payloadTemplate: {} },
    ],
  };
}

export function makeCompiledDsl(): CompiledDsl {
  const customerBc = makeCustomerBoundaryConfig();
  return {
    boundaries: [customerBc],
    byContractPath: { '/customers': customerBc },
    byBoundaryName: { Customer: customerBc },
  };
}

// ---------------------------------------------------------------------------
// Convenience factory — boot a fresh simulation environment
// ---------------------------------------------------------------------------

export function bootFreshSimulation() {
  return {
    eventStore: createEventStore(),
    graph: createStateGraph(),
    cel: createCelEvaluator(),
    dsl: makeCompiledDsl(),
    registry: makeCrmRegistry(),
  };
}

// ---------------------------------------------------------------------------
// Event builder helpers
// ---------------------------------------------------------------------------

export function makeEvent(
  overrides: Partial<DomainEvent> & { aggregateId: string; sequenceVersion: number },
): DomainEvent {
  // Derive a stable eventId from both aggregateId and sequenceVersion so that
  // events for different aggregates with the same sequenceVersion have distinct IDs.
  // This is important now that the EventStore enforces eventId uniqueness (S-1).
  const aggHash = overrides.aggregateId
    .split('')
    .reduce((h, c) => ((h * 31 + c.charCodeAt(0)) & 0xffffff), 0)
    .toString(16)
    .padStart(6, '0');
  const seqHex = String(overrides.sequenceVersion).padStart(6, '0');
  return {
    eventId: `00000000-0000-7000-8000-${aggHash}${seqHex}`,
    boundary: 'Customer',
    type: 'Customer.Created',
    payload: {} as JsonObject,
    timestamp: new Date(0).toISOString(),
    causedBy: null,
    ...overrides,
  };
}
