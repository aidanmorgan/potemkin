/**
 * Additional branch coverage for schema/typeCheck.ts
 *
 * The existing typeCheck.test.ts covers isAssignable well.
 * This file targets the internal validateNode function (exercised via
 * validateEntityAgainstSchema) and the remaining isAssignable branches.
 */

import { isAssignable, validateEntityAgainstSchema } from '../../../src/schema/typeCheck';
import type { ObjectGraphSchema } from '../../../src/schema/types';

const strSchema: ObjectGraphSchema = { name: 's', kind: 'string' };
const intSchema: ObjectGraphSchema = { name: 'i', kind: 'integer' };
const numSchema: ObjectGraphSchema = { name: 'n', kind: 'number' };
const boolSchema: ObjectGraphSchema = { name: 'b', kind: 'boolean' };
const nullSchema: ObjectGraphSchema = { name: 'null', kind: 'null' };

describe('schema/typeCheck — additional branch coverage', () => {
  // ── isAssignable edge cases ─────────────────────────────────────────────────

  describe('isAssignable – null kind', () => {
    it('non-null value is NOT assignable to null schema', () => {
      expect(isAssignable('hello', nullSchema)).toBe(false);
    });
  });

  describe('isAssignable – boolean kind mismatch', () => {
    it('number is NOT assignable to boolean schema', () => {
      expect(isAssignable(1, boolSchema)).toBe(false);
    });
  });

  describe('isAssignable – array without items', () => {
    it('any array is assignable to arraySchema without items', () => {
      const arrSchema: ObjectGraphSchema = { name: 'arr', kind: 'array' };
      expect(isAssignable([1, 'two', null], arrSchema)).toBe(true);
    });

    it('non-array is NOT assignable to array schema', () => {
      const arrSchema: ObjectGraphSchema = { name: 'arr', kind: 'array' };
      expect(isAssignable('string', arrSchema)).toBe(false);
    });
  });

  describe('isAssignable – object with additionalProperties: true', () => {
    it('extra keys are allowed when additionalProperties:true', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: { x: numSchema },
        additionalProperties: true,
      };
      expect(isAssignable({ x: 1, extra: 'allowed' }, objSchema)).toBe(true);
    });
  });

  describe('isAssignable – object with additionalProperties as schema', () => {
    it('extra property that matches addlProps schema is assignable', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: {},
        additionalProperties: strSchema,
      };
      expect(isAssignable({ extra: 'ok' }, objSchema)).toBe(true);
    });

    it('extra property that does NOT match addlProps schema is not assignable', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: {},
        additionalProperties: intSchema,
      };
      expect(isAssignable({ extra: 'not-int' }, objSchema)).toBe(false);
    });
  });

  describe('isAssignable – object value is array (not plain object)', () => {
    it('array is NOT assignable to object schema', () => {
      const objSchema: ObjectGraphSchema = {
        name: 'obj',
        kind: 'object',
        properties: {},
      };
      expect(isAssignable([], objSchema)).toBe(false);
    });
  });

  describe('isAssignable – union with empty union list', () => {
    it('no members → always false', () => {
      const emptyUnion: ObjectGraphSchema = { name: 'u', kind: 'union', union: [] };
      expect(isAssignable('x', emptyUnion)).toBe(false);
    });
  });

  describe('isAssignable – integer schema with float value', () => {
    it('float is NOT assignable to integer schema', () => {
      expect(isAssignable(1.1, intSchema)).toBe(false);
    });
  });

  describe('isAssignable – number schema with string', () => {
    it('string is NOT assignable to number schema', () => {
      expect(isAssignable('3.14', numSchema)).toBe(false);
    });
  });

  describe('isAssignable – unknown kind falls through to false', () => {
    it('an unsupported kind returns false', () => {
      const badSchema = { name: 'bad', kind: 'unsupported' as 'string' };
      expect(isAssignable('value', badSchema as ObjectGraphSchema)).toBe(false);
    });
  });

  // ── validateEntityAgainstSchema ─────────────────────────────────────────────
  // These exercise validateNode internal branches

  describe('validateEntityAgainstSchema – null handling', () => {
    it('null value against nullable schema → ok', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { field: { name: 'field', kind: 'string', nullable: true } },
      };
      const result = await validateEntityAgainstSchema({ field: null }, schema);
      expect(result.ok).toBe(true);
    });

    it('null value against non-nullable schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { field: { name: 'field', kind: 'string', nullable: false } },
      };
      const result = await validateEntityAgainstSchema({ field: null }, schema);
      expect(result.ok).toBe(false);
    });

    it('null value against null-kind schema → no error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { field: nullSchema },
      };
      const result = await validateEntityAgainstSchema({ field: null }, schema);
      expect(result.ok).toBe(true);
    });
  });

  describe('validateEntityAgainstSchema – kind: null', () => {
    it('non-null value against null-kind property → error with "expected null"', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { field: nullSchema },
      };
      const result = await validateEntityAgainstSchema({ field: 'not-null' }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected null/);
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: boolean', () => {
    it('wrong type against boolean schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { flag: boolSchema },
      };
      const result = await validateEntityAgainstSchema({ flag: 'yes' }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected boolean/);
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: integer', () => {
    it('float value against integer schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { count: intSchema },
      };
      const result = await validateEntityAgainstSchema({ count: 1.5 }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected integer/);
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: number', () => {
    it('string value against number schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { amount: numSchema },
      };
      const result = await validateEntityAgainstSchema({ amount: 'not-a-number' }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected number/);
      }
    });

    it('integer value against number schema → ok', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { amount: numSchema },
      };
      const result = await validateEntityAgainstSchema({ amount: 42 }, schema);
      expect(result.ok).toBe(true);
    });
  });

  describe('validateEntityAgainstSchema – kind: string', () => {
    it('non-string value against string schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { name: strSchema },
      };
      const result = await validateEntityAgainstSchema({ name: 123 }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected string/);
      }
    });

    it('string not in enum → error with value quoted', async () => {
      const enumSchema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          status: { name: 'status', kind: 'string', enum: ['OPEN', 'CLOSED'] },
        },
      };
      const result = await validateEntityAgainstSchema({ status: 'UNKNOWN' }, enumSchema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/not in enum/);
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: array', () => {
    it('non-array against array schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          tags: { name: 'tags', kind: 'array', items: strSchema },
        },
      };
      const result = await validateEntityAgainstSchema({ tags: 'not-array' }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected array/);
      }
    });

    it('array with wrong item type → error with index path', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          tags: { name: 'tags', kind: 'array', items: strSchema },
        },
      };
      const result = await validateEntityAgainstSchema({ tags: [1, 2] }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.path).toMatch(/\[0\]/);
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: object', () => {
    it('array value against object schema → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          meta: { name: 'meta', kind: 'object', properties: {} },
        },
      };
      const result = await validateEntityAgainstSchema({ meta: [1, 2] }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/expected object/);
      }
    });

    it('extra property when additionalProperties: false → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { x: numSchema },
        additionalProperties: false,
      };
      const result = await validateEntityAgainstSchema({ x: 1, y: 2 }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/additional property not allowed/);
      }
    });

    it('extra property when additionalProperties is object schema → validates against it', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {},
        additionalProperties: intSchema,
      };
      // int value is fine
      const ok = await validateEntityAgainstSchema({ extra: 5 }, schema);
      expect(ok.ok).toBe(true);
      // string value is not
      const fail = await validateEntityAgainstSchema({ extra: 'str' }, schema);
      expect(fail.ok).toBe(false);
    });

    it('extra property when additionalProperties: true → allowed', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {},
        additionalProperties: true,
      };
      const result = await validateEntityAgainstSchema({ anything: 'goes' }, schema);
      expect(result.ok).toBe(true);
    });

    it('required field missing at root level → path is the field name', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: { id: strSchema },
        required: ['id'],
      };
      const result = await validateEntityAgainstSchema({}, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.path).toBe('id');
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: union', () => {
    it('value matching a union member → ok', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          val: { name: 'val', kind: 'union', union: [strSchema, intSchema] },
        },
      };
      const result = await validateEntityAgainstSchema({ val: 'hello' }, schema);
      expect(result.ok).toBe(true);
    });

    it('value not matching any union member → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          val: { name: 'val', kind: 'union', union: [strSchema, intSchema] },
        },
      };
      const result = await validateEntityAgainstSchema({ val: true }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/union member/);
      }
    });
  });

  describe('validateEntityAgainstSchema – kind: any', () => {
    it('any kind never produces errors regardless of value', async () => {
      const schema: ObjectGraphSchema = { name: 'root', kind: 'any' };
      const result = await validateEntityAgainstSchema({}, schema);
      expect(result.ok).toBe(true);
    });
  });

  // ── oneOf semantics (potemkin-6dqk) ──────────────────────────────────────────

  describe('isAssignable – oneOf: exactly one member must match', () => {
    const strSchema: ObjectGraphSchema = { name: 's', kind: 'string' };
    const intSchema: ObjectGraphSchema = { name: 'i', kind: 'integer' };
    const numSchema: ObjectGraphSchema = { name: 'n', kind: 'number' };

    it('value matching exactly one oneOf member → assignable', () => {
      const schema: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        unionVariant: 'oneOf',
        union: [strSchema, intSchema],
      };
      expect(isAssignable('hello', schema)).toBe(true);
    });

    it('value matching two oneOf members → not assignable (integer satisfies both integer and number)', () => {
      const schema: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        unionVariant: 'oneOf',
        union: [intSchema, numSchema],
      };
      expect(isAssignable(5, schema)).toBe(false);
    });

    it('value matching no oneOf member → not assignable', () => {
      const schema: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        unionVariant: 'oneOf',
        union: [strSchema, intSchema],
      };
      expect(isAssignable(true, schema)).toBe(false);
    });

    it('anyOf: value matching two members → assignable (>=1 semantics)', () => {
      const schema: ObjectGraphSchema = {
        name: 'u',
        kind: 'union',
        unionVariant: 'anyOf',
        union: [intSchema, numSchema],
      };
      expect(isAssignable(5, schema)).toBe(true);
    });
  });

  describe('validateEntityAgainstSchema – oneOf semantics', () => {
    const strSchema: ObjectGraphSchema = { name: 's', kind: 'string' };
    const intSchema: ObjectGraphSchema = { name: 'i', kind: 'integer' };
    const numSchema: ObjectGraphSchema = { name: 'n', kind: 'number' };

    it('value matching exactly one oneOf member → ok', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          val: { name: 'val', kind: 'union', unionVariant: 'oneOf', union: [strSchema, intSchema] },
        },
      };
      const result = await validateEntityAgainstSchema({ val: 'hello' }, schema);
      expect(result.ok).toBe(true);
    });

    it('value matching two oneOf members → error mentions count', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          val: { name: 'val', kind: 'union', unionVariant: 'oneOf', union: [intSchema, numSchema] },
        },
      };
      const result = await validateEntityAgainstSchema({ val: 5 }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/oneOf member/);
      }
    });

    it('value matching zero oneOf members → error', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          val: { name: 'val', kind: 'union', unionVariant: 'oneOf', union: [strSchema, intSchema] },
        },
      };
      const result = await validateEntityAgainstSchema({ val: true }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/oneOf member/);
      }
    });
  });

  // ── pattern ReDoS guard (potemkin-tgta) ──────────────────────────────────────

  describe('isAssignable – pattern ReDoS guard', () => {
    it('safe pattern passes through and matches correctly', () => {
      const schema: ObjectGraphSchema = {
        name: 's',
        kind: 'string',
        pattern: '^[a-z]+$',
      };
      expect(isAssignable('abc', schema)).toBe(true);
      expect(isAssignable('ABC', schema)).toBe(false);
    });

    it('adversarial nested-quantifier pattern is rejected with SCHEMA_PATTERN_REJECTED', () => {
      const schema: ObjectGraphSchema = {
        name: 's',
        kind: 'string',
        pattern: '(a+)+',
      };
      expect(() => isAssignable('aaa', schema)).toThrow(/SCHEMA_PATTERN_REJECTED/);
    });

    it('adversarial overlapping-alternation pattern is rejected', () => {
      const schema: ObjectGraphSchema = {
        name: 's',
        kind: 'string',
        pattern: '(a|a)+',
      };
      expect(() => isAssignable('aaa', schema)).toThrow(/SCHEMA_PATTERN_REJECTED/);
    });
  });

  describe('validateEntityAgainstSchema – pattern ReDoS guard', () => {
    it('adversarial pattern in schema property throws before running the regex', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          code: { name: 'code', kind: 'string', pattern: '(a+)+' },
        },
      };
      await expect(validateEntityAgainstSchema({ code: 'aaa' }, schema)).rejects.toThrow(
        /SCHEMA_PATTERN_REJECTED/,
      );
    });

    it('safe pattern on validateEntityAgainstSchema → ok when matching', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          code: { name: 'code', kind: 'string', pattern: '^[A-Z]{3}$' },
        },
      };
      const result = await validateEntityAgainstSchema({ code: 'ABC' }, schema);
      expect(result.ok).toBe(true);
    });

    it('safe pattern on validateEntityAgainstSchema → error when not matching', async () => {
      const schema: ObjectGraphSchema = {
        name: 'root',
        kind: 'object',
        properties: {
          code: { name: 'code', kind: 'string', pattern: '^[A-Z]{3}$' },
        },
      };
      const result = await validateEntityAgainstSchema({ code: 'abc' }, schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/does not match pattern/);
      }
    });
  });
});
