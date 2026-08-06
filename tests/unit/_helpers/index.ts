/**
 * Shared test helpers for unit tests.
 */
import type { Command, DomainEvent } from '../../../src/contracts/domain';
import type { BoundaryConfig } from '../../../src/dsl/types';
import type { OpenApiDoc } from '../../../src/contract/loader';
import {
  aggregateId,
  boundaryName,
  commandId,
  eventId,
  eventType,
  httpMethod,
  operationId,
  sequenceVersion,
} from '../../../src/domain/references';

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

type CommandOverrides = Omit<
  Partial<Command>,
  'commandId' | 'targetId' | 'boundary' | 'httpMethod' | 'operationId'
> & {
  readonly commandId?: string;
  readonly targetId?: string | null;
  readonly boundary?: string;
  readonly httpMethod?: string;
  readonly operationId?: string;
};

export const makeCommand = (overrides: CommandOverrides = {}): Command => {
  const {
    commandId: rawCommandId,
    targetId: rawTargetId,
    boundary: rawBoundary,
    httpMethod: rawHttpMethod,
    operationId: rawOperationId,
    ...rest
  } = overrides;
  return {
    commandId: commandId(rawCommandId ?? 'cmd-1'),
    boundary: boundaryName(rawBoundary ?? 'TestBoundary'),
    intent: 'mutation',
    targetId:
      rawTargetId === undefined
        ? aggregateId('agg-1')
        : rawTargetId === null
          ? null
          : aggregateId(rawTargetId),
    payload: {},
    queryParams: {},
    httpMethod: httpMethod(rawHttpMethod ?? 'PATCH'),
    path: '/test/agg-1',
    origin: 'inbound',
    depth: 0,
    ...(rawOperationId === undefined ? {} : { operationId: operationId(rawOperationId) }),
    ...rest,
  };
};

export const makeDomainEvent = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  eventId: eventId('evt-1'),
  boundary: 'TestBoundary',
  aggregateId: aggregateId('agg-1'),
  type: eventType('TestEvent'),
  payload: {},
  timestamp: '2024-01-01T00:00:00.000Z',
  sequenceVersion: sequenceVersion(1),
  causedBy: 'cmd-1',
  ...overrides,
});
