/**
 * Coverage backfill for schema/dslStaticChecker.ts
 *
 * Uncovered lines 118-125:
 * The block at lines 116-128 is the reducer.append CEL value expression state path check:
 *
 *   for (const [dotPath, cel] of Object.entries(reducer.append ?? {})) {
 *     for (const p of extractStatePaths(cel)) {
 *       if (!pathExists(registry, boundary, p)) {
 *         errors.push({           ← line 118
 *           code: 'DSL_PATH_UNKNOWN',
 *           boundary,
 *           location: `reducer:${reducer.on}:append:${dotPath}:cel`,
 *           detail: `Unknown state path 'state.${p}' in append CEL`,
 *         });
 *         log.warn(...)           ← line 125
 *       }
 *     }
 *   }
 *
 * This is distinct from lines 105-110 (unknown APPEND KEY path) — it fires
 * when the append dotPath KEY is valid but the CEL VALUE references an unknown
 * state path like `state.badField`.
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

describe('schema/dslStaticChecker — additional coverage (lines 118-125)', () => {

  it('returns DSL_PATH_UNKNOWN when reducer.append CEL value references unknown state path', async () => {
    // The dotPath 'tags' IS valid (in the schema), but the CEL expression
    // accesses state.nonExistentField which is NOT in the schema.
    // This hits lines 118-125 (append CEL state path check).
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          append: {
            // 'tags' is a valid path, so it passes the dotPath check (lines 105-110)
            // But the CEL expression references state.nonExistentField → hits lines 118-125
            tags: 'state.nonExistentField',
          },
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const appendCelErrors = errors.filter(
      e => e.code === 'DSL_PATH_UNKNOWN' && e.location.includes(':cel'),
    );
    expect(appendCelErrors).toHaveLength(1);
    expect(appendCelErrors[0]?.location).toMatch(/append.*:cel/);
    expect(appendCelErrors[0]?.detail).toContain('nonExistentField');
  });

  it('append CEL error has correct location format (reducer:EVENT:append:DOTPATH:cel)', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          append: {
            tags: 'state.missingProp',
          },
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const appendCelError = errors.find(e => e.location.includes('append') && e.location.includes(':cel'));
    expect(appendCelError).toBeDefined();
    expect(appendCelError?.location).toBe('reducer:TagAdded:append:tags:cel');
    expect(appendCelError?.boundary).toBe('MyBoundary');
  });

  it('no append CEL errors when CEL expression only references valid state paths', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          append: {
            // Both the dotPath 'tags' and the CEL expression 'state.status' are valid
            tags: 'state.status',
          },
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const appendCelErrors = errors.filter(
      e => e.code === 'DSL_PATH_UNKNOWN' && e.location.includes('append') && e.location.includes(':cel'),
    );
    expect(appendCelErrors).toHaveLength(0);
  });

  it('append CEL with no state.X access produces no CEL path errors', async () => {
    // CEL expression accesses event.payload, not state.X — extractStatePaths returns []
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          append: {
            tags: 'event.payload.tag',
          },
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const appendCelErrors = errors.filter(
      e => e.location.includes('append') && e.location.includes(':cel'),
    );
    expect(appendCelErrors).toHaveLength(0);
  });

  it('multiple unknown state paths in one append CEL produce multiple errors', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{
          on: 'TagAdded',
          append: {
            tags: 'state.badOne + state.badTwo',
          },
        }],
        eventCatalog: [{ type: 'TagAdded', payloadTemplate: {} }],
      },
    ]);

    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);

    const appendCelErrors = errors.filter(
      e => e.code === 'DSL_PATH_UNKNOWN' && e.location.includes('append') && e.location.includes(':cel'),
    );
    // Both state.badOne and state.badTwo are unknown
    expect(appendCelErrors.length).toBeGreaterThanOrEqual(2);
  });
});
