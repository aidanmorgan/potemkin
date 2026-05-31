import { guardAssignPath, guardAssignedValue } from '../../../src/schema/runtimeGuard';
import { InternalExecutionError } from '../../../src/errors';
import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from '../../../src/schema/types';

const stringSchema: ObjectGraphSchema = { name: 'status', kind: 'string' };
const entitySchema: ObjectGraphSchema = {
  name: 'Loan',
  kind: 'object',
  properties: {
    id: { name: 'id', kind: 'string' },
    amount: { name: 'amount', kind: 'number' },
    status: stringSchema,
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

describe('schema/runtimeGuard', () => {
  describe('guardAssignPath', () => {
    it('does not throw for valid path', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() => guardAssignPath(registry, 'Loan', 'status')).not.toThrow();
    });

    it('throws InternalExecutionError for unknown path', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() =>
        guardAssignPath(registry, 'Loan', 'nonexistent'),
      ).toThrow(InternalExecutionError);
    });

    it('error has code SCHEMA_PATH_UNKNOWN', () => {
      const registry = makeRegistry('Loan', entitySchema);
      try {
        guardAssignPath(registry, 'Loan', 'bogus');
        fail('should have thrown InternalExecutionError');
      } catch (e) {
        expect((e as InternalExecutionError).details).toMatchObject({ code: 'SCHEMA_PATH_UNKNOWN' });
      }
    });

    it('throws InternalExecutionError when boundary is unknown', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() =>
        guardAssignPath(registry, 'Unknown', 'status'),
      ).toThrow(InternalExecutionError);
    });

    it('does not throw for nested valid path', () => {
      const nestedSchema: ObjectGraphSchema = {
        name: 'Entity',
        kind: 'object',
        properties: {
          meta: {
            name: 'meta',
            kind: 'object',
            properties: { version: { name: 'version', kind: 'integer' } },
          },
        },
      };
      const registry = makeRegistry('Entity', nestedSchema);
      expect(() => guardAssignPath(registry, 'Entity', 'meta.version')).not.toThrow();
    });
  });

  describe('guardAssignedValue', () => {
    it('does not throw for valid assignment', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() =>
        guardAssignedValue(registry, 'Loan', 'status', 'active'),
      ).not.toThrow();
    });

    it('throws InternalExecutionError for type mismatch', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() =>
        guardAssignedValue(registry, 'Loan', 'amount', 'not-a-number'),
      ).toThrow(InternalExecutionError);
    });

    it('error has code SCHEMA_TYPE_MISMATCH', () => {
      const registry = makeRegistry('Loan', entitySchema);
      try {
        guardAssignedValue(registry, 'Loan', 'amount', 'not-a-number');
        fail('should have thrown InternalExecutionError');
      } catch (e) {
        expect((e as InternalExecutionError).details).toMatchObject({ code: 'SCHEMA_TYPE_MISMATCH' });
      }
    });

    it('silently returns when boundary is unknown', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() =>
        guardAssignedValue(registry, 'UnknownBoundary', 'status', 'active'),
      ).not.toThrow();
    });

    it('silently returns when path is unknown (let guardAssignPath handle it)', () => {
      const registry = makeRegistry('Loan', entitySchema);
      expect(() =>
        guardAssignedValue(registry, 'Loan', 'unknownPath', 'value'),
      ).not.toThrow();
    });

    it('does not throw when assigning null to nullable field', () => {
      const schema: ObjectGraphSchema = {
        name: 'E',
        kind: 'object',
        properties: {
          note: { name: 'note', kind: 'string', nullable: true },
        },
      };
      const registry = makeRegistry('E', schema);
      expect(() => guardAssignedValue(registry, 'E', 'note', null)).not.toThrow();
    });
  });
});
