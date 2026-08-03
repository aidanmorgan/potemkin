/** Pure YAML authoring e2e path. */

import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { loadOpenApi } from "../../src/contract/loader.js";
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from "../_support/persistentAgent.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: YAML authoring e2e, version: "1.0.0" }
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties: { name: { type: string } }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Thing" }
components:
  schemas:
    Thing:
      type: object
      required: [id, name]
      properties: { id: { type: string }, name: { type: string } }
`;

const DSL = `
boundary: Thing
contract_path: /things
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: ThingCreated
    payload_template:
      id: command.targetId
      name: command.payload.name
behaviors:
  - name: createThing
    match:
      operationId: createThing
      condition: "true"
    emit: ThingCreated
reducers:
  - on: ThingCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

describe("YAML-only authoring", () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const system = await bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: "thing.yaml", yaml: DSL }] },
    });
    server = await withPersistentServer(createRuntimeGateway(system));
    agent = server.agent;
  });

  afterAll(async () => server?.close());

  it("serves a request from a YAML-only simulation definition", async () => {
    const response = await agent.post("/things").send({ name: "Ada" }).expect(201);
    expect(response.body.name).toBe("Ada");
    expect(typeof response.body.id).toBe("string");
  });
});
