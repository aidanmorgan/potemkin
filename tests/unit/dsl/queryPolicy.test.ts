import { validateBoundaryConfig } from '../../../src/dsl/schema.js';
import { BootError } from '../../../src/errors.js';
import { compileYaml } from '../../../src/parser/yamlParser.js';
import { compileYamlModel } from '../../../src/parser/yamlCompiler.js';
import { createRuntimeDataGenerator } from '../../../src/model/data.js';
import { createRuntimeEngine } from '../../../src/core/engine.js';
import type { RuntimeHelpers, RuntimeProgram } from '../../../src/model/runtime.js';
import type { RuntimeClock } from '../../../src/contracts/ports.js';
import type { Command } from '../../../src/contracts/domain.js';
import {
  aggregateId,
  boundaryName,
  commandId,
  httpMethod,
  operationId,
} from '../../../src/domain/references.js';

const helpers: RuntimeHelpers = {
  now: () => '2026-01-01T00:00:00.000Z',
  uuid: () => 'generated-id',
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

function dependencies(): RuntimeProgram['dependencies'] {
  return {
    helpers,
    clock,
    contract: {
      operationIdFor: () => operationId('listOrders'),
    },
  };
}

function queryCommand(
  targetId: string | null = null,
  queryParams: Command['queryParams'] = {},
): Command {
  return {
    commandId: commandId('query-1'),
    boundary: boundaryName('Order'),
    intent: 'query',
    targetId: targetId === null ? null : aggregateId(targetId),
    payload: {},
    queryParams,
    httpMethod: httpMethod('GET'),
    path: targetId === null ? '/orders' : `/orders/${targetId}`,
    origin: 'inbound',
    depth: 0,
    operationId: operationId('listOrders'),
  };
}

const policy = {
  fields: { threshold: 'state.score >= 2' },
  filter: 'state.active == true',
  sort: [{ field: 'score', direction: 'desc' }],
  page_size: 2,
  max_page_size: 2,
  cursor: 'query.cursor',
  pagination: 'envelope',
  fallback: { code: 'ORDER_NOT_FOUND' },
};

describe('YAML query policy', () => {
  it('validates and normalises the complete declarative query policy', () => {
    const config = validateBoundaryConfig({
      boundary: 'Order',
      contract_path: '/orders',
      query: policy,
      behaviors: [],
      reducers: [],
      event_catalog: [],
    });

    expect(config.query).toEqual({
      fields: policy.fields,
      filter: policy.filter,
      sort: policy.sort,
      pageSize: 2,
      maxPageSize: 2,
      cursor: policy.cursor,
      pagination: policy.pagination,
      fallback: policy.fallback,
    });
  });

  it.each([
    ['filter', { filter: 'state.' }],
    ['sort', { sort: [{ field: 'score', direction: 'sideways' }] }],
    ['page_size', { page_size: -1 }],
    ['max_page_size', { max_page_size: 1.5 }],
    ['pagination', { pagination: 'links' }],
    ['include_deleted', { include_deleted: 'yes' }],
  ])('rejects invalid query.%s configuration', (_field, override) => {
    expect(() =>
      validateBoundaryConfig({
        boundary: 'Order',
        contract_path: '/orders',
        query: { ...policy, ...override },
        behaviors: [],
        reducers: [],
        event_catalog: [],
      }),
    ).toThrow(BootError);
  });

  it('compiles filtering, fields, ordering, pagination, and targeted fallback into the runtime', async () => {
    const dsl = await compileYaml([
      {
        name: 'orders.yaml',
        yaml: `
boundary: Order
contract_path: /orders
fallback_override: true
query:
  fields:
    threshold: "state.score >= 2"
  filter: "state.active == true"
  sort:
    - field: score
      direction: desc
  page_size: 2
  max_page_size: 2
  cursor: "query.cursor"
  pagination: envelope
  fallback:
    code: ORDER_NOT_FOUND
initialization:
  - id: order-1
    score: 1
    active: true
  - id: order-2
    score: 3
    active: true
  - id: order-3
    score: 2
    active: true
  - id: order-4
    score: 9
    active: false
behaviors: []
reducers: []
event_catalog: []
`,
      },
    ]);
    const program = compileYamlModel(dsl, { dependencies: dependencies() });
    const runtime = createRuntimeEngine(program);

    const collection = await runtime.execute({
      command: queryCommand(null, { threshold: 'on' }),
      headers: {},
    });
    expect(collection).toMatchObject({
      status: 200,
      body: {
        items: [
          { id: 'order-2', score: 3 },
          { id: 'order-3', score: 2 },
        ],
        totalCount: 2,
        limit: 2,
        hasMore: false,
      },
    });

    const missing = await runtime.execute({
      command: queryCommand('missing'),
      headers: {},
    });
    expect(missing).toMatchObject({ status: 200, body: { code: 'ORDER_NOT_FOUND' } });
  });
});
