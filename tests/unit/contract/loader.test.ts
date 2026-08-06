import { decycleSchema, loadOpenApi } from '../../../src/contract/loader';

const minimalOpenApiObject = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {
    '/loans': {
      get: {
        operationId: 'listLoans',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
    },
  },
};

const minimalOpenApiJson = JSON.stringify(minimalOpenApiObject);

describe('contract/loader', () => {
  describe('loadOpenApi', () => {
    it('loads from a pre-parsed object', async () => {
      const doc = await loadOpenApi(minimalOpenApiObject);
      expect(doc.paths).toBeDefined();
    });

    it('includes /loans path', async () => {
      const doc = await loadOpenApi(minimalOpenApiObject);
      expect(doc.paths['/loans']).toBeDefined();
    });

    it('extracts get operation from /loans', async () => {
      const doc = await loadOpenApi(minimalOpenApiObject);
      expect(doc.paths['/loans']?.['get']).toBeDefined();
    });

    it('preserves operationId', async () => {
      const doc = await loadOpenApi(minimalOpenApiObject);
      expect(doc.paths['/loans']?.['get']?.operationId).toBe('listLoans');
    });

    it('loads from inline JSON string', async () => {
      const doc = await loadOpenApi(minimalOpenApiJson);
      expect(doc.paths['/loans']).toBeDefined();
    });

    it('returns raw property from loaded doc', async () => {
      const doc = await loadOpenApi(minimalOpenApiObject);
      expect(doc.raw).toBeDefined();
    });

    it('extracts response schemas', async () => {
      const doc = await loadOpenApi(minimalOpenApiObject);
      const op = doc.paths['/loans']?.['get'];
      expect(op?.responseSchemas).toBeDefined();
      expect(op?.responseSchemas?.['200']).toBeDefined();
    });

    it('extracts requestBodySchema for POST', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: {
          '/loans': {
            post: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { amount: { type: 'number' } } },
                  },
                },
              },
              responses: {},
            },
          },
        },
      };
      const doc = await loadOpenApi(spec);
      expect(doc.paths['/loans']?.['post']?.requestBodySchema).toBeDefined();
    });

    it('produces JSON-safe schemas for recursive component references', async () => {
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Recursive schema', version: '1' },
        components: {
          schemas: {
            Node: {
              type: 'object',
              properties: {
                next: { $ref: '#/components/schemas/Node' },
              },
            },
          },
        },
        paths: {
          '/nodes': {
            get: {
              operationId: 'getNode',
              responses: {
                '200': {
                  description: 'A node',
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/Node' },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const schema = doc.paths['/nodes']?.['get']?.responseSchemas?.['200'];
      expect(schema).toMatchObject({ type: 'object', properties: { next: {} } });
      expect(() => JSON.stringify(schema)).not.toThrow();
    });

    it('decycles arbitrary recursive records without retaining object identity', () => {
      const schema: Record<string, unknown> = { type: 'object' };
      schema['self'] = schema;

      expect(decycleSchema(schema)).toEqual({ type: 'object', self: {} });
    });

    it('extracts path parameters', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: {
          '/loans/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {},
            },
          },
        },
      };
      const doc = await loadOpenApi(spec);
      const op = doc.paths['/loans/{id}']?.['get'];
      expect(op?.parameters).toHaveLength(1);
      expect(op?.parameters?.[0]?.name).toBe('id');
    });

    it('loads inline YAML string', async () => {
      const yaml = `
openapi: "3.0.0"
info:
  title: T
  version: "1"
paths:
  /loans:
    get:
      operationId: listLoans
      responses: {}
`;
      const doc = await loadOpenApi(yaml);
      expect(doc.paths['/loans']).toBeDefined();
    });

    it('preserves YAML merge keys when loading inline contracts', async () => {
      const yaml = `
openapi: "3.0.0"
info:
  title: T
  version: "1"
paths:
  /loans:
    get:
      <<: &listLoans
        operationId: listLoans
        responses: {}
`;

      const doc = await loadOpenApi(yaml);

      expect(doc.paths['/loans']?.['get']?.operationId).toBe('listLoans');
    });

    it('preserves implicit timestamp resolution for inline contracts', async () => {
      const yaml = `
openapi: "3.0.0"
info:
  title: T
  version: "1"
x-generated-at: 2026-01-02T03:04:05.000Z
paths: {}
`;

      const doc = await loadOpenApi(yaml);

      expect(doc.source).toMatchObject({ 'x-generated-at': expect.any(Date) });
    });

    it('surfaces duplicate-key errors from inline YAML', async () => {
      const yaml = `
openapi: "3.0.0"
openapi: "3.0.1"
info:
  title: T
  version: "1"
paths: {}
`;

      await expect(loadOpenApi(yaml)).rejects.toThrow(/Map keys must be unique/);
    });
  });
});
