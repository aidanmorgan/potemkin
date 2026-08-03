import {
  boundaryName,
  contractPath,
  eventType,
  field,
  fieldPath,
  operationId,
  pathSegment,
} from "../../src/authoring/references.js";
import request from "supertest";
import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootRuntime, type RuntimeSystem } from "../../src/runtime/system.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createRuntimeGateway } from "../../src/http/runtimeGateway.js";
import { createRuntimeOtelRequestResponseObserver } from "../../src/observability/runtimeExchange.js";
import {
  boundary,
  compileProgram,
  event,
  expression,
  simulation,
} from "../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../src/authoring/nativeReducer.js";
import type { EventContext } from "../../src/model/runtime.js";
import type { JsonValue } from "../../src/types.js";

const OPENAPI = `
openapi: "3.0.3"
info: { title: OTEL runtime exchange, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OrderInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
components:
  schemas:
    OrderInput:
      type: object
      required: [id, secret]
      properties:
        id: { type: string }
        secret: { type: string }
    Order:
      type: object
      required: [id, status]
      properties:
        id: { type: string }
        status: { type: string }
        secret: { type: string }
`;

const YAML = `
boundary: Order
contract_path: /orders
mask: [secret]
event_catalog:
  - type: OrderCreated
    payload_template:
      id: command.payload.id
      secret: command.payload.secret
      status: "'CREATED'"
behaviors:
  - name: create-order
    match: { operationId: createOrder, condition: "true" }
    emit: OrderCreated
reducers:
  - on: OrderCreated
    replace_state: true
`;

interface ExportedSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

function recordingTracer(spans: ExportedSpan[]): Tracer {
  return {
    startActiveSpan(name: string, callback: (span: Span) => unknown): unknown {
      const attributes: Record<string, unknown> = {};
      const span = {
        setAttributes(values: Attributes): Span {
          Object.assign(attributes, values);
          return this as unknown as Span;
        },
        setAttribute(key: string, value: unknown): Span {
          attributes[key] = value;
          return this as unknown as Span;
        },
        end(): void {
          spans.push({ name, attributes: { ...attributes } });
        },
      };
      return callback(span as unknown as Span);
    },
  } as unknown as Tracer;
}

function typescriptDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName("Order"), contractPath(pathSegment("orders")))
        .mask(fieldPath(field("secret")))
        .eventCatalog(
          event(eventType("OrderCreated"), {
            id: expression("event", ({ command }: EventContext) => command.payload.id),
            secret: expression("event", ({ command }: EventContext) => command.payload.secret),
            status: expression("event", () => "CREATED"),
          }),
        )
        .behavior({
          name: "create-order",
          operationId: operationId("createOrder"),
          condition: expression("behavior", () => true),
          emit: eventType("OrderCreated"),
        })
        .reducer(
          reducerRule(eventType("OrderCreated"))
            .apply(({ state, event }) => ({
              ...state,
              id: event.payload.id,
              secret: event.payload.secret,
              status: "CREATED",
            }))
            .build(),
        ),
    )
    .build();
}

async function bootPair(tracer: Tracer): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  const observer = createRuntimeOtelRequestResponseObserver({
    tracer,
    spanName: "potemkin.e2e.exchange",
  });
  const redactSecrets = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          key === "secret" ? "[REDACTED]" : redactSecrets(child),
        ]),
      );
    }
    return value;
  };
  const capture = {
    maxBytes: 1_024,
    redact: (_direction: "request" | "response", body: JsonValue | null) =>
      body === null ? body : redactSecrets(body),
  } as const;
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: "orders.yaml", yaml: YAML }] },
      observability: { observeTransportRequestResponse: observer, requestResponseCapture: capture },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
      observability: { observeTransportRequestResponse: observer, requestResponseCapture: capture },
    }),
  ]);
}

describe("final OTEL request/response exchange", () => {
  it.each(["YAML", "TypeScript"])(
    "%s exports the original request and final shaped response",
    async (name) => {
      const spans: ExportedSpan[] = [];
      const [yamlSystem, typescriptSystem] = await bootPair(recordingTracer(spans));
      const system = name === "YAML" ? yamlSystem : typescriptSystem;
      try {
        const response = await request(createRuntimeGateway(system))
          .post("/orders")
          .set("x-potemkin-trace-id", `trace-${name}`)
          .send({ id: `${name.toLowerCase()}-order`, secret: "do-not-export" })
          .expect(201);

        expect(response.body).toEqual({ id: `${name.toLowerCase()}-order`, status: "CREATED" });
        expect(spans).toHaveLength(1);
        const attributes = spans[0]!.attributes;
        expect(attributes).toMatchObject({
          "potemkin.request.path": "/orders",
          "potemkin.request.body": JSON.stringify({
            id: `${name.toLowerCase()}-order`,
            secret: "[REDACTED]",
          }),
          "potemkin.response.status": 201,
          "potemkin.response.body": JSON.stringify(response.body),
          "potemkin.trace_id": `trace-${name}`,
        });
        expect(JSON.stringify(attributes)).not.toContain("do-not-export");

        await request(createRuntimeGateway(system))
          .post("/orders")
          .send({ id: "invalid" })
          .expect(400);
        expect(spans).toHaveLength(2);
        expect(spans[1]!.attributes["potemkin.response.status"]).toBe(400);

        const forwarded = await request(createRuntimeGateway(system))
          .post("/_engine/forward")
          .send({
            method: "POST",
            path: "/orders",
            headers: {
              "content-type": "application/json",
              "x-potemkin-trace-id": `trace-${name}-forwarded`,
            },
            query: {},
            body: { id: `${name.toLowerCase()}-forwarded`, secret: "forwarded-secret" },
          })
          .expect(200);
        expect(forwarded.body).toMatchObject({ status: 201 });
        expect(spans).toHaveLength(3);
        expect(spans[2]!.attributes["potemkin.request.path"]).toBe("/orders");
        expect(spans[2]!.attributes["potemkin.trace_id"]).toBe(`trace-${name}-forwarded`);
        expect(spans[2]!.attributes["potemkin.request.body"]).toBe(
          JSON.stringify({
            id: `${name.toLowerCase()}-forwarded`,
            secret: "[REDACTED]",
          }),
        );
        expect(spans[2]!.attributes["potemkin.response.status"]).toBe(200);
        expect(String(spans[2]!.attributes["potemkin.response.body"])).toContain('"status":201');
        expect(String(spans[2]!.attributes["potemkin.response.body"])).not.toContain(
          "forwarded-secret",
        );

        await request(createRuntimeGateway(system))
          .post("/orders")
          .set("content-type", "application/json")
          .send("{malformed-json")
          .expect(400);
        expect(spans).toHaveLength(4);
        expect(spans[3]!.attributes).toMatchObject({
          "potemkin.request.body.captured": true,
          "potemkin.response.status": 400,
        });
      } finally {
        await system.dispose();
        await (name === "YAML" ? typescriptSystem : yamlSystem).dispose();
      }
    },
  );
});
