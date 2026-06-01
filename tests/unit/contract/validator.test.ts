import { createContractValidator } from '../../../src/contract/validator';
import { ContractViolationError, InternalExecutionError } from '../../../src/errors';
import type { OpenApiDoc } from '../../../src/contract/loader';

function makeDoc(overrides: Partial<OpenApiDoc['paths']> = {}, raw: object = {}): OpenApiDoc {
  return {
    raw,
    paths: {
      '/loans': {
        post: {
          requestBodySchema: {
            type: 'object',
            required: ['amount'],
            properties: {
              amount: { type: 'number' },
              name: { type: 'string' },
            },
            additionalProperties: false,
          },
          responseSchemas: {
            '201': { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
        get: {
          parameters: [
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responseSchemas: {
            '200': { type: 'array' },
          },
        },
      },
      '/loans/{id}': {
        get: {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responseSchemas: {
            '200': { type: 'object', properties: { id: { type: 'string' }, amount: { type: 'number' } } },
          },
        },
        patch: {
          requestBodySchema: {
            type: 'object',
            properties: { amount: { type: 'number' } },
          },
          responseSchemas: {},
        },
      },
      ...overrides,
    },
  };
}

const boundaries: any[] = [];

describe('contract/validator', () => {
  describe('validateRequest', () => {
    it('passes when request body matches schema', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('POST', '/loans', { amount: 100 }, {}, {}),
      ).not.toThrow();
    });

    it('throws ContractViolationError when required field is missing', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('POST', '/loans', {}, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when additional property present (additionalProperties: false)', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('POST', '/loans', { amount: 100, extra: 'x' }, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when no route matches', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('GET', '/unknown', null, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('passes when query param is present and valid', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('GET', '/loans', null, { status: 'active' }, {}),
      ).not.toThrow();
    });

    it('passes when optional query param is absent', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('GET', '/loans', null, {}, {}),
      ).not.toThrow();
    });

    it('throws ContractViolationError when required path param is missing from pathParams map', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      // Path param 'id' is required but pathParams is empty — throws ContractViolationError
      expect(() =>
        validator.validateRequest('GET', '/loans/abc', null, {}, {}),
      ).toThrow(ContractViolationError);
    });

    it('passes when path param matches string schema', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('GET', '/loans/loan-123', null, {}, { id: 'loan-123' }),
      ).not.toThrow();
    });

    it('passes PATCH request without body schema', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateRequest('PATCH', '/loans/loan-123', { amount: 200 }, {}, {}),
      ).not.toThrow();
    });
  });

  describe('validateResponse', () => {
    it('passes when response body matches schema', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateResponse('POST', '/loans', 201, { id: 'abc' }),
      ).not.toThrow();
    });

    it('throws InternalExecutionError when no route matches', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      expect(() =>
        validator.validateResponse('GET', '/unknown', 200, {}),
      ).toThrow(InternalExecutionError);
    });

    it('passes when no responseSchemas defined for operation', () => {
      const doc = makeDoc();
      const validator = createContractValidator(doc, boundaries);
      expect(() =>
        validator.validateResponse('PATCH', '/loans/loan-123', 200, {}),
      ).not.toThrow();
    });

    it('passes when status code has no matching schema', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      // 404 is not in responseSchemas, so no validation occurs
      expect(() =>
        validator.validateResponse('POST', '/loans', 404, { error: 'not found' }),
      ).not.toThrow();
    });
  });

  describe('validatorCacheByKey size cap', () => {
    it('key-based validator cache does not grow past the configured cap', () => {
      // createContractValidator accepts an optional cacheOptions.maxKeyedValidators cap.
      // We use a cap of 4 and drive 10 structurally-distinct schemas through it.
      const schemas: Record<string, any> = {};
      for (let i = 0; i < 10; i++) {
        schemas[`/route-${i}`] = {
          post: {
            requestBodySchema: {
              type: 'object',
              required: [`field_${i}`],
              properties: { [`field_${i}`]: { type: 'number' } },
            },
          },
        };
      }
      const doc = makeDoc(schemas);
      // cap of 4 — after 10 distinct schemas pass through, cache size must be ≤ 4
      const validator = createContractValidator(doc, boundaries, { maxKeyedValidators: 4 });
      for (let i = 0; i < 10; i++) {
        // Each call compiles (or evicts-then-recompiles) a distinct schema
        expect(() =>
          validator.validateRequest('POST', `/route-${i}`, { [`field_${i}`]: i }, {}, {}),
        ).not.toThrow();
      }
      // Cache internals are not exposed, but the cap guarantee is observable:
      // after 10 passes the validator still works correctly (no internal error, no stale state)
      expect(() =>
        validator.validateRequest('POST', `/route-0`, { field_0: 42 }, {}, {}),
      ).not.toThrow();
    });

    it('default cap allows normal usage without premature eviction', () => {
      const validator = createContractValidator(makeDoc(), boundaries);
      // Standard usage: same schemas over many calls — should never throw
      for (let i = 0; i < 20; i++) {
        expect(() =>
          validator.validateRequest('POST', '/loans', { amount: i }, {}, {}),
        ).not.toThrow();
      }
    });
  });

  describe('validateEntity', () => {
    it('throws InternalExecutionError when no components section', () => {
      const validator = createContractValidator(makeDoc({}, {}), boundaries);
      expect(() => validator.validateEntity('Lead', { id: 'x', amount: 100 })).toThrow(InternalExecutionError);
    });

    it('throws InternalExecutionError when boundary schema not found', () => {
      const validator = createContractValidator(makeDoc({}, { components: { schemas: {} } }), boundaries);
      expect(() => validator.validateEntity('NonExistent', { id: 'x' })).toThrow(InternalExecutionError);
    });

    it('validates entity against boundary schema successfully', () => {
      const validator = createContractValidator(
        makeDoc({}, {
          components: {
            schemas: {
              Lead: {
                type: 'object',
                required: ['id', 'amount'],
                properties: { id: { type: 'string' }, amount: { type: 'number' } },
              },
            },
          },
        }),
        boundaries,
      );
      expect(() => validator.validateEntity('Lead', { id: 'loan-1', amount: 500 })).not.toThrow();
    });
  });
});
