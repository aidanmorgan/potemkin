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
});
