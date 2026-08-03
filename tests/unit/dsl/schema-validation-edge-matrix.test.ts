import { validateBoundaryConfig, validateGlobalConfig } from "../../../src/dsl/schema.js";

const boundaryBase = {
  boundary: "Thing",
  contract_path: "/things",
  behaviors: [],
  reducers: [],
  event_catalog: [
    { type: "ThingCreated", payload_template: {} },
    { type: "Other", payload_template: {} },
    { type: "Created", payload_template: {} },
    { type: "Changed", payload_template: {} },
    { type: "OrderUpdated", payload_template: {} },
    { type: "Fallback", payload_template: {} },
  ],
};

function boundaryWith(value: Record<string, unknown>) {
  return { ...boundaryBase, ...value };
}

function expectBoundaryInvalid(value: Record<string, unknown>): void {
  expect(() => validateBoundaryConfig(boundaryWith(value))).toThrow();
}

describe("YAML DSL nested schema validation edge matrix", () => {
  it("rejects every behavior sub-shape that cannot become the runtime model", () => {
    const valid = {
      name: "create",
      response_status: 201,
      match: {
        operationId: "createThing",
        condition: "true",
        method: "post",
        headers: { "x-mode": "present" },
        required_scopes: ["write"],
        requires: [{ name: "allowed", condition: "true", message: "denied", error_status: 403 }],
      },
      emit: "ThingCreated",
      postcondition: "true",
      link_name: "self",
      link_condition: "true",
      dispatch_commands: [
        {
          boundary: "Audit",
          intent: "mutation",
          operationId: "record",
          target_id: "command.payload.id",
          payload: { source: "command.payload.source" },
          condition: "true",
        },
      ],
    };
    expect(validateBoundaryConfig(boundaryWith({ behaviors: [valid] })).behaviors).toHaveLength(1);

    for (const invalid of [
      null,
      { ...valid, name: "" },
      { ...valid, response_status: 99 },
      { ...valid, response_status: 600 },
      { ...valid, match: "bad" },
      { ...valid, match: { ...valid.match, typo: true } },
      { ...valid, match: { ...valid.match, operationId: undefined } },
      { ...valid, match: { ...valid.match, operationId: "" } },
      { ...valid, match: { ...valid.match, condition: "(" } },
      { ...valid, match: { ...valid.match, required_scopes: "write" } },
      { ...valid, match: { ...valid.match, required_scopes: [""] } },
      { ...valid, match: { ...valid.match, requires: "guard" } },
      { ...valid, match: { ...valid.match, requires: [{ name: "guard" }] } },
      { ...valid, match: { ...valid.match, method: 1 } },
      { ...valid, match: { ...valid.match, headers: { "x-mode": 1 } } },
      { ...valid, emit: "", emit_when: [{ when: "true", emit: "Other" }] },
      { ...valid, emit_when: "true", emit: undefined },
      { ...valid, emit_when: [], emit: undefined, dispatch_commands: undefined },
      { ...valid, emit_when: [{ when: "(", emit: "Other" }], emit: undefined },
      { ...valid, emit: undefined, dispatch_commands: undefined },
      { ...valid, postcondition: 1 },
      { ...valid, link_name: "" },
      { ...valid, link_condition: "(" },
      { ...valid, dispatch_commands: "bad" },
      { ...valid, dispatch_commands: [{ ...valid.dispatch_commands[0], intent: "bad" }] },
      { ...valid, dispatch_commands: [{ ...valid.dispatch_commands[0], target_id: "(" }] },
      { ...valid, dispatch_commands: [{ ...valid.dispatch_commands[0], payload: { id: 1 } }] },
      {
        ...valid,
        dispatch_commands: [{ ...valid.dispatch_commands[0], condition: "(" }],
      },
    ]) {
      expectBoundaryInvalid({ behaviors: [invalid] });
    }
  });

  it("rejects reducer patch shape errors and accepts all patch operation families", () => {
    const allPatches = [
      { op: "add", path: "/a", value: 1 },
      { op: "remove", path: "/b" },
      { op: "replace", path: "/c", value: null },
      { op: "append", path: "/d", value: false },
      { op: "prepend", path: "/e", value: [] },
      { op: "increment", path: "/f", by: 1 },
      { op: "merge", path: "/g", value: { nested: "${event.payload.value}" } },
      { op: "upsert", path: "/h", key: "id", value: { id: 1 } },
      { op: "move", path: "/i", from: "/j" },
      { op: "copy", path: "/k", from: "/l" },
    ];
    expect(
      validateBoundaryConfig(
        boundaryWith({ reducers: [{ on: "Changed", replace_state: true, patches: allPatches }] }),
      ).reducers[0]?.patches,
    ).toHaveLength(allPatches.length);

    for (const [index, invalid] of [
      null,
      { on: "Changed", typo: true },
      { on: "Changed", patches: "bad" },
      { on: "Changed", replace_state: "yes" },
      { on: "Changed", patches: [{ op: "bad", path: "/x" }] },
      { on: "Changed", patches: [{ op: "replace", path: "x", value: 1 }] },
      { on: "Changed", patches: [{ op: "replace", path: "/x${id}", value: 1 }] },
      { on: "Changed", patches: [{ op: "move", path: "/x" }] },
      { on: "Changed", patches: [{ op: "copy", path: "/x" }] },
      { on: "Changed", patches: [{ op: "upsert", path: "/x" }] },
      { on: "Changed", patches: [{ op: "add", path: "/x" }] },
      { on: "Changed", patches: [{ op: "replace", path: "/x", value: "state.value" }] },
      { on: "Changed", patches: [{ op: "replace", path: "/x", value: "${1 +}" }] },
    ].entries()) {
      try {
        validateBoundaryConfig(boundaryWith({ reducers: [invalid] }));
      } catch {
        continue;
      }
      throw new Error(`reducer invalid case ${index} was accepted`);
    }
  });

  it("rejects identity, query, event, initialization, and state nested errors", () => {
    const query = {
      fields: { id: "state.id" },
      filter: "true",
      sort: [{ field: "id", direction: "desc" }],
      page_size: "10",
      max_page_size: 20,
      cursor: "true",
      expand: ["customer"],
      pagination: "raw",
      include_deleted: false,
      fallback: { empty: true },
    };
    expect(validateBoundaryConfig(boundaryWith({ query })).query).toMatchObject({
      pagination: "raw",
      includeDeleted: false,
    });

    for (const invalid of [
      "bad",
      { unknown: true },
      { fields: [] },
      { fields: { id: "(" } },
      { filter: "(" },
      { sort: "bad" },
      { sort: [{ field: "id", typo: true }] },
      { sort: [{ direction: "asc" }] },
      { sort: [{ field: "id", direction: "sideways" }] },
      { page_size: -1 },
      { page_size: "" },
      { page_size: "(" },
      { max_page_size: 1.5 },
      { cursor: 1 },
      { expand: [1] },
      { pagination: "page" },
      { include_deleted: "yes" },
      { fallback: () => true },
    ]) {
      expectBoundaryInvalid({ query: invalid });
    }

    for (const invalid of [
      "bad",
      { creation: "bad" },
      { creation: { generate: 1 } },
      { key: "bad" },
      { key: { cel: "command.id" } },
      { key: { from: "other", name: "id" } },
      { key: { from: "path" } },
      { key: { from: "payload" } },
    ]) {
      expectBoundaryInvalid({ identity: invalid });
    }

    for (const invalid of [
      ["event"],
      [{ type: "Created", payload_template: { id: "(" } }],
      [{ type: "Created", payload_template: { id: 1 } }],
      [{ type: "Created", schema_ref: 1 }],
      "bad",
    ]) {
      expectBoundaryInvalid({ event_catalog: invalid });
    }
    for (const invalid of ["bad", ["item"], [1]]) {
      expectBoundaryInvalid({ initialization: invalid });
    }
    for (const invalid of [
      "bad",
      { computed: "bad" },
      { computed: [{ name: "display", formula: "(" }] },
      { computed: [{ name: "display", formula: "true", depends_on: [""] }] },
      { internal: "bad" },
      { internal: [{ name: "version" }] },
      { internal: [{ name: "version", type: "unknown" }] },
    ]) {
      expectBoundaryInvalid({ state: invalid });
    }
  });

  it("rejects global nested policy variants that cannot be compiled", () => {
    const invalidGlobals = [
      { auth: { mode: "oauth" } },
      { auth: { jwt: "bad" } },
      { auth: { jwt: { secret: "" } } },
      { auth: { jwt: { secret: "s", algorithm: "RS256" } } },
      { auth: { session: "bad" } },
      { hateoas: "bad" },
      { security_headers: { custom_headers: [] } },
      { versioning: { versions: "bad" } },
      {
        versioning: {
          versions: [
            { version: "v1", prefix: "/v1", default: true },
            { version: "v2", prefix: "/v2", default: true },
          ],
        },
      },
      { fault_rules: [{ name: "fault", match: "bad", response: { status: 500 } }] },
      { fault_rules: [{ name: "fault", match: {}, response: "bad" }] },
      { fault_rules: [{ name: "fault", match: {}, response: { status: "500" } }] },
      { webhooks: [{ name: "hook", url: "url", trigger: "bad" }] },
      { fallback: { rules: "bad" } },
      { fallback: { rules: [{ match: { typo: true }, respond: { status: 404 } }] } },
      { fallback: { rules: [{ match: {}, respond: { status: 99 } }] } },
      { coverage: { Thing: "bad" } },
      { coverage: { Thing: { strict: "yes" } } },
      { coverage: { Thing: { operations: [""] } } },
    ];
    for (const value of invalidGlobals) expect(() => validateGlobalConfig(value)).toThrow();
  });
});
