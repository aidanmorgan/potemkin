import { deriveSchemasFromOpenApi } from '../../../src/schema/fromOpenApi';
import { BootError } from '../../../src/errors';
import type { OpenApiDoc } from '../../../src/contract/loader';

function makeDoc(schemas: Record<string, object>): OpenApiDoc {
  return {
    raw: { components: { schemas } },
    paths: {},
  };
}

const loanBoundary: any = {
  boundary: 'Loan',
  contractPath: '/loans',
  fallbackOverride: false,
  behaviors: [],
  reducers: [],
  eventCatalog: [],
};

describe('schema/fromOpenApi', () => {
  describe('deriveSchemasFromOpenApi', () => {
    it('returns a registry with a known boundary', () => {
      const doc = makeDoc({
        Loan: { type: 'object', properties: { id: { type: 'string' } } },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      expect(registry.get('Loan')).toBeDefined();
    });

    it('throws BootError when schema is missing for boundary', () => {
      const doc = makeDoc({});
      expect(() =>
        deriveSchemasFromOpenApi(doc, [loanBoundary]),
      ).toThrow(BootError);
    });

    it('BootError has code BOOT_ERR_SCHEMA_MISSING', () => {
      const doc = makeDoc({});
      try {
        deriveSchemasFromOpenApi(doc, [loanBoundary]);
        fail('should have thrown BootError');
      } catch (e) {
        expect((e as BootError).code).toBe('BOOT_ERR_SCHEMA_MISSING');
      }
    });

    it('throws BootError for discriminator (unsupported)', () => {
      const doc = makeDoc({
        Loan: { type: 'object', discriminator: { propertyName: 'type' } },
      });
      expect(() =>
        deriveSchemasFromOpenApi(doc, [loanBoundary]),
      ).toThrow(BootError);
    });

    it('converts object schema properties', () => {
      const doc = makeDoc({
        Loan: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            amount: { type: 'number' },
          },
        },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      const schema = registry.get('Loan')!.entity;
      expect(schema.kind).toBe('object');
      expect(schema.properties?.['id']?.kind).toBe('string');
      expect(schema.properties?.['amount']?.kind).toBe('number');
    });

    it('converts integer type', () => {
      const doc = makeDoc({
        Loan: { type: 'object', properties: { count: { type: 'integer' } } },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      expect(registry.get('Loan')!.entity.properties?.['count']?.kind).toBe('integer');
    });

    it('converts boolean type', () => {
      const doc = makeDoc({
        Loan: { type: 'object', properties: { active: { type: 'boolean' } } },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      expect(registry.get('Loan')!.entity.properties?.['active']?.kind).toBe('boolean');
    });

    it('converts array type with items', () => {
      const doc = makeDoc({
        Loan: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      const tags = registry.get('Loan')!.entity.properties?.['tags'];
      expect(tags?.kind).toBe('array');
      expect(tags?.items?.kind).toBe('string');
    });

    it('populates arrayPaths for array properties', () => {
      const doc = makeDoc({
        Loan: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      expect(registry.get('Loan')!.arrayPaths).toContain('tags');
    });

    it('converts nullable shorthand', () => {
      const doc = makeDoc({
        Loan: { type: 'object', properties: { note: { type: 'string', nullable: true } } },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      expect(registry.get('Loan')!.entity.properties?.['note']?.nullable).toBe(true);
    });

    it('converts oneOf as union', () => {
      const doc = makeDoc({
        Loan: {
          type: 'object',
          properties: {
            value: {
              oneOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      expect(registry.get('Loan')!.entity.properties?.['value']?.kind).toBe('union');
    });

    it('converts enum', () => {
      const doc = makeDoc({
        Loan: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['active', 'closed'] } },
        },
      });
      const registry = deriveSchemasFromOpenApi(doc, [loanBoundary]);
      const status = registry.get('Loan')!.entity.properties?.['status'];
      expect(status?.enum).toEqual(['active', 'closed']);
    });

    it('handles missing components section gracefully with empty boundaries', () => {
      const doc: OpenApiDoc = { raw: {}, paths: {} };
      const registry = deriveSchemasFromOpenApi(doc, []);
      expect(registry.byBoundary).toEqual({});
    });
  });
});
