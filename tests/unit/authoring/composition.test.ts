import { boundary, simulation } from "../../../src/authoring/runtimeModel.js";
import {
  composeBoundaries,
  defineComponent,
  include,
  use,
} from "../../../src/authoring/composition.js";
import {
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  eventType,
  operationId,
  pathSegment,
  schemaReference,
  stateFieldName,
  type ContractPath,
} from "../../../src/authoring/references.js";
import type { ComponentSource } from "../../../src/authoring/composition.js";

describe("direct TypeScript component composition", () => {
  it("materializes use and include into ordinary runtime boundaries", () => {
    const fragment = defineComponent(componentName("AuditFragment"), () => ({
      eventCatalog: [{ type: eventType("AuditRecorded"), payload: {} }],
      reducers: [{ on: eventType("AuditRecorded"), apply: () => [] }],
    }));
    const component = defineComponent(componentName("Resource"), (parameters) => ({
      eventCatalog: [
        {
          type: eventType("ResourceCreated"),
          payload: { label: () => parameters["label"] ?? null },
        },
      ],
      behaviors: [
        {
          name: behaviorName("create"),
          operationId: operationId("createResource"),
          emit: eventType("ResourceCreated"),
          dispatchCommands: [
            {
              boundary: boundaryName("Resource"),
              intent: "mutation",
              operationId: operationId("noop"),
            },
          ],
        },
      ],
      reducers: [{ on: eventType("ResourceCreated"), apply: () => [] }],
      include: [include(fragment)],
    }));

    const definition = simulation()
      .use(
        use(component, boundaryName("Orders"), contractPath(pathSegment("orders")), {
          label: "order",
        }),
      )
      .build();
    const [materialized] = composeBoundaries(definition.boundaries, definition.uses);

    expect(materialized).toMatchObject({
      boundary: "Orders",
      contractPath: "/orders",
      eventCatalog: [{ type: "ResourceCreated" }, { type: "AuditRecorded" }],
    });
    expect(materialized?.behaviors[0]?.dispatchCommands?.[0]?.boundary).toBe("Orders");
    expect(materialized?.reducers).toHaveLength(2);
    const label = materialized?.eventCatalog[0]?.payload.label;
    expect(typeof label === "function" ? label({} as never) : label).toBe("order");
  });

  it("applies local event and behavior definitions over included fragments", () => {
    const fragment = defineComponent(componentName("Shared"), () => ({
      eventCatalog: [
        { type: eventType("SharedEvent"), payload: {} },
        { type: eventType("IncludedOnly"), payload: {} },
      ],
      behaviors: [
        {
          name: behaviorName("shared"),
          operationId: operationId("included"),
          emit: eventType("SharedEvent"),
        },
        {
          name: behaviorName("included-only"),
          operationId: operationId("includedOnly"),
          emit: eventType("IncludedOnly"),
        },
      ],
      reducers: [],
    }));
    const host = boundary(boundaryName("Host"), contractPath(pathSegment("host")))
      .event({ type: eventType("SharedEvent"), payload: {} })
      .behavior({
        name: behaviorName("shared"),
        operationId: operationId("local"),
        emit: eventType("SharedEvent"),
      })
      .event({ type: eventType("HostEvent"), payload: {} })
      .include(include(fragment))
      .build();

    const [materialized] = composeBoundaries([host]);
    expect(materialized?.eventCatalog.map((event) => event.type)).toEqual([
      "SharedEvent",
      "HostEvent",
      "IncludedOnly",
    ]);
    expect(materialized?.behaviors.map((behavior) => behavior.operationId)).toEqual([
      "local",
      "includedOnly",
    ]);
  });

  it("rejects cyclic components and duplicate live boundaries", () => {
    const cyclic = defineComponent(componentName("Cycle"), () => ({ include: [include(cyclic)] }));
    expect(() =>
      composeBoundaries(
        [],
        [use(cyclic, boundaryName("CycleA"), contractPath(pathSegment("cycle-a")))],
      ),
    ).toThrow("Cyclic TypeScript component composition");

    const first = boundary(boundaryName("Same"), contractPath(pathSegment("same"))).build();
    const second = boundary(boundaryName("Same"), contractPath(pathSegment("other"))).build();
    expect(() => composeBoundaries([first, second])).toThrow("Duplicate runtime boundary");

    const samePath = boundary(boundaryName("Different"), contractPath(pathSegment("same"))).build();
    expect(() => composeBoundaries([first, samePath])).toThrow("Duplicate runtime contract path");
  });

  it("merges every source-neutral component field and rewrites aliases for use", () => {
    const fragment = defineComponent(componentName("Part"), () => {
      const source: ComponentSource = {
        schema: schemaReference("Part"),
        fallbackOverride: true,
        identity: { generate: () => "generated" },
        query: {},
        queryMapping: {},
        eventCatalog: [{ type: eventType("Created"), payload: {} }],
        behaviors: [
          {
            name: behaviorName("dispatch"),
            operationId: operationId("dispatch"),
            dispatchCommands: [
              {
                boundary: boundaryName("Part"),
                intent: "mutation",
                operationId: operationId("save"),
              },
            ],
          },
        ],
        reducers: [{ on: eventType("Created"), apply: () => [] }],
        initialization: [],
        response: {},
        mask: [],
        latency: { fixedMs: 1 },
        auditFields: true,
        deprecated: { date: "2026-01-01" },
        state: { computed: [], internal: [] },
        strictSchema: true,
        faults: [],
        reactions: [
          {
            boundary: boundaryName("Part"),
            on: eventReference(boundaryName("Part"), eventType("Created")),
            emit: eventType("Recorded"),
          },
          { boundary: boundaryName("Part"), on: eventType("Created"), emit: eventType("Recorded") },
        ],
        export: { states: [] },
      };
      return source;
    });
    const materialized = composeBoundaries(
      [],
      [
        use(
          fragment,
          boundaryName("Orders"),
          contractPath(pathSegment("orders")),
          {},
          { Other: "External" },
        ),
      ],
    )[0]!;
    expect(materialized).toMatchObject({
      boundary: "Orders",
      contractPath: "/orders",
      schema: "Part",
      fallbackOverride: true,
      strictSchema: true,
      auditFields: true,
    });
    expect(materialized.behaviors[0]?.dispatchCommands?.[0]?.boundary).toBe("Orders");
    expect(materialized.reactions?.map((reaction) => reaction.on)).toEqual([
      "Orders:Created",
      "Created",
    ]);
  });

  it("requires semantic component names and schema references", () => {
    const component = defineComponent(componentName("Typed"), {
      schema: schemaReference("Typed"),
    });
    expect(component.name).toBe("Typed");
    // @ts-expect-error Component sources cannot leak raw runtime schema strings.
    const invalidSource: ComponentSource = { schema: "Typed" };
    void invalidSource;
  });

  it("rejects include clashes, identity/schema conflicts, state conflicts, and unbound aliases", () => {
    const event = (name: string) =>
      defineComponent(componentName(name), () => ({
        eventCatalog: [{ type: eventType("Shared"), payload: {} }],
        behaviors: [
          {
            name: behaviorName("shared"),
            operationId: operationId(name),
            emit: eventType("Shared"),
          },
        ],
        reducers: [],
      }));
    const first = event("First");
    const second = event("Second");
    const host = boundary(boundaryName("Host"), contractPath(pathSegment("host")))
      .include(include(first))
      .include(include(second))
      .build();
    expect(() => composeBoundaries([host])).toThrow("include clash");

    const identity = defineComponent(componentName("Identity"), () => ({
      identity: { generate: () => "id" },
    }));
    const identityHost = boundary(
      boundaryName("IdentityHost"),
      contractPath(pathSegment("identity")),
    )
      .identity({ generate: () => "host" })
      .include(include(identity))
      .build();
    expect(() => composeBoundaries([identityHost])).toThrow("identity is already supplied");

    const schema = defineComponent(componentName("Schema"), () => ({
      schema: schemaReference("Schema"),
    }));
    const schemaHost = boundary(boundaryName("SchemaHost"), contractPath(pathSegment("schema")))
      .schema(schemaReference("Host"))
      .include(include(schema))
      .build();
    expect(() => composeBoundaries([schemaHost])).toThrow("schema is already supplied");

    const state = defineComponent(componentName("State"), () => ({
      state: {
        computed: [{ name: stateFieldName("same"), dependsOn: [], formula: () => true }],
        internal: [],
      },
    }));
    const stateHost = boundary(boundaryName("StateHost"), contractPath(pathSegment("state")))
      .state({
        computed: [{ name: stateFieldName("same"), dependsOn: [], formula: () => false }],
        internal: [],
      })
      .include(include(state))
      .build();
    expect(() => composeBoundaries([stateHost])).toThrow("state field");

    const alias = defineComponent(componentName("Alias"), () => ({
      behaviors: [
        {
          name: behaviorName("alias-dispatch"),
          operationId: operationId("aliasDispatch"),
          dispatchCommands: [
            {
              boundary: boundaryName("Unbound"),
              intent: "mutation",
              operationId: operationId("save"),
            },
          ],
        },
      ],
    }));
    expect(() =>
      composeBoundaries(
        [],
        [use(alias, boundaryName("AliasUse"), contractPath(pathSegment("alias")))],
      ),
    ).toThrow("leaves boundary alias");
  });

  it("validates component and use construction boundaries", () => {
    expect(() => componentName(" ")).toThrow("Invalid Potemkin component-name");
    expect(() =>
      use(
        defineComponent(componentName("Part"), {}),
        boundaryName(" "),
        contractPath(pathSegment("x")),
      ),
    ).toThrow("Invalid Potemkin boundary-name");
    expect(() =>
      use(defineComponent(componentName("Part"), {}), boundaryName("X"), "" as ContractPath),
    ).toThrow("requires a contract path");
    expect(include(defineComponent(componentName("Part"), {}))).toMatchObject({ parameters: {} });
  });
});
