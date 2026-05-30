/**
 * Shared test helpers for unit tests.
 */
import type { Command, DomainEvent } from '../../../src/types';
import type { BoundaryConfig } from '../../../src/dsl/types';
import type { OpenApiDoc } from '../../../src/contract/loader';

/**
 * Minimal OpenApiDoc for pattern-matcher unit tests. Maps the default test routes
 * to operationIds so lookupOperationId resolves them. Extend `paths` via the argument
 * for bespoke routes.
 */
export const makeOpenApi = (paths: OpenApiDoc['paths'] = {}): OpenApiDoc => ({
  raw: {},
  paths: {
    '/test': {
      get: { operationId: 'listTest' },
      post: { operationId: 'createTest' },
    },
    '/test/{id}': {
      get: { operationId: 'getTest' },
      patch: { operationId: 'updateTest' },
      put: { operationId: 'updateTest' },
      delete: { operationId: 'deleteTest' },
    },
    ...paths,
  },
});

export const makeBoundary = (overrides: Partial<BoundaryConfig> = {}): BoundaryConfig => ({
  boundary: 'TestBoundary',
  contractPath: '/test',
  fallbackOverride: false,
  behaviors: [],
  reducers: [],
  eventCatalog: [],
  ...overrides,
});

export const makeCommand = (overrides: Partial<Command> = {}): Command => ({
  commandId: 'cmd-1',
  boundary: 'TestBoundary',
  intent: 'mutation',
  targetId: 'agg-1',
  payload: {},
  queryParams: {},
  httpMethod: 'PATCH',
  path: '/test/agg-1',
  origin: 'inbound',
  depth: 0,
  ...overrides,
});

export const makeDomainEvent = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  eventId: 'evt-1',
  boundary: 'TestBoundary',
  aggregateId: 'agg-1',
  type: 'TestEvent',
  payload: {},
  timestamp: '2024-01-01T00:00:00.000Z',
  sequenceVersion: 1,
  causedBy: 'cmd-1',
  ...overrides,
});
