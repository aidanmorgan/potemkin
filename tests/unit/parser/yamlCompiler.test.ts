import { compileYaml } from "../../../src/parser/yamlParser.js";
import { compileYamlModel } from "../../../src/parser/yamlCompiler.js";
import { createRuntimeDataGenerator } from "../../../src/model/data.js";
import { createRuntimeEngine } from "../../../src/core/engine.js";
import type { RuntimeClock, RuntimeHelpers, RuntimeProgram } from "../../../src/model/runtime.js";
import type { Command } from "../../../src/types.js";
import { readFileSync } from "node:fs";

const helpers: RuntimeHelpers = {
  now: () => "2026-01-01T00:00:00.000Z",
  uuid: () => "generated-order",
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

function command(overrides: Partial<Command> = {}): Command {
  return {
    commandId: "command-1",
    boundary: "Order",
    intent: "creation",
    targetId: "order-1",
    payload: { id: "order-1", status: "new" },
    queryParams: {},
    httpMethod: "POST",
    path: "/orders",
    origin: "inbound",
    depth: 0,
    ...overrides,
  };
}

function dependencies(): RuntimeProgram["dependencies"] {
  return {
    helpers,
    clock,
    contract: {
      operationIdFor: (_path, method) => (method === "POST" ? "createOrder" : "getOrder"),
    },
  };
}

describe("YAML parser compiler", () => {
  it("turns CEL/YAML declarations into the same callback runtime program used by TypeScript", async () => {
    const dsl = await compileYaml([
      {
        name: "orders.yaml",
        yaml: `
boundary: Order
contract_path: /orders
behaviors:
  - name: create
    match:
      operationId: createOrder
      condition: "payload.status == 'new'"
    emit: OrderCreated
reducers:
  - on: OrderCreated
    patches:
      - op: replace
        path: /id
        value: "\${event.payload.id}"
      - op: replace
        path: /status
        value: "\${event.payload.status}"
event_catalog:
  - type: OrderCreated
    payload_template:
      id: "payload.id"
      status: "payload.status"
`,
      },
    ]);
    const program = compileYamlModel(dsl, { dependencies: dependencies() });
    expect(program.boundaries[0]?.behaviors[0]?.condition).toBeInstanceOf(Function);
    expect(program.boundaries[0]?.reducers[0]?.apply).toBeInstanceOf(Function);

    const runtime = createRuntimeEngine(program);
    const result = await runtime.execute({ command: command(), headers: {} });
    expect(result).toMatchObject({ status: 201, body: { id: "order-1", status: "new" } });
    expect(result.events[0]?.payload).toEqual({ id: "order-1", status: "new" });
  });

  it("retains global chaos, projection, webhook, idempotency, security, and dispatch policy", async () => {
    const fixture = "/Users/aidan/dev/bankwest/potemkin/tests/fixtures/authoring-parity/dsl";
    const dsl = await compileYaml(
      ["order.yaml", "receipt.yaml"].map((name) => ({
        name,
        yaml: readFileSync(`${fixture}/${name}`, "utf8"),
      })),
      readFileSync(`${fixture}/global.yaml`, "utf8"),
    );
    const deliveries: string[] = [];
    const program = compileYamlModel(dsl, {
      dependencies: {
        ...dependencies(),
        webhooks: {
          deliver: async ({ body }) => {
            deliveries.push(body);
          },
        },
      },
    });
    const runtime = createRuntimeEngine(program);
    const result = await runtime.execute({
      command: command(),
      headers: {},
    });
    expect(result.events.map((event) => event.type)).toEqual(["OrderCreated", "ReceiptCreated"]);
    expect(runtime.snapshot().projections.OrderSummary).toBeDefined();
    expect(deliveries).toHaveLength(1);
    expect(result.headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });

    const fault = await runtime.execute({
      command: command({ commandId: "fault", targetId: "order-2" }),
      headers: { "x-parity-fault": "on" },
    });
    expect(fault.status).toBe(503);
  });

  it("applies request-local seeds and the runtime virtual clock to YAML expressions", async () => {
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
    const dsl = await compileYaml([
      {
        name: "seeded.yaml",
        yaml: `
boundary: Seeded
contract_path: /seeded
event_catalog:
  - type: SeededCreated
    payload_template:
      id: command.payload.id
      name: "$fake('person.firstName')"
      generatedAt: "$now()"
behaviors:
  - name: create
    match: { operationId: createSeeded, condition: "true" }
    emit: SeededCreated
reducers:
  - on: SeededCreated
    replace_state: true
`,
      },
    ]);
    const program = compileYamlModel(dsl, { dependencies: { ...dependencies(), clock } });
    const runtime = createRuntimeEngine(program);

    const first = await runtime.execute({
      command: command({
        boundary: "Seeded",
        operationId: "createSeeded",
        targetId: "seeded-1",
        payload: { id: "seeded-1" },
      }),
      headers: {},
      controls: { seed: "same-seed" },
    });
    const second = await runtime.execute({
      command: command({
        commandId: "command-2",
        boundary: "Seeded",
        operationId: "createSeeded",
        targetId: "seeded-2",
        payload: { id: "seeded-2" },
      }),
      headers: {},
      controls: { seed: "same-seed" },
    });
    expect((first.events[0]!.payload as Record<string, unknown>).name).toBe(
      (second.events[0]!.payload as Record<string, unknown>).name,
    );

    clock.advance(60_000);
    const shifted = await runtime.execute({
      command: command({
        commandId: "command-3",
        boundary: "Seeded",
        operationId: "createSeeded",
        targetId: "seeded-3",
        payload: { id: "seeded-3" },
      }),
      headers: {},
      controls: { clockOffsetMs: 10_000 },
    });
    expect((shifted.events[0]!.payload as Record<string, unknown>).generatedAt).toBe(
      "2026-01-01T00:01:10.000Z",
    );
  });
});
