import {
  boundaryName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from "../../src/authoring/references.js";
import type { Response } from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootRuntime } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import type { RuntimeSystem } from "../../src/runtime/system.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { createYamlRuntimeExtensions } from "../../src/parser/gateway.js";
import { boundary, compileProgram, event, simulation } from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type { EventContext, IdentityContext } from "../../src/model/runtime.js";
import { withPersistentServer } from "../_support/persistentAgent.js";
import type { PersistentAgent, PersistentServer } from "../_support/persistentAgent.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: Runtime TTL controls, version: "1.0.0" }
paths:
  /resources:
    post:
      operationId: createResource
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ResourceInput" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
  /resources/{id}:
    get:
      operationId: getResource
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
components:
  schemas:
    ResourceInput:
      type: object
      required: [id, value]
      additionalProperties: false
      properties:
        id: { type: string }
        value: { type: string }
    Resource:
      type: object
      required: [id, value]
      additionalProperties: false
      properties:
        id: { type: string }
        value: { type: string }
`;

const YAML_BOUNDARY = `
boundary: Resource
contract_path: /resources
identity:
  creation:
    generate: command.payload.id
event_catalog:
  - type: ResourceCreated
    payload_template:
      id: command.payload.id
      value: command.payload.value
behaviors:
  - name: create-resource
    match:
      operationId: createResource
      condition: "true"
      required_scopes: [resource:write]
    emit: ResourceCreated
reducers:
  - on: ResourceCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /value, value: "\${event.payload.value}" }
`;

const YAML_GLOBAL = `
idempotency:
  enabled: true
  ttl_seconds: 1
  hash_includes_body: true
auth:
  mode: session
  session:
    cookie_name: potemkin_sid
    ttl_seconds: 1
    csrf_header: x-csrf-token
`;

function directDefinition() {
  const created = event(eventType("ResourceCreated"), {
    id: ({ command }: EventContext) => command.payload.id,
    value: ({ command }: EventContext) => command.payload.value,
  });
  const reducer = reducerRule(eventType("ResourceCreated"))
    .apply(({ state, event: emitted }) => ({
      ...state,
      id: emitted.payload.id,
      value: emitted.payload.value,
    }))
    .build();
  return simulation()
    .boundary(
      boundary(boundaryName("Resource"), contractPath(pathSegment("resources")))
        .identity({ generate: ({ payload }: IdentityContext) => String(payload.id) })
        .eventCatalog(created)
        .behavior({
          name: "create-resource",
          operationId: operationId("createResource"),
          requiredScopes: ["resource:write"],
          emit: eventType("ResourceCreated"),
        })
        .reducer(reducer)
        .build(),
    )
    .global({
      idempotency: { enabled: true, ttlSeconds: 1, hashIncludesBody: true },
      auth: {
        mode: "session",
        session: { cookieName: "potemkin_sid", ttlSeconds: 1, csrfHeader: "x-csrf-token" },
      },
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
        modules: [{ name: "resource.yaml", yaml: YAML_BOUNDARY }],
        globalYaml: YAML_GLOBAL,
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

function sessionCookie(response: Response): string {
  const cookie = response.headers["set-cookie"]?.[0];
  if (cookie === undefined) throw new Error("Session login did not return a cookie");
  return cookie.split(";", 1)[0]!;
}

async function login(app: PersistentAgent): Promise<{ cookie: string; csrf: string }> {
  const response = await app
    .post("/sessions")
    .send({ actorId: "ttl-user", scopes: ["resource:write"] })
    .expect(200);
  expect(typeof response.body.csrfToken).toBe("string");
  return { cookie: sessionCookie(response), csrf: response.body.csrfToken as string };
}

describe("source-independent idempotency and session TTL behaviour", () => {
  let systems: [RuntimeSystem, RuntimeSystem];
  let servers: [PersistentServer, PersistentServer];

  beforeEach(async () => {
    systems = await bootPair();
    servers = (await Promise.all(
      systems.map((system) =>
        withPersistentServer(createRuntimeGateway(system, createYamlRuntimeExtensions(system))),
      ),
    )) as [PersistentServer, PersistentServer];
  });
  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(systems.map((system) => system.dispose()));
  });

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)("%s expires idempotency entries using the runtime clock", async (_name, index) => {
    const system = systems[index];
    const app = servers[index].agent;
    const credentials = await login(app);
    const key = `ttl-${_name}`;
    const first = await app
      .post("/resources")
      .set("Cookie", credentials.cookie)
      .set("X-CSRF-Token", credentials.csrf)
      .set("Idempotency-Key", key)
      .send({ id: `${_name.toLowerCase()}-one`, value: "first" })
      .expect(201);
    const replay = await app
      .post("/resources")
      .set("Cookie", credentials.cookie)
      .set("X-CSRF-Token", credentials.csrf)
      .set("Idempotency-Key", key)
      .send({ id: `${_name.toLowerCase()}-one`, value: "first" })
      .expect(201);
    expect(replay.headers["x-idempotency-replay"]).toBe("true");
    expect(replay.body).toEqual(first.body);

    await app.post("/_admin/clock/advance").send({ ms: 1_001 }).expect(200);
    const renewedCredentials = await login(app);
    const fresh = await app
      .post("/resources")
      .set("Cookie", renewedCredentials.cookie)
      .set("X-CSRF-Token", renewedCredentials.csrf)
      .set("Idempotency-Key", key)
      .send({ id: `${_name.toLowerCase()}-two`, value: "second" })
      .expect(201);
    expect(fresh.body.id).toBe(`${_name.toLowerCase()}-two`);
    expect(system.engine.snapshot().events).toHaveLength(2);
  });

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s expires sessions and enforces CSRF while the session is live",
    async (_name, index) => {
      const app = servers[index].agent;
      const credentials = await login(app);
      const body = { id: `${_name.toLowerCase()}-session`, value: "created" };

      await app
        .post("/resources")
        .set("Cookie", credentials.cookie)
        .send(body)
        .expect(403, {
          code: "CSRF_TOKEN_INVALID",
          message: "CSRF token missing or invalid",
          details: { code: "CSRF_TOKEN_INVALID" },
        });
      await app
        .post("/resources")
        .set("Cookie", credentials.cookie)
        .set("X-CSRF-Token", credentials.csrf)
        .send(body)
        .expect(201);

      await app.post("/_admin/clock/advance").send({ ms: 1_001 }).expect(200);
      await app
        .post("/resources")
        .set("Cookie", credentials.cookie)
        .set("X-CSRF-Token", credentials.csrf)
        .send({ id: `${_name.toLowerCase()}-expired`, value: "expired" })
        .expect(401, {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required for this operation",
          details: { code: "AUTHENTICATION_REQUIRED" },
        });
    },
  );

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s applies a request-local clock offset to TTL checks without changing shared time",
    async (_name, index) => {
      const system = systems[index];
      const app = servers[index].agent;
      const credentials = await login(app);
      const id = `${_name.toLowerCase()}-request-clock`;

      await app
        .post("/resources")
        .set("Cookie", credentials.cookie)
        .set("X-CSRF-Token", credentials.csrf)
        .set("X-Potemkin-Clock-Offset", "1001")
        .send({ id, value: "future-view" })
        .expect(401, {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required for this operation",
          details: { code: "AUTHENTICATION_REQUIRED" },
        });

      expect(system.clock.offsetMs()).toBe(0);
      await app
        .post("/resources")
        .set("Cookie", credentials.cookie)
        .set("X-CSRF-Token", credentials.csrf)
        .send({ id, value: "shared-clock" })
        .expect(201);
    },
  );

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)(
    "%s compiles an administrative fault wire rule at the parser boundary",
    async (_name, index) => {
      const system = systems[index];
      const app = servers[index].agent;
      const registration = await app
        .post("/_admin/faults")
        .send({
          name: `${_name.toLowerCase()}-temporary`,
          match: { condition: "true" },
          response: { status: 503, body: { code: "TEMPORARY" } },
          ttlMs: 1_000,
        })
        .expect(201);
      expect(registration.body.name).toBe(`${_name.toLowerCase()}-temporary`);

      await app
        .post("/resources")
        .send({ id: `${_name.toLowerCase()}-fault`, value: "blocked" })
        .expect(503, { code: "TEMPORARY" });
      expect(system.engine.snapshot().events).toHaveLength(0);
      await app.post("/_admin/clock/advance").send({ ms: 1_001 }).expect(200);
      await app
        .post("/resources")
        .send({ id: `${_name.toLowerCase()}-fault`, value: "unblocked" })
        .expect(401, {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required for this operation",
          details: { code: "AUTHENTICATION_REQUIRED" },
        });
    },
  );

  it.each([
    ["YAML", 0],
    ["TypeScript", 1],
  ] as const)("%s reset clears volatile runtime stores as one operation", async (_name, index) => {
    const system = systems[index];
    const app = servers[index].agent;
    const credentials = await login(app);
    await app
      .post("/resources")
      .set("Cookie", credentials.cookie)
      .set("X-CSRF-Token", credentials.csrf)
      .set("Idempotency-Key", `reset-${_name}`)
      .send({ id: `${_name.toLowerCase()}-before-reset`, value: "before" })
      .expect(201);
    system.faults.add({
      name: "reset-fault",
      matches: () => true,
      response: { status: 503, body: { code: "RESET_FAULT" } },
    });
    await app.post("/_admin/clock/advance").send({ ms: 250 }).expect(200);

    await app.post("/_admin/reset").expect(204);
    expect(system.engine.snapshot().events).toHaveLength(0);
    expect(system.engine.snapshot().state).toHaveLength(0);
    expect(system.faults.list()).toHaveLength(0);
    expect(system.clock.offsetMs()).toBe(0);
    await app.get("/_admin/events?count=true").expect(200, { count: 0 });
    await app.get("/_admin/state").expect(200, { entities: {} });
    await app.get("/_admin/faults").expect(200, []);

    await app
      .post("/resources")
      .set("Cookie", credentials.cookie)
      .set("X-CSRF-Token", credentials.csrf)
      .send({ id: `${_name.toLowerCase()}-stale-session`, value: "not-authorized" })
      .expect(401, {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required for this operation",
        details: { code: "AUTHENTICATION_REQUIRED" },
      });
    const renewedCredentials = await login(app);
    await app
      .post("/resources")
      .set("Cookie", renewedCredentials.cookie)
      .set("X-CSRF-Token", renewedCredentials.csrf)
      .set("Idempotency-Key", `reset-${_name}`)
      .send({ id: `${_name.toLowerCase()}-after-reset`, value: "after" })
      .expect(201);
  });
});
