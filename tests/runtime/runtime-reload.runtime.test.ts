import {
  boundaryName,
  contractPath,
  eventType,
  operationId,
  pathParameter,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootRuntime } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { compileYamlProgram } from "../../src/parser/public.js";
import {
  boundary,
  compileProgram,
  event,
  expression,
  simulation,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type { EventContext, IdentityContext } from "../../src/model/runtime.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: Runtime reload, version: "1.0.0" }
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/WidgetInput" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
        "202":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
  /widgets/{id}:
    get:
      operationId: getWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
components:
  schemas:
    WidgetInput:
      type: object
      required: [id, name]
      properties: { id: { type: string }, name: { type: string } }
    Widget:
      type: object
      required: [id, name]
      properties: { id: { type: string }, name: { type: string } }
`;

const YAML = `
boundary: Widget
contract_path: /widgets
identity: { creation: { generate: command.payload.id } }
event_catalog:
  - type: WidgetCreated
    payload_template: { id: command.payload.id, name: command.payload.name }
behaviors:
  - name: create-widget
    match: { operationId: createWidget, condition: "true" }
    response_status: 202
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

const YAML_BY_ID = `
boundary: WidgetById
contract_path: /widgets/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

function typescriptDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName("Widget"), contractPath(pathSegment("widgets")))
        .identity({
          generate: expression("identity", ({ payload }: IdentityContext) => String(payload.id)),
        })
        .eventCatalog(
          event(eventType("WidgetCreated"), {
            id: expression("event", ({ command }: EventContext) => String(command.payload.id)),
            name: expression("event", ({ command }: EventContext) => String(command.payload.name)),
          }),
        )
        .behavior({
          name: "create-widget",
          operationId: operationId("createWidget"),
          condition: expression("behavior", () => true),
          emit: eventType("WidgetCreated"),
          responseStatus: 202,
        })
        .reducer(
          reducerRule(eventType("WidgetCreated"))
            .apply(({ state, event }) => ({
              ...state,
              id: String(event.payload.id),
              name: String(event.payload.name),
            }))
            .build(),
        )
        .build(),
    )
    .boundary(
      boundary(
        boundaryName("WidgetById"),
        contractPath(pathSegment("widgets"), pathParameter("id")),
      )
        .fallbackOverride(true)
        .build(),
    )
    .build();
}

describe("source-independent runtime reload", () => {
  it("reprojects the existing event log while switching between TypeScript and YAML programs", async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const system = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
    });
    try {
      const app = createRuntimeGateway(system);
      await request(app).post("/widgets").send({ id: "widget-1", name: "first" }).expect(202);

      const yamlProgram = await compileYamlProgram(
        {
          modules: [
            { name: "widgets.yaml", yaml: YAML },
            { name: "widgets-by-id.yaml", yaml: YAML_BY_ID },
          ],
        },
        { dependencies: system.engine.program.dependencies },
      );
      await system.reload(yamlProgram);

      await request(app).get("/widgets/widget-1").expect(200, { id: "widget-1", name: "first" });
      await request(app).post("/widgets").send({ id: "widget-2", name: "second" }).expect(202);
      expect(system.engine.snapshot().events.map((event) => event.aggregateId)).toEqual([
        "widget-1",
        "widget-2",
      ]);

      const invalidDefinition = typescriptDefinition();
      const invalidProgram = compileProgram(
        {
          ...invalidDefinition,
          boundaries: invalidDefinition.boundaries.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  state: {
                    validate: () => {
                      throw new Error("reload validation failed");
                    },
                  },
                }
              : item,
          ),
        },
        {
          dependencies: system.engine.program.dependencies,
          openapi,
        },
      );
      await expect(system.reload(invalidProgram)).rejects.toThrow("reload validation failed");
      await request(app).get("/widgets/widget-1").expect(200, { id: "widget-1", name: "first" });

      const directProgram = compileProgram(typescriptDefinition(), {
        dependencies: system.engine.program.dependencies,
        openapi,
      });
      await system.reload(directProgram);
      await request(app).get("/widgets/widget-2").expect(200, { id: "widget-2", name: "second" });
      expect(system.engine.snapshot().state).toEqual(
        expect.arrayContaining([
          ["widget-1", { id: "widget-1", name: "first" }],
          ["widget-2", { id: "widget-2", name: "second" }],
        ]),
      );
    } finally {
      await system.dispose();
    }
  });
});
