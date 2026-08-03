import {
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import {
  behavior,
  compileProgram,
  event,
  expression,
  simulation,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import { defineComponent, include, use } from "../../src/authoring/composition.js";
import type { EventContext, IdentityContext } from "../../src/model/runtime.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: Composition parity, version: "1.0.0" }
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
      required: [id, label, status]
      properties:
        id: { type: string }
        label: { type: string }
        status: { type: string }
        audited: { type: boolean }
`;

const YAML_COMPONENTS = [
  {
    name: "audit.yaml",
    yaml: `
kind: component
name: Audit
event_catalog:
  - type: AuditRecorded
    payload_template:
      audited: "true"
reducers:
  - on: AuditRecorded
    patches:
      - { op: add, path: /audited, value: "\${event.payload.audited}" }
`,
  },
  {
    name: "order.yaml",
    yaml: `
kind: component
name: Order
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: OrderCreated
    payload_template:
      id: command.targetId
      label: command.payload.label
      status: "'CREATED'"
  - type: AuditRecorded
    payload_template:
      audited: "true"
behaviors:
  - name: create-order
    match: { operationId: createOrder, condition: "true" }
    emit_when:
      - { when: "true", emit: OrderCreated }
      - { when: "true", emit: AuditRecorded }
reducers:
  - on: OrderCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
include:
  - component: Audit
`,
  },
];

const YAML_USE = `
use:
  - { component: Order, as: Order, contract_path: /orders }
`;

function directDefinition() {
  const audit = defineComponent(componentName("Audit"), () => ({
    eventCatalog: [event(eventType("AuditRecorded"), { audited: () => true })],
    reducers: [
      reducerRule(eventType("AuditRecorded"))
        .apply(({ state, event: emitted }) => ({
          ...state,
          audited: emitted.payload.audited,
        }))
        .build(),
    ],
  }));
  const order = defineComponent(componentName("Order"), () => ({
    identity: {
      generate: expression("identity", ({ helpers }: IdentityContext) => helpers.uuid()),
    },
    eventCatalog: [
      event(eventType("OrderCreated"), {
        id: expression("event", ({ command }: EventContext) => String(command.targetId)),
        label: expression("event", ({ command }: EventContext) => command.payload.label),
        status: expression("event", () => "CREATED"),
      }),
      event(eventType("AuditRecorded"), { audited: () => true }),
    ],
    behaviors: [
      behavior(behaviorName("create-order"))
        .operation(operationId("createOrder"))
        .emitWhen(
          { when: expression("behavior", () => true), event: eventType("OrderCreated") },
          { when: expression("behavior", () => true), event: eventType("AuditRecorded") },
        )
        .build(),
    ],
    reducers: [
      reducerRule(eventType("OrderCreated"))
        .apply(({ state, event: emitted }) => ({
          ...state,
          id: emitted.payload.id,
          label: emitted.payload.label,
          status: emitted.payload.status,
        }))
        .build(),
    ],
    include: [include(audit)],
  }));
  return simulation()
    .use(use(order, boundaryName("Order"), contractPath(pathSegment("orders"))))
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [],
        componentModules: YAML_COMPONENTS,
        useMappingModules: [{ name: "use.yaml", yaml: YAML_USE }],
      },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(directDefinition(), { dependencies, openapi }),
    }),
  ]);
}

describe("runtime component composition parity", () => {
  it("runs YAML use/include and direct TypeScript use/include through the same runtime", async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    try {
      const [yamlResponse, typescriptResponse] = await Promise.all([
        request(createRuntimeGateway(yamlSystem))
          .post("/orders")
          .set("X-Potemkin-Seed", "composition-seed")
          .send({ label: "first" }),
        request(createRuntimeGateway(typescriptSystem))
          .post("/orders")
          .set("X-Potemkin-Seed", "composition-seed")
          .send({ label: "first" }),
      ]);
      expect(yamlResponse.status).toBe(201);
      expect(typescriptResponse.status).toBe(201);
      expect(typescriptResponse.body).toEqual(yamlResponse.body);
      expect(yamlResponse.body).toMatchObject({ label: "first", status: "CREATED", audited: true });
      expect(yamlSystem.engine.snapshot().events.map((event) => event.type)).toEqual([
        "OrderCreated",
        "AuditRecorded",
      ]);
      expect(typescriptSystem.engine.snapshot().events.map((event) => event.type)).toEqual([
        "OrderCreated",
        "AuditRecorded",
      ]);
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });
});
