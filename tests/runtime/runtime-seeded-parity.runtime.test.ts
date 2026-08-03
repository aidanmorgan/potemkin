import {
  boundaryName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
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
info: { title: Seeded runtime parity, version: "1.0.0" }
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
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
components:
  schemas:
    ResourceInput:
      type: object
      required: [label]
      properties: { label: { type: string } }
    Resource:
      type: object
      required: [id, label, generatedName, status]
      properties:
        id: { type: string }
        label: { type: string }
        generatedName: { type: string }
        status: { type: string }
`;

const YAML = `
boundary: Resource
contract_path: /resources
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: ResourceCreated
    payload_template:
      id: command.targetId
      label: command.payload.label
      generatedName: $fake('person.firstName')
      status: "'CREATED'"
behaviors:
  - name: create-resource
    match: { operationId: createResource, condition: "true" }
    emit: ResourceCreated
reducers:
  - on: ResourceCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
      - { op: replace, path: /generatedName, value: "\${event.payload.generatedName}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

function typescriptDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName("Resource"), contractPath(pathSegment("resources")))
        .identity({
          generate: expression("identity", ({ helpers }: IdentityContext) => helpers.uuid()),
        })
        .eventCatalog(
          event(eventType("ResourceCreated"), {
            id: expression("event", ({ command }: EventContext) => String(command.targetId)),
            label: expression("event", ({ command }: EventContext) =>
              String(command.payload.label),
            ),
            generatedName: expression("event", ({ helpers }: EventContext) =>
              helpers.data.person.firstName(),
            ),
            status: expression("event", () => "CREATED"),
          }),
        )
        .behavior({
          name: "create-resource",
          operationId: operationId("createResource"),
          condition: expression("behavior", () => true),
          emit: eventType("ResourceCreated"),
        })
        .reducer(
          reducerRule(eventType("ResourceCreated"))
            .apply(({ state, event }) => ({
              ...state,
              id: event.payload.id,
              label: event.payload.label,
              generatedName: event.payload.generatedName,
              status: "CREATED",
            }))
            .build(),
        ),
    )
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: "resource.yaml", yaml: YAML }] },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
    }),
  ]);
}

describe("seeded data and UUID parity", () => {
  it("uses the same request seed for YAML and TypeScript-generated values", async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    try {
      const seed = "parity-seed";
      const [yamlResponse, typescriptResponse] = await Promise.all([
        request(createRuntimeGateway(yamlSystem))
          .post("/resources")
          .set("X-Potemkin-Seed", seed)
          .send({ label: "one" }),
        request(createRuntimeGateway(typescriptSystem))
          .post("/resources")
          .set("X-Potemkin-Seed", seed)
          .send({ label: "one" }),
      ]);

      expect(yamlResponse.status).toBe(201);
      expect(typescriptResponse.status).toBe(201);
      expect(typescriptResponse.body).toEqual(yamlResponse.body);
      expect(yamlResponse.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(typeof yamlResponse.body.generatedName).toBe("string");
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });

  it("isolates different seeds between requests", async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    try {
      const yamlApp = createRuntimeGateway(yamlSystem);
      const typescriptApp = createRuntimeGateway(typescriptSystem);
      const [first, second] = await Promise.all([
        request(yamlApp).post("/resources").set("X-Potemkin-Seed", "seed-a").send({ label: "one" }),
        request(typescriptApp)
          .post("/resources")
          .set("X-Potemkin-Seed", "seed-b")
          .send({ label: "one" }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.id).not.toBe(second.body.id);
      expect(first.body.generatedName).not.toBe(second.body.generatedName);
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });
});
