import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
  projectionName,
} from '../../src/domain/references.js';
import request from 'supertest';
import { loadOpenApi } from '../../src/contract/loader.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { bootRuntime, type RuntimeSystem } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import { bootYamlRuntime } from '../../src/parser/runtime.js';
import {
  boundary,
  defineProjection,
  event,
  expression,
  simulation,
} from '../../src/authoring/builders.js';
import { compileProgram } from '../../src/authoring/compiler.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';
import type { EventContext, IdentityContext, ProjectionContext } from '../../src/model/runtime.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Derived projection parity, version: "1.0.0" }
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
      required: [label]
      properties: { label: { type: string } }
    Order:
      type: object
      required: [id, label]
      properties:
        id: { type: string }
        label: { type: string }
`;

const YAML_MODULE = `
boundary: Order
contract_path: /orders
identity:
  creation:
    generate: $uuidv7()
initialization:
  - { id: seeded-order, label: seeded }
event_catalog:
  - type: OrderCreated
    payload_template:
      id: command.targetId
      label: command.payload.label
behaviors:
  - name: create-order
    match: { operationId: createOrder, condition: "true" }
    emit: OrderCreated
reducers:
  - on: OrderCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const YAML_GLOBAL = `
derived_projections:
  - name: OrderSummary
    key: event.aggregateId
    subscribe: [BaselineEntityCreatedEvent, OrderCreated]
    reduce:
      - on: BaselineEntityCreatedEvent
        patches:
          - { op: add, path: /label, value: "\${event.payload.label}" }
      - on: OrderCreated
        patches:
          - { op: add, path: /label, value: "\${event.payload.label}" }
`;

function typescriptDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName('Order'), contractPath(pathSegment('orders')))
        .identity({
          generate: expression('identity', ({ helpers }: IdentityContext) => helpers.uuid()),
        })
        .initialization({ id: 'seeded-order', label: 'seeded' })
        .eventCatalog(
          event(eventType('OrderCreated'), {
            id: expression('event', ({ command }: EventContext) => String(command.targetId)),
            label: expression('event', ({ command }: EventContext) => command.payload.label),
          }),
        )
        .behavior({
          name: behaviorName('create-order'),
          operationId: operationId('createOrder'),
          condition: expression('behavior', () => true),
          emit: eventType('OrderCreated'),
        })
        .reducer(
          reducerRule(eventType('OrderCreated'))
            .apply(({ state, event: emitted }) => ({
              ...state,
              id: emitted.payload.id,
              label: emitted.payload.label,
            }))
            .build(),
        ),
    )
    .global({
      derivedProjections: [
        defineProjection({
          name: projectionName('OrderSummary'),
          key: expression('projection', ({ event }: ProjectionContext) =>
            String(event?.aggregateId),
          ),
          subscribe: [eventType('BaselineEntityCreatedEvent'), eventType('OrderCreated')],
          reduce: [
            reducerRule(eventType('BaselineEntityCreatedEvent'))
              .apply(({ state, event: emitted }) => ({
                ...state,
                label: emitted.payload.label,
              }))
              .build(),
            reducerRule(eventType('OrderCreated'))
              .apply(({ state, event: emitted }) => ({
                ...state,
                label: emitted.payload.label,
              }))
              .build(),
          ],
        }),
      ],
    })
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [{ name: 'order.yaml', yaml: YAML_MODULE }],
        globalYaml: YAML_GLOBAL,
      },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
    }),
  ]);
}

async function projection(app: ReturnType<typeof createRuntimeGateway>): Promise<unknown> {
  const response = await request(app).get('/_admin/derived/OrderSummary').expect(200);
  return response.body;
}

describe('runtime derived projection parity', () => {
  it('projects initialization and mutations, then restores the same projection on reset', async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    const yamlApp = createRuntimeGateway(yamlSystem);
    const typescriptApp = createRuntimeGateway(typescriptSystem);
    try {
      const initialYaml = await projection(yamlApp);
      const initialTypescript = await projection(typescriptApp);
      expect(initialYaml).toEqual({ 'seeded-order': { label: 'seeded' } });
      expect(initialTypescript).toEqual(initialYaml);

      const [yamlCreated, typescriptCreated] = await Promise.all([
        request(yamlApp)
          .post('/orders')
          .set('X-Potemkin-Seed', 'projection-seed')
          .send({ label: 'created' }),
        request(typescriptApp)
          .post('/orders')
          .set('X-Potemkin-Seed', 'projection-seed')
          .send({ label: 'created' }),
      ]);
      expect(yamlCreated.status).toBe(201);
      expect(typescriptCreated.status).toBe(201);
      expect(typescriptCreated.body).toEqual(yamlCreated.body);
      expect(await projection(yamlApp)).toMatchObject({ 'seeded-order': { label: 'seeded' } });
      expect(await projection(typescriptApp)).toEqual(await projection(yamlApp));

      await Promise.all([
        request(yamlApp).post('/_admin/reset').expect(204),
        request(typescriptApp).post('/_admin/reset').expect(204),
      ]);
      expect(await projection(yamlApp)).toEqual(initialYaml);
      expect(await projection(typescriptApp)).toEqual(initialTypescript);
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });
});
