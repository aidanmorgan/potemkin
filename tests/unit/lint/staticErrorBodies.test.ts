import { BootError } from '../../../src/errors';
import type { RuntimeBoundary, RuntimeFault, RuntimeProgram } from '../../../src/model/runtime';
import type { OpenApiDoc } from '../../../src/contract/loader';
import type { JsonObject } from '../../../src/contracts/value';
import { lintStaticErrorBodies } from '../../../src/lint/staticErrorBodies';
import { ALL_CHECKS } from '../../../src/lint/checks';
import { runLint } from '../../../src/lint/runner';
import { bootRuntime } from '../../../src/runtime/system';
import { createDefaultRuntimeHost } from '../../../src/runtime/host';
import {
  behavior,
  boundary as defineBoundary,
  event,
  simulation,
} from '../../../src/authoring/builders';
import { compileProgram } from '../../../src/authoring/compiler';
import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  guardName,
  operationId,
  pathSegment,
} from '../../../src/domain/references';

function contract(schema: JsonObject): OpenApiDoc {
  return {
    raw: {},
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          responseSchemas: { '422': schema },
        },
      },
    },
  };
}

function boundary(overrides: Partial<RuntimeBoundary> = {}): RuntimeBoundary {
  return {
    boundary: 'Order',
    contractPath: '/orders',
    eventCatalog: [],
    behaviors: [],
    reducers: [],
    ...overrides,
  };
}

function program(
  boundaries: readonly RuntimeBoundary[],
  policies: RuntimeProgram['policies'] = {},
): Pick<RuntimeProgram, 'boundaries' | 'policies'> {
  return { boundaries, policies };
}

describe('static contract-error lint', () => {
  it('validates TypeScript/YAML-neutral guard output and reports its source location', () => {
    const openapi = contract({
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string', pattern: '^accepted$' } },
    });
    const value = boundary({
      behaviors: [
        {
          name: 'create',
          operationId: 'createOrder',
          requires: [
            {
              name: 'accepted-only',
              check: () => true,
              errorCode: 'NOT_ACCEPTED',
              errorMessage: 'rejected',
            },
          ],
        },
      ],
    });

    expect(() =>
      lintStaticErrorBodies(program([value]), openapi, {
        sourceByBoundary: { Order: '/tmp/order.yaml' },
      }),
    ).toThrow(BootError);
    try {
      lintStaticErrorBodies(program([value]), openapi, {
        sourceByBoundary: { Order: '/tmp/order.yaml' },
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        details: {
          boundary: 'Order',
          operationId: 'createOrder',
          method: 'POST',
          path: '/orders',
          status: 422,
        },
      });
      expect((error as Error).message).toContain('/tmp/order.yaml');
    }
  });

  it('validates static fault bodies through the same contract resolver', () => {
    const openapi = contract({
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string' } },
    });
    const fault: RuntimeFault = {
      name: 'bad-fault',
      matches: () => true,
      response: { status: 422, body: { error: 42 } },
    };

    expect(() => lintStaticErrorBodies(program([boundary({ faults: [fault] })]), openapi)).toThrow(
      /fault "bad-fault".*POST \/orders 422/,
    );
  });

  it('does not reject an error status that the matched operation does not declare', () => {
    const openapi: OpenApiDoc = {
      raw: {},
      paths: {
        '/orders': {
          post: {
            operationId: 'createOrder',
            responseSchemas: { '200': { type: 'object' } },
          },
        },
      },
    };
    const fault: RuntimeFault = {
      name: 'undeclared',
      matches: () => true,
      response: { status: 422, body: { invalid: true } },
    };

    expect(() =>
      lintStaticErrorBodies(program([boundary({ faults: [fault] })]), openapi),
    ).not.toThrow();
  });

  it('is registered in the canonical lint runner', () => {
    const openapi = contract({
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string', pattern: '^accepted$' } },
    });
    const value = boundary({
      behaviors: [
        {
          name: 'create',
          operationId: 'createOrder',
          requires: [
            { name: 'accepted-only', check: () => true, errorCode: 'NO', errorMessage: 'rejected' },
          ],
        },
      ],
    });

    const result = runLint(
      { program: program([value]), openapi, sourceByBoundary: { Order: '/tmp/order.yaml' } },
      ALL_CHECKS,
    );
    expect(result.errors[0]).toMatchObject({
      code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      location: { file: '/tmp/order.yaml', boundary: 'Order' },
    });
  });

  it('runs the same check at runtime boot', async () => {
    const openapi = contract({
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string', pattern: '^accepted$' } },
    });
    const definition = simulation()
      .boundary(
        defineBoundary(boundaryName('Order'), contractPath(pathSegment('orders')))
          .eventCatalog(event(eventType('OrderCreated'), {}))
          .behavior(
            behavior(behaviorName('create'))
              .operation(operationId('createOrder'))
              .emit(eventType('OrderCreated'))
              .requires({
                name: guardName('accepted-only'),
                check: () => true,
                errorCode: 'NO',
                errorMessage: 'rejected',
              })
              .build(),
          )
          .build(),
      )
      .build();

    await expect(
      bootRuntime({
        host: createDefaultRuntimeHost(),
        openapi,
        programFactory: ({ dependencies }) => compileProgram(definition, { dependencies, openapi }),
      }),
    ).rejects.toMatchObject({ code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION' });
  });
});
