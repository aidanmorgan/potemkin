/**
 * Exhaustive permutation tests for schema/pathResolver.
 * Targets: src/schema/pathResolver.ts (branches ~96.55% → ≥95%, already high)
 */
import { resolvePath, isValidPath, pathExists } from '../../../src/schema/pathResolver';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';

// ── Schema builders ───────────────────────────────────────────────────────────

function stringSchema(name: string, extra: Partial<ObjectGraphSchema> = {}): ObjectGraphSchema {
  return { name, kind: 'string', ...extra };
}

function intSchema(name: string): ObjectGraphSchema {
  return { name, kind: 'integer' };
}

function anySchema(name: string): ObjectGraphSchema {
  return { name, kind: 'any' };
}

function objectSchema(
  name: string,
  props: Record<string, ObjectGraphSchema>,
  extra: Partial<ObjectGraphSchema> = {},
): ObjectGraphSchema {
  return { name, kind: 'object', properties: props, ...extra };
}

function arraySchema(name: string, items?: ObjectGraphSchema): ObjectGraphSchema {
  return { name, kind: 'array', items };
}

function unionSchema(name: string, members: ObjectGraphSchema[]): ObjectGraphSchema {
  return { name, kind: 'union', union: members };
}

// ── Root schema for tests ──────────────────────────────────────────────────

const ROOT: ObjectGraphSchema = objectSchema('Root', {
  name: stringSchema('Root.name'),
  age: intSchema('Root.age'),
  address: objectSchema('Root.address', {
    street: stringSchema('Root.address.street'),
    city: stringSchema('Root.address.city'),
    geo: objectSchema('Root.address.geo', {
      lat: { name: 'Root.address.geo.lat', kind: 'number' },
      lng: { name: 'Root.address.geo.lng', kind: 'number' },
    }),
  }),
  tags: arraySchema('Root.tags', stringSchema('Root.tags[]')),
  matrix: arraySchema('Root.matrix', arraySchema('Root.matrix[]', intSchema('Root.matrix[][]'))),
  items: arraySchema('Root.items', objectSchema('Root.items[]', {
    id: stringSchema('Root.items[].id'),
    value: intSchema('Root.items[].value'),
  })),
  meta: objectSchema('Root.meta', {}, {
    additionalProperties: true,
  }),
  typed: objectSchema('Root.typed', {}, {
    additionalProperties: stringSchema('Root.typed.__additional'),
  }),
  status: unionSchema('Root.status', [
    stringSchema('Root.status[0]'),
    intSchema('Root.status[1]'),
  ]),
  strict: objectSchema('Root.strict', {
    only: stringSchema('Root.strict.only'),
  }, {
    additionalProperties: false,
  }),
});

describe('schema/pathResolver — permutations', () => {
  // ── Empty path ─────────────────────────────────────────────────────────────
  describe('empty path', () => {
    it('empty string returns root schema', () => {
      expect(resolvePath(ROOT, '')).toBe(ROOT);
    });
  });

  // ── Top-level scalar paths ─────────────────────────────────────────────────
  describe('top-level scalar paths', () => {
    it('resolves name', () => {
      expect(resolvePath(ROOT, 'name')?.kind).toBe('string');
    });

    it('resolves age (integer)', () => {
      expect(resolvePath(ROOT, 'age')?.kind).toBe('integer');
    });

    it('returns null for unknown top-level key', () => {
      expect(resolvePath(ROOT, 'unknown')).toBeNull();
    });
  });

  // ── Nested object paths ────────────────────────────────────────────────────
  describe('nested object paths', () => {
    it('resolves 2-level nested: address.street', () => {
      expect(resolvePath(ROOT, 'address.street')?.kind).toBe('string');
    });

    it('resolves 3-level nested: address.geo.lat', () => {
      expect(resolvePath(ROOT, 'address.geo.lat')?.kind).toBe('number');
    });

    it('resolves address.city', () => {
      expect(resolvePath(ROOT, 'address.city')?.kind).toBe('string');
    });

    it('returns null for missing nested key', () => {
      expect(resolvePath(ROOT, 'address.nonexistent')).toBeNull();
    });

    it('returns null for path through non-object scalar', () => {
      expect(resolvePath(ROOT, 'name.sub')).toBeNull();
    });
  });

  // ── Array index paths ──────────────────────────────────────────────────────
  describe('array index paths', () => {
    it('tags[0] resolves to items schema (string)', () => {
      expect(resolvePath(ROOT, 'tags[0]')?.kind).toBe('string');
    });

    it('tags[] resolves to items schema', () => {
      expect(resolvePath(ROOT, 'tags[]')?.kind).toBe('string');
    });

    it('items[0].id resolves to string', () => {
      expect(resolvePath(ROOT, 'items[0].id')?.kind).toBe('string');
    });

    it('items[0].value resolves to integer', () => {
      expect(resolvePath(ROOT, 'items[0].value')?.kind).toBe('integer');
    });

    it('2D array matrix[0][0] resolves to integer', () => {
      expect(resolvePath(ROOT, 'matrix[0][0]')?.kind).toBe('integer');
    });

    it('returns null when array has no items schema', () => {
      const schema = arraySchema('bare', undefined);
      expect(resolvePath(schema, '[]')).toBeNull();
    });

    it('returns null on array index access when not an array', () => {
      expect(resolvePath(ROOT, 'name[0]')).toBeNull();
    });
  });

  // ── mixed paths ────────────────────────────────────────────────────────────
  describe('mixed access paths', () => {
    it('items[0].id (mixed array index and dot)', () => {
      const r = resolvePath(ROOT, 'items[0].id');
      expect(r?.kind).toBe('string');
    });

    it('items[0].value', () => {
      expect(resolvePath(ROOT, 'items[0].value')?.kind).toBe('integer');
    });
  });

  // ── additionalProperties ───────────────────────────────────────────────────
  describe('additionalProperties resolution', () => {
    it('additionalProperties: true returns any schema for unknown key', () => {
      const r = resolvePath(ROOT, 'meta.anything');
      expect(r?.kind).toBe('any');
    });

    it('additionalProperties: schema returns that schema for unknown key', () => {
      const r = resolvePath(ROOT, 'typed.unknownKey');
      expect(r?.kind).toBe('string');
    });

    it('additionalProperties: false returns null for unknown key', () => {
      expect(resolvePath(ROOT, 'strict.unknown')).toBeNull();
    });

    it('resolves known key in strict schema', () => {
      expect(resolvePath(ROOT, 'strict.only')?.kind).toBe('string');
    });
  });

  // ── union schema ───────────────────────────────────────────────────────────
  describe('union schema resolution', () => {
    it('resolves path through first matching union member', () => {
      // status is union[string, integer]; from union at root level
      // accessing 'length' on string member — tricky, but the resolver tries each
      // More direct: build a union of objects where one has the key
      const schema = unionSchema('U', [
        objectSchema('U[0]', { x: stringSchema('U[0].x') }),
        objectSchema('U[1]', { y: intSchema('U[1].y') }),
      ]);
      expect(resolvePath(schema, 'x')?.kind).toBe('string');
      expect(resolvePath(schema, 'y')?.kind).toBe('integer');
    });

    it('returns null when no union member has the path', () => {
      const schema = unionSchema('U', [
        objectSchema('U[0]', { x: stringSchema('U[0].x') }),
      ]);
      expect(resolvePath(schema, 'z')).toBeNull();
    });

    it('empty union returns null', () => {
      const schema = unionSchema('U', []);
      expect(resolvePath(schema, 'x')).toBeNull();
    });
  });

  // ── any schema ────────────────────────────────────────────────────────────
  describe('any schema', () => {
    it('any schema returns any schema for any token', () => {
      const schema = anySchema('any');
      expect(resolvePath(schema, 'x')?.kind).toBe('any');
    });

    it('any schema with nested path returns any schema', () => {
      const schema = anySchema('any');
      expect(resolvePath(schema, 'a.b.c')?.kind).toBe('any');
    });
  });

  // ── prototype pollution prevention ────────────────────────────────────────
  describe('prototype pollution prevention', () => {
    it('__proto__ does not resolve', () => {
      // hasOwnProperty check prevents prototype chain access
      expect(resolvePath(ROOT, '__proto__')).toBeNull();
    });

    it('constructor does not resolve as a property', () => {
      expect(resolvePath(ROOT, 'constructor')).toBeNull();
    });

    it('toString does not resolve as a property', () => {
      expect(resolvePath(ROOT, 'toString')).toBeNull();
    });
  });

  // ── isValidPath ────────────────────────────────────────────────────────────
  describe('isValidPath', () => {
    it('returns true for valid path', () => {
      expect(isValidPath(ROOT, 'name')).toBe(true);
    });

    it('returns false for invalid path', () => {
      expect(isValidPath(ROOT, 'nonexistent')).toBe(false);
    });

    it('returns true for empty path', () => {
      expect(isValidPath(ROOT, '')).toBe(true);
    });
  });

  // ── pathExists with registry ───────────────────────────────────────────────
  describe('pathExists', () => {
    const registry: ObjectGraphSchemaRegistry = {
      byBoundary: {
        MyBoundary: {
          boundary: 'MyBoundary',
          entity: ROOT,
          arrayPaths: [],
        },
      },
      get(b: string) {
        return this.byBoundary[b];
      },
    };

    it('returns true for existing boundary + path', () => {
      expect(pathExists(registry, 'MyBoundary', 'name')).toBe(true);
    });

    it('returns false for unknown boundary', () => {
      expect(pathExists(registry, 'UnknownBoundary', 'name')).toBe(false);
    });

    it('returns false for invalid path in known boundary', () => {
      expect(pathExists(registry, 'MyBoundary', 'nonexistent')).toBe(false);
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('handles path with multiple consecutive array indices', () => {
      expect(resolvePath(ROOT, 'matrix[0][0]')?.kind).toBe('integer');
    });

    it('resolves object properties on non-object kind gracefully (returns null)', () => {
      // Trying to access a.b.c where b is an array
      expect(resolvePath(ROOT, 'tags.nonexistent')).toBeNull();
    });
  });
});
