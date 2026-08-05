import request from 'supertest';
import { loadOpenApi } from '../../src/contract/loader.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { defineComponent, include, yamlComponent } from '../../src/authoring/composition.js';
import { boundary, event, simulation } from '../../src/authoring/builders.js';
import { collectTypeScriptComponents, compileMixedProgram } from '../../src/parser/mixed.js';
import { bootRuntime } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import {
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
  schemaReference,
} from '../../src/domain/references.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Cross-language composition, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OrderInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
components:
  schemas:
    OrderInput:
      type: object
      properties: { label: { type: string } }
    Order:
      type: object
      properties:
        id: { type: string }
        label: { type: string }
        audited: { type: boolean }
`;

function tsComponent() {
  return defineComponent(componentName('Order'), () => ({
    identity: { generate: ({ helpers }) => helpers.uuid() },
    eventCatalog: [
      event(eventType('OrderCreated'), { label: ({ command }) => command.payload.label }),
    ],
    behaviors: [
      {
        name: behaviorName('create-order'),
        operationId: operationId('createOrder'),
        emit: eventType('OrderCreated'),
      },
    ],
    reducers: [
      reducerRule(eventType('OrderCreated'))
        .apply(({ state, event: emitted }) => ({ ...state, label: emitted.payload.label }))
        .build(),
    ],
  }));
}

const yamlAudit = {
  name: 'audit.yaml',
  yaml: `
kind: component
name: Audit
event_catalog:
  - type: AuditRecorded
    payload_template: { audited: "true" }
reducers:
  - on: AuditRecorded
    patches:
      - { op: add, path: /audited, value: "true" }
`,
};

async function bootMixed(input: Parameters<typeof compileMixedProgram>[0]) {
  const openapi = await loadOpenApi(OPENAPI);
  const host = createDefaultRuntimeHost();
  return bootRuntime({
    host,
    openapi,
    programFactory: (context) => compileMixedProgram(input, { ...context, openapi }),
  });
}

describe('mixed cross-language component composition', () => {
  it('rejects cyclic TypeScript component references before runtime compilation', () => {
    // The forward references are intentional: they construct the cycle under test.
    let left: ReturnType<typeof defineComponent>;
    let right: ReturnType<typeof defineComponent>;
    left = defineComponent(componentName('Left'), () => ({ include: [include(right)] }));
    right = defineComponent(componentName('Right'), () => ({ include: [include(left)] }));
    left = defineComponent(componentName('Left'), () => ({ include: [include(right)] }));
    right = defineComponent(componentName('Right'), () => ({ include: [include(left)] }));

    expect(() =>
      collectTypeScriptComponents(simulation().component(left).component(right).build()),
    ).toThrow('Cyclic TypeScript component composition: Left -> Right -> Left');
  });

  it('enforces TypeScript component parameter types at a YAML use link', async () => {
    const parameterized = defineComponent(
      componentName('Parameterized'),
      (parameters) => ({
        eventCatalog: [event(eventType('ParameterizedCreated'), { tenant: parameters.tenant })],
      }),
      { parameters: { tenant: { type: 'string', required: true } } },
    );
    await expect(
      bootMixed({
        yaml: {
          modules: [],
          useMappingModules: [
            {
              name: 'use.yaml',
              yaml: 'use:\n  - { component: Parameterized, as: ParameterizedOrders, contract_path: /orders, with: { tenant: 42 } }\n',
            },
          ],
        },
        direct: simulation().component(parameterized).build(),
      }),
    ).rejects.toThrow('Component "Parameterized" parameter "tenant" must be a string');
  });

  it('lets a YAML use entry instantiate a registered TypeScript component', async () => {
    const component = tsComponent();
    const system = await bootMixed({
      yaml: {
        modules: [],
        useMappingModules: [
          {
            name: 'use.yaml',
            yaml: 'use:\n  - { component: Order, as: Orders, contract_path: /orders }\n',
          },
        ],
      },
      direct: simulation().component(component).build(),
    });
    try {
      const response = await request(createRuntimeGateway(system))
        .post('/orders')
        .set('X-Potemkin-Seed', 'mixed-use')
        .send({ label: 'first' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ label: 'first' });
    } finally {
      await system.dispose();
    }
  });

  it('lets a TypeScript boundary include an explicit YAML component reference', async () => {
    const direct = simulation()
      .boundary(
        boundary(boundaryName('Orders'), contractPath(pathSegment('orders')))
          .schema(schemaReference('Order'))
          .identity({ generate: ({ helpers }) => helpers.uuid() })
          .eventCatalog(
            event(eventType('OrderCreated'), { label: ({ command }) => command.payload.label }),
            event(eventType('AuditRecorded'), { audited: () => true }),
          )
          .behavior({
            name: behaviorName('create-order'),
            operationId: operationId('createOrder'),
            emitWhen: [
              { when: () => true, event: eventType('OrderCreated') },
              { when: () => true, event: eventType('AuditRecorded') },
            ],
          })
          .reducer(
            reducerRule(eventType('OrderCreated'))
              .apply(({ state, event: emitted }) => ({ ...state, label: emitted.payload.label }))
              .build(),
          )
          .include(include(yamlComponent(componentName('Audit'))))
          .build(),
      )
      .build();
    const system = await bootMixed({
      yaml: { modules: [], componentModules: [yamlAudit] },
      direct,
    });
    try {
      const response = await request(createRuntimeGateway(system))
        .post('/orders')
        .set('X-Potemkin-Seed', 'mixed-include')
        .send({ label: 'first' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ label: 'first', audited: true });
    } finally {
      await system.dispose();
    }
  });

  it('lets a YAML boundary include a registered TypeScript component', async () => {
    const system = await bootMixed({
      yaml: {
        modules: [
          {
            name: 'orders.yaml',
            yaml: `
boundary: Orders
contract_path: /orders
event_catalog: []
behaviors: []
reducers: []
include:
  - component: Order
`,
          },
        ],
      },
      direct: simulation().component(tsComponent()).build(),
    });
    try {
      const response = await request(createRuntimeGateway(system))
        .post('/orders')
        .set('X-Potemkin-Seed', 'mixed-yaml-include')
        .send({ label: 'first' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ label: 'first' });
    } finally {
      await system.dispose();
    }
  });
});
