import { staticCheckDsl } from '../../../src/schema/dslStaticChecker';
import type { CompiledDsl } from '../../../src/dsl/types';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';

const stringSchema: ObjectGraphSchema = { name: 'status', kind: 'string' };
const entitySchema: ObjectGraphSchema = {
  name: 'MyBoundary',
  kind: 'object',
  properties: {
    status: stringSchema,
    count: { name: 'count', kind: 'integer' },
  },
};

function makeRegistry(boundary: string, schema: ObjectGraphSchema): ObjectGraphSchemaRegistry {
  return {
    byBoundary: {
      [boundary]: { boundary, entity: schema, arrayPaths: [] },
    },
    get(b: string) {
      return this.byBoundary[b];
    },
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

describe('schema/dslStaticChecker', () => {
  it('returns empty errors for valid DSL with known paths', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        behaviors: [
          {
            name: 'b1',
            match: { intent: 'mutation', condition: 'state.status == "active"' },
            emit: 'Ev',
          },
        ],
        reducers: [{ on: 'Ev', assign: { status: '"closed"' } }],
        eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
      },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors).toHaveLength(0);
  });

  it('returns DSL_PATH_UNKNOWN when behavior condition accesses unknown state path', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        behaviors: [
          {
            name: 'b1',
            match: { intent: 'mutation', condition: 'state.unknownField == "x"' },
            emit: 'Ev',
          },
        ],
        eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
      },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors.some(e => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
  });

  it('returns DSL_BOUNDARY_UNKNOWN when boundary has no schema', async () => {
    const dsl = makeCompiledDsl([
      { ...minimalBoundary, boundary: 'NoBoundary' },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors.some(e => e.code === 'DSL_BOUNDARY_UNKNOWN')).toBe(true);
  });

  it('returns DSL_PATH_UNKNOWN for reducer patch with unknown path', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{ on: 'Ev', patches: [{ op: 'replace', path: '/unknownField', value: '${"val"}' }] }],
        eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
      },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors.some(e => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
  });

  it('returns DSL_PATH_UNKNOWN for reducer patch CEL with unknown state path', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{ on: 'Ev', patches: [{ op: 'replace', path: '/status', value: '${state.badPath}' }] }],
        eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
      },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors.some(e => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
  });

  it('returns DSL_PATH_UNKNOWN for reducer append patch with unknown path', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        reducers: [{ on: 'Ev', patches: [{ op: 'append', path: '/badArr', value: '${"val"}' }] }],
        eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
      },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors.some(e => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
  });

  it('returns DSL_PATH_UNKNOWN for event catalog payload template with unknown path', async () => {
    const dsl = makeCompiledDsl([
      {
        ...minimalBoundary,
        eventCatalog: [
          { type: 'Ev', payloadTemplate: { field: 'state.badField' } },
        ],
      },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors.some(e => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
  });

  it('returns empty errors for empty DSL', async () => {
    const dsl = makeCompiledDsl([]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors).toHaveLength(0);
  });

  it('error objects include boundary and location fields', async () => {
    const dsl = makeCompiledDsl([
      { ...minimalBoundary, boundary: 'NoBoundary' },
    ]);
    const registry = makeRegistry('MyBoundary', entitySchema);
    const errors = await staticCheckDsl(dsl, registry);
    expect(errors[0]).toHaveProperty('boundary');
    expect(errors[0]).toHaveProperty('location');
    expect(errors[0]).toHaveProperty('detail');
  });
});
