import { createRuntimeEngine } from '../../../src/core/engine.js';
import { RuntimeExecutionError } from '../../../src/core/errors.js';
import { compileRuntime } from '../../../src/model/compiler.js';
import { createRuntimeDataGenerator } from '../../../src/model/data.js';
import type {
  CompiledRuntimeProgram,
  RuntimeBoundary,
  RuntimeHelpers,
  RuntimeProgram,
} from '../../../src/model/runtime.js';
import type { RuntimeClock } from '../../../src/contracts/ports.js';
import type { RuntimeRequestResponseObservation } from '../../../src/contracts/ports.js';
import type { Command } from '../../../src/contracts/domain.js';
import type { JsonObject } from '../../../src/contracts/value.js';
import {
  aggregateId,
  boundaryName,
  commandId,
  httpMethod,
  operationId,
} from '../../../src/domain/references.js';

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

const helpers: RuntimeHelpers = {
  now: () => '2026-01-01T00:00:00.000Z',
  uuid: (() => {
    let next = 0;
    return () => `generated-${++next}`;
  })(),
  random: () => 0,
  data: createRuntimeDataGenerator(() => 0),
  clone: <T>(value: T) => structuredClone(value),
};

const clock: RuntimeClock = {
  nowMs: () => 1_735_689_600_000,
  offsetMs: () => 0,
  advance: () => 0,
  reset: () => undefined,
};

function request(
  command: CommandOverrides,
  controls?: Parameters<ReturnType<typeof createRuntimeEngine>['execute']>[0]['controls'],
): Parameters<ReturnType<typeof createRuntimeEngine>['execute']>[0] {
  const {
    commandId: rawCommandId,
    targetId: rawTargetId,
    boundary: rawBoundary,
    httpMethod: rawHttpMethod,
    operationId: rawOperationId,
    ...rest
  } = command;
  const value: Command = {
    commandId: commandId(rawCommandId ?? 'command-1'),
    boundary: boundaryName(rawBoundary ?? 'Order'),
    intent: command.intent ?? 'creation',
    targetId:
      rawTargetId === undefined
        ? aggregateId('order-1')
        : rawTargetId === null
          ? null
          : aggregateId(rawTargetId),
    payload: command.payload ?? { id: 'order-1', secret: 'not-for-response' },
    queryParams: command.queryParams ?? {},
    httpMethod: httpMethod(rawHttpMethod ?? 'POST'),
    path: command.path ?? '/orders',
    origin: command.origin ?? 'inbound',
    depth: command.depth ?? 0,
    ...(rawOperationId === undefined ? {} : { operationId: operationId(rawOperationId) }),
    ...rest,
  };
  return { command: value, headers: {}, controls };
}

function contract(
  overrides: Partial<RuntimeProgram['dependencies']['contract']> = {},
): RuntimeProgram['dependencies']['contract'] {
  return {
    operationIdFor: () => operationId('createOrder'),
    ...overrides,
  };
}

function boundary(overrides: Partial<RuntimeBoundary> = {}): RuntimeBoundary {
  return {
    boundary: 'Order',
    contractPath: '/orders',
    eventCatalog: [
      {
        type: 'OrderCreated',
        payload: { id: ({ payload }) => payload.id, secret: ({ payload }) => payload.secret },
      },
    ],
    behaviors: [{ name: 'create', operationId: 'createOrder', emit: 'OrderCreated' }],
    reducers: [{ on: 'OrderCreated', replaceState: true }],
    ...overrides,
  };
}

function program(
  definition: RuntimeBoundary,
  dependencies: Partial<RuntimeProgram['dependencies']>,
  policies: Parameters<typeof compileRuntime>[0]['policies'] = {},
): CompiledRuntimeProgram {
  return compileRuntime(
    { boundaries: [definition], policies },
    { contract: contract(), helpers, clock, ...dependencies },
  );
}

describe('pure TypeScript runtime request/response observability', () => {
  it('applies request log-level overrides and metric tags through injected ports', async () => {
    const logs: Array<{
      level: string;
      message: string;
      fields?: Readonly<Record<string, unknown>>;
    }> = [];
    const metrics: Array<{
      name: string;
      value?: number;
      fields?: Readonly<Record<string, string>>;
    }> = [];
    const runtime = createRuntimeEngine(
      program(boundary(), {
        observability: {
          log: (level, message, fields) => logs.push({ level, message, fields }),
          metric: (name, value, fields) => metrics.push({ name, value, fields }),
        },
      }),
    );

    await runtime.execute(
      request(
        { commandId: 'command-observability-controls', targetId: 'observability-order' },
        { logLevel: 'error', metricTag: { key: 'tenant', value: 'acme' } },
      ),
    );

    expect(logs).toEqual([
      expect.objectContaining({
        level: 'error',
        message: 'Runtime request matched boundary',
      }),
    ]);
    expect(metrics).toEqual(
      expect.arrayContaining([
        {
          name: 'runtime.commands.committed',
          value: 1,
          fields: { boundary: 'Order', tenant: 'acme' },
        },
        expect.objectContaining({
          name: 'runtime.requests.completed',
          value: 1,
          fields: expect.objectContaining({
            operation: 'createOrder',
            status: '201',
            outcome: 'committed',
            tenant: 'acme',
          }),
        }),
        expect.objectContaining({
          name: 'runtime.events.appended',
          value: 1,
          fields: expect.objectContaining({ operation: 'createOrder', tenant: 'acme' }),
        }),
      ]),
    );
  });

  it('observes the original request after validation and post-response shaping complete', async () => {
    const order: string[] = [];
    const observations: RuntimeRequestResponseObservation[] = [];
    const validatedBodies: JsonObject[] = [];
    const runtime = createRuntimeEngine(
      program(
        boundary({
          response: {
            mask: ['secret'],
            headers: { 'x-runtime-shaped': () => 'true' },
          },
        }),
        {
          contract: contract({
            validateResponse: (_operationId, _status, body) => {
              order.push('validated');
              validatedBodies.push(body as JsonObject);
            },
          }),
          webhooks: {
            deliver: async () => {
              order.push('webhook');
            },
          },
          observability: {
            observeRequestResponse: async (observation) => {
              order.push('observed');
              observations.push(observation);
            },
          },
        },
        {
          webhooks: [
            {
              name: 'order-created',
              trigger: () => true,
              url: () => 'https://hooks.test/orders',
              payload: { id: ({ event }) => event!.aggregateId },
            },
          ],
        },
      ),
    );

    const inbound = request(
      {
        commandId: 'command-success',
        targetId: 'order-success',
        payload: { id: 'order-success', secret: 'sensitive' },
      },
      { traceId: 'trace-success' },
    );
    const result = await runtime.execute(inbound);

    expect(order).toEqual(['validated', 'webhook', 'observed']);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.request).toBe(inbound);
    expect(observations[0]!.result).toBe(result);
    expect(observations[0]!.correlation).toEqual({
      traceId: 'trace-success',
      commandId: 'command-success',
    });
    expect(observations[0]!.result).toMatchObject({
      status: 201,
      committed: true,
      headers: { 'x-runtime-shaped': 'true' },
      body: { id: 'order-success' },
    });
    expect((observations[0]!.result.body as JsonObject).secret).toBeUndefined();
    expect(validatedBodies[0]!.secret).toBe('sensitive');
  });

  it('observes a declarative fault response after fault masking and preserves correlation', async () => {
    const observations: RuntimeRequestResponseObservation[] = [];
    const runtime = createRuntimeEngine(
      program(
        boundary({
          faults: [
            {
              name: 'planned-outage',
              matches: () => true,
              response: { status: 503, body: { error: 'OUTAGE', secret: 'internal' } },
            },
          ],
        }),
        {
          observability: {
            observeRequestResponse: (observation) => {
              observations.push(observation);
            },
          },
        },
      ),
    );
    const inbound = request(
      { commandId: 'command-fault', targetId: 'faulted-order' },
      { traceId: 'trace-fault', maskFields: ['/secret'] },
    );

    const result = await runtime.execute(inbound);

    expect(result).toMatchObject({
      status: 503,
      committed: false,
      events: [],
      body: { error: 'OUTAGE' },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]!.request).toBe(inbound);
    expect(observations[0]!.result).toBe(result);
    expect(observations[0]!.correlation).toEqual({
      traceId: 'trace-fault',
      commandId: 'command-fault',
    });
    expect((observations[0]!.result.body as JsonObject).secret).toBe('[MASKED]');
  });

  it('observes thrown runtime failures as error results while preserving rejection behavior', async () => {
    const observations: RuntimeRequestResponseObservation[] = [];
    const runtime = createRuntimeEngine(
      program(boundary(), {
        contract: contract({
          validateRequest: () => {
            throw new RuntimeExecutionError(422, 'Request rejected', {
              code: 'REQUEST_REJECTED',
              message: 'Request rejected',
            });
          },
        }),
        observability: {
          observeRequestResponse: (observation) => {
            observations.push(observation);
          },
        },
      }),
    );
    const inbound = request({ commandId: 'command-failure' }, { traceId: 'trace-failure' });

    await expect(runtime.execute(inbound)).rejects.toMatchObject({
      status: 422,
      body: { code: 'REQUEST_REJECTED' },
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]!.request).toBe(inbound);
    expect(observations[0]!.result).toMatchObject({
      status: 422,
      committed: false,
      events: [],
      body: { code: 'REQUEST_REJECTED', message: 'Request rejected' },
    });
    expect(observations[0]!.correlation).toEqual({
      traceId: 'trace-failure',
      commandId: 'command-failure',
    });
  });

  it('does not export successful items from a rolled-back transactional batch', async () => {
    const observations: RuntimeRequestResponseObservation[] = [];
    const runtime = createRuntimeEngine(
      program(boundary(), {
        observability: {
          observeRequestResponse: (observation) => {
            observations.push(observation);
          },
        },
      }),
    );
    const first = request(
      {
        commandId: 'batch-first',
        targetId: 'batch-order',
        payload: { id: 'batch-order', secret: 'first' },
      },
      { traceId: 'batch-trace' },
    );
    const duplicate = request({
      commandId: 'batch-duplicate',
      targetId: 'batch-order',
      payload: { id: 'batch-order', secret: 'second' },
    });

    await expect(
      runtime.executeBatch([first, duplicate], { transactional: true }),
    ).rejects.toMatchObject({ status: 409 });

    expect(observations).toHaveLength(1);
    expect(observations[0]!.request).toBe(duplicate);
    expect(observations[0]!.result).toMatchObject({ status: 409, committed: false, events: [] });
    expect(runtime.snapshot().events).toEqual([]);
  });
});
