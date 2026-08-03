import { compileRuntime } from "../../../src/model/compiler.js";
import { createRuntimeDataGenerator } from "../../../src/model/data.js";
import { createRuntimeEngine } from "../../../src/core/engine.js";
import type {
  RuntimeBoundary,
  RuntimeClock,
  RuntimeFault,
  RuntimeHelpers,
  RuntimeProgram,
} from "../../../src/model/runtime.js";
import type { Command, JsonObject } from "../../../src/types.js";

const helpers: RuntimeHelpers = {
  now: () => "2026-01-01T00:00:00.000Z",
  uuid: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
  random: () => 0,
  data: createRuntimeDataGenerator(() => 0),
  clone: <T>(value: T) => structuredClone(value),
};

const clock: RuntimeClock = {
  nowMs: () => 1_735_689_600_000,
  offsetMs: () => 0,
  advance: () => 0,
  reset: () => undefined,
};

function contract(): RuntimeProgram["dependencies"]["contract"] {
  return {
    operationIdFor: (_path, method) => (method === "POST" ? "createOrder" : "getOrder"),
  };
}

function request(
  command: Partial<Command>,
): Parameters<ReturnType<typeof createRuntimeEngine>["execute"]>[0] {
  const value: Command = {
    commandId: command.commandId ?? "command-1",
    boundary: command.boundary ?? "Order",
    intent: command.intent ?? "creation",
    targetId: command.targetId === undefined ? "order-1" : command.targetId,
    payload: command.payload ?? { id: "order-1", status: "new" },
    queryParams: command.queryParams ?? {},
    httpMethod: command.httpMethod ?? "POST",
    path: command.path ?? "/orders",
    origin: command.origin ?? "inbound",
    depth: command.depth ?? 0,
    ...command,
  };
  return { command: value, headers: {} };
}

function program(
  boundary: RuntimeBoundary,
  policies: Parameters<typeof compileRuntime>[0]["policies"] = {},
  dependencies: Partial<RuntimeProgram["dependencies"]> = {},
) {
  return compileRuntime(
    { boundaries: [boundary], policies },
    { contract: contract(), helpers, clock, ...dependencies },
  );
}

describe("source-independent runtime engine", () => {
  it("detaches mutable reducer context values from state and event storage", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: {
              id: ({ payload }) => payload.id,
              nested: ({ payload }) => payload.nested,
            },
          },
        ],
        behaviors: [
          { name: "create", operationId: "createOrder", emit: "OrderCreated" },
          { name: "read", operationId: "getOrder" },
        ],
        reducers: [
          {
            on: "OrderCreated",
            replaceState: true,
            apply: ({ state, event }) => {
              const stateNested = state["nested"];
              if (
                stateNested !== null &&
                typeof stateNested === "object" &&
                !Array.isArray(stateNested)
              ) {
                (stateNested as JsonObject)["tamperedByReducer"] = "state";
              }
              const eventNested = event.payload["nested"];
              if (
                eventNested !== null &&
                typeof eventNested === "object" &&
                !Array.isArray(eventNested)
              ) {
                (eventNested as JsonObject)["tamperedByReducer"] = "event";
              }
              return [{ op: "replace", path: "/processed", value: true }];
            },
          },
        ],
      }),
    );

    const created = await runtime.execute(
      request({ payload: { id: "order-1", nested: { value: "original" } } }),
    );
    expect(created.events[0]?.payload).toEqual({
      id: "order-1",
      nested: { value: "original" },
    });

    await expect(
      runtime.execute(
        request({
          operationId: "getOrder",
          intent: "query",
          httpMethod: "GET",
          targetId: "order-1",
        }),
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { id: "order-1", nested: { value: "original" }, processed: true },
    });
  });

  it("does not expose stored aggregate state to reducer inputs", async () => {
    let reducerInput: JsonObject | undefined;
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: {
              id: ({ payload }) => payload.id,
              nested: ({ payload }) => payload.nested,
            },
          },
          { type: "OrderUpdated", payload: {} },
        ],
        behaviors: [
          { name: "create", operationId: "createOrder", emit: "OrderCreated" },
          { name: "update", operationId: "updateOrder", emit: "OrderUpdated" },
          { name: "read", operationId: "getOrder" },
        ],
        reducers: [
          {
            on: "OrderCreated",
            reduce: ({ event }) => ({
              id: event.payload.id,
              nested: event.payload.nested,
            }),
          },
          {
            on: "OrderUpdated",
            reduce: ({ state }) => {
              reducerInput = state as JsonObject;
              return { ...state, updated: true };
            },
          },
        ],
      }),
    );

    await runtime.execute(request({ payload: { id: "order-1", nested: { items: ["initial"] } } }));
    await runtime.execute(
      request({
        commandId: "command-2",
        operationId: "updateOrder",
        intent: "mutation",
        payload: {},
      }),
    );

    const nested = reducerInput?.["nested"];
    expect(nested !== null && typeof nested === "object" && !Array.isArray(nested)).toBe(true);
    (nested as { items: string[] }).items.push("outside");

    await expect(
      runtime.execute(
        request({
          operationId: "getOrder",
          intent: "query",
          httpMethod: "GET",
          targetId: "order-1",
        }),
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { nested: { items: ["initial"] }, updated: true },
    });
  });

  it("executes identity, events, reducers, queries, and reset without YAML or CEL", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: { id: ({ payload }) => payload.id, status: ({ payload }) => payload.status },
          },
        ],
        behaviors: [
          { name: "create", operationId: "createOrder", emit: "OrderCreated" },
          { name: "read", operationId: "getOrder" },
        ],
        reducers: [
          {
            on: "OrderCreated",
            apply: ({ event }) => [
              { op: "replace", path: "/id", value: event.payload.id },
              { op: "replace", path: "/status", value: event.payload.status },
            ],
          },
        ],
      }),
    );

    const created = await runtime.execute(request({}));
    expect(created).toMatchObject({
      status: 201,
      committed: true,
      body: { id: "order-1", status: "new" },
    });
    expect(created.events).toHaveLength(1);
    expect(
      (
        await runtime.execute(
          request({
            intent: "query",
            httpMethod: "GET",
            operationId: "getOrder",
            targetId: "order-1",
          }),
        )
      ).body,
    ).toEqual({ id: "order-1", status: "new" });

    await runtime.reset();
    await expect(
      runtime.execute(
        request({
          intent: "query",
          httpMethod: "GET",
          operationId: "getOrder",
          targetId: "order-1",
        }),
      ),
    ).resolves.toMatchObject({ status: 404, body: { code: "ENTITY_ABSENCE" } });
  });

  it("applies every matching reducer in declaration order and emits every matching transition", async () => {
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [
            { type: "OrderCreated", payload: { id: ({ payload }) => payload.id } },
            { type: "OrderCreatedLater", payload: { id: ({ payload }) => payload.id } },
          ],
          behaviors: [
            {
              name: "create",
              operationId: "createOrder",
              emitWhen: [
                { when: () => true, event: "OrderCreated" },
                { when: () => true, event: "OrderCreatedLater" },
              ],
            },
          ],
          reducers: [
            { on: "OrderCreated", apply: () => [{ op: "replace", path: "/first", value: true }] },
            { on: "OrderCreated", apply: () => [{ op: "replace", path: "/second", value: true }] },
          ],
        },
        {
          derivedProjections: [
            {
              name: "orders",
              key: ({ event }) => event!.aggregateId,
              subscribe: ["OrderCreated"],
              reduce: [
                {
                  on: "OrderCreated",
                  apply: () => [{ op: "replace", path: "/first", value: true }],
                },
                {
                  on: "OrderCreated",
                  apply: () => [{ op: "replace", path: "/second", value: true }],
                },
              ],
            },
          ],
        },
      ),
    );

    const result = await runtime.execute(request({ payload: { id: "order-1" } }));
    expect(result.events.map((event) => event.type)).toEqual(["OrderCreated", "OrderCreatedLater"]);
    expect(
      (
        await runtime.execute(
          request({
            intent: "query",
            httpMethod: "GET",
            operationId: "getOrder",
            targetId: "order-1",
          }),
        )
      ).body,
    ).toMatchObject({ first: true, second: true });
    expect(runtime.snapshot().projections.orders).toEqual([
      ["order-1", { first: true, second: true }],
    ]);
  });

  it("keeps secondary dispatch and reactions inside one atomic transaction", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          { type: "OrderCreated", payload: { id: ({ payload }) => payload.id } },
          { type: "OrderRecorded", payload: { id: ({ payload }) => payload.id } },
        ],
        behaviors: [
          {
            name: "create",
            operationId: "createOrder",
            emit: "OrderCreated",
            dispatchCommands: [
              {
                boundary: "Order",
                intent: "mutation",
                operationId: "recordOrder",
                targetId: ({ command }) => command.targetId,
                payload: { id: ({ command }) => command.targetId },
              },
            ],
          },
          // Internal dispatch is selected by operationId; its transport method
          // is not the inbound HTTP method that authored this behavior.
          { name: "record", operationId: "recordOrder", method: "GET", emit: "OrderRecorded" },
        ],
        reducers: [
          {
            on: "OrderCreated",
            apply: ({ event }) => [{ op: "replace", path: "/id", value: event.payload.id }],
          },
          {
            on: "OrderRecorded",
            apply: ({ event, state }) => [
              { op: "replace", path: "/recorded", value: event.payload.id },
              { op: "replace", path: "/id", value: state.id ?? null },
            ],
          },
        ],
        reactions: [
          {
            on: "OrderCreated",
            boundary: "Order",
            emit: "OrderRecorded",
            target: ({ event }) => event?.aggregateId ?? null,
          },
        ],
      }),
    );

    const result = await runtime.execute(request({}));
    expect(result.committed).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "OrderCreated",
      "OrderRecorded",
      "OrderRecorded",
    ]);
    expect(
      (
        await runtime.execute(
          request({
            intent: "query",
            httpMethod: "GET",
            operationId: "getOrder",
            targetId: "order-1",
          }),
        )
      ).body,
    ).toMatchObject({ id: "order-1", recorded: "order-1" });
  });

  it("supports chaos probability, idempotency, optimistic concurrency, and response policy", async () => {
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          mask: ["/secret"],
          deprecated: { date: "2026-01-01" },
          eventCatalog: [
            {
              type: "OrderCreated",
              payload: { id: ({ payload }) => payload.id, secret: ({ payload }) => payload.secret },
            },
          ],
          behaviors: [
            {
              name: "create",
              operationId: "createOrder",
              emit: "OrderCreated",
              requiredScopes: ["orders:write"],
            },
          ],
          reducers: [{ on: "OrderCreated", replaceState: true }],
          faults: [
            {
              name: "outage",
              matches: ({ headers }) => headers["x-chaos"] === "on",
              probability: 1,
              response: { status: 503, body: { error: "outage" } },
            },
          ],
        },
        {
          idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
          auth: { authorize: () => true },
          securityHeaders: { enabled: true, nosniff: true },
        },
      ),
    );

    const chaos = await runtime.execute({ ...request({}), headers: { "x-chaos": "on" } });
    expect(chaos.status).toBe(503);

    const first = await runtime.execute({
      ...request({}),
      headers: { authorization: "Bearer alice", "idempotency-key": "same" },
      actor: { id: "alice", scopes: ["orders:write"] },
    });
    const replay = await runtime.execute({
      ...request({ commandId: "command-2" }),
      headers: { authorization: "Bearer alice", "idempotency-key": "same" },
      actor: { id: "alice", scopes: ["orders:write"] },
    });
    expect(first.events).toHaveLength(1);
    expect(replay.committed).toBe(false);
    expect(replay.events).toEqual(first.events);
    expect(first.headers).toMatchObject({
      Deprecation: "Thu, 01 Jan 2026 00:00:00 GMT",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("runs derived projections, signed webhooks, sagas and compensation after commit", async () => {
    const delivered: string[] = [];
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [{ on: "OrderCreated", replaceState: true }],
        },
        {
          derivedProjections: [
            {
              name: "orders",
              key: ({ event }) => event!.aggregateId,
              subscribe: ["OrderCreated"],
              reduce: [
                {
                  on: "OrderCreated",
                  apply: ({ event }) => [{ op: "replace", path: "/id", value: event.payload.id }],
                },
              ],
            },
          ],
          webhooks: [
            {
              name: "orders",
              trigger: () => true,
              url: () => "https://hooks.test/orders",
              secret: "secret",
              payload: { id: ({ event }) => event!.aggregateId },
            },
          ],
          sagas: [
            {
              name: "fulfil",
              trigger: { boundary: "Order", intent: "creation", condition: () => true },
              steps: [],
            },
          ],
        },
        {
          webhooks: {
            deliver: async ({ body }: { body: string }) => {
              delivered.push(body);
            },
          },
        },
      ),
    );

    const result = await runtime.execute(request({}));
    expect(result.committed).toBe(true);
    expect(runtime.snapshot().projections.orders).toEqual([["order-1", { id: "order-1" }]]);
    expect(delivered[0]).toContain("order-1");
  });

  it("stores seeds as baseline events, rebuilds projections, and enforces entity intent", async () => {
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          initialization: [{ id: "seed-1", status: "seeded" }],
          eventCatalog: [
            { type: "OrderUpdated", payload: { status: ({ payload }) => payload.status } },
          ],
          behaviors: [{ name: "update", operationId: "updateOrder", emit: "OrderUpdated" }],
          reducers: [
            {
              on: "OrderUpdated",
              apply: ({ event }) => [
                { op: "replace", path: "/status", value: event.payload.status },
              ],
            },
          ],
        },
        {
          derivedProjections: [
            {
              name: "orders",
              key: ({ event }) => event!.aggregateId,
              subscribe: ["BaselineEntityCreatedEvent"],
              reduce: [{ on: "BaselineEntityCreatedEvent", replaceState: true }],
            },
          ],
        },
      ),
    );

    await runtime.execute(
      request({ intent: "query", httpMethod: "GET", operationId: "getOrder", targetId: "seed-1" }),
    );
    expect(runtime.snapshot().events).toHaveLength(1);
    expect(runtime.snapshot().events[0]).toMatchObject({
      type: "BaselineEntityCreatedEvent",
      sequenceVersion: 1,
      aggregateId: "seed-1",
    });
    expect(runtime.snapshot().projections.orders).toEqual([
      ["seed-1", { id: "seed-1", status: "seeded" }],
    ]);
    await expect(
      runtime.execute(request({ intent: "creation", targetId: "seed-1" })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runtime.execute(request({ intent: "mutation", targetId: "missing" })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("supports query operators, sorting, cursors, sparse fields, and dry-run controls", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: { id: ({ payload }) => payload.id, score: ({ payload }) => payload.score },
          },
        ],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [{ on: "OrderCreated", replaceState: true }],
      }),
    );
    await runtime.execute(request({ targetId: "a", payload: { id: "a", score: 2 } }));
    await runtime.execute(
      request({ commandId: "command-2", targetId: "b", payload: { id: "b", score: 1 } }),
    );
    const page = await runtime.execute(
      request({
        intent: "query",
        httpMethod: "GET",
        operationId: "getOrder",
        targetId: null,
        queryParams: { "score:gte": "1", sort: "-score", limit: "1", fields: "score" },
      }),
    );
    expect(page.body).toMatchObject({
      items: [{ id: "a", score: 2 }],
      totalCount: 2,
      hasMore: true,
    });
    const dryRun = await runtime.execute({
      ...request({ commandId: "dry", targetId: "c", payload: { id: "c", score: 3 } }),
      controls: { dryRun: true },
    });
    expect(dryRun.committed).toBe(false);
    await expect(
      runtime.execute(
        request({ intent: "query", httpMethod: "GET", operationId: "getOrder", targetId: "c" }),
      ),
    ).resolves.toMatchObject({ status: 404, body: { code: "ENTITY_ABSENCE" } });
  });

  it("keeps request controls scoped to one request and exposes the runtime envelopes", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: {
              id: ({ payload }) => payload.id,
              createdAt: ({ helpers }) => helpers.now(),
            },
          },
        ],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [{ on: "OrderCreated", replaceState: true }],
      }),
    );

    const offset = await runtime.execute({
      ...request({ targetId: "offset-order", payload: { id: "offset-order" } }),
      controls: { clockOffsetMs: 60 * 60 * 1_000, includeEvents: true, echo: true },
    });
    expect(offset.body).toMatchObject({ _debug: { boundary: "Order", targetId: "offset-order" } });
    expect((offset.body as Record<string, unknown>)["_events"]).toHaveLength(1);
    const offsetEvent = (
      (offset.body as Record<string, unknown>)["_events"] as Array<Record<string, unknown>>
    )[0]!;
    expect(offsetEvent["timestamp"]).toBe("2026-01-01T01:00:00.000Z");

    const ordinary = await runtime.execute({
      ...request({
        commandId: "ordinary",
        targetId: "ordinary-order",
        payload: { id: "ordinary-order" },
      }),
      controls: { includeEvents: true },
    });
    const ordinaryEvent = (
      (ordinary.body as Record<string, unknown>)["_events"] as Array<Record<string, unknown>>
    )[0]!;
    expect(ordinaryEvent["timestamp"]).toBe("2026-01-01T00:00:00.000Z");

    const shaped = await runtime.execute({
      ...request({
        intent: "query",
        httpMethod: "GET",
        operationId: "getOrder",
        targetId: "offset-order",
      }),
      controls: { responseFormat: "hal" },
    });
    expect(shaped.body).toMatchObject({ _links: { self: { href: "/orders" } } });
  });

  it("uses the request seed for direct TypeScript UUID helpers", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: {
              id: ({ payload }) => payload.id,
              generatedId: ({ helpers }) => helpers.uuid(),
              generatedName: ({ helpers }) => helpers.data.person.firstName(),
            },
          },
        ],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [{ on: "OrderCreated", replaceState: true }],
      }),
    );

    const run = (commandId: string, targetId: string, seed: string) =>
      runtime.execute({
        ...request({ commandId, targetId, payload: { id: targetId } }),
        controls: { seed },
      });
    const first = await run("seed-one", "seed-one", "same-seed");
    const second = await run("seed-two", "seed-two", "same-seed");
    const third = await run("seed-three", "seed-three", "different-seed");

    expect(first.events[0]!.payload.generatedId).toBe(second.events[0]!.payload.generatedId);
    expect(first.events[0]!.payload.generatedName).toBe(second.events[0]!.payload.generatedName);
    expect(first.events[0]!.payload.generatedId).not.toBe(third.events[0]!.payload.generatedId);
    expect(first.events[0]!.payload.generatedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("distinguishes missing authentication from insufficient scopes", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
        behaviors: [
          {
            name: "create",
            operationId: "createOrder",
            emit: "OrderCreated",
            requiredScopes: ["orders:write"],
          },
        ],
        reducers: [{ on: "OrderCreated", replaceState: true }],
      }),
    );
    await expect(runtime.execute(request({}))).rejects.toMatchObject({
      status: 401,
      body: { code: "AUTHENTICATION_REQUIRED" },
      headers: { "WWW-Authenticate": "Bearer" },
    });
    await expect(
      runtime.execute({
        ...request({ commandId: "forbidden" }),
        actor: { id: "alice", scopes: ["orders:read"] },
      }),
    ).rejects.toMatchObject({ status: 403, body: { code: "AUTHORIZATION_DENIED" } });
    await expect(
      runtime.execute({
        ...request({ commandId: "allowed" }),
        actor: { id: "alice", scopes: ["orders:write"] },
      }),
    ).resolves.toMatchObject({ status: 201 });
  });

  it("does not let transport chaos replace authorization denial for an authenticated actor", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
        behaviors: [
          {
            name: "create",
            operationId: "createOrder",
            emit: "OrderCreated",
            requiredScopes: ["orders:write"],
          },
        ],
        reducers: [{ on: "OrderCreated", replaceState: true }],
      }),
    );

    await expect(
      runtime.execute({
        ...request({}),
        actor: { id: "alice", scopes: ["orders:read"] },
        controls: { forceStatus: 418, dropConnectionMs: 5 },
      }),
    ).rejects.toMatchObject({ status: 403, body: { code: "AUTHORIZATION_DENIED" } });
    expect(runtime.snapshot().events).toHaveLength(0);
    expect(runtime.snapshot().state).toHaveLength(0);
  });

  it("executes with the effective actor while preserving authenticated identity provenance", async () => {
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [{ on: "OrderCreated", replaceState: true }],
        },
        {
          auth: {
            authenticate: ({ headers }) =>
              headers.authorization === "Bearer admin-user:admin"
                ? { id: "admin-user", scopes: ["admin"] }
                : undefined,
          },
        },
      ),
    );

    const result = await runtime.execute({
      ...request({ targetId: "identity-order", payload: { id: "identity-order" } }),
      headers: { authorization: "Bearer admin-user:admin" },
      actor: { id: "effective-user", scopes: ["agent"] },
    });

    expect(result.events[0]!.request).toEqual(
      expect.objectContaining({
        actorId: "effective-user",
        actorScopes: ["agent"],
        originalActorId: "admin-user",
        originalActorScopes: ["admin"],
      }),
    );
  });

  it("applies the virtual clock to event helpers and resets it with the runtime", async () => {
    let offset = 0;
    const clock = {
      nowMs: () => Date.now() + offset,
      offsetMs: () => offset,
      advance: (milliseconds: number) => {
        offset += milliseconds;
        return offset;
      },
      reset: () => {
        offset = 0;
      },
    };
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [
            { type: "OrderCreated", payload: { createdAt: ({ helpers }) => helpers.now() } },
          ],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [{ on: "OrderCreated", replaceState: true }],
        },
        {},
        { clock },
      ),
    );

    await runtime.execute(request({ targetId: "first", payload: { id: "first" } }));
    clock.advance(3_600_000);
    await runtime.execute(
      request({ commandId: "second", targetId: "second", payload: { id: "second" } }),
    );
    expect(runtime.snapshot().events.at(-1)?.timestamp).toBe("2026-01-01T01:00:00.000Z");

    await runtime.reset();
    expect(clock.offsetMs()).toBe(0);
  });

  it("gives declarative chaos rules precedence over generic rate-limit and status defaults", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [{ on: "OrderCreated", replaceState: true }],
        faults: [
          {
            name: "custom-force-status",
            headers: { "x-potemkin-force-status": "418" },
            matches: ({ headers }) => headers["x-potemkin-force-status"] === "418",
            response: { status: 418, body: { error: "TEAPOT" } },
          },
        ],
      }),
    );

    const limited = await runtime.execute({
      ...request({ targetId: "limited" }),
      controls: { rateLimit: true },
    });
    expect(limited).toMatchObject({
      status: 429,
      body: { error: "TOO_MANY_REQUESTS" },
      events: [],
      committed: false,
    });
    const overridden = await runtime.execute({
      ...request({ targetId: "overridden" }),
      headers: { "x-potemkin-force-status": "418" },
      controls: { forceStatus: 500 },
    });
    expect(overridden).toMatchObject({
      status: 418,
      body: { error: "TEAPOT" },
      events: [],
      committed: false,
    });
  });

  it("matches named chaos selectors from direct TypeScript controls", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [{ on: "OrderCreated", replaceState: true }],
        faults: [
          {
            name: "maintenance",
            selectors: { forceResponse: "maintenance" },
            matches: () => true,
            response: { status: 503, body: { code: "MAINTENANCE" } },
          },
        ],
      }),
    );

    const result = await runtime.execute({
      ...request({ targetId: "maintenance-order" }),
      controls: { forceResponse: "maintenance" },
    });
    expect(result).toMatchObject({
      status: 503,
      body: { code: "MAINTENANCE" },
      committed: false,
      events: [],
    });
  });

  it("uses historical event metadata for read-at-version validators and conditionals", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [
          {
            type: "OrderCreated",
            payload: { id: ({ payload }) => payload.id, status: ({ payload }) => payload.status },
          },
          { type: "OrderUpdated", payload: { status: ({ payload }) => payload.status } },
        ],
        behaviors: [
          { name: "create", operationId: "createOrder", emit: "OrderCreated" },
          { name: "update", operationId: "updateOrder", emit: "OrderUpdated" },
          { name: "read", operationId: "getOrder" },
        ],
        reducers: [
          { on: "OrderCreated", replaceState: true },
          {
            on: "OrderUpdated",
            apply: ({ event }) => [{ op: "replace", path: "/status", value: event.payload.status }],
          },
        ],
      }),
    );

    await runtime.execute(
      request({
        commandId: "history-create",
        targetId: "history-order",
        payload: { id: "history-order", status: "created" },
      }),
    );
    await runtime.execute(
      request({
        commandId: "history-update",
        intent: "mutation",
        httpMethod: "PUT",
        operationId: "updateOrder",
        targetId: "history-order",
        payload: { status: "paid" },
      }),
    );

    const current = await runtime.execute(
      request({
        commandId: "history-current",
        intent: "query",
        httpMethod: "GET",
        operationId: "getOrder",
        targetId: "history-order",
      }),
    );
    expect(current).toMatchObject({
      body: { id: "history-order", status: "paid" },
      headers: { ETag: '"2"' },
    });

    const historical = await runtime.execute({
      ...request({
        commandId: "history-read",
        intent: "query",
        httpMethod: "GET",
        operationId: "getOrder",
        targetId: "history-order",
      }),
      headers: { "if-none-match": '"1"' },
      controls: { readAtVersion: 1 },
    });
    expect(historical).toMatchObject({ status: 304, body: null, headers: { ETag: '"1"' } });

    const historicalBody = await runtime.execute({
      ...request({
        commandId: "history-read-body",
        intent: "query",
        httpMethod: "GET",
        operationId: "getOrder",
        targetId: "history-order",
      }),
      controls: { readAtVersion: 1 },
    });
    expect(historicalBody).toMatchObject({
      status: 200,
      body: { id: "history-order", status: "created" },
      headers: { ETag: '"1"' },
    });
    expect(
      (
        await runtime.execute(
          request({
            commandId: "history-current-again",
            intent: "query",
            httpMethod: "GET",
            operationId: "getOrder",
            targetId: "history-order",
          }),
        )
      ).body,
    ).toMatchObject({ status: "paid" });
  });

  it("re-emits a historic event through the reducer and post-commit pipeline", async () => {
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [{ on: "OrderCreated", replaceState: true }],
        },
        {
          derivedProjections: [
            {
              name: "audit",
              key: ({ event }) => event!.aggregateId,
              subscribe: ["OrderCreated"],
              reduce: [
                {
                  on: "OrderCreated",
                  apply: ({ event }) => [
                    { op: "replace", path: "/lastEventId", value: event.eventId },
                  ],
                },
              ],
            },
          ],
        },
      ),
    );
    const created = await runtime.execute(
      request({ targetId: "replay-order", payload: { id: "replay-order" } }),
    );
    const original = created.events[0]!;
    const replayed = await runtime.execute({
      ...request({
        commandId: "replay-command",
        intent: "query",
        httpMethod: "GET",
        operationId: "getOrder",
        targetId: "replay-order",
      }),
      controls: { replayEvent: original.eventId },
    });

    expect(replayed).toMatchObject({ status: 200, committed: true, body: { id: "replay-order" } });
    expect(replayed.events).toHaveLength(1);
    expect(replayed.events[0]).toMatchObject({
      type: "OrderCreated",
      aggregateId: "replay-order",
      sequenceVersion: 2,
      causedBy: "replay-command",
    });
    expect(replayed.events[0]!.eventId).not.toBe(original.eventId);
    expect(runtime.snapshot().events).toHaveLength(2);
    expect(runtime.snapshot().projections.audit).toHaveLength(1);
  });

  it("restores the exact checkpoint when a transactional batch item fails", async () => {
    const runtime = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [{ on: "OrderCreated", replaceState: true }],
      }),
    );

    await expect(
      runtime.executeBatch(
        [
          request({
            commandId: "batch-1",
            targetId: "batch-order",
            payload: { id: "batch-order" },
          }),
          request({
            commandId: "batch-2",
            targetId: "batch-order",
            payload: { id: "batch-order" },
          }),
        ],
        { transactional: true },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(runtime.snapshot().events).toEqual([]);
    expect(runtime.snapshot().state).toEqual([]);
  });

  it("does not retain idempotency metadata for a rolled-back transactional item", async () => {
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [{ type: "OrderCreated", payload: { id: ({ payload }) => payload.id } }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [{ on: "OrderCreated", replaceState: true }],
        },
        { idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true } },
      ),
    );

    await expect(
      runtime.executeBatch(
        [
          {
            ...request({
              commandId: "idempotent-first",
              targetId: "idempotent-first",
              payload: { id: "idempotent-first" },
            }),
            headers: { "idempotency-key": "bulk-key" },
          },
          {
            ...request({
              commandId: "idempotent-fails",
              targetId: "idempotent-first",
              payload: { id: "idempotent-first" },
            }),
            headers: { "idempotency-key": "other-key" },
            actor: { id: "other", scopes: [] },
          },
        ],
        { transactional: true },
      ),
    ).rejects.toMatchObject({ status: 409 });

    const retried = await runtime.execute({
      ...request({
        commandId: "idempotent-retry",
        targetId: "idempotent-first",
        payload: { id: "idempotent-first" },
      }),
      headers: { "idempotency-key": "bulk-key" },
    });
    expect(retried).toMatchObject({ status: 201, committed: true });
    expect(retried.headers?.["X-Potemkin-Idempotency-Replay"]).toBeUndefined();
  });

  it("selects fallback rules and the forwarding port for unknown boundaries", async () => {
    const boundary: RuntimeBoundary = {
      boundary: "Order",
      contractPath: "/orders",
      eventCatalog: [],
      behaviors: [],
      reducers: [],
    };
    const fallback = createRuntimeEngine(
      program(boundary, {
        fallback: {
          rules: [
            {
              match: { method: "GET", path: "/orders/**", inContract: false },
              respond: { status: 410, body: { code: "GONE" }, headers: { "x-fallback": "rule" } },
            },
          ],
          default: { status: 404, body: { code: "DEFAULT" } },
        },
      }),
    );
    await expect(
      fallback.execute(
        request({ boundary: "Unknown", intent: "query", httpMethod: "GET", path: "/orders/old" }),
      ),
    ).resolves.toMatchObject({ status: 410, body: { code: "GONE" } });
    await expect(
      fallback.execute(
        request({ boundary: "Unknown", intent: "query", httpMethod: "POST", path: "/other" }),
      ),
    ).resolves.toMatchObject({ status: 404, body: { code: "DEFAULT" } });

    const forwarded = createRuntimeEngine(
      program(
        boundary,
        {},
        {
          forwarding: {
            forward: async () => ({ status: 202, body: { forwarded: true }, events: [] }),
          },
        },
      ),
    );
    await expect(
      forwarded.execute(request({ boundary: "Unknown", intent: "query", path: "/remote" })),
    ).resolves.toMatchObject({ status: 202, body: { forwarded: true } });
  });

  it("resolves payload, query, header, path, and generated identity keys", async () => {
    const variants: readonly [
      RuntimeBoundary["identity"],
      Partial<Command>,
      Record<string, string>,
      string,
    ][] = [
      [
        { key: { from: "payload", pointer: "/nested/id" } },
        { targetId: null, payload: { nested: { id: "p-1" } } },
        {},
        "p-1",
      ],
      [
        { key: { from: "query", name: "id" } },
        { targetId: null, queryParams: { id: "q-1" } },
        {},
        "q-1",
      ],
      [
        { key: { from: "header", name: "X-Entity" } },
        { targetId: null },
        { "X-Entity": "h-1" },
        "h-1",
      ],
      [
        { key: { from: "path", name: "id" } },
        { targetId: null, path: "/orders/path-1" },
        {},
        "path-1",
      ],
    ];
    for (const [identity, command, headers, expected] of variants) {
      const runtime = createRuntimeEngine(
        program({
          boundary: "Order",
          contractPath: "/orders/{id}",
          identity,
          eventCatalog: [{ type: "OrderCreated", payload: {} }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [],
        }),
      );
      const result = await runtime.execute({ ...request(command), headers });
      expect(result.events[0]?.aggregateId).toBe(expected);
    }

    const generated = createRuntimeEngine(
      program({
        boundary: "Order",
        contractPath: "/orders",
        eventCatalog: [{ type: "OrderCreated", payload: {} }],
        behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
        reducers: [],
      }),
    );
    await expect(generated.execute(request({ targetId: null }))).resolves.toMatchObject({
      events: [expect.objectContaining({ aggregateId: expect.stringMatching(/^id-/) })],
    });
  });

  it("handles session login/logout, CSRF enforcement, and authentication failures", async () => {
    let destroyed: string | undefined;
    const session = {
      create: () => ({
        id: "session-1",
        actor: { id: "actor-1", scopes: ["write"] },
        csrfToken: "csrf-1",
        expiresAt: 1_735_689_600_000,
      }),
      get: (id: string) =>
        id === "session-1"
          ? { id, actor: { id: "actor-1", scopes: ["write"] }, csrfToken: "csrf-1" }
          : undefined,
      destroy: (id: string) => {
        destroyed = id;
      },
    };
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [{ type: "OrderCreated", payload: {} }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [],
        },
        { auth: { mode: "session", session: { csrf: true, csrfHeader: "x-csrf" } } },
        { sessions: session },
      ),
    );
    const login = await runtime.execute(
      request({
        httpMethod: "POST",
        path: "/sessions",
        payload: { actorId: "actor-1", scopes: ["write", 7] },
      }),
    );
    expect(login).toMatchObject({
      status: 200,
      body: { sessionId: "session-1", csrfToken: "csrf-1" },
    });
    await expect(
      runtime.execute({
        ...request({ payload: { id: "order-1" } }),
        headers: { cookie: "sid=session-1" },
      }),
    ).rejects.toMatchObject({ status: 403, body: { code: "CSRF_TOKEN_INVALID" } });
    await expect(
      runtime.execute({
        ...request({ payload: { id: "order-1" } }),
        headers: { cookie: "sid=session-1", "x-csrf": "csrf-1" },
      }),
    ).resolves.toMatchObject({ status: 201 });
    await expect(
      runtime.execute({
        ...request({ httpMethod: "DELETE", path: "/sessions/current" }),
        headers: { cookie: "sid=session-1" },
      }),
    ).resolves.toMatchObject({ status: 204 });
    expect(destroyed).toBe("session-1");

    const authFailure = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [],
          behaviors: [],
          reducers: [],
        },
        {
          auth: {
            authenticate: () => {
              throw { code: "TOKEN_INVALID", message: "bad token" };
            },
          },
        },
      ),
    );
    await expect(authFailure.execute(request({ intent: "query" }))).rejects.toMatchObject({
      status: 401,
      body: { code: "TOKEN_INVALID" },
    });
  });

  it("keeps lifecycle, observation, metrics, tracing, and exporter failures non-fatal", async () => {
    const logs: string[] = [];
    const metrics: string[] = [];
    const phases: string[] = [];
    const runtime = createRuntimeEngine(
      program(
        {
          boundary: "Order",
          contractPath: "/orders",
          eventCatalog: [{ type: "OrderCreated", payload: {} }],
          behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
          reducers: [],
        },
        {
          lifecycle: {
            boot: () => {
              phases.push("boot");
            },
            validation: () => {
              phases.push("validation");
            },
            request: () => {
              phases.push("request");
            },
            commit: () => {
              phases.push("commit");
            },
            reset: () => {
              phases.push("reset");
            },
            shutdown: () => {
              phases.push("shutdown");
            },
          },
        },
        {
          observability: {
            trace: async (_name, run) => run(),
            log: (level, message) => logs.push(`${level}:${message}`),
            metric: (name) => metrics.push(name),
            observeRequestResponse: async () => {
              throw new Error("exporter unavailable");
            },
          },
        },
      ),
    );
    await runtime.start();
    await expect(runtime.execute(request({}))).resolves.toMatchObject({ status: 201 });
    await runtime.reset();
    await runtime.shutdown();
    expect(phases).toEqual(
      expect.arrayContaining(["boot", "validation", "request", "commit", "reset", "shutdown"]),
    );
    expect(metrics).toContain("runtime.commands.committed");
    expect(logs.some((entry) => entry.includes("observation failed"))).toBe(true);
  });

  it("applies the complete typed chaos and declarative fault precedence matrix", async () => {
    const baseBoundary: RuntimeBoundary = {
      boundary: "Order",
      contractPath: "/orders",
      eventCatalog: [{ type: "OrderCreated", payload: {} }],
      behaviors: [{ name: "create", operationId: "createOrder", emit: "OrderCreated" }],
      reducers: [],
    };
    const controls = [
      ["timeout", 504],
      ["throttle", 429],
      ["outage", 503],
      ["bad_gateway", 502],
      ["conflict", 409],
      ["auth", 401],
      ["forbidden", 403],
    ] as const;
    for (const [errorClass, status] of controls) {
      const runtime = createRuntimeEngine(program(baseBoundary, {}, { sleep: async () => {} }));
      await expect(
        runtime.execute({ ...request({}), controls: { errorClass } }),
      ).resolves.toMatchObject({ status, body: { errorClass } });
    }

    const generic = createRuntimeEngine(program(baseBoundary, {}, { sleep: async () => {} }));
    await expect(
      generic.execute({ ...request({}), controls: { forceStatus: 418, retryAfterSeconds: 2.9 } }),
    ).resolves.toMatchObject({
      status: 418,
      headers: { "Retry-After": "2" },
    });
    await expect(
      generic.execute({ ...request({}), controls: { dropConnectionMs: 0 } }),
    ).resolves.toMatchObject({ status: 504, connectionClosed: true });
    await expect(
      generic.execute({ ...request({}), controls: { rateLimit: true, retryAfterSeconds: 4 } }),
    ).resolves.toMatchObject({ status: 429, headers: { "Retry-After": "4" } });
    await expect(
      generic.execute({ ...request({}), controls: { signal: "rate_limit" } }),
    ).resolves.toMatchObject({ status: 429 });
    await expect(
      generic.execute({ ...request({}), controls: { successRate: 0 } }),
    ).resolves.toMatchObject({ status: 503, body: { error: "SUCCESS_RATE_GATE" } });

    const guard = {
      name: "guard",
      check: () => true,
      errorCode: "GUARD",
      errorMessage: "guard",
    };
    const headerFault: RuntimeFault = {
      name: "header-fault",
      headers: { "x-test": "present", "x-mode": "*" },
      selectors: {
        signal: "fault",
        forceResponse: "named",
        scenario: "scenario-1",
        featureFlag: "flag-1",
        errorClass: "conflict",
      },
      requiredScopes: ["write"],
      requires: [guard],
      probability: 1,
      matches: () => true,
      response: { status: 520, body: { code: "HEADER_FAULT" } },
    };
    const declarative = createRuntimeEngine(
      program({ ...baseBoundary, faults: [headerFault] }, {}, { sleep: async () => {} }),
    );
    const matchingRequest = {
      ...request({}),
      actor: { id: "actor-1", scopes: ["write"] },
      headers: { "x-test": "yes", "x-mode": "anything" },
      controls: {
        signal: "fault" as const,
        forceResponse: "named",
        scenario: "scenario-1",
        featureFlag: "flag-1",
        errorClass: "conflict" as const,
      },
    };
    await expect(declarative.execute(matchingRequest)).resolves.toMatchObject({
      status: 520,
      body: { code: "HEADER_FAULT" },
    });
    await expect(
      declarative.execute({ ...matchingRequest, headers: { "x-test": "no" } }),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      declarative.execute({
        ...matchingRequest,
        controls: { ...matchingRequest.controls, useFault: "header-fault" },
      }),
    ).resolves.toMatchObject({ status: 520 });

    const throwingFault = createRuntimeEngine(
      program(
        {
          ...baseBoundary,
          faults: [
            {
              name: "throws",
              matches: () => {
                throw new Error("fault predicate failed");
              },
              response: { status: 520 },
            },
          ],
        },
        {},
        { sleep: async () => {} },
      ),
    );
    await expect(throwingFault.execute(request({}))).resolves.toMatchObject({ status: 201 });
  });
});
