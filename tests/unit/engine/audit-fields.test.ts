/**
 * Unit tests for automatic audit fields (updatedAt, updatedBy).
 *
 * After every mutation event is processed, the UoW sets:
 *   - updatedAt: current ISO timestamp
 *   - updatedBy: command.actor.id or null
 *
 * These tests exercise the UoW execution path to verify audit field injection.
 */

import { executeUnitOfWork } from '../../../src/engine/uow';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createEventStore } from '../../../src/eventstore/store';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
import type { ContractValidator } from '../../../src/contract/validator';

// OpenAPI used for operationId resolution in these UoW tests. The boundary is bound
// to /test; commands hit POST /test (createTest), PATCH /test/{id} (updateTest), and
// GET /test/{id} (getTest).
const auditOpenapi = makeOpenApi();

const cel = createCelEvaluator();

// A no-op validator that passes everything
const noopValidator: ContractValidator = {
  validateRequest: () => {},
  validateResponse: () => {},
  validateEntity: () => {},
};

describe('audit fields — updatedAt / updatedBy', () => {
  it('sets updatedAt on mutation via fallback override', async () => {
    const graph = createStateGraph();
    graph.set('agg-1', { id: 'agg-1', status: 'NEW' });

    const events = createEventStore();
    // Seed an event so concurrency checks pass
    events.append([{
      eventId: 'seed-1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'BaselineEntityCreatedEvent',
      payload: { id: 'agg-1', status: 'NEW' },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }]);

    const boundary = makeBoundary({
      auditFields: true,
      fallbackOverride: true,
      behaviors: [],
      reducers: [],
      eventCatalog: [],
    });

    const dsl = {
      boundaries: [boundary],
      byContractPath: { '/test': boundary },
      byBoundaryName: { TestBoundary: boundary },
    };

    const command = makeCommand({
      intent: 'mutation',
      httpMethod: 'PATCH',
      targetId: 'agg-1',
      payload: { status: 'CONTACTED' },
    });

    const beforeTime = new Date().toISOString();

    const result = await executeUnitOfWork({
      command,
      dsl,
      graph,
      events,
      cel,
      validator: noopValidator,
      openapi: auditOpenapi,
    });

    const afterTime = new Date().toISOString();

    expect(result.status).toBe(200);
    const entity = graph.get('agg-1');
    expect(entity).not.toBeNull();
    expect(entity!.updatedAt).toBeDefined();
    expect(typeof entity!.updatedAt).toBe('string');
    // updatedAt should be between beforeTime and afterTime
    expect(entity!.updatedAt as string >= beforeTime).toBe(true);
    expect(entity!.updatedAt as string <= afterTime).toBe(true);
  });

  it('sets updatedBy to null when no actor is present', async () => {
    const graph = createStateGraph();
    graph.set('agg-1', { id: 'agg-1', status: 'NEW' });

    const events = createEventStore();
    events.append([{
      eventId: 'seed-1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'BaselineEntityCreatedEvent',
      payload: { id: 'agg-1', status: 'NEW' },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }]);

    const boundary = makeBoundary({
      auditFields: true,
      fallbackOverride: true,
      behaviors: [],
      reducers: [],
      eventCatalog: [],
    });

    const dsl = {
      boundaries: [boundary],
      byContractPath: { '/test': boundary },
      byBoundaryName: { TestBoundary: boundary },
    };

    const command = makeCommand({
      intent: 'mutation',
      httpMethod: 'PATCH',
      targetId: 'agg-1',
      payload: { status: 'CONTACTED' },
    });

    await executeUnitOfWork({
      command,
      dsl,
      graph,
      events,
      cel,
      validator: noopValidator,
      openapi: auditOpenapi,
    });

    const entity = graph.get('agg-1');
    expect(entity!.updatedBy).toBeNull();
  });

  it('sets updatedBy to actor.id when actor is present', async () => {
    const graph = createStateGraph();
    graph.set('agg-1', { id: 'agg-1', status: 'NEW' });

    const events = createEventStore();
    events.append([{
      eventId: 'seed-1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'BaselineEntityCreatedEvent',
      payload: { id: 'agg-1', status: 'NEW' },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }]);

    const boundary = makeBoundary({
      auditFields: true,
      fallbackOverride: true,
      behaviors: [],
      reducers: [],
      eventCatalog: [],
    });

    const dsl = {
      boundaries: [boundary],
      byContractPath: { '/test': boundary },
      byBoundaryName: { TestBoundary: boundary },
    };

    const command = makeCommand({
      intent: 'mutation',
      httpMethod: 'PATCH',
      targetId: 'agg-1',
      payload: { status: 'CONTACTED' },
      actor: { id: 'user-42', scopes: ['manager'] },
    });

    await executeUnitOfWork({
      command,
      dsl,
      graph,
      events,
      cel,
      validator: noopValidator,
      openapi: auditOpenapi,
    });

    const entity = graph.get('agg-1');
    expect(entity!.updatedBy).toBe('user-42');
  });

  it('sets updatedAt on creation events', async () => {
    const graph = createStateGraph();

    const events = createEventStore();

    const boundary = makeBoundary({
      auditFields: true,
      fallbackOverride: true,
      behaviors: [{
        name: 'create',
        match: { method: 'POST', operationId: 'createTest', condition: 'true' },
        emit: 'Created',
      }],
      reducers: [{
        on: 'Created',
        patches: [
          { op: 'replace', path: '/id', value: '${event.payload.id}' },
          { op: 'replace', path: '/name', value: '${event.payload.name}' },
        ],
      }],
      eventCatalog: [{
        type: 'Created',
        payloadTemplate: { id: 'command.targetId', name: 'command.payload.name' },
      }],
    });

    const dsl = {
      boundaries: [boundary],
      byContractPath: { '/test': boundary },
      byBoundaryName: { TestBoundary: boundary },
    };

    const command = makeCommand({
      intent: 'creation',
      httpMethod: 'POST',
      path: '/test',
      targetId: 'agg-new',
      payload: { name: 'Test Entity' },
    });

    await executeUnitOfWork({
      command,
      dsl,
      graph,
      events,
      cel,
      validator: noopValidator,
      openapi: auditOpenapi,
    });

    const entity = graph.get('agg-new');
    expect(entity).not.toBeNull();
    expect(entity!.updatedAt).toBeDefined();
    expect(entity!.updatedBy).toBeNull(); // no actor on command
  });

  it('does not set audit fields on query intent', async () => {
    const graph = createStateGraph();
    graph.set('agg-1', { id: 'agg-1', status: 'NEW' });

    const events = createEventStore();
    events.append([{
      eventId: 'seed-1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'BaselineEntityCreatedEvent',
      payload: { id: 'agg-1', status: 'NEW' },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }]);

    const boundary = makeBoundary({
      auditFields: true,
      fallbackOverride: true,
      behaviors: [],
      reducers: [],
      eventCatalog: [],
    });

    const dsl = {
      boundaries: [boundary],
      byContractPath: { '/test': boundary },
      byBoundaryName: { TestBoundary: boundary },
    };

    const command = makeCommand({
      intent: 'query',
      httpMethod: 'GET',
      targetId: 'agg-1',
      payload: {},
    });

    await executeUnitOfWork({
      command,
      dsl,
      graph,
      events,
      cel,
      validator: noopValidator,
      openapi: auditOpenapi,
    });

    const entity = graph.get('agg-1');
    // Query should not add audit fields
    expect(entity!.updatedAt).toBeUndefined();
    expect(entity!.updatedBy).toBeUndefined();
  });
});
