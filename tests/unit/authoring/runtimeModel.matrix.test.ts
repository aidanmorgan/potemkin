import {
  behavior,
  boundary,
  event,
  simulation,
  type TypedEventContext,
} from "../../../src/authoring/runtimeModel.js";
import { defineComponent, use } from "../../../src/authoring/composition.js";
import { defineHelper } from "../../../src/authoring/helpers.js";
import { defineResource } from "../../../src/authoring/resourceModel.js";
import {
  boundaryName,
  componentName,
  contractPath,
  eventType,
  field,
  fieldPath,
  helperName,
  operationId,
  pathSegment,
  resourceName,
  schemaReference,
} from "../../../src/authoring/references.js";
import type { RuntimeGuard } from "../../../src/model/runtime.js";
import type { JsonObject } from "../../../src/types.js";

describe("source-neutral TypeScript runtime model builders", () => {
  it("preserves payload inference through incremental event builder calls", () => {
    const inferred = event(eventType("Inferred"))
      .payload({ id: () => "order-1" })
      .build();
    expect(inferred.payload.id).toEqual(expect.any(Function));

    const created = event(eventType("Created"))
      .payload<{ id: string }>({ id: () => "order-1" })
      .payload<{ total: number }>({ total: () => 42 })
      .build();

    const idExpression = created.payload.id;
    if (typeof idExpression === "function") {
      const id: string = idExpression({} as TypedEventContext<JsonObject>);
      expect(id).toBe("order-1");
    }
    expect(created.payload.total).toEqual(expect.any(Function));
    // @ts-expect-error Incremental event builders expose only authored payload keys.
    void created.payload.missing;
  });

  it("builds events and exercises every behavior authoring branch", () => {
    const builtEvent = event(eventType("Created"))
      .payload({ id: () => "id-1" })
      .schemaRef(schemaReference("#/components/schemas/Created"))
      .build();
    expect(builtEvent).toMatchObject({
      type: "Created",
      schemaRef: "#/components/schemas/Created",
    });
    expect(Object.isFrozen(builtEvent)).toBe(true);

    const guard: RuntimeGuard = {
      name: "allowed",
      check: () => true,
      errorCode: "NOT_ALLOWED",
      errorMessage: "not allowed",
      errorStatus: 403,
    };
    const emission = { when: () => true, event: eventType("Created") };
    const command = {
      boundary: boundaryName("Audit"),
      intent: "mutation" as const,
      operationId: operationId("record"),
      targetId: () => "audit-1",
      payload: { source: () => "test" },
      condition: () => true,
    };

    const emitted = behavior("create")
      .operation(operationId("create"))
      .when(() => true)
      .condition(() => true)
      .method("POST")
      .headers({ "x-test": "yes" })
      .requires(guard)
      .scopes("write", "audit")
      .emit(eventType("Created"))
      .postcondition(() => true)
      .link("self", () => true)
      .status(201)
      .build();
    expect(emitted).toMatchObject({
      method: "POST",
      emit: "Created",
      responseStatus: 201,
      requiredScopes: ["write", "audit"],
    });

    // @ts-expect-error The public authoring API uses canonical uppercase HTTP methods.
    behavior("lowercase-method").method("post");

    const dispatched = behavior("dispatch")
      .operation(operationId("dispatch"))
      .emitWhen(emission)
      .dispatch(command)
      .build();
    expect(dispatched.emitWhen).toHaveLength(1);
    expect(dispatched.dispatchCommands).toHaveLength(1);

    expect(() => behavior("missing-operation").emit(eventType("Created")).build()).toThrow(
      'Behavior "missing-operation" requires an operationId',
    );
    expect(() => behavior("missing-effect").operation(operationId("noop")).build()).toThrow(
      'Behavior "missing-effect" requires an event or dispatch',
    );
  });

  it("builds a boundary through all optional source-neutral policies", () => {
    const resourceEvent = event(eventType("ResourceCreated"), { id: () => "id-1" });
    const reducer = { on: eventType("ResourceCreated"), apply: () => [] };
    const fault = {
      name: "unavailable",
      matches: () => true,
      response: { status: 503, body: { code: "UNAVAILABLE" } },
    };
    const reaction = {
      boundary: boundaryName("Audit"),
      on: "Created",
      emit: "Recorded",
      intent: "creation" as const,
      when: () => true,
      target: () => "audit-1",
      payload: { source: () => "test" },
    };

    const definition = boundary(boundaryName("Orders"), contractPath(pathSegment("orders")))
      .schema(schemaReference("Order"))
      .fallbackOverride()
      .identity({ key: { from: "path", name: "orderId" }, generate: () => "order-1" })
      .query({
        fields: { status: () => true },
        filter: () => true,
        sort: () => 0,
        pageSize: () => 10,
        maxPageSize: 100,
        cursor: () => undefined,
        expand: ["customer"],
        pagination: "envelope",
        includeDeleted: true,
        fallback: () => ({ fallback: true }),
      })
      .queryMapping({ status: () => true })
      .event(resourceEvent)
      .eventCatalog({ type: eventType("Audited"), payload: {} })
      .behavior({ name: "create", operationId: operationId("create"), emit: eventType("Created") })
      .reducer(reducer)
      .seed({ state: { id: "seed-1" }, id: "seed-1" })
      .initialization({ state: { id: "seed-2" }, eventType: "Seeded" })
      .response({ latency: { fixedMs: 2 }, status: () => 201 })
      .mask(fieldPath(field("secret")))
      .deprecated({ date: "2026-01-01", sunset: "2027-01-01", replacement: "/v2/orders" })
      .latency({ minMs: 1, maxMs: 3 })
      .auditFields()
      .strictSchema()
      .state({ computed: [], internal: [{ name: "version", type: "integer" }] })
      .faults(fault)
      .reactions(reaction)
      .include({
        component: defineComponent(componentName("Audit"), { eventCatalog: [] }),
        parameters: { enabled: true },
      })
      .build();

    expect(definition).toMatchObject({
      boundary: "Orders",
      contractPath: "/orders",
      schema: "Order",
      fallbackOverride: true,
      auditFields: true,
      strictSchema: true,
    });
    expect(definition.eventCatalog).toHaveLength(2);
    expect(definition.initialization).toHaveLength(2);
    expect(definition.faults).toHaveLength(1);
    expect(definition.reactions).toHaveLength(1);

    const disabledFallback = boundary(
      boundaryName("NoFallback"),
      contractPath(pathSegment("no-fallback")),
    )
      .fallbackOverride(false)
      .auditFields(false)
      .strictSchema(false)
      .build();
    expect(disabledFallback).toMatchObject({
      fallbackOverride: false,
      auditFields: false,
      strictSchema: false,
    });
  });

  it("builds simulations with boundaries, resources, uses, policies, helpers, and compilation inputs", () => {
    const component = defineComponent(componentName("Audit"), { eventCatalog: [] });
    const resource = defineResource({
      resource: resourceName("Order"),
      schema: schemaReference("Order"),
      eventCatalog: [],
      reducers: [],
      operations: [
        {
          operationId: operationId("createOrder"),
          contractPath: contractPath(pathSegment("orders")),
          emit: eventType("OrderCreated"),
        },
      ],
    });
    const helper = defineHelper(helperName("label"), (value: string) => `label:${value}`);
    const boundaryDefinition = boundary(
      boundaryName("Orders"),
      contractPath(pathSegment("orders")),
    ).build();

    const definition = simulation()
      .boundary(boundaryDefinition)
      .boundaries(boundary(boundaryName("Audit"), contractPath(pathSegment("audit"))))
      .use(use(component, boundaryName("Included"), contractPath(pathSegment("included"))))
      .policies({ idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true } })
      .global({ securityHeaders: { enabled: true, nosniff: true } })
      .resource(resource)
      .resources(resource)
      .helper(helper)
      .helpers(helper)
      .build();

    expect(definition.boundaries).toHaveLength(2);
    expect(definition.uses).toHaveLength(1);
    expect(definition.resources).toHaveLength(2);
    expect(definition.helpers?.map(({ name }) => name)).toEqual(["label", "label"]);
    expect(definition.policies).toMatchObject({
      idempotency: { enabled: true },
      securityHeaders: { enabled: true },
    });
  });
});
