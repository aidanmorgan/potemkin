/**
 * Audit: Contract layer (loader / router / validator) – feature completeness probing tests.
 *
 * Conventions:
 *   it(...)         – correct behaviour confirmed in current src
 *   it.failing(...) – confirmed gap; test asserts the CORRECT behaviour,
 *                     which currently fails because src has the bug.
 */

import { loadOpenApi } from '../../../src/contract/loader';
import { matchRoute } from '../../../src/contract/router';
import { createContractValidator } from '../../../src/contract/validator';
import {
  ContractViolationError,
  InternalExecutionError,
} from '../../../src/errors';
import type { OpenApiDoc } from '../../../src/contract/loader';

// ---------------------------------------------------------------------------
// Helpers / fixture builders
// ---------------------------------------------------------------------------

function makeDoc(paths: Record<string, unknown> = {}): OpenApiDoc {
  return {
    raw: { components: {}, paths },
    paths: paths as OpenApiDoc['paths'],
  };
}

const minimalOpenApiObject = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/items': {
      get: {
        operationId: 'listItems',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createItem',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        operationId: 'deleteItem',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '204': { description: 'No Content' } },
      },
    },
    '/items/active': {
      get: {
        operationId: 'listActiveItems',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe('Contract loader – loadOpenApi', () => {
  it('loads a pre-parsed object', async () => {
    const doc = await loadOpenApi(minimalOpenApiObject);
    expect(doc.paths['/items']).toBeDefined();
    expect(doc.paths['/items']['get']).toBeDefined();
  });

  it('loads an inline JSON string', async () => {
    const doc = await loadOpenApi(JSON.stringify(minimalOpenApiObject));
    expect(doc.paths['/items']).toBeDefined();
  });

  it('loads an inline YAML string', async () => {
    const yamlStr = `
openapi: "3.0.0"
info:
  title: YAML Test
  version: "1.0.0"
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200':
          description: pong
`;
    const doc = await loadOpenApi(yamlStr);
    expect(doc.paths['/ping']).toBeDefined();
  });

  it('preserves vendor extensions in the raw field', async () => {
    const docWithExt = {
      ...minimalOpenApiObject,
      'x-custom-extension': 'preserved',
    };
    const doc = await loadOpenApi(docWithExt);
    expect((doc.raw as Record<string, unknown>)['x-custom-extension']).toBe('preserved');
  });

  it('preserves x-internal on operations in the raw field', async () => {
    const docWithExt = {
      ...minimalOpenApiObject,
      paths: {
        '/ping': {
          get: {
            operationId: 'ping',
            'x-internal': true,
            responses: { '200': { description: 'pong' } },
          },
        },
      },
    };
    const doc = await loadOpenApi(docWithExt);
    const rawPaths = (doc.raw as Record<string, unknown>)['paths'] as Record<string, unknown>;
    const getOp = (rawPaths['/ping'] as Record<string, unknown>)['get'] as Record<string, unknown>;
    expect(getOp['x-internal']).toBe(true);
  });

  // GAP (nice-to-have): loadOpenApi does not accept a Buffer input.
  // The signature is `string | object` and Buffer is object-shaped, but swagger-parser
  // may reject a Buffer as it's not a plain object or a file path.
  it.failing('loads from a Buffer containing JSON', async () => {
    const buf = Buffer.from(JSON.stringify(minimalOpenApiObject));
    // Should parse the buffer as UTF-8 JSON; currently the loader passes Buffer
    // as-is to SwaggerParser.dereference which throws because it's not a plain object.
    const doc = await loadOpenApi(buf as unknown as object);
    expect(doc.paths['/items']).toBeDefined();
  });

  it('dereferences $ref within the document', async () => {
    const docWithRef = {
      openapi: '3.0.0',
      info: { title: 'Ref Test', version: '1.0.0' },
      components: {
        schemas: {
          Item: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
      },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Item' },
                  },
                },
              },
            },
          },
        },
      },
    };
    const doc = await loadOpenApi(docWithRef);
    // After dereference, the $ref should be resolved inline
    const schema = doc.paths['/items']?.['get']?.responseSchemas?.['200'];
    expect(schema).toBeDefined();
    expect(schema?.type).toBe('object');
  });

  it('populates parameters from the loaded document', async () => {
    const doc = await loadOpenApi(minimalOpenApiObject);
    const params = doc.paths['/items/{id}']?.['get']?.parameters;
    expect(params).toBeDefined();
    expect(params?.find((p) => p.name === 'id')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Router tests
// ---------------------------------------------------------------------------

describe('Contract router – matchRoute', () => {
  let doc: OpenApiDoc;

  beforeAll(async () => {
    doc = await loadOpenApi(minimalOpenApiObject);
  });

  it('matches an exact literal path', () => {
    const result = matchRoute(doc, 'GET', '/items');
    expect(result).not.toBeNull();
    expect(result?.contractPath).toBe('/items');
  });

  it('matches a parameterised path and extracts path params', () => {
    const result = matchRoute(doc, 'GET', '/items/abc123');
    expect(result).not.toBeNull();
    expect(result?.pathParams['id']).toBe('abc123');
  });

  it('returns null for an unknown path', () => {
    const result = matchRoute(doc, 'GET', '/unknown');
    expect(result).toBeNull();
  });

  it('returns null for a known path with an unknown method', () => {
    const result = matchRoute(doc, 'PATCH', '/items');
    expect(result).toBeNull();
  });

  it('prefers the specific literal path over the parameterised template (/items/active vs /items/{id})', () => {
    const result = matchRoute(doc, 'GET', '/items/active');
    expect(result?.contractPath).toBe('/items/active');
    expect(result?.pathParams).toEqual({});
  });

  it('accepts method names in uppercase (normalises to lowercase internally)', () => {
    const result = matchRoute(doc, 'POST', '/items');
    expect(result).not.toBeNull();
    expect(result?.operation.operationId).toBe('createItem');
  });

  it('accepts method names in lowercase', () => {
    const result = matchRoute(doc, 'post', '/items');
    expect(result).not.toBeNull();
    expect(result?.operation.operationId).toBe('createItem');
  });

  it('accepts method names in mixed case', () => {
    const result = matchRoute(doc, 'Post', '/items');
    expect(result).not.toBeNull();
  });

  // GAP: Trailing slash sensitivity — GET /items/ should NOT match /items template.
  // The templateToRegex produces ^\/items$ which requires exact match, so /items/ would
  // fail to match. This is correct behaviour but can silently surprise callers.
  it('does NOT match a path with trailing slash against a template without one', () => {
    const result = matchRoute(doc, 'GET', '/items/');
    // /items/ does NOT match /items (no trailing slash in template)
    // and it does NOT match /items/{id} because the empty segment after / would fail [^/]+
    expect(result).toBeNull();
  });

  it('handles URL-encoded characters in path parameter values', () => {
    // %20 is a valid path segment character; [^/]+ should match it
    const result = matchRoute(doc, 'GET', '/items/hello%20world');
    expect(result).not.toBeNull();
    expect(result?.pathParams['id']).toBe('hello%20world');
  });

  it('handles plus sign in path parameter value', () => {
    const result = matchRoute(doc, 'GET', '/items/foo+bar');
    expect(result).not.toBeNull();
    expect(result?.pathParams['id']).toBe('foo+bar');
  });

  // GAP: When two templates have equal staticPrefixLength, the tie-break is
  // Array.prototype.sort which is implementation-defined for equal-key items.
  // The sort is NOT stable-guaranteed across engines for ties.
  // For /items/{id}/name vs /items/{id}/tags both have same static length.
  // This tests whether the result is at least deterministic (same answer each call).
  it('tie on specificity: matchRoute is deterministic across repeated calls', () => {
    const tiedDoc: OpenApiDoc = {
      raw: {},
      paths: {
        '/items/{id}/name': { get: { operationId: 'getName' } },
        '/items/{id}/tags': { get: { operationId: 'getTags' } },
      },
    };
    const r1 = matchRoute(tiedDoc, 'GET', '/items/abc/name');
    const r2 = matchRoute(tiedDoc, 'GET', '/items/abc/name');
    // Both calls should return the same result
    expect(r1?.contractPath).toBe(r2?.contractPath);
  });

  it('query string is NOT part of the path passed to matchRoute (caller strips it)', () => {
    // The router matches against path only; it doesn't parse query strings itself.
    // Callers must strip the query string before calling matchRoute.
    // Passing a path with ?query=1 should fail to match /items.
    const result = matchRoute(doc, 'GET', '/items?limit=10');
    expect(result).toBeNull();
  });

  // GAP (important): The router should ideally strip query strings automatically
  // so that /items?limit=10 still matches /items. Currently it does NOT — this
  // silently returns null instead of matching.
  it.failing('matchRoute strips query string from path before matching', () => {
    const result = matchRoute(doc, 'GET', '/items?limit=10');
    expect(result).not.toBeNull();
    expect(result?.contractPath).toBe('/items');
  });
});

// ---------------------------------------------------------------------------
// Validator tests
// ---------------------------------------------------------------------------

describe('Contract validator – validateRequest', () => {
  let doc: OpenApiDoc;
  let validator: ReturnType<typeof createContractValidator>;

  beforeAll(async () => {
    doc = await loadOpenApi(minimalOpenApiObject);
    validator = createContractValidator(doc, []);
  });

  it('does not throw for a valid request body', () => {
    expect(() =>
      validator.validateRequest('POST', '/items', { name: 'test item' }, {}, {}),
    ).not.toThrow();
  });

  it('throws ContractViolationError for a missing required request body field', () => {
    expect(() =>
      validator.validateRequest('POST', '/items', {}, {}, {}),
    ).toThrow(ContractViolationError);
  });

  it('throws ContractViolationError for an unrecognised route', () => {
    expect(() =>
      validator.validateRequest('GET', '/no-such-path', null, {}, {}),
    ).toThrow(ContractViolationError);
  });

  it('does not throw when optional query param is absent', () => {
    expect(() =>
      validator.validateRequest('GET', '/items', null, {}, {}),
    ).not.toThrow();
  });

  it('validates query param value against schema (integer type)', () => {
    // "abc" is not a valid integer — should throw
    expect(() =>
      validator.validateRequest('GET', '/items', null, { limit: 'abc' }, {}),
    ).toThrow(ContractViolationError);
  });

  it('coerces string "5" to integer for query param validation', () => {
    // "5" coerced to 5 is a valid integer — should NOT throw
    expect(() =>
      validator.validateRequest('GET', '/items', null, { limit: '5' }, {}),
    ).not.toThrow();
  });

  it('validates path param type — string id passes', () => {
    expect(() =>
      validator.validateRequest('GET', '/items/abc', null, {}, { id: 'abc' }),
    ).not.toThrow();
  });

  it('throws ContractViolationError when integer path param receives a non-numeric string', () => {
    // DELETE /items/{id} has id schema type: integer
    expect(() =>
      validator.validateRequest('DELETE', '/items/not-a-number', null, {}, { id: 'not-a-number' }),
    ).toThrow(ContractViolationError);
  });

  it('does not throw when integer path param receives a numeric string (coercion)', () => {
    expect(() =>
      validator.validateRequest('DELETE', '/items/42', null, {}, { id: '42' }),
    ).not.toThrow();
  });

  it('error thrown for path param type mismatch uses status 400', () => {
    try {
      validator.validateRequest('DELETE', '/items/not-a-number', null, {}, { id: 'not-a-number' });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractViolationError);
      expect((e as ContractViolationError).status).toBe(400);
    }
  });
});

describe('Contract validator – validateResponse', () => {
  let doc: OpenApiDoc;
  let validator: ReturnType<typeof createContractValidator>;

  beforeAll(async () => {
    doc = await loadOpenApi(minimalOpenApiObject);
    validator = createContractValidator(doc, []);
  });

  it('does not throw for a valid response body matching the schema', () => {
    expect(() =>
      validator.validateResponse('GET', '/items', 200, { id: 'abc' }),
    ).not.toThrow();
  });

  it('throws InternalExecutionError for a response body that violates the schema', () => {
    // GET /items 200 schema requires { id: string } — missing id should fail
    expect(() =>
      validator.validateResponse('GET', '/items', 200, { wrong: 'field' }),
    ).toThrow(InternalExecutionError);
  });

  it('does not throw when response schema is absent for the given status', () => {
    // POST /items 201 has no content schema in the fixture
    expect(() =>
      validator.validateResponse('POST', '/items', 201, { anything: true }),
    ).not.toThrow();
  });

  it('throws InternalExecutionError for unmatched route during response validation', () => {
    expect(() =>
      validator.validateResponse('GET', '/no-route', 200, {}),
    ).toThrow(InternalExecutionError);
  });

  it('falls back to "default" schema key when exact status not found', async () => {
    const docWithDefault = await loadOpenApi({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            responses: {
              default: {
                description: 'default',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
                  },
                },
              },
            },
          },
        },
      },
    });
    const v = createContractValidator(docWithDefault, []);
    // Missing required 'msg' field → should throw
    expect(() => v.validateResponse('GET', '/test', 404, { other: 1 })).toThrow(InternalExecutionError);
    // Valid body → should not throw
    expect(() => v.validateResponse('GET', '/test', 404, { msg: 'hello' })).not.toThrow();
  });
});

describe('Contract validator – validateEntity', () => {
  it('throws InternalExecutionError when components section is absent', () => {
    const doc: OpenApiDoc = { raw: {}, paths: {} };
    const v = createContractValidator(doc, []);
    expect(() => v.validateEntity('MyBoundary', { field: 'value' })).toThrow(InternalExecutionError);
  });

  it('throws InternalExecutionError when components.schemas is absent', () => {
    const doc: OpenApiDoc = { raw: { components: {} }, paths: {} };
    const v = createContractValidator(doc, []);
    expect(() => v.validateEntity('MyBoundary', { field: 'value' })).toThrow(InternalExecutionError);
  });

  it('throws InternalExecutionError when schema for boundary is absent', () => {
    const doc: OpenApiDoc = {
      raw: { components: { schemas: {} } },
      paths: {},
    };
    const v = createContractValidator(doc, []);
    expect(() => v.validateEntity('MyBoundary', { field: 'value' })).toThrow(InternalExecutionError);
  });

  it('validates entity against the boundary schema (pass case)', () => {
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            LoanAccount: {
              type: 'object',
              properties: { id: { type: 'string' }, status: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      },
      paths: {},
    };
    const v = createContractValidator(doc, []);
    expect(() => v.validateEntity('LoanAccount', { id: 'abc', status: 'active' })).not.toThrow();
  });

  it('throws InternalExecutionError when entity violates the boundary schema', () => {
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            LoanAccount: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      },
      paths: {},
    };
    const v = createContractValidator(doc, []);
    // Missing required 'id' field
    expect(() => v.validateEntity('LoanAccount', { status: 'active' })).toThrow(InternalExecutionError);
  });

  // GAP (important): The schema lookup in validateEntity is case-sensitive.
  // If boundary name is "loanAccount" but schema key is "LoanAccount", it throws
  // even if the schema exists under a different casing.
  it('schema lookup for validateEntity is case-sensitive', () => {
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            LoanAccount: {
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        },
      },
      paths: {},
    };
    const v = createContractValidator(doc, []);
    // 'loanaccount' (wrong case) should throw because lookup is case-sensitive
    expect(() => v.validateEntity('loanaccount', { id: 'x' })).toThrow(InternalExecutionError);
  });

  // GAP (nice-to-have): There is no case-insensitive fallback for schema lookup.
  it.failing('validateEntity performs case-insensitive schema name lookup', () => {
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            LoanAccount: {
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        },
      },
      paths: {},
    };
    const v = createContractValidator(doc, []);
    // Should succeed even with wrong-cased boundary name
    expect(() => v.validateEntity('loanaccount', { id: 'x' })).not.toThrow();
  });
});

describe('Contract validator – Ajv caching', () => {
  it('caches compiled validators across repeated validateRequest calls (no re-compilation)', async () => {
    const doc = await loadOpenApi(minimalOpenApiObject);
    const v = createContractValidator(doc, []);

    // Repeated calls — if caching is working, no recompilation occurs.
    // We can only observe that it doesn't throw or degrade (no direct cache inspection).
    for (let i = 0; i < 5; i++) {
      expect(() =>
        v.validateRequest('POST', '/items', { name: 'x' }, {}, {}),
      ).not.toThrow();
    }
  });

  it('caches compiled validators across repeated validateResponse calls', async () => {
    const doc = await loadOpenApi(minimalOpenApiObject);
    const v = createContractValidator(doc, []);

    for (let i = 0; i < 5; i++) {
      expect(() =>
        v.validateResponse('GET', '/items', 200, { id: 'abc' }),
      ).not.toThrow();
    }
  });
});

describe('Contract validator – required query parameter enforcement', () => {
  it('throws ContractViolationError when a required query param is missing', async () => {
    const docWithRequired = await loadOpenApi({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            parameters: [
              { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    const v = createContractValidator(docWithRequired, []);
    expect(() =>
      v.validateRequest('GET', '/search', null, {}, {}),
    ).toThrow(ContractViolationError);
  });

  it('does not throw when a required query param is present', async () => {
    const docWithRequired = await loadOpenApi({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            parameters: [
              { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    const v = createContractValidator(docWithRequired, []);
    expect(() =>
      v.validateRequest('GET', '/search', null, { q: 'hello' }, {}),
    ).not.toThrow();
  });
});
