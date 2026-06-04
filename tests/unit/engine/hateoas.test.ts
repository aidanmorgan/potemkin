/**
 * Unit tests for engine/hateoas: computeLinks and applyHateoasLinks.
 *
 * Covers:
 *   - baseUrl set → absolute hrefs
 *   - baseUrl unset → relative hrefs
 *   - baseUrl with trailing slash → single slash between base and path
 *   - HATEOAS disabled → null / no-op
 *   - self link generation
 *   - action link generation with CEL conditions
 *   - applyHateoasLinks: single entity, raw array, pagination envelope
 */

import { computeLinks, applyHateoasLinks } from '../../../src/engine/hateoas';
import type { ApplyHateoasInput } from '../../../src/engine/hateoas';
import type { CompiledDsl, BoundaryConfig, HateoasConfig } from '../../../src/dsl/types';
import { createCelEvaluator } from '../../../src/cel/evaluator';

const cel = createCelEvaluator();

function makeHateoasConfig(overrides: Partial<HateoasConfig> = {}): HateoasConfig {
  return { enabled: true, ...overrides };
}

function makeBoundary(overrides: Partial<BoundaryConfig> = {}): BoundaryConfig {
  return {
    boundary: 'Lead',
    contractPath: '/leads',
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
    ...overrides,
  };
}

function makeLeadByIdBoundary(): BoundaryConfig {
  return {
    boundary: 'LeadById',
    contractPath: '/leads/{id}',
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
  };
}

function makeDsl(
  boundaries: BoundaryConfig[],
  hateoas?: HateoasConfig,
): CompiledDsl {
  return {
    boundaries,
    byContractPath: Object.fromEntries(boundaries.map((b) => [b.contractPath, b])),
    byBoundaryName: Object.fromEntries(boundaries.map((b) => [b.boundary, b])),
    hateoas,
  };
}

// ---------------------------------------------------------------------------
// computeLinks — baseUrl
// ---------------------------------------------------------------------------

describe('engine/hateoas computeLinks — baseUrl', () => {
  it('baseUrl set: self link href is prefixed with baseUrl', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig({ baseUrl: 'https://api.example.com' }));

    const links = computeLinks({ entity: { id: 'abc-123' }, boundary, dsl, cel });

    expect(links).not.toBeNull();
    expect(links!['self'].href).toBe('https://api.example.com/leads/abc-123');
  });

  it('baseUrl with trailing slash: still produces exactly one slash between base and path', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig({ baseUrl: 'https://api.example.com/' }));

    const links = computeLinks({ entity: { id: 'abc-123' }, boundary, dsl, cel });

    expect(links!['self'].href).toBe('https://api.example.com/leads/abc-123');
  });

  it('baseUrl unset: self link href is a relative path', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig());

    const links = computeLinks({ entity: { id: 'abc-123' }, boundary, dsl, cel });

    expect(links!['self'].href).toBe('/leads/abc-123');
  });

  it('baseUrl set: action link hrefs are also prefixed', () => {
    const contactBoundary: BoundaryConfig = {
      boundary: 'LeadContact',
      contractPath: '/leads/{id}/contact',
      fallbackOverride: false,
      reducers: [],
      eventCatalog: [],
      behaviors: [
        {
          behaviourId: 'contactLead',
          intent: 'mutation',
          match: { method: 'POST', condition: 'true' },
          linkName: 'contact',
          emit: [],
          response: null,
        } as unknown as BoundaryConfig['behaviors'][number],
      ],
    };
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl(
      [boundary, contactBoundary],
      makeHateoasConfig({ baseUrl: 'https://api.example.com' }),
    );

    const links = computeLinks({ entity: { id: 'lead-1' }, boundary, dsl, cel });

    expect(links!['contact']).toBeDefined();
    expect(links!['contact'].href).toBe('https://api.example.com/leads/lead-1/contact');
  });

  it('baseUrl set with collection boundary: resolves sibling path and prefixes', () => {
    const collectionBoundary = makeBoundary();
    const byIdBoundary = makeLeadByIdBoundary();
    const dsl = makeDsl(
      [collectionBoundary, byIdBoundary],
      makeHateoasConfig({ baseUrl: 'https://api.example.com' }),
    );

    const links = computeLinks({ entity: { id: 'lead-42' }, boundary: collectionBoundary, dsl, cel });

    expect(links!['self'].href).toBe('https://api.example.com/leads/lead-42');
  });
});

// ---------------------------------------------------------------------------
// computeLinks — disabled / no-op
// ---------------------------------------------------------------------------

describe('engine/hateoas computeLinks — disabled', () => {
  it('returns null when hateoas config is undefined', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], undefined);

    expect(computeLinks({ entity: { id: 'x' }, boundary, dsl, cel })).toBeNull();
  });

  it('returns null when hateoas.enabled is false', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], { enabled: false });

    expect(computeLinks({ entity: { id: 'x' }, boundary, dsl, cel })).toBeNull();
  });

  it('returns empty record when entity has no id', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig());

    const links = computeLinks({ entity: { name: 'no-id' }, boundary, dsl, cel });

    expect(links).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// applyHateoasLinks — baseUrl propagated through helper
// ---------------------------------------------------------------------------

describe('engine/hateoas applyHateoasLinks — baseUrl', () => {
  it('single entity: _links.self.href uses baseUrl when set', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig({ baseUrl: 'https://api.example.com' }));

    const input: ApplyHateoasInput = {
      body: { id: 'lead-1', status: 'NEW' },
      boundary,
      dsl,
      cel,
    };

    const result = applyHateoasLinks(input) as Record<string, unknown>;
    const links = result['_links'] as Record<string, { href: string }>;
    expect(links['self'].href).toBe('https://api.example.com/leads/lead-1');
  });

  it('single entity: _links.self.href is relative when baseUrl unset', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig());

    const input: ApplyHateoasInput = {
      body: { id: 'lead-1', status: 'NEW' },
      boundary,
      dsl,
      cel,
    };

    const result = applyHateoasLinks(input) as Record<string, unknown>;
    const links = result['_links'] as Record<string, { href: string }>;
    expect(links['self'].href).toBe('/leads/lead-1');
  });

  it('array: each item gets absolute hrefs when baseUrl set', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig({ baseUrl: 'https://api.example.com' }));

    const input: ApplyHateoasInput = {
      body: [{ id: 'lead-1' }, { id: 'lead-2' }],
      boundary,
      dsl,
      cel,
    };

    const result = applyHateoasLinks(input) as Array<Record<string, unknown>>;
    expect(Array.isArray(result)).toBe(true);
    const links0 = result[0]['_links'] as Record<string, { href: string }>;
    const links1 = result[1]['_links'] as Record<string, { href: string }>;
    expect(links0['self'].href).toBe('https://api.example.com/leads/lead-1');
    expect(links1['self'].href).toBe('https://api.example.com/leads/lead-2');
  });

  it('pagination envelope: items get absolute hrefs when baseUrl set', () => {
    const boundary = makeLeadByIdBoundary();
    const dsl = makeDsl([boundary], makeHateoasConfig({ baseUrl: 'https://api.example.com' }));

    const input: ApplyHateoasInput = {
      body: { items: [{ id: 'lead-1' }, { id: 'lead-2' }], totalCount: 2, offset: 0, limit: 10, hasMore: false },
      boundary,
      dsl,
      cel,
    };

    const result = applyHateoasLinks(input) as Record<string, unknown>;
    const items = result['items'] as Array<Record<string, unknown>>;
    const links0 = items[0]['_links'] as Record<string, { href: string }>;
    expect(links0['self'].href).toBe('https://api.example.com/leads/lead-1');
  });
});
