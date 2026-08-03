import {
  boundaryName,
  behaviorName,
  contractPath,
  eventReference,
  eventType,
  faultName,
  sagaName,
  sagaStepName,
  operationId,
  pathParameter,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createYamlRuntimeExtensions } from "../../src/parser/gateway.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import type { RuntimeTransportObservation } from "../../src/model/runtime.js";
import type { JsonValue } from "../../src/types.js";
import {
  boundary,
  compileProgram,
  defineGlobal,
  event,
  expression,
  simulation,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type {
  EventContext,
  FaultContext,
  IdentityContext,
  SagaContext,
  WebhookContext,
  ProjectionContext,
} from "../../src/model/runtime.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: Runtime parity, version: "1.0.0" }
paths:
  /orders:
    get:
      operationId: listOrders
      responses:
        "200": { description: Orders, content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Order" } } } } }
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OrderInput" }
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
  /orders/{id}:
    get:
      operationId: getOrder
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
  /receipts/{id}:
    post:
      operationId: createReceipt
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Receipt" } } } }
components:
  schemas:
    OrderInput:
      type: object
      required: [id, name]
      properties: { id: { type: string }, name: { type: string } }
    Order:
      type: object
      required: [id, name, status]
      properties: { id: { type: string }, name: { type: string }, status: { type: string } }
    Receipt:
      type: object
      required: [id, orderId, status]
      properties: { id: { type: string }, orderId: { type: string }, status: { type: string } }
`;

const GLOBAL_YAML = `
fault_rules:
  - name: chaos
    match: { headers: { x-chaos: on }, condition: "true" }
    response: { status: 503, body: { code: CHAOS } }
idempotency: { enabled: true, ttl_seconds: 60, hash_includes_body: true }
sagas:
  - name: issue-receipt
    trigger: { boundary: Order, intent: creation, condition: "true" }
    steps:
      - name: receipt
        boundary: Receipt
        intent: creation
        operationId: createReceipt
        target_id: "$concat(event.aggregateId, '-receipt')"
        payload: { orderId: event.aggregateId }
derived_projections:
  - name: OrderSummary
    key: event.aggregateId
    subscribe: [Order:OrderCreated]
    reduce:
      - on: Order:OrderCreated
        patches: [{ op: replace, path: /name, value: "\${event.payload.name}" }]
webhooks:
  - name: order-hook
    trigger: { boundary: Order, intent: creation, condition: "true" }
    url: "https://example.test/order"
    payload: { orderId: event.aggregateId }
`;

const YAML = `
boundary: Order
contract_path: /orders
identity: { creation: { generate: command.payload.id } }
event_catalog:
  - type: OrderCreated
    payload_template:
      id: command.payload.id
      name: command.payload.name
      status: "'CREATED'"
behaviors:
  - name: create-order
    match: { operationId: createOrder, condition: "true" }
    emit: OrderCreated
reducers:
  - on: OrderCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
---
boundary: Receipt
contract_path: /receipts/{id}
identity: { key: { from: path, name: id } }
event_catalog:
  - type: ReceiptCreated
    payload_template:
      id: command.targetId
      orderId: command.payload.orderId
      status: "'ISSUED'"
behaviors:
  - name: create-receipt
    match: { operationId: createReceipt, condition: "true" }
    emit: ReceiptCreated
reducers:
  - on: ReceiptCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /orderId, value: "\${event.payload.orderId}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

function directDefinition() {
  const order = boundary(boundaryName("Order"), contractPath(pathSegment("orders")))
    .identity({
      generate: expression("identity", ({ command }: IdentityContext) =>
        String(command.payload.id),
      ),
    })
    .eventCatalog(
      event(eventType("OrderCreated"), {
        id: expression("event", ({ command }: EventContext) => String(command.payload.id)),
        name: expression("event", ({ command }: EventContext) => String(command.payload.name)),
        status: expression("event", () => "CREATED"),
      }),
    )
    .behavior({
      name: behaviorName("create-order"),
      operationId: operationId("createOrder"),
      condition: expression("behavior", () => true),
      emit: eventType("OrderCreated"),
    })
    .reducer(
      reducerRule(eventType("OrderCreated"))
        .apply(({ state, event }) => ({
          ...state,
          id: String(event.payload.id),
          name: String(event.payload.name),
          status: "CREATED",
        }))
        .build(),
    );
  const receipt = boundary(
    boundaryName("Receipt"),
    contractPath(pathSegment("receipts"), pathParameter("id")),
  )
    .identity({ key: { from: "path", name: "id" } })
    .eventCatalog(
      event(eventType("ReceiptCreated"), {
        id: expression("event", ({ command }: EventContext) => String(command.targetId)),
        orderId: expression("event", ({ command }: EventContext) =>
          String(command.payload.orderId),
        ),
        status: expression("event", () => "ISSUED"),
      }),
    )
    .behavior({
      name: behaviorName("create-receipt"),
      operationId: operationId("createReceipt"),
      condition: expression("behavior", () => true),
      emit: eventType("ReceiptCreated"),
    })
    .reducer(
      reducerRule(eventType("ReceiptCreated"))
        .apply(({ state, event }) => ({
          ...state,
          id: String(event.payload.id),
          orderId: String(event.payload.orderId),
          status: "ISSUED",
        }))
        .build(),
    );
  const orderById = boundary(
    boundaryName("OrderById"),
    contractPath(pathSegment("orders"), pathParameter("id")),
  ).fallbackOverride(true);
  return simulation()
    .boundary(order)
    .boundary(orderById)
    .boundary(receipt)
    .global(
      defineGlobal({
        idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
        faults: [
          {
            name: faultName("chaos"),
            headers: { "x-chaos": "on" },
            matches: (_context: FaultContext) => true,
            response: { status: 503, body: { code: "CHAOS" } },
          },
        ],
        sagas: [
          {
            name: sagaName("issue-receipt"),
            trigger: {
              boundary: boundaryName("Order"),
              intent: "creation",
              condition: (_context: SagaContext) => true,
            },
            steps: [
              {
                name: sagaStepName("receipt"),
                boundary: boundaryName("Receipt"),
                intent: "creation",
                operationId: operationId("createReceipt"),
                targetId: ({ event }: SagaContext) => `${event?.aggregateId ?? ""}-receipt`,
                payload: { orderId: ({ event }: SagaContext) => event?.aggregateId ?? "" },
              },
            ],
          },
        ],
        derivedProjections: [
          {
            name: "OrderSummary",
            key: ({ event }: ProjectionContext) => event?.aggregateId ?? "",
            subscribe: [eventReference(boundaryName("Order"), eventType("OrderCreated"))],
            reduce: [
              reducerRule(eventType("OrderCreated"))
                .apply(({ state, event }) => ({
                  ...state,
                  name: String(event.payload.name),
                }))
                .build(),
            ],
          },
        ],
        webhooks: [
          {
            name: "order-hook",
            trigger: ({ event }: WebhookContext) => event?.type === "OrderCreated",
            url: () => "https://example.test/order",
            payload: { orderId: ({ event }: WebhookContext) => event?.aggregateId ?? "" },
          },
        ],
      }),
    )
    .build();
}

function appFor(system: RuntimeSystem, source: string) {
  return createRuntimeGateway(
    system,
    source === "YAML" ? createYamlRuntimeExtensions(system) : undefined,
  );
}

async function runPath(system: RuntimeSystem, source: string) {
  const app = appFor(system, source);
  const created = await request(app).post("/orders").send({ id: "order-1", name: "Desk lamp" });
  const fetched = await request(app).get("/orders/order-1");
  const receipt = await request(app).get("/_admin/events");
  return { created, fetched, receipt };
}

describe("YAML and TypeScript runtime paths", () => {
  let yamlSystem: RuntimeSystem;
  let typescriptSystem: RuntimeSystem;
  const deliveries: string[] = [];
  const yamlTransportObservations: RuntimeTransportObservation[] = [];
  const typescriptTransportObservations: RuntimeTransportObservation[] = [];

  function transportObservability(observations: RuntimeTransportObservation[]) {
    return {
      observeTransportRequestResponse: (observation: RuntimeTransportObservation) => {
        observations.push(observation);
      },
      requestResponseCapture: {
        maxBytes: 1_024,
        redact: (direction: "request" | "response", body: JsonValue | null) => {
          if (
            direction !== "request" ||
            body === null ||
            Array.isArray(body) ||
            typeof body !== "object"
          )
            return body;
          return { ...body, name: "[REDACTED]" };
        },
      },
    } as const;
  }

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI);
    yamlSystem = await bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [
          { name: "order.yaml", yaml: YAML.split("---")[0]! },
          {
            name: "order-by-id.yaml",
            yaml: "boundary: OrderById\ncontract_path: /orders/{id}\nfallback_override: true\nbehaviors: []\nreducers: []\nevent_catalog: []",
          },
          { name: "receipt.yaml", yaml: YAML.split("---")[1]! },
        ],
        globalYaml: GLOBAL_YAML,
      },
      webhooks: {
        deliver: async ({ body }) => {
          deliveries.push(body);
        },
      },
      observability: transportObservability(yamlTransportObservations),
    });
    typescriptSystem = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(directDefinition(), { dependencies, openapi }),
      webhooks: {
        deliver: async ({ body }) => {
          deliveries.push(body);
        },
      },
      observability: transportObservability(typescriptTransportObservations),
    });
  });

  afterAll(async () => {
    await Promise.all([yamlSystem?.dispose(), typescriptSystem?.dispose()]);
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s executes a real command, query, saga and projection through HTTP",
    async (_name, getSystem) => {
      const result = await runPath(getSystem(), _name);
      expect(result.created.status).toBe(201);
      expect(result.created.body).toMatchObject({
        id: "order-1",
        name: "Desk lamp",
        status: "CREATED",
      });
      expect(result.fetched.status).toBe(200);
      expect(result.fetched.body).toEqual(result.created.body);
      expect(result.receipt.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "OrderCreated", aggregateId: "order-1" }),
          expect.objectContaining({ type: "ReceiptCreated", aggregateId: "order-1-receipt" }),
          expect.objectContaining({ type: "SagaCompleted" }),
        ]),
      );
      const collection = await request(appFor(getSystem(), _name)).get("/orders").expect(200);
      expect(collection.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "order-1" })]),
      );
      expect(collection.body).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "order-1-receipt" })]),
      );
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s applies chaos without mutating state and replays idempotently",
    async (_name, getSystem) => {
      const system = getSystem();
      const app = appFor(system, _name);
      const before = system.engine.snapshot().events.length;
      await request(app)
        .post("/orders")
        .set("x-chaos", "on")
        .send({ id: "chaos-order", name: "Blocked" })
        .expect(503);
      expect(system.engine.snapshot().events.length).toBe(before);
      const first = await request(app)
        .post("/orders")
        .set("idempotency-key", `${_name}-same`)
        .send({ id: `${_name}-idempotent`, name: "Once" })
        .expect(201);
      const second = await request(app)
        .post("/orders")
        .set("idempotency-key", `${_name}-same`)
        .send({ id: `${_name}-idempotent`, name: "Once" })
        .expect(201);
      expect(second.headers["x-potemkin-idempotency-replay"]).toBe("true");
      expect(second.body).toEqual(first.body);

      // A selected declarative fault wins over a lower-priority transport drop
      // control; the client receives the fault response rather than a reset
      // connection.
      await request(app)
        .post("/orders")
        .set("x-chaos", "on")
        .set("x-potemkin-drop-connection", "0")
        .send({ id: `precedence-${_name}`, name: "Fault wins" })
        .expect(503);
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s exposes virtual clock controls and direct rate-limit chaos", async (_name, getSystem) => {
    const system = getSystem();
    const app = appFor(system, _name);
    const clock = await request(app).post("/_admin/clock/advance").send({ ms: 60_000 }).expect(200);
    expect(clock.body).toEqual({ offsetMs: 60_000 });

    const id = `clock-${_name.toLowerCase()}`;
    const before = Date.now() + 45_000;
    await request(app)
      .post("/orders")
      .set("x-potemkin-rate-limit", "true")
      .send({ id: `${id}-blocked`, name: "Blocked" })
      .expect(429);
    const created = await request(app).post("/orders").send({ id, name: "Clocked" }).expect(201);
    expect(created.body.id).toBe(id);
    const events = await request(app).get("/_admin/events").query({ aggregateId: id }).expect(200);
    expect(Date.parse(events.body.events[0].timestamp)).toBeGreaterThan(before);

    const reset = await request(app).post("/_admin/clock/reset").send({}).expect(200);
    expect(reset.body).toEqual({ offsetMs: 0 });
    expect(system.clock.offsetMs()).toBe(0);
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s exposes transport-level CORS and OPTIONS handling", async (_name, getSystem) => {
    const system = getSystem();
    const app = appFor(system, _name);
    const preflight = await request(app)
      .options("/orders")
      .set("Origin", "https://client.example")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("POST");
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");

    const response = await request(app)
      .get("/orders/order-1")
      .set("Origin", "https://client.example")
      .expect(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s executes object-array creates and rolls back transactional bulk failures",
    async (_name, getSystem) => {
      const system = getSystem();
      const app = appFor(system, _name);
      const created = await request(app)
        .post("/orders")
        .set("x-potemkin-bulk-transactional", "true")
        .send([
          { id: `bulk-${_name}-1`, name: "First" },
          { id: `bulk-${_name}-2`, name: "Second" },
        ])
        .expect(201);
      expect(created.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `bulk-${_name}-1` }),
          expect.objectContaining({ id: `bulk-${_name}-2` }),
        ]),
      );

      await request(app)
        .post("/orders")
        .set("x-potemkin-bulk-transactional", "true")
        .send([
          { id: `rollback-${_name}`, name: "Will roll back" },
          { id: `rollback-${_name}`, name: "Duplicate" },
        ])
        .expect(409);
      const state = await request(app).get("/_admin/state").expect(200);
      expect(state.body.entities[`rollback-${_name}`]).toBeUndefined();
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s defers post-commit side effects until transactional bulk succeeds",
    async (_name, getSystem) => {
      const system = getSystem();
      const app = appFor(system, _name);
      const before = deliveries.length;
      await request(app)
        .post("/orders")
        .set("x-potemkin-bulk-transactional", "true")
        .send([
          { id: `side-effect-${_name}`, name: "Will roll back" },
          { id: `side-effect-${_name}`, name: "Duplicate" },
        ])
        .expect(409);
      expect(deliveries.length).toBe(before);

      await request(app)
        .post("/orders")
        .set("x-potemkin-bulk-transactional", "true")
        .send([
          { id: `side-effect-${_name}-1`, name: "First" },
          { id: `side-effect-${_name}-2`, name: "Second" },
        ])
        .expect(201);
      expect(deliveries.length).toBeGreaterThan(before);
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s exposes the Specmatic forwarding envelope through the same runtime",
    async (_name, getSystem) => {
      const system = getSystem();
      const app = appFor(system, _name);
      const forwarded = await request(app)
        .post("/_engine/forward")
        .send({
          method: "POST",
          path: "/orders",
          headers: { "content-type": "application/json" },
          query: {},
          body: { id: `forward-${_name}`, name: "Forwarded order" },
        })
        .expect(200);
      expect(forwarded.body).toMatchObject({
        status: 201,
        headers: { "x-specmatic-result": "success" },
        body: { id: `forward-${_name}`, name: "Forwarded order", status: "CREATED" },
      });
      const routes = await request(app).get("/_engine/routes").expect(200);
      expect(routes.body.paths).toEqual(expect.arrayContaining(["/orders", "/orders/{id}"]));

      const bulk = await request(app)
        .post("/_engine/forward")
        .send({
          method: "POST",
          path: "/orders",
          headers: { "x-potemkin-bulk-transactional": "true" },
          query: {},
          body: [
            { id: `forward-bulk-${_name}-1`, name: "Bulk one" },
            { id: `forward-bulk-${_name}-2`, name: "Bulk two" },
          ],
        })
        .expect(200);
      expect(bulk.body.status).toBe(201);
      expect(bulk.body.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `forward-bulk-${_name}-1` }),
          expect.objectContaining({ id: `forward-bulk-${_name}-2` }),
        ]),
      );

      const dropped = await request(app)
        .post("/_engine/forward")
        .send({
          method: "POST",
          path: "/orders",
          headers: { "x-potemkin-drop-connection": "0" },
          query: {},
          body: { id: `forward-dropped-${_name}`, name: "Should not commit" },
        })
        .expect(200);
      expect(dropped.body).toMatchObject({
        status: 504,
        headers: { "x-potemkin-dropped": "true" },
        body: null,
      });
      const state = await request(app).get("/_admin/state").expect(200);
      expect(state.body.entities[`forward-dropped-${_name}`]).toBeUndefined();
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s supports parser-compiled dynamic fault administration", async (_name, getSystem) => {
    const system = getSystem();
    const app = appFor(system, _name);
    const added = await request(app)
      .post("/_admin/faults")
      .send({
        name: `${_name}-temporary-outage`,
        match: { intent: "query", condition: "true" },
        response: { status: 503, body: { code: "TEMPORARY_OUTAGE" } },
        ttlMs: 5_000,
      })
      .expect(201);

    expect(added.body.name).toBe(`${_name}-temporary-outage`);
    const listed = await request(app).get("/_admin/faults").expect(200);
    expect(listed.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: added.body.id,
          rule: expect.objectContaining({
            name: `${_name}-temporary-outage`,
            response: { status: 503, body: { code: "TEMPORARY_OUTAGE" } },
          }),
        }),
      ]),
    );

    await request(app).get("/orders/order-1").expect(503, { code: "TEMPORARY_OUTAGE" });
    await request(app)
      .delete(`/_admin/faults/${added.body.id as string}`)
      .expect(204);
    await request(app).get("/orders/order-1").expect(200);
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s accepts a typed runtime fault without routing TypeScript registration through the YAML compiler",
    async (_name, getSystem) => {
      if (_name === "YAML") return;
      const system = getSystem();
      const id = system.faults.add(
        {
          name: "typed-query-outage",
          matches: ({ command }) => command.intent === "query",
          response: { status: 503, body: { code: "TYPED_OUTAGE" } },
        },
        1_000,
      );
      await request(appFor(system, _name))
        .get("/orders/order-1")
        .expect(503, { code: "TYPED_OUTAGE" });
      system.clock.advance(1_000);
      await request(appFor(system, _name)).get("/orders/order-1").expect(200);
      expect(system.faults.list().some((entry) => entry.id === id)).toBe(false);
    },
  );

  it.each([
    ["YAML", () => yamlSystem, yamlTransportObservations],
    ["TypeScript", () => typescriptSystem, typescriptTransportObservations],
  ])(
    "%s observes the original request and final serialized response with bounded capture",
    async (_name, getSystem, observations) => {
      observations.length = 0;
      const system = getSystem();
      const app = appFor(system, _name);
      const response = await request(app)
        .post("/orders")
        .set("x-potemkin-trace-id", `trace-${_name}`)
        .send({ id: `observed-${_name}`, name: "Captured order" })
        .expect(201);

      expect(response.body).toMatchObject({ id: `observed-${_name}`, status: "CREATED" });
      expect(observations).toHaveLength(1);
      expect(observations[0]!.request.path).toBe("/orders");
      expect(observations[0]!.request.body).toMatchObject({
        captured: true,
        truncated: false,
        value: { id: `observed-${_name}`, name: "[REDACTED]" },
      });
      expect(observations[0]!.response).toMatchObject({
        status: 201,
        body: { captured: true, truncated: false, value: response.body },
      });
      expect(observations[0]!.correlation).toMatchObject({ traceId: `trace-${_name}` });
      expect(observations[0]!.correlation.commandId).toEqual(expect.any(String));
    },
  );
});
