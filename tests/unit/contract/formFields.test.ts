import { buildFormFieldOperations } from '../../../src/contract/formFields';
import type { OpenApiDoc } from '../../../src/contract/loader';

function doc(raw: unknown): OpenApiDoc {
  return { raw, paths: {} } as OpenApiDoc;
}

describe('buildFormFieldOperations', () => {
  it('collects coercible form fields per operation from the resolved OpenAPI', () => {
    const ops = buildFormFieldOperations(doc({
      paths: {
        '/v1/customers': {
          post: {
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: { type: 'string' },
                      balance: { type: 'integer' },
                      livemode: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }));

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      method: 'POST',
      pathPattern: '/v1/customers',
      // string fields are omitted — only coercible types are published
      fields: { balance: 'integer', livemode: 'boolean' },
    });
  });

  it('ignores operations with no form body and operations with only string fields', () => {
    const ops = buildFormFieldOperations(doc({
      paths: {
        '/json-only': {
          post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } },
        },
        '/strings-only': {
          post: {
            requestBody: {
              content: { 'application/x-www-form-urlencoded': { schema: { properties: { name: { type: 'string' } } } } },
            },
          },
        },
      },
    }));
    expect(ops).toHaveLength(0);
  });

  it('returns an empty list when there are no paths', () => {
    expect(buildFormFieldOperations(doc({}))).toEqual([]);
    expect(buildFormFieldOperations(doc(null))).toEqual([]);
  });
});
