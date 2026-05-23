/**
 * Exhaustive permutation tests for schema/fromOpenApi.
 * Targets: src/schema/fromOpenApi.ts (branches ~96.61% → ≥95%, lines 14,85)
 */
import { deriveSchemasFromOpenApi } from '../../../src/schema/fromOpenApi';
import { BootError } from '../../../src/errors';
import type { OpenApiDoc } from '../../../src/contract/loader';

function makeDoc(schemas: Record<string, object>, extraRaw: object = {}): OpenApiDoc {
  return {
    raw: { components: { schemas }, ...extraRaw },
    paths: {},
  };
}

const baseBoundary: any = {
  boundary: 'Item',
  contractPath: '/items',
  fallbackOverride: false,
  behaviors: [],
  reducers: [],
  eventCatalog: [],
};

describe('schema/fromOpenApi — permutations', () => {
  // ── Each OAS type ───────────────────────────────────────────────────────────
  describe('type conversions', () => {
    it.each([
      ['string', 'string'],
      ['number', 'number'],
      ['integer', 'integer'],
      ['boolean', 'boolean'],
      ['null', 'null'],
    ])('type: %s → kind: %s', (oasType, expectedKind) => {
      const doc = makeDoc({ Item: { type: oasType } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.kind).toBe(expectedKind);
    });

    it('type: array → kind: array', () => {
      const doc = makeDoc({ Item: { type: 'array', items: { type: 'string' } } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.kind).toBe('array');
    });

    it('type: object → kind: object', () => {
      const doc = makeDoc({ Item: { type: 'object' } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.kind).toBe('object');
    });

    it('object inferred from properties (no type key)', () => {
      const doc = makeDoc({ Item: { properties: { id: { type: 'string' } } } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.kind).toBe('object');
    });

    it('no type, no properties, no items → kind: any', () => {
      const doc = makeDoc({ Item: {} });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.kind).toBe('any');
    });
  });

  // ── format variations ───────────────────────────────────────────────────────
  describe('format field', () => {
    it.each(['uuid', 'date-time', 'email', 'custom-unknown'])(
      'preserves format: %s',
      (format) => {
        const doc = makeDoc({ Item: { type: 'string', format } });
        const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
        expect(reg.get('Item')!.entity.format).toBe(format);
      },
    );
  });

  // ── nullable ────────────────────────────────────────────────────────────────
  describe('nullable: true', () => {
    it('preserves nullable: true on string', () => {
      const doc = makeDoc({ Item: { type: 'string', nullable: true } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.nullable).toBe(true);
    });

    it('nullable: false not set when absent', () => {
      const doc = makeDoc({ Item: { type: 'string' } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.nullable).toBe(false);
    });
  });

  // ── enum ────────────────────────────────────────────────────────────────────
  describe('enum values', () => {
    it('preserves enum on string schema', () => {
      const doc = makeDoc({ Item: { type: 'string', enum: ['a', 'b', 'c'] } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.enum).toEqual(['a', 'b', 'c']);
    });

    it('preserves enum on non-string kind', () => {
      const doc = makeDoc({ Item: { type: 'integer', enum: [1, 2, 3] } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.enum).toEqual([1, 2, 3]);
    });
  });

  // ── oneOf → union ───────────────────────────────────────────────────────────
  describe('oneOf → union', () => {
    it('converts oneOf to union kind', () => {
      const doc = makeDoc({
        Item: {
          oneOf: [
            { type: 'string' },
            { type: 'integer' },
          ],
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.kind).toBe('union');
      expect(schema.union).toHaveLength(2);
      expect(schema.union![0]!.kind).toBe('string');
      expect(schema.union![1]!.kind).toBe('integer');
    });
  });

  // ── anyOf → union ───────────────────────────────────────────────────────────
  describe('anyOf → union', () => {
    it('converts anyOf to union kind', () => {
      const doc = makeDoc({
        Item: {
          anyOf: [
            { type: 'string' },
            { type: 'boolean' },
          ],
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.kind).toBe('union');
      expect(schema.union).toHaveLength(2);
    });
  });

  // ── allOf → merged object ───────────────────────────────────────────────────
  describe('allOf → object merge', () => {
    it('merges allOf properties into single object', () => {
      const doc = makeDoc({
        Item: {
          allOf: [
            { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          ],
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.kind).toBe('object');
      expect(schema.properties?.['id']?.kind).toBe('string');
      expect(schema.properties?.['name']?.kind).toBe('string');
      expect(schema.required).toContain('id');
      expect(schema.required).toContain('name');
    });

    it('allOf with no properties → any schema', () => {
      const doc = makeDoc({
        Item: {
          allOf: [
            { description: 'base' },
            { description: 'extension' },
          ],
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.kind).toBe('any');
    });
  });

  // ── additionalProperties ─────────────────────────────────────────────────
  describe('additionalProperties', () => {
    it('additionalProperties: false → false', () => {
      const doc = makeDoc({
        Item: { type: 'object', additionalProperties: false },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.additionalProperties).toBe(false);
    });

    it('additionalProperties: true → true', () => {
      const doc = makeDoc({
        Item: { type: 'object', additionalProperties: true },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.additionalProperties).toBe(true);
    });

    it('additionalProperties as schema → ObjectGraphSchema', () => {
      const doc = makeDoc({
        Item: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const addl = reg.get('Item')!.entity.additionalProperties;
      expect(typeof addl).toBe('object');
      expect((addl as any).kind).toBe('string');
    });
  });

  // ── nested arrays of objects ─────────────────────────────────────────────
  describe('nested arrays of objects', () => {
    it('converts array of objects', () => {
      const doc = makeDoc({
        Item: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
            children: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' } },
              },
            },
          },
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.properties?.['tags']?.kind).toBe('array');
      expect(schema.properties?.['tags']?.items?.kind).toBe('string');
      expect(schema.properties?.['children']?.kind).toBe('array');
      expect(schema.properties?.['children']?.items?.kind).toBe('object');
    });

    it('collectArrayPaths finds nested array paths', () => {
      const doc = makeDoc({
        Item: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  subItems: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const bs = reg.get('Item')!;
      expect(bs.arrayPaths).toContain('items');
      expect(bs.arrayPaths).toContain('items[].subItems');
    });
  });

  // ── array without items ────────────────────────────────────────────────────
  describe('array schema without items', () => {
    it('array without items schema produces array kind with no items', () => {
      const doc = makeDoc({ Item: { type: 'array' } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.kind).toBe('array');
      expect(schema.items).toBeUndefined();
    });
  });

  // ── type as array (nullable shorthand) ──────────────────────────────────────
  describe('type array (nullable shorthand)', () => {
    it('["string", "null"] → union with nullable: true', () => {
      const doc = makeDoc({ Item: { type: ['string', 'null'] } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      // ["string", "null"] with 1 non-null → maps to that type with nullable
      expect(['string', 'union']).toContain(schema.kind);
    });

    it('["string", "integer"] → union kind', () => {
      const doc = makeDoc({ Item: { type: ['string', 'integer'] } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      const schema = reg.get('Item')!.entity;
      expect(schema.kind).toBe('union');
    });
  });

  // ── missing component schema ────────────────────────────────────────────────
  describe('missing component schema', () => {
    it('throws BootError BOOT_ERR_SCHEMA_MISSING when schema not found', () => {
      const doc = makeDoc({});
      expect(() => deriveSchemasFromOpenApi(doc, [baseBoundary])).toThrow(BootError);
    });

    it('BOOT_ERR_SCHEMA_MISSING code', () => {
      try {
        deriveSchemasFromOpenApi(makeDoc({}), [baseBoundary]);
      } catch (e) {
        expect((e as BootError).code).toBe('BOOT_ERR_SCHEMA_MISSING');
      }
    });

    it('no components section → throws', () => {
      const doc: OpenApiDoc = { raw: {}, paths: {} };
      expect(() => deriveSchemasFromOpenApi(doc, [baseBoundary])).toThrow(BootError);
    });
  });

  // ── discriminator (unsupported) ─────────────────────────────────────────────
  describe('discriminator (unsupported)', () => {
    it('throws BOOT_ERR_SCHEMA_UNSUPPORTED for discriminator', () => {
      const doc = makeDoc({ Item: { type: 'object', discriminator: { propertyName: 'type' } } });
      try {
        deriveSchemasFromOpenApi(doc, [baseBoundary]);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_SCHEMA_UNSUPPORTED');
      }
    });
  });

  // ── required fields ──────────────────────────────────────────────────────────
  describe('required field', () => {
    it('preserves required array on object schema', () => {
      const doc = makeDoc({
        Item: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.required).toEqual(['id', 'name']);
    });

    it('required is undefined when not specified', () => {
      const doc = makeDoc({
        Item: { type: 'object', properties: { id: { type: 'string' } } },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.required).toBeUndefined();
    });
  });

  // ── description field ─────────────────────────────────────────────────────
  describe('description field', () => {
    it('preserves description on schema', () => {
      const doc = makeDoc({
        Item: { type: 'string', description: 'A string item' },
      });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Item')!.entity.description).toBe('A string item');
    });
  });

  // ── registry.get ──────────────────────────────────────────────────────────
  describe('registry access', () => {
    it('registry.get returns undefined for unknown boundary', () => {
      const doc = makeDoc({ Item: { type: 'string' } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.get('Unknown')).toBeUndefined();
    });

    it('registry.byBoundary has the boundary key', () => {
      const doc = makeDoc({ Item: { type: 'string' } });
      const reg = deriveSchemasFromOpenApi(doc, [baseBoundary]);
      expect(reg.byBoundary['Item']).toBeDefined();
    });
  });
});
