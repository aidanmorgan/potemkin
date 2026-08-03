import {
  defineResource,
  expandResources,
  type ResourceDefinition,
} from "../../../src/authoring/resourceModel.js";
import {
  contractPath,
  eventType,
  field,
  fieldPath,
  operationId,
  pathSegment,
  resourceName,
  schemaReference,
  stateFieldName,
} from "../../../src/authoring/references.js";
import type { OpenApiDoc } from "../../../src/contract/loader.js";
import { reducerRule } from "../../../src/authoring/nativeReducer.js";

const openapi = {
  paths: {
    "/orders": {
      get: { operationId: "listOrders" },
      post: { operationId: "createOrder" },
    },
    "/orders/{orderId}": {
      get: { operationId: "readOrder" },
      put: { operationId: "updateOrder" },
    },
  },
} as unknown as OpenApiDoc;

const fullResource: ResourceDefinition = {
  resource: resourceName("Order"),
  schema: schemaReference("Order"),
  identity: { generate: () => "order-1" },
  query: { pagination: "raw" },
  eventCatalog: [{ type: eventType("OrderCreated"), payload: {} }],
  reducers: [
    reducerRule(eventType("OrderCreated"))
      .apply(() => ({}))
      .build(),
  ],
  initialization: [{ state: { id: "seed-1" } }],
  response: { mask: [fieldPath(field("secret"))] },
  mask: [fieldPath(field("internal"))],
  auditFields: true,
  deprecated: { date: "2026-01-01" },
  latency: { fixedMs: 1 },
  state: { internal: [{ name: stateFieldName("version") }] },
  strictSchema: true,
  faults: [],
  reactions: [],
  operations: [
    { operationId: operationId("listOrders"), query: true },
    { operationId: operationId("createOrder"), emit: eventType("OrderCreated") },
    { operationId: operationId("readOrder"), query: true },
    {
      operationId: operationId("updateOrder"),
      behavior: { emit: eventType("OrderUpdated"), headers: { "x-mode": "update" } },
    },
    {
      operationId: operationId("fallbackCreate"),
      contractPath: contractPath(pathSegment("fallback")),
      method: "PATCH",
      behavior: { emitWhen: [{ when: () => true, event: eventType("Fallback") }] },
    },
  ],
};
const blankOperationId = " " as unknown as ResourceDefinition["operations"][number]["operationId"];
// @ts-expect-error Resource operations use the canonical uppercase HTTP method union.
const lowercaseResourceMethod: ResourceDefinition["operations"][number]["method"] = "patch";
void lowercaseResourceMethod;

describe("TypeScript resource expansion", () => {
  it("expands collection/detail paths and preserves optional source-neutral fields", () => {
    const expanded = expandResources([fullResource], openapi);
    expect(Object.isFrozen(expanded)).toBe(true);
    expect(expanded.map(({ contractPath: path }) => path)).toEqual([
      "/orders",
      "/orders/{orderId}",
      "/fallback",
    ]);
    expect(expanded[0]).toMatchObject({
      boundary: "Order__orders",
      fallbackOverride: true,
      identity: { generate: expect.any(Function) },
      initialization: fullResource.initialization,
      reactions: fullResource.reactions,
    });
    expect(expanded[1]).toMatchObject({
      boundary: "Order__orders_By_orderId",
      fallbackOverride: true,
      identity: { key: { from: "path", name: "orderId" } },
    });
    expect(expanded[1]?.initialization).toBeUndefined();
    expect(expanded[1]?.reactions).toBeUndefined();
    expect(expanded[2]).toMatchObject({
      boundary: "Order__fallback",
      behaviors: [{ method: "PATCH", emitWhen: expect.any(Array) }],
    });
  });

  it("supports detail-only resources and attaches initialization/reactions once", () => {
    const detailOnly: ResourceDefinition = {
      ...fullResource,
      resource: resourceName("Detail"),
      operations: [
        { operationId: operationId("readOrder"), query: true },
        { operationId: operationId("updateOrder"), emit: eventType("OrderUpdated") },
      ],
    };
    const expanded = expandResources([detailOnly], openapi);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      boundary: "Detail__orders_By_orderId",
      initialization: fullResource.initialization,
      reactions: fullResource.reactions,
    });
  });

  it("rejects invalid resources and operations before expansion", () => {
    const invalid = (value: unknown): ResourceDefinition => value as ResourceDefinition;
    expect(() => defineResource(invalid({}))).toThrow("Resource.resource");
    expect(() => defineResource(invalid({ resource: "Order" }))).toThrow("non-empty schema");
    expect(() =>
      defineResource(invalid({ resource: "Order", schema: "Order", operations: [] })),
    ).toThrow("requires operations");
    expect(() =>
      defineResource(
        invalid({ resource: "Order", schema: "Order", operations: [], eventCatalog: [] }),
      ),
    ).toThrow("requires operations");
    expect(() =>
      defineResource(
        invalid({ resource: "Order", schema: "Order", operations: [{}], eventCatalog: {} }),
      ),
    ).toThrow("requires eventCatalog");

    expect(() => expandResources([invalid({ ...fullResource, resource: " " })])).toThrow(
      "non-empty resource and schema",
    );
    expect(() => expandResources([invalid({ ...fullResource, operations: [] })])).toThrow(
      "requires at least one operation",
    );
    expect(() =>
      expandResources([
        invalid({ ...fullResource, operations: [{ operationId: blankOperationId }] }),
      ]),
    ).toThrow("without an operationId");
    expect(() =>
      expandResources([
        invalid({
          ...fullResource,
          operations: [
            { operationId: operationId("query"), query: true, emit: eventType("Created") },
          ],
        }),
      ]),
    ).toThrow("cannot emit and query");
    expect(() =>
      expandResources([
        invalid({
          ...fullResource,
          operations: [{ operationId: operationId("missing") }],
        }),
      ]),
    ).toThrow("requires an emit or behavior dispatch");
    expect(() =>
      expandResources([
        invalid({
          ...fullResource,
          operations: [
            {
              operationId: operationId("missing"),
              contractPath: undefined,
              query: true,
            },
          ],
        }),
      ]),
    ).toThrow("not present in the OpenAPI contract");
  });
});
