import {
  boundaryName,
  behaviorName,
  contractPath,
  eventReference,
  eventType,
  operationId,
  pathSegment,
  projectionName,
} from "../../src/authoring/references.js";
import http from "node:http";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { MAX_RUNTIME_DELAY_MS } from "../../src/model/runtime.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import {
  boundary,
  compileProgram,
  defineGlobal,
  event,
  simulation,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type { EventContext, RuntimeTransportObservation } from "../../src/model/runtime.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: Direct chaos parity, version: "1.0.0" }
paths:
  /items:
    post:
      operationId: createItem
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Item" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Item" }
components:
  schemas:
    Item:
      type: object
      required: [id]
      properties:
        id: { type: string }
`;

const YAML = `
boundary: Item
contract_path: /items
identity:
  creation:
    generate: command.payload.id
event_catalog:
  - type: ItemCreated
    payload_template:
      id: command.payload.id
behaviors:
  - name: create-item
    match: { operationId: createItem, condition: "true" }
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

const YAML_GLOBAL = `
idempotency:
  enabled: true
  ttl_seconds: 60
  hash_includes_body: true
derived_projections:
  - name: ItemSummary
    key: event.aggregateId
    subscribe: ["Item:ItemCreated"]
    reduce:
      - on: ItemCreated
        patches:
          - { op: replace, path: /id, value: "\${event.payload.id}" }
          - { op: replace, path: /committed, value: "\${true}" }
`;

function directDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName("Item"), contractPath(pathSegment("items")))
        .identity({ generate: ({ command }) => String(command.payload.id) })
        .eventCatalog(
          event(eventType("ItemCreated"), {
            id: ({ payload }: EventContext) => String(payload.id),
          }),
        )
        .behavior({
          name: behaviorName("create-item"),
          operationId: operationId("createItem"),
          condition: () => true,
          emit: eventType("ItemCreated"),
        })
        .reducer(
          reducerRule(eventType("ItemCreated"))
            .apply(({ state, event: emitted }) => ({ ...state, id: emitted.payload.id }))
            .build(),
        )
        .build(),
    )
    .global(
      defineGlobal({
        idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
        derivedProjections: [
          {
            name: projectionName("ItemSummary"),
            key: ({ event: emitted }) => emitted?.aggregateId ?? "",
            subscribe: [eventReference(boundaryName("Item"), eventType("ItemCreated"))],
            reduce: [
              reducerRule(eventType("ItemCreated"))
                .apply(({ state, event: emitted }) => ({
                  ...state,
                  id: String(emitted.payload.id),
                  committed: true,
                }))
                .build(),
            ],
          },
        ],
      }),
    )
    .build();
}

let observations: [RuntimeTransportObservation[], RuntimeTransportObservation[]];
let delays: [number[], number[]];

function recordingSleep(target: number[]): (milliseconds: number) => Promise<void> {
  return async (milliseconds) => {
    target.push(milliseconds);
    // Keep the positive-delay assertion real while avoiding a 30-second test
    // when proving the upper bound with an injected runtime port.
    if (milliseconds < MAX_RUNTIME_DELAY_MS)
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  };
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [{ name: "item.yaml", yaml: YAML }],
        globalYaml: YAML_GLOBAL,
      },
      observability: {
        observeTransportRequestResponse: (observation) => {
          observations[0].push(observation);
        },
        requestResponseCapture: { maxBytes: 1_024 },
      },
      sleep: recordingSleep(delays[0]),
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(directDefinition(), { dependencies, openapi }),
      observability: {
        observeTransportRequestResponse: (observation) => {
          observations[1].push(observation);
        },
        requestResponseCapture: { maxBytes: 1_024 },
      },
      sleep: recordingSleep(delays[1]),
    }),
  ]);
}

async function listen(app: ReturnType<typeof createRuntimeGateway>): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  return server;
}

async function closeServer(server: http.Server): Promise<void> {
  // A dropped request can leave an active socket behind even after the client
  // observes ECONNRESET. Close those sockets before waiting for the listener
  // so the test process cannot retain a handle after the assertion completes.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((closeError) => (closeError === undefined ? resolve() : reject(closeError))),
  );
}

async function requestWithDroppedConnection(
  server: http.Server,
  traceId: string,
  delayMs: number,
  options: Readonly<{ id?: string; headers?: Readonly<Record<string, string>> }> = {},
): Promise<NodeJS.ErrnoException | undefined> {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP listener address");
  const body = JSON.stringify({ id: options.id ?? "dropped" });
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/items",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-potemkin-drop-connection": String(delayMs),
          "x-potemkin-trace-id": traceId,
          ...options.headers,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          reject(
            new Error(`Expected a dropped connection, received HTTP ${response.statusCode ?? 0}`),
          ),
        );
      },
    );
    client.once("error", (error: NodeJS.ErrnoException) => resolve(error));
    client.once("timeout", () => reject(new Error("Timed out waiting for dropped connection")));
    client.end(body);
  });
}

async function waitForObservation(
  values: readonly RuntimeTransportObservation[],
  predicate: (observation: RuntimeTransportObservation) => boolean,
): Promise<RuntimeTransportObservation> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = values.find(predicate);
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected transport observation, received ${values.length}`);
}

describe("direct TCP chaos parity", () => {
  let systems: [RuntimeSystem, RuntimeSystem];

  beforeEach(async () => {
    observations = [[], []];
    delays = [[], []];
    systems = await bootPair();
  });
  afterEach(async () => {
    await Promise.all(systems.map((system) => system.dispose()));
  });

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s drops the real HTTP connection without committing state",
    async (_name, index) => {
      const system = systems[index]!;
      const server = await listen(createRuntimeGateway(system));
      try {
        const traceId = `direct-drop-${_name}`;
        const error = await requestWithDroppedConnection(server, traceId, 0);
        expect(error?.code).toMatch(/ECONNRESET|EPIPE|ERR_HTTP2_STREAM_CANCEL/);
        const observation = await waitForObservation(
          observations[index]!,
          (candidate) => candidate.correlation.traceId === traceId,
        );
        expect(observation).toMatchObject({
          request: { method: "POST", path: "/items" },
          response: { connectionClosed: true },
          correlation: { traceId },
        });
        expect(system.engine.snapshot().events).toHaveLength(0);
        await request(createRuntimeGateway(system))
          .post("/items")
          .send({ id: "healthy" })
          .expect(201, { id: "healthy" });
        expect(system.engine.snapshot().events).toHaveLength(1);
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s does not persist idempotency or projection state for a direct connection drop",
    async (_name, index) => {
      const system = systems[index]!;
      const server = await listen(createRuntimeGateway(system));
      try {
        const key = `direct-drop-state-${_name}`;
        const droppedId = `dropped-${_name}`;
        const error = await requestWithDroppedConnection(server, `direct-drop-state-${_name}`, 0, {
          id: droppedId,
          headers: { "idempotency-key": key },
        });
        expect(error?.code).toMatch(/ECONNRESET|EPIPE|ERR_HTTP2_STREAM_CANCEL/);
        expect(system.engine.snapshot().events).toHaveLength(0);
        expect(system.engine.snapshot().projections.ItemSummary).toBeUndefined();

        const committed = await request(createRuntimeGateway(system))
          .post("/items")
          .set("idempotency-key", key)
          .send({ id: droppedId })
          .expect(201, { id: droppedId });
        expect(committed.headers["x-idempotency-replay"]).toBeUndefined();

        const replay = await request(createRuntimeGateway(system))
          .post("/items")
          .set("idempotency-key", key)
          .send({ id: droppedId })
          .expect(201, { id: droppedId });
        expect(replay.headers["x-idempotency-replay"]).toBe("true");
        expect(system.engine.snapshot().events).toHaveLength(1);
        expect(system.engine.snapshot().projections.ItemSummary).toEqual([
          [droppedId, { id: droppedId, committed: true }],
        ]);
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s waits for a positive drop delay, then closes without committing state",
    async (_name, index) => {
      const system = systems[index]!;
      const server = await listen(createRuntimeGateway(system));
      try {
        const traceId = `direct-drop-positive-${_name}`;
        const started = Date.now();
        const error = await requestWithDroppedConnection(server, traceId, 25);
        expect(error?.code).toMatch(/ECONNRESET|EPIPE|ERR_HTTP2_STREAM_CANCEL/);
        expect(Date.now() - started).toBeGreaterThanOrEqual(20);
        const observation = await waitForObservation(
          observations[index]!,
          (candidate) => candidate.correlation.traceId === traceId,
        );
        expect(observation.response.connectionClosed).toBe(true);
        expect(system.engine.snapshot().events).toHaveLength(0);
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s accepts the maximum bounded drop delay without committing state",
    async (_name, index) => {
      const system = systems[index]!;
      const server = await listen(createRuntimeGateway(system));
      try {
        const traceId = `direct-drop-maximum-${_name}`;
        const error = await requestWithDroppedConnection(server, traceId, MAX_RUNTIME_DELAY_MS);
        expect(error?.code).toMatch(/ECONNRESET|EPIPE|ERR_HTTP2_STREAM_CANCEL/);
        expect(delays[index]).toContain(MAX_RUNTIME_DELAY_MS);
        expect(system.engine.snapshot().events).toHaveLength(0);
      } finally {
        await closeServer(server);
      }
    },
  );
});
