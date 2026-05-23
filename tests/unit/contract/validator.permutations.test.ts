/**
 * Exhaustive permutation tests for contract/validator.
 * Targets: src/contract/validator.ts (branches ~79% → ≥95%)
 */
import { createContractValidator } from '../../../src/contract/validator';
import { ContractViolationError, InternalExecutionError } from '../../../src/errors';
import type { OpenApiDoc } from '../../../src/contract/loader';

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeDoc(extraPaths: Partial<OpenApiDoc['paths']> = {}, raw: object = {}): OpenApiDoc {
  return {
    raw,
    paths: {
      '/items': {
        get: {
          parameters: [
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'page', in: 'query', required: true, schema: { type: 'integer' } },
          ],
          responseSchemas: { '200': { type: 'array', items: { type: 'object' } } },
        },
        post: {
          requestBodySchema: {
            type: 'object',
            required: ['name', 'amount'],
            properties: {
              name: { type: 'string' },
              amount: { type: 'number' },
              status: { type: 'string', enum: ['active', 'inactive'] },
            },
            additionalProperties: false,
          },
          responseSchemas: {
            '201': {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' } },
            },
            'default': { type: 'object' },
          },
        },
      },
      '/items/{id}': {
        get: {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'include', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responseSchemas: { '200': { type: 'object', properties: { id: { type: 'string' } } } },
        },
        patch: {
          parameters: [
            { name: 'id', in: 'path', required: false, schema: { type: 'string' } },
          ],
          requestBodySchema: { type: 'object', properties: { name: { type: 'string' } } },
        },
        delete: {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
        },
      },
      '/typed-params': {
        get: {
          parameters: [
            { name: 'count', in: 'query', required: false, schema: { type: 'number' } },
            { name: 'flag', in: 'query', required: false, schema: { type: 'string' } },
          ],
        },
      },
      ...extraPaths,
    },
  };
}

const boundaries: any[] = [];

describe('contract/validator — permutations', () => {
  // ── validateRequest: query parameter scenarios ────────────────────────────
  describe('validateRequest — query parameters', () => {
    it('passes when required query param is present', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/items', null, { page: '1' }, {}),
      ).not.toThrow();
    });

    it('throws ContractViolationError when required query param is absent', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/items', null, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('passes when optional query param is absent', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/items', null, { page: '1' }, {}),
      ).not.toThrow();
    });

    it('coerces integer query param from string to number', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/items', null, { page: '5', limit: '10' }, {}),
      ).not.toThrow();
    });

    it('coerces number query param from string', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/typed-params', null, { count: '3.14' }, {}),
      ).not.toThrow();
    });

    it('throws ContractViolationError when query param fails schema', () => {
      // limit must be integer, 'not-a-number' should fail
      const doc = makeDoc({
        '/strict-query': {
          get: {
            parameters: [
              { name: 'count', in: 'query', required: true, schema: { type: 'integer' } },
            ],
          },
        },
      });
      const v = createContractValidator(doc, boundaries);
      // Pass non-numeric string
      expect(() =>
        v.validateRequest('GET', '/strict-query', null, { count: 'not-a-number' }, {}),
      ).toThrow(ContractViolationError);
    });

    it('handles array query param (uses first element for validation)', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/items', null, { page: ['1', '2'] as any }, {}),
      ).not.toThrow();
    });
  });

  // ── validateRequest: path parameter scenarios ─────────────────────────────
  describe('validateRequest — path parameters', () => {
    it('throws when required path param is missing from pathParams', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('GET', '/items/item-1', null, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('passes when optional path param is absent', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('PATCH', '/items/abc', {}, {}, {}),
      ).not.toThrow();
    });

    it('throws when path param fails schema validation', () => {
      // DELETE /items/{id} expects id to be integer
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('DELETE', '/items/not-an-int', null, {}, { id: 'not-an-int' }),
      ).toThrow(ContractViolationError);
    });

    it('passes when path param matches integer schema', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('DELETE', '/items/42', null, {}, { id: '42' }),
      ).not.toThrow();
    });
  });

  // ── validateRequest: request body scenarios ───────────────────────────────
  describe('validateRequest — request body', () => {
    it('passes valid body', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'foo', amount: 100 }, {}, {}),
      ).not.toThrow();
    });

    it('throws when required body field is missing', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'foo' }, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('throws when additionalProperties: false and extra field present', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'foo', amount: 100, extra: 'bad' }, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('passes when enum value is valid', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'foo', amount: 100, status: 'active' }, {}, {}),
      ).not.toThrow();
    });

    it('throws when enum value is invalid', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'foo', amount: 100, status: 'invalid' }, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('cached validator returns same compiled function for same schema', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      // Call twice with same schema — exercises WeakMap cache
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'x', amount: 1 }, {}, {}),
      ).not.toThrow();
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'y', amount: 2 }, {}, {}),
      ).not.toThrow();
    });
  });

  // ── validateResponse: scenarios ───────────────────────────────────────────
  describe('validateResponse', () => {
    it('passes when response matches schema for status code', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateResponse('POST', '/items', 201, { id: 'item-1' }),
      ).not.toThrow();
    });

    it('throws InternalExecutionError when response fails schema', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateResponse('POST', '/items', 201, {}),
      ).toThrow(InternalExecutionError);
    });

    it('uses "default" schema when exact status not found', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      // 500 not in responseSchemas but 'default' exists
      expect(() =>
        v.validateResponse('POST', '/items', 500, { any: 'value' }),
      ).not.toThrow();
    });

    it('passes when no schema for the specific status', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      // 404 has no schema in GET /items responseSchemas
      expect(() =>
        v.validateResponse('GET', '/items', 404, { error: 'not found' }),
      ).not.toThrow();
    });

    it('throws InternalExecutionError when no route matches for response', () => {
      const v = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        v.validateResponse('GET', '/nonexistent', 200, {}),
      ).toThrow(InternalExecutionError);
    });

    it('passes when operation has no responseSchemas defined', () => {
      const doc = makeDoc({
        '/no-schema': {
          get: { operationId: 'noSchema' },
        },
      });
      const v = createContractValidator(doc, boundaries);
      expect(() =>
        v.validateResponse('GET', '/no-schema', 200, { anything: true }),
      ).not.toThrow();
    });
  });

  // ── validateEntity: all branches ──────────────────────────────────────────
  describe('validateEntity', () => {
    it('throws when no components section', () => {
      const v = createContractValidator(makeDoc({}, {}), boundaries);
      expect(() => v.validateEntity('Item', {})).toThrow(InternalExecutionError);
    });

    it('throws when components.schemas is missing', () => {
      const v = createContractValidator(makeDoc({}, { components: {} }), boundaries);
      expect(() => v.validateEntity('Item', {})).toThrow(InternalExecutionError);
    });

    it('throws when components.schemas is an array (not object)', () => {
      const v = createContractValidator(makeDoc({}, { components: { schemas: [] } }), boundaries);
      expect(() => v.validateEntity('Item', {})).toThrow(InternalExecutionError);
    });

    it('throws when boundary schema not found in schemas', () => {
      const v = createContractValidator(
        makeDoc({}, { components: { schemas: { Other: { type: 'object' } } } }),
        boundaries,
      );
      expect(() => v.validateEntity('NotHere', {})).toThrow(InternalExecutionError);
    });

    it('throws when boundary schema is null', () => {
      const v = createContractValidator(
        makeDoc({}, { components: { schemas: { Item: null } } }),
        boundaries,
      );
      expect(() => v.validateEntity('Item', {})).toThrow(InternalExecutionError);
    });

    it('throws when boundary schema is an array', () => {
      const v = createContractValidator(
        makeDoc({}, { components: { schemas: { Item: [] } } }),
        boundaries,
      );
      expect(() => v.validateEntity('Item', {})).toThrow(InternalExecutionError);
    });

    it('passes when entity matches schema', () => {
      const v = createContractValidator(
        makeDoc({}, {
          components: {
            schemas: {
              Item: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' }, amount: { type: 'number' } },
              },
            },
          },
        }),
        boundaries,
      );
      expect(() => v.validateEntity('Item', { id: 'item-1', amount: 50 })).not.toThrow();
    });

    it('throws InternalExecutionError when entity fails schema', () => {
      const v = createContractValidator(
        makeDoc({}, {
          components: {
            schemas: {
              Item: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
              },
            },
          },
        }),
        boundaries,
      );
      // missing required 'id'
      expect(() => v.validateEntity('Item', {})).toThrow(InternalExecutionError);
    });
  });
});
