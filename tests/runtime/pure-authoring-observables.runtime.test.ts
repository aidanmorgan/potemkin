import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from "../../src/authoring/references.js";
/**
 * Pure-format parity trace.
 *
 * Each system is booted from exactly one authoring format. The requests are
 * replayed independently, then the client-visible and admin observables are
 * compared as an equivalence trace. This keeps the test useful for future
 * model-based conformance work without allowing either boot to consume the
 * other format.
 */

import { bootRuntime } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { loadOpenApi } from "../../src/contract/loader.js";
import {
  boundary,
  compileProgram,
  event,
  expression,
  simulation,
  type SimulationDefinition,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type { EventContext, IdentityContext, MatchContext } from "../../src/model/runtime.js";
import { compareEquivalenceTrace } from "../equivalence/comparator.js";
import type { EquivalenceResponse, EquivalenceStep } from "../equivalence/types.js";
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from "../_support/persistentAgent.js";

const OPENAPI = `
openapi: "3.0.3"
info:
  title: Pure authoring observable parity
  version: "1.0.0"
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WidgetInput"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
components:
  schemas:
    WidgetInput:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
    Widget:
      type: object
      required: [id, name, status]
      properties:
        id: { type: string }
        name: { type: string }
        status: { type: string }
`;

const YAML_DSL = `
boundary: Widget
contract_path: /widgets
fallback_override: false
identity:
  creation:
    generate: command.payload.id
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: command.payload.id
      name: command.payload.name
      status: "'READY'"
behaviors:
  - name: create-widget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

function definition(): SimulationDefinition {
  return simulation()
    .boundary(
      boundary(boundaryName("Widget"), contractPath(pathSegment("widgets")))
        .fallbackOverride(false)
        .identity({
          generate: expression("identity", ({ command }: IdentityContext) =>
            String(command.payload["id"]),
          ),
        })
        .eventCatalog(
          event(eventType("WidgetCreated"), {
            id: expression("event", ({ command }: EventContext) => String(command.payload["id"])),
            name: expression("event", ({ command }: EventContext) =>
              String(command.payload["name"]),
            ),
            status: "READY",
          }),
        )
        .behavior({
          name: behaviorName("create-widget"),
          operationId: operationId("createWidget"),
          condition: (_input: MatchContext) => true,
          emit: eventType("WidgetCreated"),
        })
        .reducer(
          reducerRule(eventType("WidgetCreated"))
            .apply(({ state, event }) => ({
              ...state,
              id: String(event.payload["id"]),
              name: String(event.payload["name"]),
              status: String(event.payload["status"]),
            }))
            .build(),
        ),
    )
    .build();
}

interface BootedPath {
  readonly name: "yaml" | "typescript";
  readonly server: PersistentServer;
  readonly agent: PersistentAgent;
}

interface TraceResult {
  readonly create: EquivalenceResponse;
  readonly events: EquivalenceResponse;
  readonly state: EquivalenceResponse;
  readonly forward: EquivalenceResponse;
}

interface EventAdminBody {
  readonly events: readonly Record<string, unknown>[];
}

interface StateAdminBody {
  readonly entities: Record<string, Record<string, unknown>>;
}

function responseOf(response: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}): EquivalenceResponse {
  return {
    status: response.status,
    headers: { "x-specmatic-result": response.headers["x-specmatic-result"] ?? "" },
    body: response.body as EquivalenceResponse["body"],
  };
}

async function runTrace(agent: PersistentAgent): Promise<TraceResult> {
  await agent.post("/_admin/reset").expect(204);
  const create = await agent
    .post("/widgets")
    .send({ id: "widget-001", name: "Desk lamp" })
    .expect(201);
  const events = await agent.get("/_admin/events").expect(200);
  const state = await agent.get("/_admin/state").expect(200);
  const forward = await agent
    .post("/_engine/forward")
    .send({
      method: "POST",
      path: "/widgets",
      headers: { "content-type": "application/json" },
      query: {},
      body: { id: "widget-002", name: "Notebook" },
    })
    .expect(200);

  return {
    create: responseOf(create),
    events: responseOf(events),
    state: responseOf(state),
    forward: responseOf(forward),
  };
}

function asSteps(trace: TraceResult): readonly EquivalenceStep[] {
  return [
    {
      operation: "createWidget",
      request: { method: "POST", path: "/widgets", body: { id: "widget-001", name: "Desk lamp" } },
      model: trace.create,
      real: trace.create,
    },
    {
      operation: "events",
      request: { method: "GET", path: "/_admin/events" },
      model: trace.events,
      real: trace.events,
    },
    {
      operation: "state",
      request: { method: "GET", path: "/_admin/state" },
      model: trace.state,
      real: trace.state,
    },
    {
      operation: "forward",
      request: { method: "POST", path: "/_engine/forward" },
      model: trace.forward,
      real: trace.forward,
    },
  ];
}

function semanticResponse(operation: string, response: EquivalenceResponse): EquivalenceResponse {
  if (
    operation === "events" &&
    response.body !== null &&
    typeof response.body === "object" &&
    !Array.isArray(response.body)
  ) {
    const body = response.body as { readonly events?: readonly Record<string, unknown>[] };
    return {
      ...response,
      body: {
        events: (body.events ?? []).map((eventRecord) => ({
          type: String(eventRecord.type ?? ""),
          aggregateId: String(eventRecord.aggregateId ?? ""),
          payload: eventRecord.payload ?? null,
        })),
      } as EquivalenceResponse["body"],
    };
  }
  return response;
}

describe("pure YAML and pure TypeScript observable traces", () => {
  let yamlPath: BootedPath;
  let typescriptPath: BootedPath;

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const yamlSystem = await bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: "widget.yaml", yaml: YAML_DSL }] },
    });
    const typescriptSystem = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) => compileProgram(definition(), { dependencies, openapi }),
    });
    const yamlServer = await withPersistentServer(createRuntimeGateway(yamlSystem));
    const typescriptServer = await withPersistentServer(createRuntimeGateway(typescriptSystem));
    yamlPath = { name: "yaml", server: yamlServer, agent: yamlServer.agent };
    typescriptPath = {
      name: "typescript",
      server: typescriptServer,
      agent: typescriptServer.agent,
    };
  }, 120_000);

  afterAll(async () => {
    await Promise.all([yamlPath?.server.close(), typescriptPath?.server.close()]);
  }, 30_000);

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => typescriptPath],
  ])("%s independently produces the complete observable trace", async (_name, getPath) => {
    const trace = await runTrace(getPath().agent);
    expect(trace.create.body).toEqual({ id: "widget-001", name: "Desk lamp", status: "READY" });
    const eventsBody = trace.events.body as unknown as EventAdminBody;
    const stateBody = trace.state.body as unknown as StateAdminBody;
    expect(eventsBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "WidgetCreated", aggregateId: "widget-001" }),
      ]),
    );
    expect(stateBody.entities["widget-001"]).toEqual({
      id: "widget-001",
      name: "Desk lamp",
      status: "READY",
    });
    expect(trace.forward.body).toMatchObject({
      status: 201,
      body: { id: "widget-002", name: "Notebook", status: "READY" },
    });
    expect(compareEquivalenceTrace(asSteps(trace)).conforms).toBe(true);
  });

  it("replays the same request trace through both pure boots and compares the observables", async () => {
    const [yamlTrace, typescriptTrace] = await Promise.all([
      runTrace(yamlPath.agent),
      runTrace(typescriptPath.agent),
    ]);

    const comparison = compareEquivalenceTrace([
      {
        operation: "createWidget",
        request: { method: "POST", path: "/widgets" },
        model: yamlTrace.create,
        real: typescriptTrace.create,
      },
      {
        operation: "events",
        request: { method: "GET", path: "/_admin/events" },
        model: semanticResponse("events", yamlTrace.events),
        real: semanticResponse("events", typescriptTrace.events),
      },
      {
        operation: "state",
        request: { method: "GET", path: "/_admin/state" },
        model: yamlTrace.state,
        real: typescriptTrace.state,
      },
      {
        operation: "forward",
        request: { method: "POST", path: "/_engine/forward" },
        model: yamlTrace.forward,
        real: typescriptTrace.forward,
      },
    ]);

    expect(comparison.conforms).toBe(true);
    expect(comparison.divergences).toEqual([]);
  });

  it.each([
    ["YAML", () => yamlPath],
    ["TypeScript", () => typescriptPath],
  ])("%s reset removes state and events deterministically", async (_name, getPath) => {
    const target = getPath();
    await target.agent.post("/_admin/reset").expect(204);
    await expect(target.agent.get("/_admin/state").expect(200)).resolves.toMatchObject({
      body: { entities: {} },
    });
    await expect(target.agent.get("/_admin/events").expect(200)).resolves.toMatchObject({
      body: { events: [] },
    });
  });
});
