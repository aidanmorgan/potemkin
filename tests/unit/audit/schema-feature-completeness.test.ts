/**
 * AUDIT: Schema feature completeness probing tests.
 *
 * Covers: typeCheck, fromOpenApi, pathResolver, runtimeGuard, dslStaticChecker.
 *
 * `it.failing` marks a gap in the current src — asserts the CORRECT
 * behaviour so it will turn green once the bug is fixed.
 * Plain `it` documents a feature that already works.
 */

import { isAssignable, validateEntityAgainstSchema } from '../../../src/schema/typeCheck';
import { deriveSchemasFromOpenApi } from '../../../src/schema/fromOpenApi';
import { resolvePath, pathExists } from '../../../src/schema/pathResolver';
import { guardAssignPath, guardAssignedValue } from '../../../src/schema/runtimeGuard';
import { staticCheckDsl } from '../../../src/schema/dslStaticChecker';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';
import type { CompiledDsl, BoundaryConfig } from '../../../src/dsl/types';
import type { OpenApiDoc } from '../../../src/contract/loader';
import type { JsonObject } from '../../../src/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRegistry(boundary: string, schema: ObjectGraphSchema): ObjectGraphSchemaRegistry {
  return {
    byBoundary: { [boundary]: { boundary, entity: schema, arrayPaths: [] } },
    get(b: string) { return this.byBoundary[b]; },
  };
}

function makeDoc(schemas: Record<string, JsonObject>): OpenApiDoc {
  return {
    raw: { components: { schemas } } as unknown as JsonObject,
    paths: {},
    info: { title: 'test', version: '0.0.0' },
  } as unknown as OpenApiDoc;
}

function makeCompiledDsl(boundaries: Partial<BoundaryConfig>[]): CompiledDsl {
  const full = boundaries.map((b) => ({
    boundary: 'B',
    contractPath: '/b',
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
    ...b,
  })) as BoundaryConfig[];
  return {
    boundaries: full,
    byBoundaryName: Object.fromEntries(full.map((b) => [b.boundary, b])),
    byContractPath: {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A.  typeCheck — isAssignable / validateEntityAgainstSchema
// ═══════════════════════════════════════════════════════════════════════════════

describe('typeCheck: format enforcement', () => {
  const uuidSchema: ObjectGraphSchema = { name: 'id', kind: 'string', format: 'uuid' };
  const dateTimeSchema: ObjectGraphSchema = { name: 'ts', kind: 'string', format: 'date-time' };

  // The schema carries `format` but isAssignable / validateEntityAgainstSchema
  // never reads it — any string passes regardless of format.

  it(
    'isAssignable rejects a non-UUID string against format:uuid schema',
    () => {
      expect(isAssignable('not-a-uuid', uuidSchema)).toBe(false);
    },
  );

  it('accepts a valid UUID string against format:uuid schema', () => {
    expect(isAssignable('550e8400-e29b-41d4-a716-446655440000', uuidSchema)).toBe(true);
  });

  it(
    'isAssignable rejects a non-ISO-8601 string against format:date-time schema',
    () => {
      expect(isAssignable('not-a-date', dateTimeSchema)).toBe(false);
    },
  );

  it('rejects invalid format strings (format is now enforced)', () => {
    expect(isAssignable('garbage', uuidSchema)).toBe(false);
    expect(isAssignable('garbage', dateTimeSchema)).toBe(false);
  });
});

describe('typeCheck: numeric enum enforcement', () => {
  // enum on integer/number kind is stored by fromOpenApi but isAssignable
  // only checks enum inside the `kind === "string"` branch.
  const intEnumSchema: ObjectGraphSchema = {
    name: 'status_code',
    kind: 'integer',
    enum: [200, 201, 204],
  };

  it(
    'isAssignable rejects integer 404 against integer schema with enum [200,201,204]',
    () => {
      expect(isAssignable(404, intEnumSchema)).toBe(false);
    },
  );

  it('accepts integer 200 which is in the enum [200,201,204]', () => {
    expect(isAssignable(200, intEnumSchema)).toBe(true);
  });

  it('rejects integer 999 that is not in the enum [200,201,204]', () => {
    expect(isAssignable(999, intEnumSchema)).toBe(false);
  });
});

describe('typeCheck: minimum / maximum / minLength / maxLength enforcement', () => {
  // These OpenAPI constraint keywords are not stored in ObjectGraphSchema
  // (the type definition has no such fields) and not enforced in isAssignable.

  it(
    'validateEntityAgainstSchema reports error when integer is below minimum',
    async () => {
      const schema: ObjectGraphSchema = {
        name: 'Root',
        kind: 'object',
        properties: {
          age: { name: 'age', kind: 'integer', minimum: 0 },
        },
        required: ['age'],
      };
      const result = await validateEntityAgainstSchema({ age: -1 } as JsonObject, schema);
      expect(result.ok).toBe(false);
    },
  );

  it(
    'validateEntityAgainstSchema reports error when string is shorter than minLength',
    async () => {
      const schema: ObjectGraphSchema = {
        name: 'Root',
        kind: 'object',
        properties: {
          code: { name: 'code', kind: 'string', minLength: 3 },
        },
        required: ['code'],
      };
      const result = await validateEntityAgainstSchema({ code: 'ab' } as JsonObject, schema);
      expect(result.ok).toBe(false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// B.  fromOpenApi — OpenAPI feature gaps
// ═══════════════════════════════════════════════════════════════════════════════

describe('fromOpenApi: anyOf vs oneOf distinction', () => {
  // Both oneOf and anyOf are mapped identically to 'union'.
  // oneOf requires exactly one member to match; anyOf requires at least one.
  // The distinction is not preserved in ObjectGraphSchema.
  it('anyOf produces a union schema (works — but semantics are anyOf, not oneOf)', () => {
    const doc = makeDoc({
      MyModel: {
        anyOf: [{ type: 'string' }, { type: 'integer' }],
      } as JsonObject,
    });
    const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
    const s = reg.get('MyModel')!.entity;
    expect(s.kind).toBe('union');
    expect(s.union).toHaveLength(2);
  });

  it(
    'oneOf schema is kind "union" with unionVariant "oneOf" (semantically distinct from anyOf union)',
    () => {
      const doc = makeDoc({
        MyModel: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
        } as JsonObject,
      });
      const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
      const s = reg.get('MyModel')!.entity;
      // oneOf uses kind 'union' for runtime compatibility, distinguished by unionVariant
      expect(s.kind).toBe('union');
      expect(s.unionVariant).toBe('oneOf');
    },
  );
});

describe('fromOpenApi: allOf merge — non-property sub-schemas silently discarded', () => {
  // allOf merge only collects `properties` and `required` from sub-schemas.
  // Sub-schemas that contribute a `type` but no `properties`
  // (e.g. { type: 'string', minLength: 1 }) are silently dropped, and if
  // no sub-schema has properties the result is `kind: 'any'`.

  // The real gap: when the ONLY sub-schema in allOf has a type but NO properties,
  // the merged object is empty and the result collapses to 'any'.
  // Example: allOf with a non-object first member and an object second member
  // where the non-object member's constraints are silently discarded.
  it(
    'allOf where ALL members lack properties honours the type (type-only allOf members preserved)',
    () => {
      const doc = makeDoc({
        MyModel: {
          allOf: [
            { type: 'string', minLength: 1 },
          ],
        } as JsonObject,
      });
      const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
      const s = reg.get('MyModel')!.entity;
      // The `type: 'string'` constraint is now respected
      expect(s.kind).toBe('string');
    },
  );

  it('allOf with an object member and a property-less type-only member still merges properties (works)', () => {
    const doc = makeDoc({
      MyModel: {
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          { description: 'base constraint', type: 'object' },
        ],
      } as JsonObject,
    });
    const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
    const s = reg.get('MyModel')!.entity;
    expect(s.kind).toBe('object');
    expect(s.properties).toHaveProperty('id');
  });

  it('allOf with only property-bearing sub-schemas merges correctly (working)', () => {
    const doc = makeDoc({
      MyModel: {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'integer' } } },
        ],
      } as JsonObject,
    });
    const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
    const s = reg.get('MyModel')!.entity;
    expect(s.kind).toBe('object');
    expect(s.properties).toHaveProperty('a');
    expect(s.properties).toHaveProperty('b');
    expect(s.required).toContain('a');
  });

  it('allOf with type-only sub-schemas preserves the type', () => {
    const doc = makeDoc({
      MyModel: {
        allOf: [
          { type: 'string' },
          { minLength: 1 },
        ],
      } as JsonObject,
    });
    const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
    const s = reg.get('MyModel')!.entity;
    // type: 'string' is now preserved from the type-only member
    expect(s.kind).toBe('string');
  });
});

describe('fromOpenApi: not: keyword', () => {
  it(
    'schema with "not:" throws a clear BootError',
    () => {
      const doc = makeDoc({
        MyModel: {
          not: { type: 'string' },
        } as JsonObject,
      });
      expect(() =>
        deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]),
      ).toThrow();
    },
  );
});

describe('fromOpenApi: discriminator throws BootError (working)', () => {
  it('throws BootError when top-level schema has discriminator', () => {
    const doc = makeDoc({
      MyModel: {
        discriminator: { propertyName: 'type' },
        oneOf: [{ type: 'object' }],
      } as JsonObject,
    });
    // BootError message is the human-readable text, not the code.
    // The code 'BOOT_ERR_SCHEMA_UNSUPPORTED' is stored on .code, not in .message.
    expect(() =>
      deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]),
    ).toThrow('Discriminator not supported');
  });
});

describe('fromOpenApi: additionalProperties as schema object (working)', () => {
  it('converts additionalProperties schema to ObjectGraphSchema', () => {
    const doc = makeDoc({
      MyModel: {
        type: 'object',
        additionalProperties: { type: 'string' },
      } as JsonObject,
    });
    const reg = deriveSchemasFromOpenApi(doc, [{ boundary: 'MyModel', contractPath: '/m', fallbackOverride: false, behaviors: [], reducers: [], eventCatalog: [] }]);
    const s = reg.get('MyModel')!.entity;
    expect(s.kind).toBe('object');
    expect(typeof s.additionalProperties).toBe('object');
    expect((s.additionalProperties as ObjectGraphSchema).kind).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C.  pathResolver — union traversal
// ═══════════════════════════════════════════════════════════════════════════════

describe('pathResolver: union schema traversal', () => {
  const variantA: ObjectGraphSchema = {
    name: 'VariantA',
    kind: 'object',
    properties: { onlyInA: { name: 'onlyInA', kind: 'string' } },
  };
  const variantB: ObjectGraphSchema = {
    name: 'VariantB',
    kind: 'object',
    properties: { onlyInB: { name: 'onlyInB', kind: 'integer' } },
  };
  const unionSchema: ObjectGraphSchema = {
    name: 'MyUnion',
    kind: 'union',
    union: [variantA, variantB],
  };

  it('path existing in first union member resolves successfully', () => {
    // resolvePath tries each member in order and returns first success
    const result = resolvePath(unionSchema, 'onlyInA');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('string');
  });

  it('path existing only in second union member resolves successfully', () => {
    const result = resolvePath(unionSchema, 'onlyInB');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('integer');
  });

  it('path absent from ALL union members returns null', () => {
    const result = resolvePath(unionSchema, 'nonexistent');
    expect(result).toBeNull();
  });

  // The current union resolution uses `break` after the first successful member,
  // so if the path exists in BOTH members, the first member's schema wins.
  // This is correct for `resolvePath` — but it means the returned schema
  // may differ from what a second member would return.
  it('when path exists in both union members, first member schema is returned (documents first-wins behaviour)', () => {
    const schemaWithBoth: ObjectGraphSchema = {
      name: 'Both',
      kind: 'union',
      union: [
        { name: 'A', kind: 'object', properties: { x: { name: 'x', kind: 'string' } } },
        { name: 'B', kind: 'object', properties: { x: { name: 'x', kind: 'integer' } } },
      ],
    };
    const result = resolvePath(schemaWithBoth, 'x');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('string'); // first member wins
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D.  runtimeGuard
// ═══════════════════════════════════════════════════════════════════════════════

describe('runtimeGuard: append on non-array path', () => {
  const schema: ObjectGraphSchema = {
    name: 'Ent',
    kind: 'object',
    properties: {
      name: { name: 'name', kind: 'string' },
      tags: { name: 'tags', kind: 'array', items: { name: 'tags[]', kind: 'string' } },
    },
  };
  const registry = makeRegistry('Ent', schema);

  it('append to an array path succeeds with a matching item', () => {
    expect(() => guardAssignedValue(registry, 'Ent', 'tags', 'new-tag', 'append')).not.toThrow();
  });

  it('append to a non-array path throws SCHEMA_TYPE_MISMATCH with specific message', () => {
    // Verifying the error mentions "array" and the path
    expect(() => guardAssignedValue(registry, 'Ent', 'name', 'bad', 'append')).toThrowError(
      /SCHEMA_TYPE_MISMATCH.*append.*name.*array/i,
    );
  });

  it('append a wrong-type item to an array path throws SCHEMA_TYPE_MISMATCH', () => {
    // tags is string array; appending an integer should fail
    expect(() => guardAssignedValue(registry, 'Ent', 'tags', 42, 'append')).toThrowError(
      /SCHEMA_TYPE_MISMATCH/,
    );
  });

  it('guardAssignPath throws SCHEMA_PATH_UNKNOWN for missing boundary', () => {
    expect(() => guardAssignPath(registry, 'UnknownBoundary', 'any')).toThrowError(
      /SCHEMA_PATH_UNKNOWN/,
    );
  });

  it('guardAssignPath throws SCHEMA_PATH_UNKNOWN for missing path', () => {
    expect(() => guardAssignPath(registry, 'Ent', 'nonexistent')).toThrowError(
      /SCHEMA_PATH_UNKNOWN/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E.  dslStaticChecker — dispatch_commands CEL expressions not checked
// ═══════════════════════════════════════════════════════════════════════════════

describe('dslStaticChecker: dispatch_commands CEL expressions', () => {
  const entitySchema: ObjectGraphSchema = {
    name: 'Ent',
    kind: 'object',
    properties: {
      id: { name: 'id', kind: 'string' },
    },
  };
  const registry = makeRegistry('Ent', entitySchema);

  it(
    'reports DSL_PATH_UNKNOWN when dispatch_commands[].targetId CEL references unknown state path',
    async () => {
      const dsl = makeCompiledDsl([
        {
          boundary: 'Ent',
          behaviors: [
            {
              name: 'b1',
              match: { intent: 'mutation', condition: 'true' },
              emit: 'Ev',
              dispatchCommands: [
                {
                  boundary: 'Ent',
                  intent: 'mutation',
                  // This CEL references a non-existent path — should be caught
                  targetId: 'state.nonExistentId',
                  payload: {},
                },
              ],
            },
          ],
          reducers: [],
          eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
        },
      ]);
      const errors = await staticCheckDsl(dsl, registry);
      expect(errors.some((e) => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
    },
  );

  it(
    'reports DSL_PATH_UNKNOWN when dispatch_commands[].payload CEL references unknown state path',
    async () => {
      const dsl = makeCompiledDsl([
        {
          boundary: 'Ent',
          behaviors: [
            {
              name: 'b1',
              match: { intent: 'mutation', condition: 'true' },
              emit: 'Ev',
              dispatchCommands: [
                {
                  boundary: 'Ent',
                  intent: 'mutation',
                  targetId: 'state.id',
                  payload: { someField: 'state.doesNotExist' },
                },
              ],
            },
          ],
          reducers: [],
          eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
        },
      ]);
      const errors = await staticCheckDsl(dsl, registry);
      expect(errors.some((e) => e.code === 'DSL_PATH_UNKNOWN')).toBe(true);
    },
  );

  it('reports no errors when dispatch_commands references valid state paths (once gap fixed, this should pass)', async () => {
    // Confirm baseline: valid path causes no errors today (feature is not checked at all)
    const dsl = makeCompiledDsl([
      {
        boundary: 'Ent',
        behaviors: [
          {
            name: 'b1',
            match: { intent: 'mutation', condition: 'true' },
            emit: 'Ev',
            dispatchCommands: [
              {
                boundary: 'Ent',
                intent: 'mutation',
                targetId: 'state.id',
                payload: {},
              },
            ],
          },
        ],
        reducers: [],
        eventCatalog: [{ type: 'Ev', payloadTemplate: {} }],
      },
    ]);
    const errors = await staticCheckDsl(dsl, registry);
    // No errors expected for valid references — passes now AND after fix
    expect(errors.filter((e) => e.code === 'DSL_PATH_UNKNOWN')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F.  typeCheck — enum on non-string kinds (validates integer/number enum gap)
// ═══════════════════════════════════════════════════════════════════════════════
describe('typeCheck: enum enforcement for integer kind', () => {
  // Already covered in section A but adding a validate-path test here.
  it(
    'validateEntityAgainstSchema reports error for integer value not in enum',
    async () => {
      const schema: ObjectGraphSchema = {
        name: 'Root',
        kind: 'object',
        properties: {
          code: { name: 'code', kind: 'integer', enum: [1, 2, 3] },
        },
        required: ['code'],
      };
      const result = await validateEntityAgainstSchema({ code: 99 } as JsonObject, schema);
      expect(result.ok).toBe(false);
    },
  );

  it('validateEntityAgainstSchema accepts integer in string enum (working enum check for string)', async () => {
    const schema: ObjectGraphSchema = {
      name: 'Root',
      kind: 'object',
      properties: {
        status: { name: 'status', kind: 'string', enum: ['active', 'closed'] },
      },
      required: ['status'],
    };
    const result = await validateEntityAgainstSchema({ status: 'pending' } as JsonObject, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.reason).toMatch(/not in enum/i);
    }
  });
});
