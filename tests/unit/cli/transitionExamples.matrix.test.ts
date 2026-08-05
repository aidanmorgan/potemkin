import express from 'express';
import { loadOpenApi } from '../../../src/contract/loader.js';
import {
  byIdPath,
  isFormOperation,
  isObject,
  jsonObject,
  operationRequest,
  pathForOperation,
  requestBody,
  routeFor,
  routesFor,
  safeName,
  type OperationRoute,
} from '../../../src/cli/transition-examples.js';

const OPENAPI = `
openapi: 3.0.3
info: { title: exporter matrix, version: 1.0.0 }
paths:
  /things:
    get:
      operationId: listThings
      responses: { "200": { description: ok } }
    post:
      operationId: createThing
      requestBody:
        content:
          application/x-www-form-urlencoded: { schema: { type: object } }
      responses: { "201": { description: created } }
  /things/{id}:
    get:
      operationId: getThing
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok } }
`;

function syntheticRoute(schema: Record<string, unknown>): OperationRoute {
  return {
    method: 'POST',
    path: '/things',
    operation: {
      operationId: 'synthetic',
      responses: {},
      requestBodySchema: schema,
    },
  } as OperationRoute;
}

describe('transition example request generation', () => {
  it('handles names, object guards, route lookup, and concrete paths', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const routes = routesFor(openapi);

    expect(safeName('  a/b:c  ')).toBe('a_b_c');
    expect(safeName('***')).toBe('example');
    expect(isObject({ value: 1 })).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(jsonObject({ value: 1 })).toEqual({ value: 1 });
    expect(jsonObject([1])).toEqual({});

    expect(routes.map((route) => route.operation.operationId)).toEqual([
      'listThings',
      'createThing',
      'getThing',
    ]);
    expect(routeFor(routes, 'createThing')?.method).toBe('POST');
    expect(routeFor(routes, 'missing')).toBeUndefined();
    expect(pathForOperation(routes, 'getThing', 'a/b')).toBe('/things/a%2Fb');
    expect(pathForOperation(routes, 'missing', 'id')).toBeUndefined();
    expect(byIdPath(openapi, '/things', 'a/b')).toBe('/things/a%2Fb');
    expect(byIdPath(openapi, '/missing', 'id')).toBeUndefined();

    const create = routeFor(routes, 'createThing')!;
    expect(isFormOperation(openapi, create)).toBe(true);
    expect(isFormOperation(openapi, routeFor(routes, 'listThings')!)).toBe(false);

    const app = express();
    for (const method of ['DELETE', 'PATCH', 'PUT', 'POST'] as const) {
      const test = operationRequest(
        app,
        { ...create, method, form: method === 'POST', headers: { 'x-test': 'yes' } },
        { id: method },
      );
      expect(test).toBeDefined();
    }
  });

  it('selects representative values across OpenAPI primitive, composite, and format schemas', () => {
    const route = syntheticRoute({
      type: 'object',
      required: [
        'currency',
        'withDefault',
        'withExample',
        'startedAt',
        'endedAt',
        'emailAddress',
        'dateValue',
        'emailFormat',
        'uuidFormat',
        'dateFormat',
        'dateTimeFormat',
        'uriFormat',
        'integerValue',
        'numberValue',
        'booleanValue',
        'arrayValue',
        'emptyArray',
        'oneOfValue',
        'anyOfValue',
        'nullableValue',
        'fallbackValue',
      ],
      properties: {
        currency: { type: 'string', enum: ['usd', 'eur'] },
        withDefault: { type: 'string', default: 'default' },
        withExample: { type: 'string', example: 'example' },
        startedAt: { type: 'string' },
        endedAt: { type: 'string' },
        emailAddress: { type: 'string' },
        dateValue: { type: 'string' },
        emailFormat: { type: 'string', format: 'email' },
        uuidFormat: { type: 'string', format: 'uuid' },
        dateFormat: { type: 'string', format: 'date' },
        dateTimeFormat: { type: 'string', format: 'date-time' },
        uriFormat: { type: 'string', format: 'uri' },
        integerValue: { type: 'integer', minimum: 7 },
        numberValue: { type: 'number' },
        booleanValue: { type: 'boolean' },
        arrayValue: { type: 'array', items: { type: 'integer' } },
        emptyArray: { type: 'array' },
        oneOfValue: { oneOf: [{ type: 'string', default: 'one' }] },
        anyOfValue: { anyOf: [{ type: 'string', example: 'any' }] },
        nullableValue: { type: ['null', 'string'] },
        fallbackValue: {},
      },
    });

    const body = requestBody(route, 0);
    expect(body).toMatchObject({
      currency: 'usd',
      withDefault: 'default',
      withExample: 'example',
      startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-02T00:00:00.000Z',
      emailAddress: 'export@example.com',
      dateValue: '2020-01-01T00:00:00.000Z',
      emailFormat: 'export@example.com',
      uuidFormat: '00000000-0000-7000-8000-000000000001',
      dateFormat: '2020-01-01T00:00:00.000Z',
      dateTimeFormat: '2020-01-01T00:00:00.000Z',
      uriFormat: 'https://example.com/export',
      integerValue: 7,
      numberValue: 1,
      booleanValue: false,
      arrayValue: [1],
      emptyArray: [],
      oneOfValue: 'one',
      anyOfValue: 'any',
      nullableValue: 'export',
      fallbackValue: 'export',
    });

    expect(requestBody(syntheticRoute({ type: 'array', items: { type: 'object' } }), 0)).toEqual(
      {},
    );
  });

  it('applies exporter variants for Stripe-style payment fields', () => {
    const route = syntheticRoute({
      type: 'object',
      required: ['payment_method', 'capture_method'],
      properties: {
        payment_method: { type: 'string' },
        capture_method: { type: 'string' },
      },
    });
    expect(requestBody(route, 0)).toMatchObject({
      payment_method: 'pm_card_visa',
      capture_method: 'automatic',
    });
    expect(requestBody(route, 2)).toMatchObject({
      payment_method: 'pm_card_visa',
      capture_method: 'manual',
    });
  });
});
