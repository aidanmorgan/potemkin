/**
 * Integration tests for the identity.key DSL — declarative key extraction
 * from request path / query / header / payload sources.
 */

import { extractEntityKey } from '../../src/engine/keyExtractor';
import { validateBoundaryConfig } from '../../src/dsl/schema';
import type { BoundaryConfig, IdentityKeyConfig } from '../../src/dsl/types';

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

describe('identity.key — boot validation (fail fast)', () => {
  const boundaryWith = (key: Record<string, unknown>) => ({
    boundary: 'Foo',
    contract_path: '/foo',
    identity: { key },
  });

  it('rejects identity.key.cel (CEL-based key extraction is unsupported)', () => {
    expect(() => validateBoundaryConfig(boundaryWith({ cel: 'command.path' })))
      .toThrow(/identity\.key\.cel.*not supported/);
  });

  it('rejects identity.key with no `from`', () => {
    expect(() => validateBoundaryConfig(boundaryWith({ name: 'x-tenant' })))
      .toThrow(/identity\.key\.from.*required/);
  });

  it('rejects from: header without a `name`', () => {
    expect(() => validateBoundaryConfig(boundaryWith({ from: 'header' })))
      .toThrow(/from: header requires "name"/);
  });

  it('rejects from: payload without `name` or `pointer`', () => {
    expect(() => validateBoundaryConfig(boundaryWith({ from: 'payload' })))
      .toThrow(/from: payload requires "pointer"/);
  });

  it('accepts a well-formed from: header key config', () => {
    const result = validateBoundaryConfig(boundaryWith({ from: 'header', name: 'x-token-id' }));
    expect(result.identity?.key).toEqual({ from: 'header', name: 'x-token-id' });
  });
});
