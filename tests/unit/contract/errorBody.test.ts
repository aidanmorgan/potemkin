import { buildContractErrorBody, validateContractErrorBody } from '../../../src/contract/errorBody';
import { resolveResponseSchema } from '../../../src/contract/responseSchema';
import { loadOpenApi, type OpenApiDoc } from '../../../src/contract/loader';
import type { JsonObject } from '../../../src/contracts/value';
import * as path from 'node:path';

function docFor(schema: Record<string, unknown>, responseKey = 'default'): OpenApiDoc {
  return {
    raw: { components: { schemas: { Error: schema } } },
    paths: {
      '/widgets/{id}': {
        get: {
          operationId: 'getWidget',
          responseSchemas: { [responseKey]: schema as JsonObject },
        },
      },
    },
  };
}

describe('contract error body builder', () => {
  it('uses the shared exact-status then default resolver and never uses range keys', () => {
    const doc = {
      raw: {},
      paths: {
        '/widgets': {
          get: {
            responseSchemas: {
              '4XX': {
                type: 'object',
                required: ['wrong'],
                properties: { wrong: { type: 'string' } },
              },
              default: {
                type: 'object',
                required: ['fallback'],
                properties: { fallback: { type: 'boolean' } },
              },
              '404': {
                type: 'object',
                required: ['exact'],
                properties: { exact: { type: 'string' } },
              },
            },
          },
        },
      },
    } as OpenApiDoc;

    expect(resolveResponseSchema(doc, 'GET', '/widgets', 404)).toEqual(
      doc.paths['/widgets']!.get!.responseSchemas!['404'],
    );
    expect(buildContractErrorBody(doc, 'GET', '/widgets', 400)).toEqual({ fallback: false });
    expect(buildContractErrorBody(doc, 'GET', '/widgets', 418)).toEqual({ fallback: false });
  });

  it('retains optional diagnostic details from the engine error envelope', () => {
    const doc = docFor({
      type: 'object',
      required: ['error'],
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    });

    expect(
      buildContractErrorBody(doc, 'GET', '/widgets/1', 422, {
        code: 'ALREADY_NEGOTIATING',
        message: 'The operation is not allowed in the current state',
        details: { code: 'ALREADY_NEGOTIATING', requirement: 'not-negotiating' },
      }),
    ).toEqual({
      error: 'ALREADY_NEGOTIATING',
      message: 'The operation is not allowed in the current state',
      details: { code: 'ALREADY_NEGOTIATING', requirement: 'not-negotiating' },
    });
  });

  it('does not index OpenAPI response ranges in the loaded operation', async () => {
    const doc = await loadOpenApi({
      openapi: '3.0.3',
      info: { title: 'range test', version: '1' },
      paths: {
        '/widgets': {
          get: {
            responses: {
              '4XX': {
                description: 'range',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              default: {
                description: 'fallback',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    });
    expect(doc.paths['/widgets']!.get!.responseSchemas).toEqual({ default: { type: 'object' } });
  });

  it('returns undefined for an unknown route or an undeclared status without default', () => {
    const doc = docFor(
      { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      '404',
    );
    expect(buildContractErrorBody(doc, 'GET', '/missing', 404)).toBeUndefined();
    expect(buildContractErrorBody(doc, 'GET', '/widgets/1', 500)).toBeUndefined();
  });

  it('fills refs, first oneOf/anyOf branches, merged allOf, and required object fields', () => {
    const errorSchema = {
      allOf: [
        {
          type: 'object',
          required: ['code'],
          properties: { code: { enum: ['FIRST', 'SECOND'], type: 'string' } },
        },
        {
          type: 'object',
          required: ['nested'],
          properties: { nested: { $ref: '#/components/schemas/Nested' } },
        },
      ],
    };
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            Error: errorSchema,
            Nested: {
              type: 'object',
              required: ['value', 'choice'],
              properties: {
                value: { type: 'number' },
                choice: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
              },
            },
          },
        },
      },
      paths: {
        '/widgets': {
          get: {
            responseSchemas: { default: { $ref: '#/components/schemas/Error' } },
          },
        },
      },
    };
    expect(buildContractErrorBody(doc, 'GET', '/widgets', 422)).toEqual({
      code: 'FIRST',
      nested: { value: 0, choice: false },
    });
  });

  it('uses deterministic valid values for formats, patterns, and minimum-sized arrays', () => {
    const doc = docFor({
      type: 'object',
      required: ['when', 'date', 'token', 'items'],
      properties: {
        when: { type: 'string', format: 'date-time' },
        date: { type: 'string', format: 'date' },
        token: { type: 'string', pattern: '^ERR_[A-Z]+$' },
        items: { type: 'array', minItems: 2, items: { type: 'integer' } },
      },
    });
    const body = buildContractErrorBody(
      doc,
      'GET',
      '/widgets/1',
      400,
      {},
      {
        now: () => '2030-01-02T03:04:05.000Z',
      },
    );
    expect(body).toEqual({
      when: '2030-01-02T03:04:05.000Z',
      date: '2030-01-02',
      token: 'ERR_AA',
      items: [0, 0],
    });
    expect(validateContractErrorBody(doc, 'GET', '/widgets/1', 400, body!)).toEqual({
      valid: true,
    });
  });

  it('fills every supported scalar format and safely handles malformed patterns', () => {
    const doc = docFor({
      type: 'object',
      required: ['time', 'uuid', 'email', 'uri', 'hostname', 'ipv4', 'unknown', 'bad'],
      properties: {
        time: { type: 'string', format: 'time' },
        uuid: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        uri: { type: 'string', format: 'uri-reference' },
        hostname: { type: 'string', format: 'hostname' },
        ipv4: { type: 'string', format: 'ipv4' },
        unknown: { type: 'string', format: 'unsupported' },
        bad: { type: 'string', pattern: '[' },
      },
    });

    expect(buildContractErrorBody(doc, 'GET', '/widgets/1', 400)).toEqual({
      time: '00:00:00.000Z',
      uuid: '00000000-0000-4000-8000-000000000000',
      email: 'error@example.com',
      uri: 'https://example.com/error',
      hostname: 'example.com',
      ipv4: '127.0.0.1',
      unknown: '',
      bad: '',
    });
  });

  it('fills constants, nullable unions, minimums, lengths, and nested arrays', () => {
    const doc = docFor({
      type: 'object',
      required: ['constant', 'count', 'zero', 'enabled', 'nothing', 'labels', 'short'],
      properties: {
        constant: { const: 'fixed' },
        count: { type: 'integer', minimum: 3 },
        zero: { type: 'number', minimum: 0 },
        enabled: { type: 'boolean' },
        nothing: { type: 'null' },
        labels: { type: 'array', minItems: 2, items: { type: 'string', minLength: 3 } },
        short: { type: 'string', minLength: 4 },
      },
    });
    expect(buildContractErrorBody(doc, 'GET', '/widgets/1', 400)).toEqual({
      constant: 'fixed',
      count: 3,
      zero: 0,
      enabled: false,
      nothing: null,
      labels: ['xxx', 'xxx'],
      short: 'xxxx',
    });
  });

  it('resolves schema combinators and local references with sibling constraints', () => {
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            Nested: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string', minLength: 2 } },
            },
            Cyclic: { $ref: '#/components/schemas/Cyclic' },
          },
        },
      },
      paths: {
        '/widgets': {
          get: {
            responseSchemas: {
              default: {
                type: 'object',
                required: ['all', 'one', 'list', 'unknown'],
                properties: {
                  all: {
                    allOf: [
                      { $ref: '#/components/schemas/Nested' },
                      { properties: { extra: { type: 'boolean' } } },
                    ],
                  },
                  one: {
                    oneOf: [{ type: 'string', minLength: 1 }, { type: 'number' }],
                    description: 'sibling metadata',
                  },
                  list: { type: 'array', items: { $ref: '#/components/schemas/Nested' } },
                  unknown: { $ref: '#/components/schemas/DoesNotExist' },
                },
              },
            },
          },
        },
      },
    };
    expect(buildContractErrorBody(doc, 'GET', '/widgets', 500)).toEqual({
      all: { value: 'xx' },
      one: 'x',
      list: [],
      unknown: '',
    });
  });

  it('uses mapped codes for enum fields and reports validation failures', () => {
    const doc = docFor({
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string', enum: ['api_error', 'other'] } },
    });
    const body = buildContractErrorBody(
      doc,
      'GET',
      '/widgets/1',
      500,
      { code: 'ENTITY_ABSENCE' },
      { codeMap: { ENTITY_ABSENCE: 'mapped_error' } },
    );
    expect(body).toEqual({ error: 'mapped_error' });
    expect(validateContractErrorBody(doc, 'GET', '/widgets/1', 500, { error: 1 })).toMatchObject({
      valid: false,
      errors: expect.any(Array),
    });
    expect(validateContractErrorBody(doc, 'GET', '/missing', 500, { error: 'anything' })).toEqual({
      valid: true,
    });
  });

  it('uses the first enum value without a code map and accepts an injected map', () => {
    const doc = docFor({
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['type'],
          properties: { type: { type: 'string', enum: ['api_error', 'invalid_request_error'] } },
        },
      },
    });
    expect(
      buildContractErrorBody(doc, 'GET', '/widgets/1', 500, {
        code: 'ENTITY_ABSENCE',
        message: 'missing',
      }),
    ).toEqual({
      error: { type: 'api_error' },
    });
    expect(
      buildContractErrorBody(
        doc,
        'GET',
        '/widgets/1',
        500,
        { code: 'ENTITY_ABSENCE', message: 'missing' },
        {
          codeMap: { ENTITY_ABSENCE: 'invalid_request_error' },
        },
      ),
    ).toEqual({
      error: { type: 'invalid_request_error' },
    });
  });

  it('produces bodies valid for the CRM error schema and a Stripe default error schema', async () => {
    const root = path.resolve(process.cwd(), 'examples');
    const crm = await loadOpenApi(path.join(root, 'crm', 'openapi', 'nuisance-bureau.yaml'));
    const crmBody = buildContractErrorBody(
      crm,
      'GET',
      '/leads/00000000-0000-7000-8000-000000000099',
      404,
      { code: 'ENTITY_ABSENCE', message: 'Lead not found' },
    );
    expect(crmBody).toBeDefined();
    expect(
      validateContractErrorBody(
        crm,
        'GET',
        '/leads/00000000-0000-7000-8000-000000000099',
        404,
        crmBody!,
      ).valid,
    ).toBe(true);

    const stripe = await loadOpenApi(path.join(root, 'stripe', 'openapi', 'stripe-official.json'));
    expect(stripe.errorCodeMap?.ENTITY_ABSENCE).toBe('invalid_request_error');
    const stripeRoute = Object.entries(stripe.paths).flatMap(([routePath, item]) =>
      Object.entries(item)
        .filter(([, operation]) => operation?.responseSchemas?.default !== undefined)
        .map(([method]) => ({ method, routePath })),
    )[0];
    expect(stripeRoute).toBeDefined();
    const concretePath = stripeRoute!.routePath.replace(/\{[^}]+\}/g, 'example');
    const stripeBody = buildContractErrorBody(
      stripe,
      stripeRoute!.method,
      concretePath,
      500,
      { code: 'ENTITY_ABSENCE', message: 'resource not found' },
      { codeMap: stripe.errorCodeMap },
    );
    expect(stripeBody).toBeDefined();
    expect(
      validateContractErrorBody(stripe, stripeRoute!.method, concretePath, 500, stripeBody!).valid,
    ).toBe(true);

    const unmappedStripeBody = buildContractErrorBody(
      stripe,
      stripeRoute!.method,
      concretePath,
      500,
      { code: 'UNMAPPED_ENGINE_CODE', message: 'resource not found' },
    );
    expect(unmappedStripeBody).toEqual({
      error: {
        code: 'UNMAPPED_ENGINE_CODE',
        type: 'api_error',
        message: 'resource not found',
      },
    });
  }, 120_000);

  it('validates a deterministic body for every declared error response pair', async () => {
    const root = path.resolve(process.cwd(), 'examples');
    for (const [name, source] of [
      ['CRM', path.join(root, 'crm', 'openapi', 'nuisance-bureau.yaml')],
      ['Stripe', path.join(root, 'stripe', 'openapi', 'stripe-official.json')],
    ] as const) {
      const doc = await loadOpenApi(source);
      for (const [routePath, item] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(item)) {
          for (const responseStatus of Object.keys(operation?.responseSchemas ?? {})) {
            if (responseStatus !== 'default' && Number(responseStatus) < 400) continue;
            const status = responseStatus === 'default' ? 500 : Number(responseStatus);
            const concretePath = routePath.replace(/\{[^}]+\}/g, 'example');
            const body = buildContractErrorBody(
              doc,
              method,
              concretePath,
              status,
              { code: 'ENTITY_ABSENCE', message: `${name} error` },
              { codeMap: doc.errorCodeMap },
            );
            expect(body).toBeDefined();
            expect(validateContractErrorBody(doc, method, concretePath, status, body!).valid).toBe(
              true,
            );
          }
        }
      }
    }
  }, 120_000);
});
