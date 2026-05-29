/**
 * Integration tests for the identity.key DSL — declarative key extraction
 * from request path / query / header / payload sources.
 */

import { extractEntityKey } from '../../src/engine/keyExtractor';
import type { BoundaryConfig, IdentityKeyConfig } from '../../src/dsl/types';
import type { CelEvaluator } from '../../src/cel/evaluator';
import { createCelEvaluator } from '../../src/cel/evaluator';

const base: BoundaryConfig = {
  boundary: 'Foo',
  contractPath: '/foo',
  fallbackOverride: false,
  behaviors: [],
  reducers: [],
  eventCatalog: [],
};

const withKey = (key: IdentityKeyConfig): BoundaryConfig => ({ ...base, identity: { key } });

describe('identity.key — declarative key extraction', () => {
  it('extracts key from payload via dot-path pointer with array index', () => {
    const key = extractEntityKey({
      boundary: withKey({ from: 'payload', pointer: 'order.lineItems.0.sku' }),
      pathParams: {},
      queryParams: {},
      headers: {},
      body: { order: { lineItems: [{ sku: 'SKU-123' }] } },
    });
    expect(key).toBe('SKU-123');
  });

  it('extracts key from nested payload object', () => {
    const key = extractEntityKey({
      boundary: withKey({ from: 'payload', pointer: 'customer.contact.id' }),
      pathParams: {},
      queryParams: {},
      headers: {},
      body: { customer: { contact: { id: 'c-42' } } },
    });
    expect(key).toBe('c-42');
  });

  it('uses CEL expression as escape hatch', () => {
    const cel: CelEvaluator = createCelEvaluator();
    const key = extractEntityKey({
      boundary: withKey({ cel: 'command.path' }),
      pathParams: {},
      queryParams: {},
      headers: {},
      body: null,
      cel,
      command: {
        commandId: 'cmd-1', boundary: 'X', intent: 'creation', targetId: null,
        payload: {}, queryParams: {}, httpMethod: 'POST', path: '/from-cel',
        origin: 'inbound', depth: 0,
      },
    });
    expect(key).toBe('/from-cel');
  });

  it('precedence: cel wins over from when both set', () => {
    const cel = createCelEvaluator();
    const key = extractEntityKey({
      boundary: withKey({ cel: '"cel-wins"', from: 'header', name: 'x-tenant' }),
      pathParams: {},
      queryParams: {},
      headers: { 'x-tenant': 'header-loses' },
      body: null,
      cel,
      command: {
        commandId: 'cmd-1', boundary: 'X', intent: 'query', targetId: null,
        payload: {}, queryParams: {}, httpMethod: 'GET', path: '/x',
        origin: 'inbound', depth: 0,
      },
    });
    expect(key).toBe('cel-wins');
  });

  it('cel evaluation failure falls through to declarative source', () => {
    const cel = createCelEvaluator();
    const key = extractEntityKey({
      boundary: withKey({ cel: 'this.does.not.exist', from: 'header', name: 'x-tenant' }),
      pathParams: {},
      queryParams: {},
      headers: { 'x-tenant': 'fallback' },
      body: null,
      cel,
      command: {
        commandId: 'cmd-1', boundary: 'X', intent: 'query', targetId: null,
        payload: {}, queryParams: {}, httpMethod: 'GET', path: '/x',
        origin: 'inbound', depth: 0,
      },
    });
    expect(key).toBe('fallback');
  });

  it('reads from `name` when used with `from: payload` (alias for pointer)', () => {
    const key = extractEntityKey({
      boundary: withKey({ from: 'payload', name: 'lookupId' }),
      pathParams: {},
      queryParams: {},
      headers: {},
      body: { lookupId: 'lk-1' },
    });
    expect(key).toBe('lk-1');
  });

  it('default path-param fallback remains backward-compatible', () => {
    const key = extractEntityKey({
      boundary: base,
      pathParams: { id: 'legacy-id' },
      queryParams: {},
      headers: {},
      body: null,
    });
    expect(key).toBe('legacy-id');
  });
});
