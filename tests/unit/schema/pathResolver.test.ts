import { resolvePath, isValidPath, pathExists } from '../../../src/schema/pathResolver';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';

function makeObjectSchema(
  properties: Record<string, ObjectGraphSchema>,
  required?: string[],
): ObjectGraphSchema {
  return { name: 'root', kind: 'object', properties, required };
}

function makeArraySchema(items: ObjectGraphSchema): ObjectGraphSchema {
  return { name: 'arr', kind: 'array', items };
}

const stringSchema: ObjectGraphSchema = { name: 's', kind: 'string' };
const numberSchema: ObjectGraphSchema = { name: 'n', kind: 'number' };

describe('schema/pathResolver', () => {
  describe('resolvePath', () => {
    it('returns schema itself for empty path', () => {
      const schema = makeObjectSchema({ a: stringSchema });
      expect(resolvePath(schema, '')).toBe(schema);
    });

    it('resolves a top-level property', () => {
      const schema = makeObjectSchema({ name: stringSchema });
      expect(resolvePath(schema, 'name')).toBe(stringSchema);
    });

    it('resolves a nested property', () => {
      const inner = makeObjectSchema({ x: numberSchema });
      const schema = makeObjectSchema({ meta: inner });
      expect(resolvePath(schema, 'meta.x')).toBe(numberSchema);
    });

    it('returns null for unknown property', () => {
      const schema = makeObjectSchema({ name: stringSchema });
      expect(resolvePath(schema, 'unknown')).toBeNull();
    });

    it('resolves array index to items schema', () => {
      const arr = makeArraySchema(stringSchema);
      const schema = makeObjectSchema({ tags: arr });
      expect(resolvePath(schema, 'tags[0]')).toBe(stringSchema);
    });

    it('resolves array [] token to items schema', () => {
      const arr = makeArraySchema(numberSchema);
      const schema = makeObjectSchema({ nums: arr });
      expect(resolvePath(schema, 'nums[]')).toBe(numberSchema);
    });

    it('returns null when navigating through non-array with []', () => {
      const schema = makeObjectSchema({ name: stringSchema });
      expect(resolvePath(schema, 'name[]')).toBeNull();
    });

    it('returns null when navigating through non-object with property key', () => {
      const schema = makeObjectSchema({ count: numberSchema });
      expect(resolvePath(schema, 'count.nested')).toBeNull();
    });

    it('resolves through union members', () => {
      const union: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        union: [makeObjectSchema({ val: numberSchema }), stringSchema],
      };
      const schema = makeObjectSchema({ x: union });
      expect(resolvePath(schema, 'x.val')).toBe(numberSchema);
    });

    it('returns any schema for any kind', () => {
      const anySchema: ObjectGraphSchema = { name: 'any', kind: 'any' };
      const schema = makeObjectSchema({ data: anySchema });
      const result = resolvePath(schema, 'data.anything');
      expect(result?.kind).toBe('any');
    });

    it('supports additionalProperties as object schema', () => {
      const extra: ObjectGraphSchema = { name: 'extra', kind: 'string' };
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {},
        additionalProperties: extra,
      };
      const result = resolvePath(schema, 'anyKey');
      expect(result).toBe(extra);
    });

    it('supports additionalProperties: true → any schema', () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {},
        additionalProperties: true,
      };
      const result = resolvePath(schema, 'anyKey');
      expect(result?.kind).toBe('any');
    });
  });

  describe('isValidPath', () => {
    it('returns true for valid path', () => {
      const schema = makeObjectSchema({ name: stringSchema });
      expect(isValidPath(schema, 'name')).toBe(true);
    });

    it('returns false for invalid path', () => {
      const schema = makeObjectSchema({ name: stringSchema });
      expect(isValidPath(schema, 'unknown')).toBe(false);
    });
  });

  describe('pathExists', () => {
    const registry: ObjectGraphSchemaRegistry = {
      byBoundary: {
        MyBoundary: {
          boundary: 'MyBoundary',
          entity: makeObjectSchema({ status: stringSchema }),
          arrayPaths: [],
        },
      },
      get(boundary: string) {
        return this.byBoundary[boundary];
      },
    };

    it('returns true for existing path in known boundary', () => {
      expect(pathExists(registry, 'MyBoundary', 'status')).toBe(true);
    });

    it('returns false for unknown path in known boundary', () => {
      expect(pathExists(registry, 'MyBoundary', 'nonexistent')).toBe(false);
    });

    it('returns false for unknown boundary', () => {
      expect(pathExists(registry, 'UnknownBoundary', 'status')).toBe(false);
    });
  });
});
