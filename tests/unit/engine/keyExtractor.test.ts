import { extractEntityKey } from '../../../src/engine/keyExtractor';
import type { BoundaryConfig, IdentityKeyConfig } from '../../../src/dsl/types';

const baseBoundary: BoundaryConfig = {
  boundary: 'Lead',
  contractPath: '/leads/{id}',
  fallbackOverride: false,
  behaviors: [],
  reducers: [],
  eventCatalog: [],
};

const withKey = (key: IdentityKeyConfig): BoundaryConfig =>
  ({ ...baseBoundary, identity: { key } });

describe('extractEntityKey', () => {
  it('falls back to path param `id` when no identity.key is configured', () => {
    expect(extractEntityKey({
      boundary: baseBoundary,
      pathParams: { id: 'lead-1' },
      queryParams: {},
      headers: {},
      body: null,
    })).toBe('lead-1');
  });

  it('reads from named path param when `from: path`', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'path', name: 'leadId' }),
      pathParams: { leadId: 'lead-42' },
      queryParams: {},
      headers: {},
      body: null,
    })).toBe('lead-42');
  });

  it('reads from named query param when `from: query`', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'query', name: 'tenant' }),
      pathParams: {},
      queryParams: { tenant: 'acme' },
      headers: {},
      body: null,
    })).toBe('acme');
  });

  it('uses the first element of array-valued query params', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'query', name: 'tenant' }),
      pathParams: {},
      queryParams: { tenant: ['acme', 'bravo'] },
      headers: {},
      body: null,
    })).toBe('acme');
  });

  it('reads from header (lowercased) when `from: header`', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'header', name: 'X-Tenant-Id' }),
      pathParams: {},
      queryParams: {},
      headers: { 'x-tenant-id': 'acme-corp' },
      body: null,
    })).toBe('acme-corp');
  });

  it('reads from payload dot-path when `from: payload` + `pointer`', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'payload', pointer: 'customer.id' }),
      pathParams: {},
      queryParams: {},
      headers: {},
      body: { customer: { id: 'cust-99' } },
    })).toBe('cust-99');
  });

  it('returns null when configured source is missing', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'header', name: 'x-tenant' }),
      pathParams: {},
      queryParams: {},
      headers: {},
      body: null,
    })).toBeNull();
  });

  it('returns null for unknown from values', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'invalid' as 'path', name: 'id' }),
      pathParams: { id: 'x' },
      queryParams: {},
      headers: {},
      body: null,
    })).toBeNull();
  });

  it('returns null when the configured value is an empty string', () => {
    expect(extractEntityKey({
      boundary: withKey({ from: 'header', name: 'x-tenant' }),
      pathParams: {},
      queryParams: {},
      headers: { 'x-tenant': '' },
      body: null,
    })).toBeNull();
  });
});
