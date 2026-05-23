import { loadOpenApi } from '../../../src/contract/loader';

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

    it('extracts path parameters', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: {
          '/loans/{id}': {
            get: {
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              ],
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
  });
});
