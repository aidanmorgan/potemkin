import { applyResponseMutations, buildOperationLookup } from '../../../src/http/responseMutations';
import type { BoundaryConfig } from '../../../src/dsl/types';
import type { OpenApiDoc, OpenApiOperation } from '../../../src/contract/loader';

function boundary(overrides: Partial<BoundaryConfig> = {}): BoundaryConfig {
  return {
    boundary: 'Lead',
    contractPath: '/leads/{id}',
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
    ...overrides,
  };
}

const noLookup = { resolveOperationPath: () => undefined };

describe('applyResponseMutations — HATEOAS', () => {
  it('injects boundary.hateoas entries into _links', () => {
    const r = applyResponseMutations({
      body: { id: 'lead-1' },
      boundary: boundary({ hateoas: [{ rel: 'self', href: '/leads/lead-1' }] }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect((r.body as any)._links).toEqual({ self: { href: '/leads/lead-1' } });
    expect(r.journal.some((e) => e.source === 'hateoas')).toBe(true);
  });

  it('falls back to OpenAPI links: defaults when boundary declares none', () => {
    const op: OpenApiOperation = {
      responses: { '200': { links: { self: { operationId: 'getLead' } } } },
    } as unknown as OpenApiOperation;
    const lookup = { resolveOperationPath: (id: string) => (id === 'getLead' ? '/leads/{id}' : undefined) };
    const r = applyResponseMutations({ body: { id: 'x' }, boundary: boundary(), operation: op, statusCode: 200, operationLookup: lookup });
    expect((r.body as any)._links.self.href).toBe('/leads/{id}');
  });

  it('injects _links into every item of a collection', () => {
    const r = applyResponseMutations({
      body: [{ id: 'a' }, { id: 'b' }],
      boundary: boundary({ hateoas: [{ rel: 'self', href: '/leads' }] }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect((r.body as any[]).every((it) => it._links?.self?.href === '/leads')).toBe(true);
  });
});

describe('applyResponseMutations — Deprecation/Sunset', () => {
  it('emits Deprecation:true when the OpenAPI operation is deprecated', () => {
    const op = { deprecated: true } as unknown as OpenApiOperation;
    const r = applyResponseMutations({ body: { id: 'x' }, boundary: boundary(), operation: op, statusCode: 200, operationLookup: noLookup });
    expect(r.headers['Deprecation']).toBe('true');
  });

  it('emits Sunset and successor Link from boundary.deprecated', () => {
    const epochIso = new Date(0).toISOString();
    const r = applyResponseMutations({
      body: { id: 'x' },
      boundary: boundary({ deprecated: { date: epochIso, sunset: '2026-12-31', replacement: '/v2/leads' } }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect(r.headers['Deprecation']).toBe('true');
    expect(r.headers['Sunset']).toBe('2026-12-31');
    expect(r.headers['Link']).toContain('rel="successor-version"');
  });

  it('emits Deprecation: <HTTP-date> when boundary.deprecated.date is a real date', () => {
    const r = applyResponseMutations({
      body: { id: 'x' },
      boundary: boundary({ deprecated: { date: '2025-01-01T00:00:00.000Z' } }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect(r.headers['Deprecation']).toBe(new Date('2025-01-01T00:00:00.000Z').toUTCString());
  });

  it('emits Deprecation: true when boundary.deprecated has no date (epoch sentinel)', () => {
    const epochIso = new Date(0).toISOString();
    const r = applyResponseMutations({
      body: { id: 'x' },
      boundary: boundary({ deprecated: { date: epochIso } }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect(r.headers['Deprecation']).toBe('true');
  });

  it('emits no deprecation header when neither source declares it', () => {
    const r = applyResponseMutations({ body: { id: 'x' }, boundary: boundary(), operation: {} as OpenApiOperation, statusCode: 200, operationLookup: noLookup });
    expect(r.headers['Deprecation']).toBeUndefined();
  });
});

describe('applyResponseMutations — Mask', () => {
  it('removes boundary.mask fields from the body', () => {
    const r = applyResponseMutations({
      body: { id: 'x', ssn: '123-45-6789', name: 'Acme' },
      boundary: boundary({ mask: ['ssn'] }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect((r.body as any).ssn).toBeUndefined();
    expect((r.body as any).name).toBe('Acme');
    expect(r.journal.some((e) => e.source === 'mask')).toBe(true);
  });

  it('masks every item in a collection', () => {
    const r = applyResponseMutations({
      body: [{ id: 'a', ssn: '1' }, { id: 'b', ssn: '2' }],
      boundary: boundary({ mask: ['ssn'] }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect((r.body as any[]).every((it) => it.ssn === undefined)).toBe(true);
  });

  it('masking an absent field is a no-op (does not throw)', () => {
    const r = applyResponseMutations({
      body: { id: 'x' },
      boundary: boundary({ mask: ['ssn'] }),
      operation: undefined,
      statusCode: 200,
      operationLookup: noLookup,
    });
    expect((r.body as any).id).toBe('x');
  });
});

describe('buildOperationLookup', () => {
  it('maps operationId to its path template', () => {
    const doc = { paths: { '/leads/{id}': { get: { operationId: 'getLead' } } } } as unknown as OpenApiDoc;
    expect(buildOperationLookup(doc).resolveOperationPath('getLead')).toBe('/leads/{id}');
  });
});
