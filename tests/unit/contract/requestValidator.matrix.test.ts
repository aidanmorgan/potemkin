import Ajv from 'ajv';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { createRequestValidator } from '../../../src/contract/requestValidator.js';
import { createNoopLogger } from '../../../src/observability/logger.js';
import type { JsonValue } from '../../../src/contracts/value.js';

describe('request validator transport modes', () => {
  it('validates typed path/query/header parameters and form coercion', async () => {
    const doc = await loadOpenApi({
      openapi: '3.0.3',
      info: { title: 'request validator', version: '1' },
      paths: {
        '/forms/{id}': {
          post: {
            operationId: 'submitForm',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
              { name: 'page', in: 'query', required: true, schema: { type: 'integer' } },
              { name: 'If-Match', in: 'header', required: true, schema: { type: 'integer' } },
              { name: 'optional', in: 'query', required: false },
            ],
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    required: ['active', 'count', 'nested', 'entries'],
                    properties: {
                      active: { type: 'boolean' },
                      count: { type: 'integer' },
                      nested: { type: 'object', properties: { score: { type: 'number' } } },
                      entries: {
                        type: 'array',
                        items: { type: 'object', properties: { enabled: { type: 'boolean' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const ajv = new Ajv({ strict: false });
    const validator = createRequestValidator({
      doc,
      getValidator: (schema) => ajv.compile(schema),
      logger: createNoopLogger(),
    });
    const payload: JsonValue = {
      active: 'true',
      count: '3',
      nested: { score: '2.5' },
      entries: [{ enabled: 'false' }],
    };

    validator.validateRequest(
      'POST',
      '/forms/7',
      payload,
      { page: '2' },
      { id: '7' },
      { 'content-type': 'application/x-www-form-urlencoded', 'if-match': 'W/"5"' },
    );
    expect(payload).toEqual({
      active: true,
      count: 3,
      nested: { score: 2.5 },
      entries: [{ enabled: false }],
    });

    expect(() =>
      validator.validateRequest('POST', '/forms/7', payload, {}, { id: '7' }, { 'if-match': '5' }),
    ).toThrow('Missing required query parameter');
    expect(() =>
      validator.validateRequest(
        'POST',
        '/forms/not-number',
        payload,
        { page: '2' },
        { id: 'not-number' },
        { 'if-match': '5' },
      ),
    ).toThrow('failed validation');
    expect(() =>
      validator.validateRequest(
        'POST',
        '/forms/7',
        payload,
        { page: '2' },
        { id: '7' },
        { 'if-match': 'not-a-tag' },
      ),
    ).toThrow('failed validation');
  });

  it('distinguishes batch documents from batch items and selects anyOf/oneOf branches', async () => {
    const doc = await loadOpenApi({
      openapi: '3.0.3',
      info: { title: 'batch validator', version: '1' },
      paths: {
        '/batch': {
          post: {
            operationId: 'createBatch',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['value'],
                      properties: {
                        value: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
                        enabled: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/plain': {
          post: {
            operationId: 'createPlain',
            requestBody: {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });
    const ajv = new Ajv({ strict: false });
    const validator = createRequestValidator({
      doc,
      getValidator: (schema) => ajv.compile(schema),
      logger: createNoopLogger(),
    });

    validator.validateRequestItem('POST', '/batch', { value: 2, enabled: true }, {}, {});
    validator.validateRequestBatch(
      'POST',
      '/batch',
      [{ value: 2 }, { value: 'two', enabled: 'false' }],
      {},
      {},
    );
    expect(() => validator.validateRequestItem('POST', '/batch', { value: false }, {}, {})).toThrow(
      'Request body failed',
    );
    expect(() =>
      validator.validateRequestBatch('POST', '/batch', [{ missing: true }], {}, {}),
    ).toThrow('Request body failed');
    validator.validateRequestBatch('POST', '/plain', { arbitrary: true }, {}, {});
    expect(() => validator.validateRequest('GET', '/unknown', null, {}, {})).toThrow(
      'No route matches',
    );
  });
});
