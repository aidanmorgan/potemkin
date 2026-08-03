import {
  boundaryName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import { loadOpenApi } from "../../src/contract/loader.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import {
  boundary,
  compileProgram,
  event,
  expression,
  simulation,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import { createRuntimeDataGenerator } from "../../src/model/data.js";
import type { EventContext, RuntimeHelpers } from "../../src/model/runtime.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: Runtime latency parity, version: "1.0.0" }
paths:
  /jobs:
    post:
      operationId: createJob
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/JobInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Job" }
components:
  schemas:
    JobInput:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
    Job:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
`;

const YAML = `
boundary: Job
contract_path: /jobs
latency: { fixed_ms: 20, min_ms: 30, max_ms: 60 }
identity: { creation: { generate: command.payload.id } }
event_catalog:
  - type: JobCreated
    payload_template:
      id: command.payload.id
      name: command.payload.name
behaviors:
  - name: create-job
    match: { operationId: createJob, condition: "true" }
    emit: JobCreated
reducers:
  - on: JobCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

const LATENCY = { fixedMs: 20, minMs: 30, maxMs: 60 } as const;

function helpers(randomValue: number): RuntimeHelpers {
  const random = () => randomValue;
  return {
    now: () => "2026-01-01T00:00:00.000Z",
    uuid: () => "00000000-0000-7000-8000-000000000001",
    random,
    data: createRuntimeDataGenerator(random),
    clone: <T>(value: T): T => structuredClone(value),
  };
}

function directDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName("Job"), contractPath(pathSegment("jobs")))
        .latency(LATENCY)
        .identity({ generate: expression("identity", ({ payload }) => String(payload.id)) })
        .eventCatalog(
          event(eventType("JobCreated"), {
            id: expression("event", ({ command }: EventContext) => String(command.payload.id)),
            name: expression("event", ({ command }: EventContext) => String(command.payload.name)),
          }),
        )
        .behavior({
          name: "create-job",
          operationId: operationId("createJob"),
          condition: expression("behavior", () => true),
          emit: eventType("JobCreated"),
        })
        .reducer(
          reducerRule(eventType("JobCreated"))
            .apply(({ state, event: emitted }) => ({
              ...state,
              id: emitted.payload.id,
              name: emitted.payload.name,
            }))
            .build(),
        )
        .build(),
    )
    .build();
}

async function bootPair(
  randomValue = 0,
): Promise<{ systems: [RuntimeSystem, RuntimeSystem]; sleeps: [number[], number[]] }> {
  const openapi = await loadOpenApi(OPENAPI);
  const sleeps: [number[], number[]] = [[], []];
  const sleep =
    (calls: number[]) =>
    async (milliseconds: number): Promise<void> => {
      calls.push(milliseconds);
    };
  const systems = (await Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: "job.yaml", yaml: YAML }] },
      helpers: helpers(randomValue),
      sleep: sleep(sleeps[0]),
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(directDefinition(), { dependencies, openapi }),
      helpers: helpers(randomValue),
      sleep: sleep(sleeps[1]),
    }),
  ])) as [RuntimeSystem, RuntimeSystem];
  return { systems, sleeps };
}

describe("runtime latency parity", () => {
  it("applies stacked fixed and ranged latency through the same HTTP runtime", async () => {
    const { systems, sleeps } = await bootPair();
    try {
      const responses = await Promise.all(
        systems.map((system) =>
          request(createRuntimeGateway(system))
            .post("/jobs")
            .send({ id: "job-1", name: "nightly export" }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(responses[0]?.body).toEqual(responses[1]?.body);
      expect(sleeps).toEqual([
        [20, 30],
        [20, 30],
      ]);
      expect(
        (await request(createRuntimeGateway(systems[0]!)).get("/_admin/events")).body.events,
      ).toHaveLength(1);
      expect(
        (await request(createRuntimeGateway(systems[1]!)).get("/_admin/events")).body.events,
      ).toHaveLength(1);
    } finally {
      await Promise.all(systems.map((system) => system.dispose()));
    }
  });

  it("keeps an injected sample of one at the configured upper bound", async () => {
    const { systems, sleeps } = await bootPair(1);
    try {
      const responses = await Promise.all(
        systems.map((system) =>
          request(createRuntimeGateway(system))
            .post("/jobs")
            .send({ id: "job-upper", name: "upper bound" }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(sleeps).toEqual([
        [20, 60],
        [20, 60],
      ]);
    } finally {
      await Promise.all(systems.map((system) => system.dispose()));
    }
  });

  it("stacks typed transport latency controls after boundary latency for both sources", async () => {
    const { systems, sleeps } = await bootPair();
    try {
      const responses = await Promise.all(
        systems.map((system) =>
          request(createRuntimeGateway(system))
            .post("/jobs")
            .set("X-Potemkin-Force-Latency", "7")
            .set("X-Potemkin-Slow-Response", "5")
            .set("X-Potemkin-Jitter", "3:4")
            .send({ id: "job-controls", name: "latency controls" }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(responses[0]?.body).toEqual(responses[1]?.body);
      expect(sleeps).toEqual([
        [32, 30, 3],
        [32, 30, 3],
      ]);
    } finally {
      await Promise.all(systems.map((system) => system.dispose()));
    }
  });
});
