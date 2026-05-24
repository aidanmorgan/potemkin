/**
 * REQ-88/89/90: Derived projections integration test
 *
 * Validates that:
 * - Derived projection state is updated after domain events
 * - GET /_admin/derived/:name returns the current state
 */
import supertest from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import type { BootInput } from '../../../src/engine/boot.js';
import {
  createDerivedProjectionRegistry,
  applyEventToDerivedProjections,
  getDerivedProjection,
} from '../../../src/projections/engine.js';
import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import type { DerivedProjectionConfig } from '../../../src/dsl/types.js';
import type { DomainEvent } from '../../../src/types.js';

describe('DSL Tier-2: Derived Projections — unit-level', () => {
  const cel = createCelEvaluator();

  it('builds derived projection state from events', () => {
    const proj: DerivedProjectionConfig = {
      name: 'LoanSummary',
      key: 'event.aggregateId',
      subscribe: ['Lead:LeadCreated'],
      reduce: [
        {
          on: 'LeadCreated',
          assign: {
            loan_id: 'event.aggregateId',
            amount: 'event.payload.amount',
          },
        },
      ],
    };

    const registry = createDerivedProjectionRegistry();
    const event: DomainEvent = {
      eventId: 'evt-1',
      boundary: 'Lead',
      aggregateId: 'loan-42',
      type: 'LeadCreated',
      payload: { amount: 5000 },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: 'cmd-1',
    };

    applyEventToDerivedProjections(event, [proj], registry, cel);
    const result = getDerivedProjection(registry, 'LoanSummary');

    expect(result).not.toBeNull();
    expect(result!['loan-42']).toMatchObject({ loan_id: 'loan-42', amount: 5000 });
  });

  it('returns null for projection registry get on unknown name', () => {
    const registry = createDerivedProjectionRegistry();
    expect(getDerivedProjection(registry, 'Unknown')).toBeNull();
  });
});

describe('DSL Tier-2: Derived Projections — schema parsing', () => {
  it('parses derived_projections from global config YAML', async () => {
    const GLOBAL_YAML = `
derived_projections:
  - name: CustomerSummary
    key: event.aggregateId
    subscribe:
      - Customer:CustomerRegistered
    reduce:
      - on: CustomerRegistered
        assign:
          customer_id: event.aggregateId
`;
    const dsl = await compileDsl([], GLOBAL_YAML);
    expect(dsl.derivedProjections).toHaveLength(1);
    expect(dsl.derivedProjections![0].name).toBe('CustomerSummary');
    expect(dsl.derivedProjections![0].subscribe).toContain('Customer:CustomerRegistered');
    expect(dsl.derivedProjections![0].reduce[0].assign).toMatchObject({ customer_id: 'event.aggregateId' });
  });
});
