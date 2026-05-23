import { typeOfJson, isAssignable, validateEntityAgainstSchema } from '../../../src/schema/typeCheck';
import type { ObjectGraphSchema } from '../../../src/schema/types';

describe('schema/typeCheck', () => {
  describe('typeOfJson', () => {
    it('null -> null', () => {
      expect(typeOfJson(null)).toBe('null');
    });

    it('boolean true -> boolean', () => {
      expect(typeOfJson(true)).toBe('boolean');
    });

    it('boolean false -> boolean', () => {
      expect(typeOfJson(false)).toBe('boolean');
    });

    it('integer number -> integer', () => {
      expect(typeOfJson(42)).toBe('integer');
    });

    it('float number -> number', () => {
      expect(typeOfJson(3.14)).toBe('number');
    });

    it('string -> string', () => {
      expect(typeOfJson('hello')).toBe('string');
    });

    it('array -> array', () => {
      expect(typeOfJson([1, 2, 3])).toBe('array');
    });

    it('object -> object', () => {
      expect(typeOfJson({ a: 1 })).toBe('object');
    });

    it('zero is an integer', () => {
      expect(typeOfJson(0)).toBe('integer');
    });
  });

  describe('isAssignable', () => {
    const stringSchema: ObjectGraphSchema = { name: 's', kind: 'string' };
    const numberSchema: ObjectGraphSchema = { name: 'n', kind: 'number' };
    const intSchema: ObjectGraphSchema = { name: 'i', kind: 'integer' };
    const boolSchema: ObjectGraphSchema = { name: 'b', kind: 'boolean' };
    const nullSchema: ObjectGraphSchema = { name: 'null', kind: 'null' };
    const anySchema: ObjectGraphSchema = { name: 'any', kind: 'any' };
    const enumSchema: ObjectGraphSchema = { name: 'e', kind: 'string', enum: ['a', 'b'] };
    const nullableStr: ObjectGraphSchema = { name: 'ns', kind: 'string', nullable: true };

    it('any schema accepts any value', () => {
      expect(isAssignable(null, anySchema)).toBe(true);
      expect(isAssignable('x', anySchema)).toBe(true);
      expect(isAssignable(42, anySchema)).toBe(true);
    });

    it('null is assignable to nullable schema', () => {
      expect(isAssignable(null, nullableStr)).toBe(true);
    });

    it('null is NOT assignable to non-nullable schema', () => {
      expect(isAssignable(null, stringSchema)).toBe(false);
    });

    it('null is assignable to null kind schema', () => {
      expect(isAssignable(null, nullSchema)).toBe(true);
    });

    it('string is assignable to string schema', () => {
      expect(isAssignable('hello', stringSchema)).toBe(true);
    });

    it('number is NOT assignable to string schema', () => {
      expect(isAssignable(42, stringSchema)).toBe(false);
    });

    it('integer is assignable to integer schema', () => {
      expect(isAssignable(1, intSchema)).toBe(true);
    });

    it('float is NOT assignable to integer schema', () => {
      expect(isAssignable(1.5, intSchema)).toBe(false);
    });

    it('integer is assignable to number schema', () => {
      expect(isAssignable(1, numberSchema)).toBe(true);
    });

    it('float is assignable to number schema', () => {
      expect(isAssignable(1.5, numberSchema)).toBe(true);
    });

    it('boolean is assignable to boolean schema', () => {
      expect(isAssignable(true, boolSchema)).toBe(true);
    });

    it('string in enum is assignable', () => {
      expect(isAssignable('a', enumSchema)).toBe(true);
    });

    it('string not in enum is NOT assignable', () => {
      expect(isAssignable('c', enumSchema)).toBe(false);
    });

    it('array is assignable to array schema with items', () => {
      const arrSchema: ObjectGraphSchema = { name: 'arr', kind: 'array', items: stringSchema };
      expect(isAssignable(['x', 'y'], arrSchema)).toBe(true);
    });

    it('array with wrong item type is NOT assignable', () => {
      const arrSchema: ObjectGraphSchema = { name: 'arr', kind: 'array', items: stringSchema };
      expect(isAssignable([1, 2], arrSchema)).toBe(false);
    });

    it('empty array is assignable to array schema', () => {
      const arrSchema: ObjectGraphSchema = { name: 'arr', kind: 'array' };
      expect(isAssignable([], arrSchema)).toBe(true);
    });

    it('object is assignable to object schema', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: { x: numberSchema },
        required: ['x'],
      };
      expect(isAssignable({ x: 1 }, objSchema)).toBe(true);
    });

    it('object missing required field is NOT assignable', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: { x: numberSchema },
        required: ['x'],
      };
      expect(isAssignable({}, objSchema)).toBe(false);
    });

    it('object with extra property (additionalProperties:false) is NOT assignable', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: { x: numberSchema },
        additionalProperties: false,
      };
      expect(isAssignable({ x: 1, extra: 'bad' }, objSchema)).toBe(false);
    });

    it('union: assignable to any member', () => {
      const union: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        union: [stringSchema, numberSchema],
      };
      expect(isAssignable('str', union)).toBe(true);
      expect(isAssignable(42, union)).toBe(true);
    });

    it('union: not assignable when no members match', () => {
      const union: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        union: [stringSchema, numberSchema],
      };
      expect(isAssignable(true, union)).toBe(false);
    });
  });

  describe('validateEntityAgainstSchema', () => {
    it('returns ok: true for valid entity', async () => {
      const schema: ObjectGraphSchema = {
        name: 'Loan',
        kind: 'object',
        properties: { id: { name: 'id', kind: 'string' } },
        required: ['id'],
      };
      const result = await validateEntityAgainstSchema({ id: 'loan-1' }, schema);
      expect(result.ok).toBe(true);
    });

    it('returns ok: false with errors for invalid entity', async () => {
      const schema: ObjectGraphSchema = {
        name: 'Loan',
        kind: 'object',
        properties: { id: { name: 'id', kind: 'string' } },
        required: ['id'],
      };
      const result = await validateEntityAgainstSchema({}, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('reports error path for nested missing field', async () => {
      const schema: ObjectGraphSchema = {
        name: 'Entity',
        kind: 'object',
        properties: { meta: { name: 'meta', kind: 'object', properties: { version: { name: 'version', kind: 'integer' } }, required: ['version'] } },
        required: ['meta'],
      };
      const result = await validateEntityAgainstSchema({ meta: {} }, schema);
      expect(result.ok).toBe(false);
    });
  });
});
