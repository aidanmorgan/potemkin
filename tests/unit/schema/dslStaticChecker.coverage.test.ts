/**
 * Coverage backfill for schema/dslStaticChecker.ts — the reducer patch CEL
 * value expression state-path check.
 *
 * For each reducer patch, the static checker validates that:
 *   - the patch path targets a known schema path, and
 *   - any `state.X.Y` reads inside the patch's CEL value reference known paths,
 *     emitting DSL_PATH_UNKNOWN at location `reducer:<EVENT>:patches:<POINTER>:cel`.
 */

import { staticCheckDsl } from '../../../src/schema/dslStaticChecker';
import type { CompiledDsl } from '../../../src/dsl/types';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';

// ── shared helpers ────────────────────────────────────────────────────────────

const entitySchema: ObjectGraphSchema = {
  name: 'MyBoundary',
  kind: 'object',
  properties: {
    status: { name: 'status', kind: 'string' },
    count: { name: 'count', kind: 'integer' },
    tags: { name: 'tags', kind: 'array', items: { name: 'tag', kind: 'string' } },
  },
};

function makeRegistry(boundary: string, schema: ObjectGraphSchema): ObjectGraphSchemaRegistry {
  return {
    byBoundary: { [boundary]: { boundary, entity: schema, arrayPaths: ['tags'] } },
    get(b: string) { return this.byBoundary[b]; },
  };
}

function makeCompiledDsl(boundaries: any[] = []): CompiledDsl {
  return {
    boundaries,
    byBoundaryName: Object.fromEntries(boundaries.map((b: any) => [b.boundary, b])),
    byContractPath: {},
  };
}

const minimalBoundary = {
  boundary: 'MyBoundary',
  contractPath: '/my',
  fallbackOverride: false,
  behaviors: [],
  reducers: [],
  eventCatalog: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('schema/dslStaticChecker — reducer patch CEL value path check', () => {

  it('returns DSL_PATH_UNKNOWN when a patch CEL value references an unknown state path', async () => {
    // The path '/tags' IS valid (in the schema), but the CEL value accesses
    // state.nonExistentField which is NOT in the schema → CEL path check fires.
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          patches: [{ op: 'append', path: '/tags', value: 'state.nonExistentField' }],
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const celErrors = errors.filter(
      e => e.code === 'DSL_PATH_UNKNOWN' && e.location.includes(':cel'),
    );
    expect(celErrors).toHaveLength(1);
    expect(celErrors[0]?.location).toMatch(/patches.*:cel/);
    expect(celErrors[0]?.detail).toContain('nonExistentField');
  });

  it('patch CEL error has correct location format (reducer:EVENT:patches:POINTER:cel)', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          patches: [{ op: 'append', path: '/tags', value: 'state.missingProp' }],
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const celError = errors.find(e => e.location.includes('patches') && e.location.includes(':cel'));
    expect(celError).toBeDefined();
    expect(celError?.location).toBe('reducer:TagAdded:patches:/tags:cel');
    expect(celError?.boundary).toBe('MyBoundary');
  });

  it('no patch CEL errors when the CEL value only references valid state paths', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          patches: [{ op: 'append', path: '/tags', value: 'state.status' }],
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const celErrors = errors.filter(
      e => e.code === 'DSL_PATH_UNKNOWN' && e.location.includes('patches') && e.location.includes(':cel'),
    );
    expect(celErrors).toHaveLength(0);
  });

  it('patch CEL with no state.X access produces no CEL path errors', async () => {
    // CEL value accesses event.payload, not state.X — extractStatePaths returns []
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          patches: [{ op: 'append', path: '/tags', value: 'event.payload.tag' }],
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const celErrors = errors.filter(
      e => e.location.includes('patches') && e.location.includes(':cel'),
    );
    expect(celErrors).toHaveLength(0);
  });

  it('multiple unknown state paths in one patch CEL produce multiple errors', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          patches: [{ op: 'append', path: '/tags', value: 'state.badOne + state.badTwo' }],
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const celErrors = errors.filter(
      e => e.code === 'DSL_PATH_UNKNOWN' && e.location.includes('patches') && e.location.includes(':cel'),
    );
    // Both state.badOne and state.badTwo are unknown
    expect(celErrors.length).toBeGreaterThanOrEqual(2);
  });
});
