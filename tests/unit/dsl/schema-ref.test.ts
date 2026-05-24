/**
 * REQ-65: event_catalog[].schema_ref — pin event payload to OpenAPI $ref
 */
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { projectEvent } from '../../../src/engine/projection';
import type { ProjectionInput } from '../../../src/engine/projection';
import { BootError, InternalExecutionError } from '../../../src/errors';
import { makeBoundary, makeDomainEvent } from '../_helpers';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createStateGraph } from '../../../src/stategraph/graph';
import type { OpenApiDoc } from '../../../src/contract/loader';

const cel = createCelEvaluator();

// Minimal OpenAPI doc for testing
const makeOpenApiDoc = (schemas: Record<string, unknown> = {}): OpenApiDoc => ({
  paths: { '/test': { put: { parameters: [] } } },
  raw: {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: { '/test': { put: {} } },
    components: { schemas },
  },
} as unknown as OpenApiDoc);

// ── Schema parsing ─────────────────────────────────────────────────────────────

describe('REQ-65: event_catalog schema_ref DSL parsing', () => {
  it('parses schema_ref field on event_catalog entry', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        { name: 'open', match: { intent: 'creation', condition: 'true' }, emit: 'LoanOpened' },
      ],
      reducers: [],
      event_catalog: [
        {
          type: 'LoanOpened',
          payload_template: { principal: 'command.payload.principal' },
          schema_ref: '#/components/schemas/LoanOpenedEvent',
        },
      ],
    });
    expect(config.eventCatalog[0].schemaRef).toBe('#/components/schemas/LoanOpenedEvent');
  });

  it('leaves schemaRef undefined when not specified', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [{ name: 'open', match: { intent: 'creation', condition: 'true' }, emit: 'LoanOpened' }],
      reducers: [],
      event_catalog: [{ type: 'LoanOpened', payload_template: {} }],
    });
    expect(config.eventCatalog[0].schemaRef).toBeUndefined();
  });
});

// ── Runtime validation ─────────────────────────────────────────────────────────

describe('REQ-65: schema_ref runtime validation', () => {
  it('allows event payload that matches the schema_ref', () => {
    const openapi = makeOpenApiDoc({
      LoanOpenedEvent: {
        type: 'object',
        required: ['principal'],
        properties: { principal: { type: 'number' } },
      },
    });

    const graph = createStateGraph();
    const input: ProjectionInput = {
      event: makeDomainEvent({ type: 'LoanOpened', payload: { principal: 10000 } }),
      boundary: makeBoundary({
        boundary: 'TestBoundary',
        reducers: [],
        eventCatalog: [
          {
            type: 'LoanOpened',
            payloadTemplate: {},
            schemaRef: '#/components/schemas/LoanOpenedEvent',
          },
        ],
      }),
      graph,
      cel,
      openapi,
    };
    // Should not throw
    expect(() => projectEvent(input)).not.toThrow();
  });

  it('throws InternalExecutionError with EVENT_PAYLOAD_VIOLATES_SCHEMA when payload fails schema', () => {
    const openapi = makeOpenApiDoc({
      LoanOpenedEvent: {
        type: 'object',
        required: ['principal'],
        properties: { principal: { type: 'number' } },
      },
    });

    const graph = createStateGraph();
    const input: ProjectionInput = {
      // principal is a string, but schema requires number
      event: makeDomainEvent({ type: 'LoanOpened', payload: { principal: 'not-a-number' } }),
      boundary: makeBoundary({
        boundary: 'TestBoundary',
        reducers: [],
        eventCatalog: [
          {
            type: 'LoanOpened',
            payloadTemplate: {},
            schemaRef: '#/components/schemas/LoanOpenedEvent',
          },
        ],
      }),
      graph,
      cel,
      openapi,
    };

    expect(() => projectEvent(input)).toThrow(InternalExecutionError);
    try {
      projectEvent(input);
    } catch (err) {
      expect(err instanceof InternalExecutionError).toBe(true);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('EVENT_PAYLOAD_VIOLATES_SCHEMA');
      expect(details['eventType']).toBe('LoanOpened');
      expect(details['schemaRef']).toBe('#/components/schemas/LoanOpenedEvent');
    }
  });

  it('skips schema_ref validation when no openapi doc is provided', () => {
    const graph = createStateGraph();
    const input: ProjectionInput = {
      event: makeDomainEvent({ type: 'LoanOpened', payload: { principal: 'bad-type' } }),
      boundary: makeBoundary({
        reducers: [],
        eventCatalog: [
          {
            type: 'LoanOpened',
            payloadTemplate: {},
            schemaRef: '#/components/schemas/LoanOpenedEvent',
          },
        ],
      }),
      graph,
      cel,
      // openapi not provided
    };
    // Should not throw since no openapi to validate against
    expect(() => projectEvent(input)).not.toThrow();
  });

  it('skips schema_ref validation for System.GenericUpdateEvent', () => {
    const openapi = makeOpenApiDoc({
      SomeSchema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    const graph = createStateGraph();
    const input: ProjectionInput = {
      event: makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { x: 'not-a-number' } }),
      boundary: makeBoundary({
        reducers: [],
        eventCatalog: [],
      }),
      graph,
      cel,
      openapi,
    };
    // Generic events bypass schema_ref check
    expect(() => projectEvent(input)).not.toThrow();
  });
});
