import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  faultName,
  field,
  fieldPath,
  operationId,
  pathParameter,
  pathSegment,
  schemaReference,
} from "../../src/authoring/references.js";
/**
 * HTTP parity for the two authoring paths.
 *
 * The YAML system and the TypeScript system are separate boots. They share the
 * same OpenAPI document, but neither boot consumes the other author's model.
 * Every assertion below is made through HTTP: normal contract routes, admin
 * inspection routes, and the plugin-facing forwarding route.
 *
 * The fixture intentionally combines the feature families that are easy to
 * accidentally compare only structurally:
 *   - response headers, HATEOAS, masking, and deprecation;
 *   - event/state effects from a primary command;
 *   - secondary dispatch, choreography reaction, and a derived projection;
 *   - injected faults, idempotency, optimistic concurrency, and reset;
 *   - webhook delivery records and the `_engine/forward` response envelope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHmac } from "node:crypto";
import { bootRuntime } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { loadOpenApi } from "../../src/contract/loader.js";
import {
  boundary,
  behavior,
  compileProgram,
  defineGlobal,
  event,
  expression,
  simulation,
  type SimulationDefinition,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type {
  EventContext,
  FaultContext,
  IdentityContext,
  MatchContext,
  PostCommitContext,
  ProjectionContext,
  WebhookContext,
} from "../../src/model/runtime.js";
import { compareDefinitions } from "../equivalence/configurationParity.js";
import type { YamlLinkedProgram } from "../../src/dsl/types.js";
import { compileYaml } from "../../src/parser/yamlParser.js";
import type { YamlProgramInput } from "../../src/parser/public.js";
import type {
  RuntimeTransportObservation,
  RuntimeWebhookTransport,
} from "../../src/model/runtime.js";
import { resolveFixtureDir } from "../fixtures/index.js";
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from "../_support/persistentAgent.js";

const FIXTURE_DIR = resolveFixtureDir("authoring-parity");
const ORDER_ID = "order-parity-001";
const RECEIPT_ID = `${ORDER_ID}-receipt`;
const WEBHOOK_SECRET = "parity-webhook-secret";

type JsonRecord = Record<string, unknown>;

interface RecordedDelivery {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface BootedAuthoringPath {
  readonly name: "yaml" | "typescript";
  readonly agent: PersistentAgent;
  readonly server: PersistentServer;
  readonly deliveries: RecordedDelivery[];
  readonly observations: RuntimeTransportObservation[];
}

function recordingTransport(deliveries: RecordedDelivery[]): RuntimeWebhookTransport {
  return {
    deliver: async ({ url, headers, body }) => {
      deliveries.push({ url, headers: { ...headers }, body });
    },
  };
}

function readFixture(relativePath: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, relativePath), "utf8");
}

function yamlProgramFixture(): YamlProgramInput {
  const modules = fs
    .readdirSync(path.join(FIXTURE_DIR, "dsl"))
    .filter(
      (name) =>
        name !== "global.yaml" &&
        name !== "e2e-global.yaml" &&
        name !== "empty.yaml" &&
        name.endsWith(".yaml"),
    )
    .sort()
    .map((name) => ({ name, yaml: readFixture(`dsl/${name}`) }));
  return { modules, globalYaml: readFixture("dsl/global.yaml") };
}

async function compileYamlFixture(): Promise<YamlLinkedProgram> {
  const input = yamlProgramFixture();
  return compileYaml(input.modules, input.globalYaml);
}

function definition(): SimulationDefinition {
  const order = boundary(boundaryName("Order"), contractPath(pathSegment("orders")))
    .fallbackOverride(false)
    .identity({
      generate: expression("identity", ({ command }: IdentityContext) =>
        String(command.payload["id"]),
      ),
    })
    .response({ hateoas: [{ rel: "self", href: "/orders" }] })
    .mask(fieldPath(field("internalNote")))
    .eventCatalog(
      event(eventType("OrderCreatedFirst"), {
        id: expression("event", ({ command }: EventContext) => String(command.payload["id"])),
        name: expression("event", ({ command }: EventContext) => String(command.payload["name"])),
        quantity: expression("event", ({ command }: EventContext) =>
          Number(command.payload["quantity"]),
        ),
        internalNote: expression("event", ({ command }: EventContext) =>
          String(command.payload["internalNote"]),
        ),
        status: "FIRST",
      }),
      event(eventType("OrderCreated"), {
        id: expression("event", ({ command }: EventContext) => String(command.payload["id"])),
        name: expression("event", ({ command }: EventContext) => String(command.payload["name"])),
        quantity: expression("event", ({ command }: EventContext) =>
          Number(command.payload["quantity"]),
        ),
        internalNote: expression("event", ({ command }: EventContext) =>
          String(command.payload["internalNote"]),
        ),
        status: "CREATED",
      }),
    )
    .behavior(
      behavior(behaviorName("create-order-first"))
        .operation(operationId("createOrder"))
        .headers({ "x-parity-behavior-order": "first" })
        .condition((_input: MatchContext) => true)
        .emit(eventType("OrderCreatedFirst"))
        .status(202)
        .build(),
    )
    .behavior(
      behavior({
        name: behaviorName("create-order"),
        operationId: operationId("createOrder"),
        condition: (_input: MatchContext) => true,
        emit: eventType("OrderCreated"),
        dispatchCommands: [
          {
            boundary: boundaryName("Receipt"),
            intent: "creation",
            operationId: operationId("createReceipt"),
            targetId: ({ command }: MatchContext) => `${command.targetId ?? ""}-receipt`,
            payload: {
              orderId: ({ command }: MatchContext) => command.targetId ?? "",
              amount: ({ command }: MatchContext) => Number(command.payload["quantity"]),
            },
          },
        ],
      }),
    )
    .reducer(
      reducerRule(eventType("OrderCreatedFirst"))
        .apply(({ state, event }) => ({
          ...state,
          id: String(event.payload["id"]),
          name: String(event.payload["name"]),
          quantity: Number(event.payload["quantity"]),
          internalNote: String(event.payload["internalNote"]),
          status: String(event.payload["status"]),
        }))
        .build(),
    )
    .reducer(
      reducerRule(eventType("OrderCreated"))
        .apply(({ state, event }) => ({
          ...state,
          id: String(event.payload["id"]),
          name: String(event.payload["name"]),
          quantity: Number(event.payload["quantity"]),
          internalNote: String(event.payload["internalNote"]),
          status: String(event.payload["status"]),
        }))
        .build(),
    );

  const orderById = boundary(
    boundaryName("OrderById"),
    contractPath(pathSegment("orders"), pathParameter("id")),
  )
    .fallbackOverride(true)
    .schema(schemaReference("Order"))
    .identity({ key: { from: "path", name: "id" } })
    .response({
      hateoas: [{ rel: "self", href: "/orders/{id}" }],
      deprecated: {
        date: "2026-01-01T00:00:00Z",
        sunset: "2027-01-01T00:00:00Z",
        replacement: "/v2/orders",
      },
    })
    .mask(fieldPath(field("internalNote")))
    .eventCatalog(
      event(eventType("OrderRenamed"), {
        id: expression(
          "event",
          ({ event, command }: EventContext) => event?.aggregateId ?? String(command.targetId),
        ),
        name: expression("event", ({ command }: EventContext) => String(command.payload["name"])),
      }),
    )
    .behavior(
      behavior(behaviorName("rename-order-dispatch-only"))
        .operation(operationId("renameOrder"))
        .headers({ "x-parity-dispatch-only": "on" })
        .condition((_input: MatchContext) => true)
        .dispatch({
          boundary: boundaryName("Receipt"),
          intent: "creation",
          operationId: operationId("createReceipt"),
          targetId: ({ command }: MatchContext) =>
            `${command.targetId ?? ""}-dispatch-only-receipt`,
          payload: {
            orderId: ({ command }: MatchContext) => command.targetId ?? "",
            amount: 1,
          },
        })
        .build(),
    )
    .behavior(
      behavior({
        name: behaviorName("rename-order"),
        operationId: operationId("renameOrder"),
        condition: (_input: MatchContext) => true,
        emit: eventType("OrderRenamed"),
      }),
    )
    .reducer(
      reducerRule(eventType("OrderRenamed"))
        .apply(({ state, event }) => ({ ...state, name: String(event.payload["name"]) }))
        .build(),
    );

  const receipt = boundary(
    boundaryName("Receipt"),
    contractPath(pathSegment("receipts"), pathParameter("id")),
  )
    .fallbackOverride(false)
    .identity({
      generate: expression("identity", ({ command }: IdentityContext) => String(command.targetId)),
    })
    .eventCatalog(
      event(eventType("ReceiptCreated"), {
        id: expression("event", ({ command }: EventContext) => String(command.targetId)),
        orderId: expression("event", ({ command }: EventContext) =>
          String(command.payload["orderId"]),
        ),
        amount: expression("event", ({ command }: EventContext) =>
          Number(command.payload["amount"]),
        ),
      }),
    )
    .behavior(
      behavior({
        name: behaviorName("create-receipt"),
        operationId: operationId("createReceipt"),
        condition: (_input: MatchContext) => true,
        emit: eventType("ReceiptCreated"),
      }),
    )
    .reducer(
      reducerRule(eventType("ReceiptCreated"))
        .apply(({ state, event }) => ({
          ...state,
          id: String(event.payload["id"]),
          orderId: String(event.payload["orderId"]),
          amount: Number(event.payload["amount"]),
        }))
        .build(),
    );

  const audit = boundary(
    boundaryName("Audit"),
    contractPath(pathSegment("audits"), pathParameter("id")),
  )
    .fallbackOverride(false)
    .identity({
      generate: expression("identity", ({ helpers }: IdentityContext) => helpers.uuid()),
    })
    .eventCatalog(
      event(eventType("AuditRecorded"), {
        id: expression("event", ({ helpers }: EventContext) => helpers.uuid()),
        orderId: expression("event", ({ command }: EventContext) =>
          String(command.payload["orderId"] ?? ""),
        ),
        action: "created",
      }),
    )
    .reducer(
      reducerRule(eventType("AuditRecorded"))
        .apply(({ state, event }) => ({
          ...state,
          id: String(event.payload["id"]),
          orderId: String(event.payload["orderId"]),
          action: String(event.payload["action"]),
        }))
        .build(),
    );

  return simulation()
    .boundary(order)
    .boundary(orderById)
    .boundary(receipt)
    .boundary(audit)
    .global(
      defineGlobal({
        idempotency: { enabled: true, ttlSeconds: 86400, hashIncludesBody: true },
        securityHeaders: {
          enabled: true,
          hsts: true,
          nosniff: true,
          frameDeny: true,
          referrerPolicy: "strict-origin-when-cross-origin",
          customHeaders: { "X-Parity-Fixture": "yaml-and-typescript" },
        },
        faults: [
          {
            name: faultName("parity-fault"),
            matches: ({ headers }: FaultContext) => headers["x-parity-fault"] === "on",
            response: {
              status: 503,
              body: { error: "PARITY_FAULT", message: "deliberate parity fixture fault" },
              headers: { "Retry-After": "5" },
            },
          },
        ],
        derivedProjections: [
          {
            name: "OrderSummary",
            key: expression(
              "projection",
              ({ event }: ProjectionContext) => event?.aggregateId ?? "",
            ),
            subscribe: ["Order:OrderCreated", "OrderById:OrderRenamed"],
            reduce: [
              reducerRule(eventType("OrderCreated"))
                .apply(({ state, event }) => ({
                  ...state,
                  name: String(event.payload["name"]),
                  renameCount: 0,
                }))
                .build(),
              reducerRule(eventType("OrderRenamed"))
                .apply(({ state, event }) => ({
                  ...state,
                  name: String(event.payload["name"]),
                  renameCount: Number(state.renameCount ?? 0) + 1,
                }))
                .build(),
            ],
          },
        ],
        reactions: [
          {
            name: "audit-order-creation",
            on: "Order:OrderCreated",
            intent: "creation",
            boundary: boundaryName("Audit"),
            emit: eventType("AuditRecorded"),
            payload: {
              orderId: ({ event }: PostCommitContext) => event?.aggregateId ?? "",
            },
          },
        ],
        webhooks: [
          {
            name: "order-created-hook",
            trigger: ({ event }: WebhookContext) => event?.type === "OrderCreated",
            url: "http://127.0.0.1:19878/order-hook",
            secret: WEBHOOK_SECRET,
            payload: {
              orderId: ({ event }: WebhookContext) => event?.aggregateId ?? "",
              event: ({ event }: WebhookContext) => event?.type ?? "",
              name: ({ payload }: WebhookContext) => String(payload["name"]),
            },
            retry: { maxAttempts: 1, delayMs: 1 },
          },
        ],
      }),
    )
    .build();
}

function setHeaders(
  test: ReturnType<PersistentAgent["post"]>,
  headers: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(headers)) test.set(name, value);
}

async function post(
  agent: PersistentAgent,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const test = agent.post(route);
  setHeaders(test, headers);
  return test.send(body as object);
}

async function patch(
  agent: PersistentAgent,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const test = agent.patch(route);
  setHeaders(test, headers);
  return test.send(body as object);
}

async function jsonGet(agent: PersistentAgent, route: string) {
  return agent.get(route);
}

async function reset(agent: PersistentAgent): Promise<void> {
  const response = await agent.post("/_admin/reset");
  expect(response.status).toBe(204);
}

async function drainSideEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const ORDER_BODY = {
  id: ORDER_ID,
  name: "Parity order",
  quantity: 3,
  internalNote: "not for API consumers",
};

function assertSuccessHeaders(headers: Record<string, string>): void {
  expect(headers["x-specmatic-result"]).toBe("success");
  expect(headers["etag"]).toBeTruthy();
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-parity-fixture"]).toBe("yaml-and-typescript");
}

function assertOrderResponse(body: JsonRecord): void {
  expect(body).toMatchObject({
    id: ORDER_ID,
    name: "Parity order",
    quantity: 3,
    status: "CREATED",
  });
  expect(body).not.toHaveProperty("internalNote");
  expect(body["_links"]).toBeDefined();
}

describe("YAML and TypeScript HTTP authoring parity", () => {
  let yamlDsl: YamlLinkedProgram;
  let tsDefinition: SimulationDefinition;
  let openapi: Awaited<ReturnType<typeof loadOpenApi>>;
  let yamlPath: BootedAuthoringPath;
  let tsPath: BootedAuthoringPath;

  beforeAll(async () => {
    openapi = await loadOpenApi(path.join(FIXTURE_DIR, "openapi/authoring-parity.yaml"));
    const yamlProgram = yamlProgramFixture();
    yamlDsl = await compileYamlFixture();
    tsDefinition = definition();

    const yamlDeliveries: RecordedDelivery[] = [];
    const tsDeliveries: RecordedDelivery[] = [];
    const yamlObservations: RuntimeTransportObservation[] = [];
    const tsObservations: RuntimeTransportObservation[] = [];
    const yamlSystem = await bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram,
      webhooks: recordingTransport(yamlDeliveries),
      observability: {
        observeTransportRequestResponse: (observation) => {
          yamlObservations.push(observation);
        },
        requestResponseCapture: { maxBytes: 8_192 },
      },
    });
    const tsSystem = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) => compileProgram(tsDefinition, { dependencies, openapi }),
      webhooks: recordingTransport(tsDeliveries),
      observability: {
        observeTransportRequestResponse: (observation) => {
          tsObservations.push(observation);
        },
        requestResponseCapture: { maxBytes: 8_192 },
      },
    });
    const yamlServer = await withPersistentServer(createRuntimeGateway(yamlSystem));
    const tsServer = await withPersistentServer(createRuntimeGateway(tsSystem));
    yamlPath = {
      name: "yaml",
      agent: yamlServer.agent,
      server: yamlServer,
      deliveries: yamlDeliveries,
      observations: yamlObservations,
    };
    tsPath = {
      name: "typescript",
      agent: tsServer.agent,
      server: tsServer,
      deliveries: tsDeliveries,
      observations: tsObservations,
    };
  }, 120_000);

  afterAll(async () => {
    await Promise.all([yamlPath?.server.close(), tsPath?.server.close()]);
  }, 30_000);

  beforeEach(async () => {
    await Promise.all([reset(yamlPath.agent), reset(tsPath.agent)]);
    yamlPath.deliveries.length = 0;
    tsPath.deliveries.length = 0;
    yamlPath.observations.length = 0;
    tsPath.observations.length = 0;
  });

  it("compares equivalent declarations and reports a real semantic mismatch", () => {
    const equivalent = compareDefinitions(yamlDsl, tsDefinition, { openapi });
    expect(equivalent.equal).toBe(true);
    expect(equivalent.differences).toEqual([]);

    const changed: SimulationDefinition = {
      ...tsDefinition,
      boundaries: tsDefinition.boundaries.map((item) =>
        item.boundary === "Order" ? { ...item, mask: [fieldPath(field("name"))] } : item,
      ),
    };
    const mismatch = compareDefinitions(yamlDsl, changed, { openapi });
    expect(mismatch.equal).toBe(false);
    expect(mismatch.differences.some((pathName: string) => pathName.includes("mask"))).toBe(true);
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s create has the expected body and HTTP headers", async (_label, getPath) => {
    const target = getPath();
    const response = await post(target.agent, "/orders", ORDER_BODY);

    expect(response.status).toBe(201);
    assertOrderResponse(response.body as JsonRecord);
    assertSuccessHeaders(response.headers as Record<string, string>);
  });

  it("both authoring paths produce the same client-visible create response", async () => {
    const [yamlResponse, tsResponse] = await Promise.all([
      post(yamlPath.agent, "/orders", ORDER_BODY),
      post(tsPath.agent, "/orders", ORDER_BODY),
    ]);

    expect(yamlResponse.status).toBe(tsResponse.status);
    expect(yamlResponse.body).toEqual(tsResponse.body);
    for (const response of [yamlResponse, tsResponse]) {
      assertOrderResponse(response.body as JsonRecord);
      assertSuccessHeaders(response.headers as Record<string, string>);
    }
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s observes the final direct response after all side effects", async (_label, getPath) => {
    const target = getPath();
    const traceId = `direct-parity-${target.name}`;
    const response = await post(
      target.agent,
      "/orders",
      { ...ORDER_BODY, id: `${ORDER_ID}-${target.name}-observed` },
      { "x-potemkin-trace-id": traceId },
    );
    expect(response.status).toBe(201);
    await drainSideEffects();

    const observation = target.observations.find(
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(
      target.observations.filter((candidate) => candidate.correlation.traceId === traceId),
    ).toHaveLength(1);
    expect(observation).toMatchObject({
      request: {
        method: "POST",
        path: "/orders",
        body: {
          captured: true,
          value: {
            name: "Parity order",
            quantity: 3,
            internalNote: "not for API consumers",
          },
        },
      },
      response: {
        status: 201,
        body: {
          captured: true,
          value: expect.objectContaining({
            id: `${ORDER_ID}-${target.name}-observed`,
            name: "Parity order",
            quantity: 3,
            status: "CREATED",
          }),
        },
      },
      correlation: { traceId },
    });
    expect(observation?.response.body.value).not.toHaveProperty("internalNote");
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s records primary, dispatch, reaction, and projection state", async (_label, getPath) => {
    const target = getPath();
    await post(target.agent, "/orders", ORDER_BODY);
    await drainSideEffects();

    const eventsResponse = await jsonGet(target.agent, "/_admin/events");
    expect(eventsResponse.status).toBe(200);
    const events = (
      eventsResponse.body as {
        events: Array<{ type: string; aggregateId: string; payload: JsonRecord }>;
      }
    ).events;
    expect(
      events.some(
        (eventRecord) =>
          eventRecord.type === "OrderCreated" && eventRecord.aggregateId === ORDER_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (eventRecord) =>
          eventRecord.type === "ReceiptCreated" && eventRecord.aggregateId === RECEIPT_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (eventRecord) =>
          eventRecord.type === "AuditRecorded" && eventRecord.payload.orderId === ORDER_ID,
      ),
    ).toBe(true);

    const stateResponse = await jsonGet(target.agent, "/_admin/state");
    const entities = (stateResponse.body as { entities: Record<string, JsonRecord> }).entities;
    expect(entities[ORDER_ID]).toMatchObject({
      id: ORDER_ID,
      name: "Parity order",
      quantity: 3,
      status: "CREATED",
    });
    expect(entities[ORDER_ID]?.internalNote).toBe("not for API consumers");
    expect(entities[RECEIPT_ID]).toMatchObject({ id: RECEIPT_ID, orderId: ORDER_ID, amount: 3 });

    const projectionResponse = await jsonGet(target.agent, "/_admin/derived/OrderSummary");
    expect(projectionResponse.status).toBe(200);
    expect((projectionResponse.body as Record<string, JsonRecord>)[ORDER_ID]).toMatchObject({
      name: "Parity order",
      renameCount: 0,
    });
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s applies response shaping without changing persisted state", async (_label, getPath) => {
    const target = getPath();
    await post(target.agent, "/orders", ORDER_BODY);
    const response = await jsonGet(target.agent, `/orders/${ORDER_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: ORDER_ID,
      name: "Parity order",
      quantity: 3,
      status: "CREATED",
    });
    expect(response.body).not.toHaveProperty("internalNote");
    expect((response.body as JsonRecord)["_links"]).toBeDefined();
    expect(response.headers["deprecation"]).toBe(new Date("2026-01-01T00:00:00Z").toUTCString());
    expect(response.headers["sunset"]).toBe(new Date("2027-01-01T00:00:00Z").toUTCString());
    expect(response.headers["link"]).toContain('rel="successor-version"');

    const stateResponse = await jsonGet(target.agent, "/_admin/state");
    const entity = (stateResponse.body as { entities: Record<string, JsonRecord> }).entities[
      ORDER_ID
    ];
    expect(entity?.internalNote).toBe("not for API consumers");
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s fault short-circuits before event/state mutation", async (_label, getPath) => {
    const target = getPath();
    const before = await jsonGet(target.agent, "/_admin/events");
    const beforeCount = (before.body as { events: unknown[] }).events.length;
    const response = await post(
      target.agent,
      "/orders",
      { ...ORDER_BODY, id: `${ORDER_ID}-fault` },
      { "x-parity-fault": "on" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: "PARITY_FAULT" });
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.headers["x-specmatic-result"]).toBe("failure");
    const after = await jsonGet(target.agent, "/_admin/events");
    expect((after.body as { events: unknown[] }).events).toHaveLength(beforeCount);
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s idempotency replays one response and one event", async (_label, getPath) => {
    const target = getPath();
    const key = `parity-idempotency-${target.name}`;
    const body = { ...ORDER_BODY, id: `${ORDER_ID}-${target.name}-idem` };
    const first = await post(target.agent, "/orders", body, { "idempotency-key": key });
    const second = await post(target.agent, "/orders", body, { "idempotency-key": key });
    const conflict = await post(
      target.agent,
      "/orders",
      { ...body, name: "different body" },
      { "idempotency-key": key },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["x-idempotency-replay"]).toBe("true");
    expect(conflict.status).toBe(409);
    expect(conflict.body.code ?? conflict.body.error).toBeTruthy();

    const eventsResponse = await jsonGet(target.agent, "/_admin/events");
    const events = (eventsResponse.body as { events: Array<{ type: string; aggregateId: string }> })
      .events;
    expect(
      events.filter(
        (eventRecord) => eventRecord.type === "OrderCreated" && eventRecord.aggregateId === body.id,
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s enforces optimistic concurrency and updates the projection", async (_label, getPath) => {
    const target = getPath();
    const created = await post(target.agent, "/orders", {
      ...ORDER_BODY,
      id: `${ORDER_ID}-${target.name}-concurrency`,
    });
    const id = `${ORDER_ID}-${target.name}-concurrency`;
    const initialEtag = created.headers["etag"];
    expect(initialEtag).toBeTruthy();

    const updated = await patch(
      target.agent,
      `/orders/${id}`,
      { name: "Renamed order" },
      { "if-match": initialEtag },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Renamed order");
    expect(updated.headers["etag"]).not.toBe(initialEtag);

    const stale = await patch(
      target.agent,
      `/orders/${id}`,
      { name: "Stale write" },
      { "if-match": initialEtag },
    );
    expect(stale.status).toBe(412);
    const stateResponse = await jsonGet(target.agent, "/_admin/state");
    const entity = (stateResponse.body as { entities: Record<string, JsonRecord> }).entities[id];
    expect(entity?.name).toBe("Renamed order");

    const projectionResponse = await jsonGet(target.agent, "/_admin/derived/OrderSummary");
    expect((projectionResponse.body as Record<string, JsonRecord>)[id]).toMatchObject({
      name: "Renamed order",
      renameCount: 1,
    });
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s serializes concurrent stale writes so exactly one wins", async (_label, getPath) => {
    const target = getPath();
    const id = `${ORDER_ID}-${target.name}-race`;
    const created = await post(target.agent, "/orders", { ...ORDER_BODY, id });
    const etag = created.headers["etag"];
    const [left, right] = await Promise.all([
      patch(target.agent, `/orders/${id}`, { name: "left" }, { "if-match": etag }),
      patch(target.agent, `/orders/${id}`, { name: "right" }, { "if-match": etag }),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 412]);
    const stateResponse = await jsonGet(target.agent, "/_admin/state");
    const finalName = (stateResponse.body as { entities: Record<string, JsonRecord> }).entities[id]
      ?.name;
    expect(["left", "right"]).toContain(finalName);
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])(
    "%s exposes response mutations and headers through /_engine/forward",
    async (_label, getPath) => {
      const target = getPath();
      const id = `${ORDER_ID}-${target.name}-forward`;
      const response = await target.agent.post("/_engine/forward").send({
        method: "POST",
        path: "/orders",
        headers: { "content-type": "application/json" },
        query: {},
        body: { ...ORDER_BODY, id },
      });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(201);
      expect(response.body.body).toHaveProperty("internalNote", "not for API consumers");
      expect(response.body.headers.etag).toBeTruthy();
      const sources = (response.body._patches ?? []).map(
        (patchRecord: { source: string }) => patchRecord.source,
      );
      expect(sources).toContain("mask");
      expect(sources).toContain("hateoas");
    },
  );

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s records a signed webhook after commit", async (_label, getPath) => {
    const target = getPath();
    const id = `${ORDER_ID}-${target.name}-webhook`;
    const response = await post(target.agent, "/orders", { ...ORDER_BODY, id });
    expect(response.status).toBe(201);
    await drainSideEffects();

    expect(target.deliveries).toHaveLength(1);
    const delivery = target.deliveries[0]!;
    expect(delivery.url).toBe("http://127.0.0.1:19878/order-hook");
    expect(JSON.parse(delivery.body)).toEqual({
      orderId: id,
      event: eventType("OrderCreated"),
      name: "Parity order",
    });
    const expectedSignature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(delivery.body).digest("hex")}`;
    expect(delivery.headers["x-potemkin-signature"]).toBe(expectedSignature);
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => tsPath],
  ])("%s reset restores an empty post-boot graph and event log", async (_label, getPath) => {
    const target = getPath();
    await post(target.agent, "/orders", { ...ORDER_BODY, id: `${ORDER_ID}-${target.name}-reset` });
    const before = await jsonGet(target.agent, "/_admin/events");
    expect((before.body as { events: unknown[] }).events.length).toBeGreaterThan(0);

    await reset(target.agent);
    const state = await jsonGet(target.agent, "/_admin/state");
    const events = await jsonGet(target.agent, "/_admin/events");
    const projection = await jsonGet(target.agent, "/_admin/derived/OrderSummary");
    expect(state.body).toEqual({ entities: {} });
    expect(events.body).toEqual({ events: [] });
    expect(projection.body).toEqual({});
  });
});
