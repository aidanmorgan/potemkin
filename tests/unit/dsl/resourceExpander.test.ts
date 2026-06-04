import { expandResourceModules } from '../../../src/dsl/resourceExpander';
import type { OpenApiDoc } from '../../../src/contract/loader';

const openapi = {
  raw: {
    paths: {
      '/v1/customers': { post: { operationId: 'PostCustomers' }, get: { operationId: 'GetCustomers' } },
      '/v1/customers/{customer}': {
        get: { operationId: 'GetCustomersCustomer' },
        post: { operationId: 'PostCustomersCustomer' },
        delete: { operationId: 'DeleteCustomersCustomer' },
      },
    },
  },
  paths: {},
} as unknown as OpenApiDoc;

function resourceModule(parsed: unknown) {
  return [{ path: 'customer.resource.yaml', text: '', parsed }];
}

const baseResource = {
  resource: 'customer',
  schema: 'customer',
  identity: { creation: { generate: 'ts:customerId' }, key: { from: 'path' } },
  response: 'ts:customerResponse',
  event_catalog: [{ type: 'CustomerCreated', payload_template: {} }],
  reducers: [{ on: 'CustomerCreated', replace_state: true }],
  operations: [
    { op: 'PostCustomers', emit: 'CustomerCreated' },
    { op: 'GetCustomers', query: true },
    { op: 'GetCustomersCustomer', query: true },
    { op: 'PostCustomersCustomer', emit: 'CustomerUpdated' },
    { op: 'DeleteCustomersCustomer', emit: 'CustomerDeleted' },
  ],
};

describe('expandResourceModules', () => {
  it('expands a resource into one boundary per contract path, sharing the schema', () => {
    const out = expandResourceModules(resourceModule(baseResource), openapi);
    expect(out).toHaveLength(2);
    const byPath = Object.fromEntries(out.map((m) => [(m.parsed as Record<string, unknown>)['contract_path'], m.parsed as Record<string, unknown>]));

    const coll = byPath['/v1/customers'];
    expect(coll['schema']).toBe('customer');
    expect(coll['fallback_override']).toBe(true); // GetCustomers is a query
    expect(coll['identity']).toEqual({ creation: { generate: 'ts:customerId' } });
    expect(coll['response']).toBe('ts:customerResponse');
    expect(coll['behaviors']).toEqual([
      { name: 'PostCustomers', match: { operationId: 'PostCustomers', method: 'POST', condition: 'true' }, emit: 'CustomerCreated' },
    ]);

    const byId = byPath['/v1/customers/{customer}'];
    expect(byId['schema']).toBe('customer');
    expect(byId['identity']).toEqual({ key: { from: 'path', name: 'customer' } });
    expect(byId['behaviors']).toEqual([
      { name: 'PostCustomersCustomer', match: { operationId: 'PostCustomersCustomer', method: 'POST', condition: 'true' }, emit: 'CustomerUpdated' },
      { name: 'DeleteCustomersCustomer', match: { operationId: 'DeleteCustomersCustomer', method: 'DELETE', condition: 'true' }, emit: 'CustomerDeleted' },
    ]);
  });

  it('rejects an operation that is not in the OpenAPI', () => {
    const bad = { ...baseResource, operations: [{ op: 'NoSuchOp', emit: 'X' }] };
    expect(() => expandResourceModules(resourceModule(bad), openapi)).toThrow(/not an operationId/);
  });

  it('requires emit on non-query operations and forbids it on queries', () => {
    const noEmit = { ...baseResource, operations: [{ op: 'PostCustomers' }] };
    expect(() => expandResourceModules(resourceModule(noEmit), openapi)).toThrow(/require "emit/);
    const queryEmit = { ...baseResource, operations: [{ op: 'GetCustomers', query: true, emit: 'X' }] };
    expect(() => expandResourceModules(resourceModule(queryEmit), openapi)).toThrow(/must not declare "emit"/);
  });

  it('requires a schema name', () => {
    const noSchema = { ...baseResource, schema: undefined };
    expect(() => expandResourceModules(resourceModule(noSchema), openapi)).toThrow(/schema/);
  });

  it('rejects unknown resource keys (no silent drop)', () => {
    expect(() => expandResourceModules(resourceModule({ ...baseResource, computd: [] }), openapi)).toThrow(/unknown resource key "computd"/);
  });

  it('rejects unknown operation keys', () => {
    const bad = { ...baseResource, operations: [{ op: 'PostCustomers', emit: 'CustomerCreated', conditon: 'x' }] };
    expect(() => expandResourceModules(resourceModule(bad), openapi)).toThrow(/unknown key "conditon"/);
  });

  it('carries per-operation guards (condition + requires) into the behavior', () => {
    const guarded = {
      ...baseResource,
      operations: [
        { op: 'PostCustomersCustomer', emit: 'CustomerUpdated', condition: "state.status == 'active'",
          requires: [{ name: 'must-be-active', condition: "state.status == 'active'", error_code: 'INACTIVE' }] },
        { op: 'GetCustomersCustomer', query: true },
      ],
    };
    const out = expandResourceModules(resourceModule(guarded), openapi);
    const byId = out.find((m) => (m.parsed as Record<string, unknown>)['contract_path'] === '/v1/customers/{customer}')!;
    const behavior = ((byId.parsed as Record<string, unknown>)['behaviors'] as Record<string, unknown>[])[0];
    const match = behavior['match'] as Record<string, unknown>;
    expect(match['condition']).toBe("state.status == 'active'");
    expect(match['requires']).toEqual([{ name: 'must-be-active', condition: "state.status == 'active'", error_code: 'INACTIVE' }]);
  });

  it('threads boundary-level config (mask) onto every generated boundary', () => {
    const withMask = { ...baseResource, mask: ['email'] };
    const out = expandResourceModules(resourceModule(withMask), openapi);
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) {
      expect((m.parsed as Record<string, unknown>)['mask']).toEqual(['email']);
    }
  });
});
