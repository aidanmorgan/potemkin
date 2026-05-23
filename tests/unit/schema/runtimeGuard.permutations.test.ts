/**
 * Exhaustive permutation tests for schema/runtimeGuard.
 * Targets: src/schema/runtimeGuard.ts (branches ~81.81% → ≥95%)
 */
import { guardAssignPath, guardAssignedValue } from '../../../src/schema/runtimeGuard';
import { InternalExecutionError } from '../../../src/errors';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';

// ── Registry builder ──────────────────────────────────────────────────────────

function makeRegistry(entity: ObjectGraphSchema): ObjectGraphSchemaRegistry {
  return {
    byBoundary: {
      TestBoundary: {
        boundary: 'TestBoundary',
        entity,
        arrayPaths: [],
      },
    },
    get(b: string) { return this.byBoundary[b]; },
  };
}

const ENTITY: ObjectGraphSchema = {
  name: 'Entity',
  kind: 'object',
  properties: {
    name: { name: 'Entity.name', kind: 'string' },
    age: { name: 'Entity.age', kind: 'integer' },
    score: { name: 'Entity.score', kind: 'number' },
    active: { name: 'Entity.active', kind: 'boolean' },
    createdAt: { name: 'Entity.createdAt', kind: 'string', format: 'date-time' },
    uuid: { name: 'Entity.uuid', kind: 'string', format: 'uuid' },
    status: { name: 'Entity.status', kind: 'string', enum: ['active', 'inactive', 'pending'] },
    nullableField: { name: 'Entity.nullableField', kind: 'string', nullable: true },
    notNullable: { name: 'Entity.notNullable', kind: 'string', nullable: false },
    tags: {
      name: 'Entity.tags',
      kind: 'array',
      items: { name: 'Entity.tags[]', kind: 'string' },
    },
    scores: {
      name: 'Entity.scores',
      kind: 'array',
      items: { name: 'Entity.scores[]', kind: 'integer' },
    },
    nested: {
      name: 'Entity.nested',
      kind: 'object',
      properties: {
        value: { name: 'Entity.nested.value', kind: 'string' },
      },
    },
    strictObj: {
      name: 'Entity.strictObj',
      kind: 'object',
      properties: { only: { name: 'Entity.strictObj.only', kind: 'string' } },
      additionalProperties: false,
    },
  },
};

const registry = makeRegistry(ENTITY);

describe('schema/runtimeGuard — permutations', () => {
  // ── guardAssignPath: success cases ────────────────────────────────────────
  describe('guardAssignPath — valid paths', () => {
    it.each([
      'name',
      'age',
      'score',
      'active',
      'createdAt',
      'uuid',
      'status',
      'nullableField',
      'tags',
      'nested',
      'nested.value',
    ])('does not throw for valid path: %s', (path) => {
      expect(() => guardAssignPath(registry, 'TestBoundary', path)).not.toThrow();
    });
  });

  // ── guardAssignPath: unknown boundary ─────────────────────────────────────
  describe('guardAssignPath — unknown boundary', () => {
    it('throws InternalExecutionError for unknown boundary', () => {
      expect(() => guardAssignPath(registry, 'UnknownBoundary', 'name')).toThrow(InternalExecutionError);
    });

    it('error details.code is SCHEMA_PATH_UNKNOWN for unknown boundary', () => {
      try {
        guardAssignPath(registry, 'UnknownBoundary', 'name');
      } catch (e) {
        expect((e as InternalExecutionError).details).toMatchObject({ code: 'SCHEMA_PATH_UNKNOWN' });
      }
    });
  });

  // ── guardAssignPath: unknown path ─────────────────────────────────────────
  describe('guardAssignPath — unknown paths', () => {
    it('throws InternalExecutionError for unknown path', () => {
      expect(() => guardAssignPath(registry, 'TestBoundary', 'nonexistent')).toThrow(InternalExecutionError);
    });

    it('error details.code is SCHEMA_PATH_UNKNOWN', () => {
      try {
        guardAssignPath(registry, 'TestBoundary', 'totally.missing');
      } catch (e) {
        expect((e as InternalExecutionError).details).toMatchObject({ code: 'SCHEMA_PATH_UNKNOWN' });
      }
    });

    it('throws for path into scalar field', () => {
      expect(() => guardAssignPath(registry, 'TestBoundary', 'name.sub')).toThrow(InternalExecutionError);
    });
  });

  // ── guardAssignedValue: assign mode — success ──────────────────────────────
  describe('guardAssignedValue — assign mode — valid values', () => {
    it('assigns string to string field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'name', 'Alice')).not.toThrow();
    });

    it('assigns integer to integer field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'age', 25)).not.toThrow();
    });

    it('assigns number to number field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'score', 3.14)).not.toThrow();
    });

    it('assigns integer to number field (integers are numbers)', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'score', 5)).not.toThrow();
    });

    it('assigns boolean to boolean field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'active', true)).not.toThrow();
    });

    it('assigns valid enum value', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'status', 'active')).not.toThrow();
    });

    it('assigns null to nullable string field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'nullableField', null)).not.toThrow();
    });

    it('assigns array to array field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'tags', ['a', 'b'])).not.toThrow();
    });
  });

  // ── guardAssignedValue: assign mode — type mismatches ─────────────────────
  describe('guardAssignedValue — assign mode — type mismatches', () => {
    it('throws SCHEMA_TYPE_MISMATCH when number assigned to string field', () => {
      try {
        guardAssignedValue(registry, 'TestBoundary', 'name', 42);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(InternalExecutionError);
        expect((e as InternalExecutionError).details).toMatchObject({ code: 'SCHEMA_TYPE_MISMATCH' });
      }
    });

    it('throws SCHEMA_TYPE_MISMATCH when string assigned to integer field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'age', 'not-a-number')).toThrow(InternalExecutionError);
    });

    it('throws SCHEMA_TYPE_MISMATCH when invalid enum value assigned', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'status', 'deleted')).toThrow(InternalExecutionError);
    });

    it('throws SCHEMA_TYPE_MISMATCH when null assigned to non-nullable field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'notNullable', null)).toThrow(InternalExecutionError);
    });

    it('throws SCHEMA_TYPE_MISMATCH when boolean assigned to number field', () => {
      expect(() => guardAssignedValue(registry, 'TestBoundary', 'score', true)).toThrow(InternalExecutionError);
    });
  });

  // ── guardAssignedValue: append mode — success ──────────────────────────────
  describe('guardAssignedValue — append mode — valid', () => {
    it('appends string item to string array', () => {
      expect(() =>
        guardAssignedValue(registry, 'TestBoundary', 'tags', 'new-tag', 'append'),
      ).not.toThrow();
    });

    it('appends integer item to integer array', () => {
      expect(() =>
        guardAssignedValue(registry, 'TestBoundary', 'scores', 42, 'append'),
      ).not.toThrow();
    });
  });

  // ── guardAssignedValue: append mode — errors ──────────────────────────────
  describe('guardAssignedValue — append mode — errors', () => {
    it('throws SCHEMA_TYPE_MISMATCH when appending to non-array path', () => {
      try {
        guardAssignedValue(registry, 'TestBoundary', 'name', 'val', 'append');
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(InternalExecutionError);
        expect((e as InternalExecutionError).details).toMatchObject({ code: 'SCHEMA_TYPE_MISMATCH' });
      }
    });

    it('throws SCHEMA_TYPE_MISMATCH when appending wrong type to typed array', () => {
      // tags is string[], appending a number
      expect(() =>
        guardAssignedValue(registry, 'TestBoundary', 'tags', 123, 'append'),
      ).toThrow(InternalExecutionError);
    });

    it('throws SCHEMA_TYPE_MISMATCH when appending wrong type to integer array', () => {
      // scores is integer[], appending a string
      expect(() =>
        guardAssignedValue(registry, 'TestBoundary', 'scores', 'not-int', 'append'),
      ).toThrow(InternalExecutionError);
    });
  });

  // ── guardAssignedValue: unknown boundary / path — silently passes ──────────
  describe('guardAssignedValue — unknown boundary/path silently passes', () => {
    it('unknown boundary returns silently (guardAssignPath handles it)', () => {
      expect(() =>
        guardAssignedValue(registry, 'UnknownBoundary', 'name', 'val'),
      ).not.toThrow();
    });

    it('unknown path returns silently (guardAssignPath handles it)', () => {
      expect(() =>
        guardAssignedValue(registry, 'TestBoundary', 'nonexistent', 'val'),
      ).not.toThrow();
    });
  });

  // ── append mode with array without items schema ────────────────────────────
  describe('guardAssignedValue — append to array without items schema', () => {
    it('appending to array without items schema passes (no items to check)', () => {
      const reg = makeRegistry({
        name: 'E',
        kind: 'object',
        properties: {
          unbounded: { name: 'E.unbounded', kind: 'array' },
        },
      });
      expect(() =>
        guardAssignedValue(reg, 'TestBoundary', 'unbounded', 'anything', 'append'),
      ).not.toThrow();
    });
  });
});
