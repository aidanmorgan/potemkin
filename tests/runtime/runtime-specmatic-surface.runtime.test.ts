import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathParameter,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { definePotemkinConfig } from "../../src/config.js";
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
info: { title: Runtime transport surface, version: "1.0.0" }
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        "200":
          description: Widget collection
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/Widget" } }
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/WidgetInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
  /widgets/{id}:
    get:
      operationId: getWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          description: Widget
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
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

const WIDGET_YAML = `
boundary: Widget
contract_path: /widgets
identity:
  creation:
    generate: command.payload.id
initialization:
  - { id: seed-1, name: Seeded widget, status: READY }
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: command.payload.id
      name: command.payload.name
      status: "'CREATED'"
behaviors:
  - name: create-widget
    match: { operationId: createWidget, condition: "true" }
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

const WIDGET_BY_ID_YAML = `
boundary: WidgetById
contract_path: /widgets/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

function directDefinition() {
  const widget = boundary(boundaryName("Widget"), contractPath(pathSegment("widgets")))
    .identity({
      generate: expression("identity", ({ command }: IdentityContext) =>
        String(command.payload.id),
      ),
    })
    .initialization({ id: "seed-1", name: "Seeded widget", status: "READY" })
    .eventCatalog(
      event(eventType("WidgetCreated"), {
        id: expression("event", ({ command }: EventContext) => command.payload.id),
        name: expression("event", ({ command }: EventContext) => command.payload.name),
        status: expression("event", () => "CREATED"),
      }),
    )
    .behavior({
      name: behaviorName("create-widget"),
      operationId: operationId("createWidget"),
      condition: expression("behavior", () => true),
      emit: eventType("WidgetCreated"),
    })
    .reducer(
      reducerRule(eventType("WidgetCreated"))
        .apply(({ state, event }) => ({
          ...state,
          id: event.payload.id,
          name: event.payload.name,
          status: "CREATED",
        }))
        .build(),
    );
  const byId = boundary(
    boundaryName("WidgetById"),
    contractPath(pathSegment("widgets"), pathParameter("id")),
  ).fallbackOverride(true);
  return simulation().boundaries(widget, byId).build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  const configuration = definePotemkinConfig({
    version: 1,
    specmatic: "specmatic.yaml",
    modules: ["dsl/*.yaml"],
    plugin: { controlPort: 9000 },
  });
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [
          { name: "widget.yaml", yaml: WIDGET_YAML },
          { name: "widget-by-id.yaml", yaml: WIDGET_BY_ID_YAML },
        ],
      },
      configuration,
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(directDefinition(), { dependencies, openapi }),
      configuration,
    }),
  ]);
}

describe("new-runtime Specmatic transport surface", () => {
  let yamlSystem: RuntimeSystem;
  let typescriptSystem: RuntimeSystem;

  beforeAll(async () => {
    [yamlSystem, typescriptSystem] = await bootPair();
  });

  afterAll(async () => {
    await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s exposes cacheable route discovery and seeded fixtures", async (_name, getSystem) => {
    const app = createRuntimeGateway(getSystem());

    const routes = await request(app).get("/_engine/routes").expect(200);
    expect(routes.body).toMatchObject({
      engine: "potemkin-stateful",
      version: expect.any(String),
      ttlSeconds: 30,
    });
    expect(routes.body.paths).toEqual(["/widgets", "/widgets/{id}"]);
    expect(routes.headers.etag).toEqual(`"${routes.body.checksum}"`);
    await request(app).get("/_engine/routes").set("If-None-Match", routes.headers.etag).expect(304);

    const fixtures = await request(app).get("/_engine/fixtures").expect(200);
    expect(fixtures.body.fixtures).toEqual([
      expect.objectContaining({
        httpRequest: { method: "GET", path: "/widgets/seed-1" },
        httpResponse: expect.objectContaining({
          status: 200,
          body: { id: "seed-1", name: "Seeded widget", status: "READY" },
        }),
        source: {
          boundary: boundaryName("Widget"),
          aggregateId: "seed-1",
          contractPath: "/widgets/{id}",
        },
      }),
    ]);
    expect(fixtures.headers.etag).toEqual(`"${fixtures.body.checksum}"`);
    await request(app)
      .get("/_engine/fixtures")
      .set("If-None-Match", fixtures.headers.etag)
      .expect(304);
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s reports health and readiness in the plugin-compatible shape", async (_name, getSystem) => {
    const app = createRuntimeGateway(getSystem());
    await request(app)
      .get("/_engine/health")
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "UP",
          engine: "potemkin-stateful",
          ready: true,
          version: expect.any(String),
        });
      });
    await request(app)
      .get("/_engine/ready")
      .expect(200)
      .expect({ ready: true, state: "UP", routesDiscovered: 2 });
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s exposes typed top-level configuration metadata without consulting a YAML file",
    async (_name, getSystem) => {
      const response = await request(createRuntimeGateway(getSystem()))
        .get("/_engine/config")
        .expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toMatchObject({
        engine: "potemkin-stateful",
        potemkin: {
          version: 1,
          specmatic: "specmatic.yaml",
          modules: ["dsl/*.yaml"],
          plugin: { controlPort: 9000 },
        },
        pluginMetadata: { controlPort: 9000 },
      });
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])(
    "%s preserves the forward envelope for success, failure, HEAD, OPTIONS, and bulk requests",
    async (_name, getSystem) => {
      const app = createRuntimeGateway(getSystem());

      const created = await request(app)
        .post("/_engine/forward")
        .send({
          method: "POST",
          path: "/widgets",
          headers: {},
          query: {},
          body: { id: `${_name.toLowerCase()}-1`, name: "Forwarded widget" },
        })
        .expect(200);
      expect(created.body).toMatchObject({
        status: 201,
        headers: { "content-type": "application/json", "x-specmatic-result": "success" },
        body: { id: `${_name.toLowerCase()}-1`, name: "Forwarded widget", status: "CREATED" },
      });

      const unknown = await request(app)
        .post("/_engine/forward")
        .send({
          method: "GET",
          path: "/not-a-contract-route",
          headers: {},
          query: {},
          body: null,
        })
        .expect(200);
      expect(unknown.body).toMatchObject({
        status: 404,
        headers: { "x-specmatic-result": "failure" },
      });

      const head = await request(app)
        .post("/_engine/forward")
        .send({
          method: "HEAD",
          path: "/widgets/seed-1",
          headers: {},
          query: {},
          body: null,
        })
        .expect(200);
      expect(head.body).toMatchObject({
        status: 200,
        body: null,
        headers: { "x-specmatic-result": "success" },
      });

      const options = await request(app)
        .post("/_engine/forward")
        .send({
          method: "OPTIONS",
          path: "/widgets",
          headers: {},
          query: {},
          body: null,
        })
        .expect(200);
      expect(options.body).toMatchObject({
        status: 204,
        body: null,
        headers: { "x-specmatic-result": "success" },
      });

      const bulk = await request(app)
        .post("/_engine/forward")
        .send({
          method: "POST",
          path: "/widgets",
          headers: { "x-potemkin-bulk-transactional": "true" },
          query: {},
          body: [
            { id: `${_name.toLowerCase()}-bulk-1`, name: "Bulk one" },
            { id: `${_name.toLowerCase()}-bulk-2`, name: "Bulk two" },
          ],
        })
        .expect(200);
      expect(bulk.body).toMatchObject({
        status: 201,
        headers: { "x-specmatic-result": "success" },
      });
      expect(bulk.body.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `${_name.toLowerCase()}-bulk-1` }),
          expect.objectContaining({ id: `${_name.toLowerCase()}-bulk-2` }),
        ]),
      );
    },
  );

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s rejects a malformed outer forward envelope before execution", async (_name, getSystem) => {
    const before = getSystem().engine.snapshot().events.length;
    const response = await request(createRuntimeGateway(getSystem()))
      .post("/_engine/forward")
      .send({ method: "GET", path: "/widgets" })
      .expect(400);
    expect(response.body).toMatchObject({
      error: "MALFORMED_FORWARDED_REQUEST",
      code: "BOOT_ERR_MALFORMED_FORWARDED_REQUEST",
    });
    expect(getSystem().engine.snapshot().events.length).toBe(before);
  });

  it.each([
    ["YAML", () => yamlSystem],
    ["TypeScript", () => typescriptSystem],
  ])("%s binds the direct HTTP surface to the same runtime model", async (_name, getSystem) => {
    const app = createRuntimeGateway(getSystem());
    const id = `${_name.toLowerCase()}-direct-${Date.now()}`;

    await request(app)
      .get("/widgets/seed-1")
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({ id: "seed-1", name: "Seeded widget", status: "READY" });
      });
    await request(app).head("/widgets/seed-1").expect(200);
    await request(app)
      .options("/widgets")
      .expect(204)
      .expect((response) => {
        expect(response.headers["access-control-allow-methods"]).toContain("POST");
      });
    await request(app).get("/widgets").expect(200);

    await request(app)
      .post("/widgets")
      .send({ id, name: "Direct widget" })
      .expect(201)
      .expect((response) => {
        expect(response.body).toEqual({ id, name: "Direct widget", status: "CREATED" });
      });
    await request(app).get(`/widgets/${id}`).expect(200);

    await request(app)
      .post("/widgets")
      .set("If-Match", 'W/"not-an-integer"')
      .send({ id: `${id}-invalid`, name: "Invalid precondition" })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe("INVALID_IF_MATCH"));
    await request(app)
      .post("/widgets")
      .send([])
      .expect(400)
      .expect((response) => expect(response.body.code).toBe("CONTRACT_VIOLATION"));
  });

  it("covers direct gateway controls, CORS admission, cache validators, and parser failures", async () => {
    const app = createRuntimeGateway(typescriptSystem, {
      adminToken: "admin-secret",
      allowedOrigins: ["https://allowed.test"],
      routesTtlSeconds: 0,
    });

    const entity = await request(app)
      .get("/widgets/seed-1")
      .set("Origin", "https://allowed.test")
      .set("Cookie", "sid=session-1")
      .expect(200);
    expect(entity.headers["access-control-allow-origin"]).toBe("https://allowed.test");
    expect(entity.headers["access-control-allow-credentials"]).toBe("true");
    await request(app)
      .get("/widgets/seed-1")
      .set("Origin", "https://allowed.test")
      .set("If-None-Match", entity.headers.etag)
      .expect(304);

    await request(app)
      .options("/widgets")
      .set("Origin", "https://allowed.test")
      .expect(204)
      .expect((response) => {
        expect(response.headers["access-control-allow-origin"]).toBe("https://allowed.test");
        expect(response.headers["access-control-allow-headers"]).toContain("x-potemkin-");
      });
    await request(app)
      .get("/widgets/seed-1")
      .set("Origin", "https://blocked.test")
      .set("Cookie", "sid=session-1")
      .expect(200)
      .expect((response) => {
        expect(response.headers["access-control-allow-origin"]).toBe("https://allowed.test");
        expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      });

    await request(app)
      .get("/widgets")
      .set("x-potemkin-skip-request-validation", "true")
      .expect(401)
      .expect((response) => expect(response.body.code).toBe("ADMIN_REQUIRED"));
    await request(app)
      .get("/widgets")
      .set("Authorization", "Bearer admin-secret")
      .set("x-potemkin-skip-request-validation", "true")
      .expect(200);
    await request(app).get("/widgets").set("x-potemkin-force-status", "503").expect(503);
    await request(app).get("/not-a-contract").expect(404);

    await request(app)
      .post("/widgets")
      .set("content-type", "application/json")
      .send('{"id":')
      .expect(400);
  });

  it("enforces and exercises the typed administrative surface", async () => {
    const app = createRuntimeGateway(yamlSystem, {
      adminToken: "admin-secret",
      version: "test-version",
    });

    await request(app).get("/_admin/health").expect(401);
    await request(app)
      .get("/_admin/health")
      .set("Authorization", "Bearer admin-secret")
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ status: "ok", ready: true, version: "test-version" });
      });
    await request(app)
      .get("/_admin/state?boundary=Unknown")
      .set("Authorization", "Bearer admin-secret")
      .expect(404);
    await request(app)
      .get("/_admin/state?boundary=Widget")
      .set("Authorization", "Bearer admin-secret")
      .expect(200);

    await request(app)
      .get("/_admin/events?aggregateId=missing&type=Missing&count=true")
      .set("Authorization", "Bearer admin-secret")
      .expect(200)
      .expect({ count: 0 });
    await request(app)
      .get("/_admin/events?offset=0&limit=1")
      .set("Authorization", "Bearer admin-secret")
      .expect(200)
      .expect((response) => expect(response.body.events).toHaveLength(1));
    await request(app)
      .get("/_admin/derived/missing")
      .set("Authorization", "Bearer admin-secret")
      .expect(404);
    await request(app)
      .get("/_admin/model")
      .set("Authorization", "Bearer admin-secret")
      .expect(200)
      .expect((response) => expect(response.body.schemaVersion).toBe(1));

    const fault = await request(app)
      .post("/_admin/faults")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "admin-fault", match: {}, response: { status: 503 }, ttlMs: 2_000 })
      .expect(201);
    expect(fault.body).toMatchObject({ name: "admin-fault", id: expect.any(String) });
    await request(app)
      .get("/_admin/faults")
      .set("Authorization", "Bearer admin-secret")
      .expect(200)
      .expect((response) =>
        expect(response.body).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: fault.body.id })]),
        ),
      );
    await request(app)
      .delete("/_admin/faults/missing")
      .set("Authorization", "Bearer admin-secret")
      .expect(404);
    await request(app)
      .delete(`/_admin/faults/${fault.body.id}`)
      .set("Authorization", "Bearer admin-secret")
      .expect(204);

    await request(app)
      .post("/_admin/clock/advance")
      .set("Authorization", "Bearer admin-secret")
      .send({ ms: "not-a-number" })
      .expect(400);
    await request(app)
      .post("/_admin/clock/advance")
      .set("Authorization", "Bearer admin-secret")
      .send({ ms: 25 })
      .expect(200)
      .expect((response) => expect(response.body).toEqual({ offsetMs: expect.any(Number) }));
    await request(app)
      .post("/_admin/clock/reset")
      .set("Authorization", "Bearer admin-secret")
      .expect(200)
      .expect({ offsetMs: 0 });
    await request(app)
      .post("/_admin/force-reload")
      .set("Authorization", "Bearer admin-secret")
      .expect(404);
    await request(app)
      .post("/_admin/reset")
      .set("Authorization", "Bearer admin-secret")
      .expect(204);
  }, 60_000);
});
