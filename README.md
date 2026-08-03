# Potemkin

Potemkin is a stateful HTTP simulator. An OpenAPI contract describes the wire format. YAML or TypeScript describes the state transitions. The Node engine keeps an in-memory event log and state graph, and the Kotlin plugin lets Specmatic drive the same simulation through HTTP.

This repository has YAML and TypeScript authoring surfaces with one execution model. YAML uses CEL
expressions and declarative blocks; TypeScript uses typed builders, immutable functions, and typed
callbacks. Both compile to one immutable `RuntimeProgram` and execute through the same core engine,
policies, storage ports, and HTTP gateway.

The current design has four deliberate layers:

- `src/parser`: YAML parsing/CEL compilation, TypeScript AST discovery and loading, OpenAPI
  composition, and configuration watching.
- `src/authoring` and `src/sdk`: the typed TypeScript authoring surface, semantic identifier
  constructors, `@PotemkinConfigure`, helper registration, and native reducer contracts.
- `src/model`: the source-neutral runtime model. YAML and TypeScript are compiled into this same
  shape before execution; the runtime never branches on the authoring source.
- `src/core`, `src/runtime`, and `src/http`: event execution, state/projector behavior, policies,
  request controls, response shaping, and the HTTP gateway.

There is no TypeScript-to-YAML adapter or second TypeScript runtime. The YAML loader and TypeScript
loader each produce the common model directly. TypeScript reducers are immutable event handlers:
they receive a read-only state view and return the complete resultant state, so they cannot mutate
the engine's stored graph.

Recent changes also made the operational path explicit: one `potemkin.yml` selects multiple YAML,
OpenAPI, and TypeScript globs; the server watches that source graph and reloads it from a clean
initialization state; TypeScript factories are discovered from the AST; helpers registered by a
TypeScript factory can be used by either YAML/CEL or TypeScript; and the real end-to-end tests drive
requests through Specmatic and the Kotlin plugin rather than calling `/_engine/forward` directly.

## Verification

```text
pnpm run verify:test                                    full retained Jest suite
pnpm run test:e2e                                      Specmatic-backed E2E suites
pnpm run test:conformance                              Specmatic contract-floor gate
pnpm run test:bdd                                       BDD scenarios
pnpm run verify:check-types                            source and authoring fixture types
pnpm run verify:no-skips                               no skipped/focused/todo tests
pnpm run verify:examples                               exported example corpus is current
```

The full Specmatic stack and the examples suite require Java and the built plugin. Lower-level
runtime and parser checks live under `tests/runtime` and use the normal Jest configuration.
The current retained Jest baseline is 196 suites and 2,750 tests. The verification commands are
kept separate because the full Specmatic and example stacks require Java, a built plugin, and a
larger Node heap.

## What a developer builds

A small simulation needs these files:

```text
examples/my-service/
  potemkin.yml           # Potemkin entry point
  specmatic.yaml         # Specmatic configuration, when using the plugin
  openapi/api.yaml       # contract
  dsl/
    global.yaml
    leads.yaml
  typescript/            # scanned @PotemkinConfigure configuration modules and helpers
```

The CRM simulation in [`examples/crm`](examples/crm) is the main worked example. It models leads, campaigns, calls, agents, opportunities, reactions, a conversion saga, derived projections, helpers, faults, and consumer-side Specmatic tests. The Stripe simulation in [`examples/stripe`](examples/stripe) shows resource expansion, form requests, prefixed identifiers, a payment state machine, and reaction-created resources.

## Prerequisites

- Node.js 24.x
- pnpm 10.x
- Java 17 or newer for the Kotlin plugin and full Specmatic tests

```sh
node --version
pnpm --version
java --version
pnpm install
```

## First run: the CRM example

Build the plugin once, then run the example tests:

```sh
cd plugin
./gradlew shadowJar
cd ..

pnpm run test:examples
```

The test harness starts the Node engine, the Specmatic stub, and the plugin. Tests send requests to the stub URL, not directly to the engine. Specmatic validates the request and response against the contract, and the plugin exercises the forwarding path used by a consumer.

The CRM example can also be started from its entry point:

```sh
pnpm run start:example
```

The command prints the stub URL. Use that URL for the requests below. The exact command is also documented in [`examples/crm/README.md`](examples/crm/README.md).

## Step 1: bind the simulation to OpenAPI

Create `potemkin.yml`:

```yaml
version: 1
specmatic: ./specmatic.yaml

modules:
  - "dsl/**/*.yaml"
  - "scenarios/**/*.yaml"

openapi:
  - "openapi/**/*.yaml"

typescript:
  scan:
    - include:
        - "typescript/**/*.ts"
      exclude:
        - "**/*.test.ts"
        - "**/*.d.ts"
  watchIntervalMs: 10000
plugin:
  engine:
    url: "${POTEMKIN_ENGINE_URL:http://localhost:3000}"
    timeoutMs: 30000
  controlPort: 0
```

The `openapi` globs in `potemkin.yml` select the OpenAPI documents that Potemkin composes into its
contract model. The `specmatic` entry points to the Specmatic configuration used by the plugin.
Potemkin uses operation IDs from the composed contract when it selects a behavior. A route that is
in the contract but has no behavior uses the configured fallback policy. A path that is not in the
contract returns `404 NO_ROUTE`.

`modules` and `openapi` are arrays of globs, not single paths. Every matching YAML module and
OpenAPI document participates in the next compilation. The TypeScript scanner applies each
`include`/`exclude` pair only to discovery; an imported dependency may live outside an exclusion
glob and is still loaded when a selected module imports it. This lets teams keep shared typed
helpers outside the primary scenario globs without making them configuration entry points.

Create a boundary in `dsl/leads.yaml`:

```yaml
boundary: Lead
contract_path: /leads

identity:
  creation:
    generate: "$uuidv7()"

event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
      companyName: "command.payload.companyName"
      status: "'NEW'"
      createdAt: "$now()"

behaviors: []
reducers: []
```

The TypeScript form uses the SDK builders. A configured module can return the
simulation from a `@PotemkinConfigure` factory:

```ts
import {
  PotemkinConfigure,
  boundary,
  boundaryName,
  behavior,
  contractPath,
  event,
  eventType,
  factoryName,
  operationId,
  pathSegment,
  schemaReference,
  simulation,
} from "potemkin/sdk";

class LeadConfiguration {
  @PotemkinConfigure(factoryName("leads"))
  static create() {
    return simulation()
      .boundary(
        boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
          .identity({ generate: ({ helpers }) => helpers.uuid() })
          .eventCatalog(
            event(eventType("LeadCreated"), {
              id: ({ command }) => command.targetId ?? "",
              companyName: ({ payload }) => String(payload.companyName ?? ""),
              status: () => "NEW",
            }),
          )
          .build(),
      )
      .build();
  }
}
```

Run the simulation linter before starting the stack:

```sh
pnpm run lint:sim -- examples/crm/potemkin.yml
```

The linter catches duplicate boundaries, unknown operation IDs, invalid event references, bad CEL, and several boot-time configuration errors.

Keep a boundary small and split a simulation across files. Every file matched by
`modules` is loaded and linked at boot:

```text
dsl/
  global.yaml
  leads.yaml
  lead-actions.yaml
  campaigns.yaml
```

Set `fallback_override: true` when an operation should use the generic CRUD fallback
for unmatched requests. A GET reads the current graph node; a mutation merges the
request into state. Leave it false when an unhandled operation should return an
error instead.

```yaml
boundary: Lead
contract_path: /leads
fallback_override: true
```

The TypeScript equivalent is:

```ts
const lead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .fallbackOverride(true)
  .build();
```

## Step 2: seed deterministic state

Add `initialization` to the boundary. Seed IDs explicitly when tests need stable URLs:

```yaml
initialization:
  - id: "00000000-0000-7000-8000-000000000010"
    companyName: "Apex Solutions Ltd"
    contactName: "Mina Cole"
    email: "mina@apex.example"
    status: "CONTACTED"
    tags: ["priority", "enterprise"]
    callIds: []
```

Boot records become the reset baseline:

```sh
curl -s -X POST "$STUB_URL/_admin/reset"
curl -s "$STUB_URL/leads/00000000-0000-7000-8000-000000000010"
```

Reset clears events, state, derived projections, idempotency entries, faults, clock offsets, and other runtime bookkeeping, then restores the initialization records.

Other identity sources are useful for APIs that do not put the aggregate ID in the usual `{id}` path parameter:

```yaml
identity:
  key:
    from: header # path, query, header, or payload
    name: x-token-id
```

For a body field, use a payload pointer:

```yaml
identity:
  key:
    from: payload
    pointer: accountId
```

The TypeScript builder uses `.initialization()` and the same identity sources:

```ts
const lead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .identity({
    key: { from: "header", name: "x-token-id" },
  })
  .initialization({
    id: "00000000-0000-7000-8000-000000000010",
    companyName: "Apex Solutions Ltd",
    contactName: "Mina Cole",
    email: "mina@apex.example",
    status: "CONTACTED",
    tags: ["priority", "enterprise"],
    callIds: [],
  })
  .build();
```

When the identity is in the request body, use a payload pointer:

```ts
const account = boundary(boundaryName("Account"), contractPath(pathSegment("accounts")))
  .identity({ key: { from: "payload", pointer: "accountId" } })
  .build();
```

The identity tests in [`tests/e2e/identity-key.e2e-test.ts`](tests/e2e/identity-key.e2e-test.ts) cover header, path, query, payload, and generated IDs.

## Step 3: turn requests into events

Behaviors are evaluated in order. The first matching behavior wins. Match on the OpenAPI operation ID and add a CEL condition for domain rules:

```yaml
behaviors:
  - name: createLead
    match:
      operationId: createLead
      condition: "true"
    emit: LeadCreated

  - name: qualifyLead
    match:
      operationId: qualifyLead
      condition: "state.status == 'CONTACTED'"
    emit: LeadQualified
```

The TypeScript builder expresses the same matching rules with typed callbacks:

```ts
import {
  behavior,
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  eventType,
  guardName,
  operationId,
  pathSegment,
  scopeName,
} from "potemkin/sdk";

interface LeadInput {
  companyName?: string;
  status?: string;
}

interface LeadState {
  status?: string;
  score?: number;
  active?: boolean;
  campaignId?: string;
  qualificationCount?: number;
  history?: readonly { event: string; at?: string }[];
  quantity?: number;
  unitPrice?: number;
}

const leadBehaviors = [
  behavior<LeadInput, LeadState>(behaviorName("createLead"))
    .operation(operationId("createLead"))
    .condition(() => true)
    .emit(eventType("LeadCreated"))
    .build(),
  behavior<LeadInput, LeadState>(behaviorName("qualifyLead"))
    .operation(operationId("qualifyLead"))
    .condition(({ state }) => state?.status === "CONTACTED")
    .emit(eventType("LeadQualified"))
    .build(),
];

const lead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .behavior(...leadBehaviors)
  .build();
```

The request pipeline is:

```text
OpenAPI request validation
  -> fault rules
  -> behavior matching
  -> guards and scope checks
  -> event hydration
  -> reducers and reactions in a shadow state
  -> atomic commit
  -> response shaping and validation
```

A behavior can require fields or scopes before it emits anything:

```yaml
- name: closeLead
  match:
    operationId: closeLead
    condition: "state.status == 'QUALIFIED'"
    requires:
      - name: closeReason
        condition: "size(command.payload.reason) > 0"
        error_code: CLOSE_REASON_REQUIRED
        error_message: "A close reason is required"
    required_scopes:
      - leads:write
  emit: LeadClosed
```

Failed validation or guards leave the event log and state graph unchanged.

The same field and scope guards can be declared as typed functions:

```ts
const closeLead = behavior<LeadInput, LeadState>(behaviorName("closeLead"))
  .operation(operationId("closeLead"))
  .condition(({ state }) => state?.status === "QUALIFIED")
  .requires({
    name: guardName("closeReason"),
    check: ({ payload }) => String(payload.reason ?? "").length > 0,
    errorCode: "CLOSE_REASON_REQUIRED",
    errorMessage: "A close reason is required",
  })
  .scopes(scopeName("leads:write"))
  .emit(eventType("LeadClosed"))
  .build();
```

### Event payloads and schema checks

The event catalogue defines the event types a boundary can emit. CEL expressions are evaluated when the event is hydrated:

```yaml
event_catalog:
  - type: LeadQualified
    schema_ref: "#/components/schemas/LeadQualified"
    payload_template:
      id: "command.targetId"
      qualifiedBy: "actor.id"
      qualifiedAt: "$now()"
      score: "state.score"
```

TypeScript event payloads are ordinary typed callbacks, and `schemaReference`
can attach the same OpenAPI component check:

```ts
interface QualifiedPayload {
  id: string;
  qualifiedBy: string;
  qualifiedAt: string;
  score: number;
}

const qualified = event<QualifiedPayload>(
  eventType("LeadQualified"),
  {
    id: ({ command }) => command.targetId ?? "",
    qualifiedBy: ({ request }) => request.actor?.id ?? "",
    qualifiedAt: ({ helpers }) => helpers.now(),
    score: ({ state }) => Number(state?.score ?? 0),
  },
  schemaReference("#/components/schemas/LeadQualified"),
);
```

`schema_ref` checks the hydrated event payload against an OpenAPI component before the unit of work commits. Use `$uuidv7()`, `$now()`, request data, actor data, and current state in the appropriate DSL phase. The complete phase rules are in [`docs/cel.md`](docs/cel.md).

### Conditional events and commands

One request can choose among several events:

```yaml
- name: updateLead
  match:
    operationId: updateLead
    condition: "true"
  emit_when:
    - when: "command.payload.status == 'QUALIFIED'"
      emit: LeadQualified
    - when: "command.payload.status == 'CLOSED'"
      emit: LeadClosed
  postcondition: "state.status == command.payload.status"
```

The TypeScript builder uses `.emitWhen(...)` for the same branch selection:

```ts
const updateLead = behavior<LeadInput, LeadState>(behaviorName("updateLead"))
  .operation(operationId("updateLead"))
  .condition(() => true)
  .emitWhen(
    {
      when: ({ payload }) => payload.status === "QUALIFIED",
      event: eventType("LeadQualified"),
    },
    {
      when: ({ payload }) => payload.status === "CLOSED",
      event: eventType("LeadClosed"),
    },
  )
  .postcondition(({ state, payload }) => state?.status === payload.status)
  .build();
```

Dispatch a second command in the same unit of work when one boundary owns a workflow step in another boundary:

```yaml
- name: convertLead
  match:
    operationId: convertLead
    condition: "state.status == 'QUALIFIED'"
  emit: LeadConverted
  dispatch_commands:
    - boundary: Opportunity
      intent: creation
      operationId: createOpportunity
      target_id: "$uuidv7()"
      payload:
        leadId: "command.targetId"
        value: "command.payload.value"
```

The TypeScript equivalents use `.emitWhen(...)` and `.dispatch(...)`:

```ts
const convertLead = behavior<LeadInput, LeadState>(behaviorName("convertLead"))
  .operation(operationId("convertLead"))
  .condition(({ state }) => state?.status === "QUALIFIED")
  .emit(eventType("LeadConverted"))
  .dispatch({
    boundary: boundaryName("Opportunity"),
    intent: "creation",
    operationId: operationId("createOpportunity"),
    targetId: ({ helpers }) => helpers.uuid(),
    payload: {
      leadId: ({ command }) => command.targetId ?? "",
      value: ({ payload }) => Number(payload.value ?? 0),
    },
  })
  .build();
```

A behavior may also be dispatch-only when the primary boundary must remain
unchanged while secondary work is executed atomically. The TypeScript builder
uses `.dispatch(...)` without `.emit(...)`; YAML uses `dispatch_commands` without
`emit` or `emit_when`. Both forms compile to the same runtime behavior.

Dispatches, reactions, and reducers run against a shadow graph. If any step fails, the original request commits no partial state.

### Header matching and audit fields

Add a header predicate when the same operation needs separate simulated outcomes:

```yaml
- name: slow-database-scenario
  match:
    operationId: createCall
    headers:
      x-potemkin-scenario: slow_db
    condition: "true"
  emit: CallCreated
```

TypeScript matches the same header with `.headers(...)`:

```ts
const slowDatabaseScenario = behavior("slow-database-scenario")
  .operation(operationId("createCall"))
  .headers({ "x-potemkin-scenario": "slow_db" })
  .condition(() => true)
  .emit(eventType("CallCreated"))
  .build();
```

Set `audit_fields: true` on a boundary to stamp `updatedAt` and `updatedBy` on
non-baseline events. `updatedBy` comes from the authenticated actor, or is null
when the request has no actor:

```yaml
boundary: Note
contract_path: /notes
audit_fields: true
```

The TypeScript form is:

```ts
const note = boundary(boundaryName("Note"), contractPath(pathSegment("notes")))
  .auditFields()
  .build();
```

## Step 4: project events with reducers

A reducer turns an event into JSON Patch-style updates. The common operations are `add`, `replace`, `remove`, `move`, `copy`, `test`, `increment`, and `append`:

```yaml
reducers:
  - on: LeadCreated
    patches:
      - op: add
        path: /status
        value: "${event.payload.status}"
      - op: add
        path: /score
        value: "${0}"
      - op: add
        path: /audit
        value:
          createdBy: "${event.payload.createdBy}"

  - on: LeadQualified
    patches:
      - op: replace
        path: /status
        value: QUALIFIED
      - op: increment
        path: /qualificationCount
        by: 1
      - op: append
        path: /history
        value:
          event: "${event.type}"
          at: "${event.payload.qualifiedAt}"

  - on: LeadClosed
    patches:
      - op: test
        path: /status
        value: QUALIFIED
      - op: remove
        path: /openTasks/0
```

TypeScript reducers are immutable functions that return the complete next
state. The builder keeps the event type attached to the reducer:

```ts
interface LeadEvent {
  id?: string;
  status?: string;
  qualifiedAt?: string;
}

const leadReducer = reducerRule<LeadEvent, LeadState>(eventType("LeadQualified"))
  .apply(({ state, event }) => ({
    ...state,
    status: "QUALIFIED",
    qualificationCount: Number(state.qualificationCount ?? 0) + 1,
    history: [...(state.history ?? []), { event: event.type, at: event.payload.qualifiedAt }],
  }))
  .build();

const lead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .reducer(leadReducer)
  .state({
    computed: [
      {
        name: "lineTotal",
        formula: ({ state }) => Number(state.quantity ?? 0) * Number(state.unitPrice ?? 0),
        dependsOn: ["quantity", "unitPrice"],
      },
    ],
  })
  .build();
```

Nested JSON Pointer paths and CEL values are supported:

```yaml
- on: OpportunityCreated
  patches:
    - op: replace
      path: /totals/value
      value: "${coalesce(state.totals.value, 0) + event.payload.value}"
```

Reducers are deterministic. They cannot perform network calls or depend on mutable process state. The patch tests in [`tests/e2e/reducer-patch-ops.e2e-test.ts`](tests/e2e/reducer-patch-ops.e2e-test.ts) cover the supported operations and failure behavior.

Computed fields are declared on the boundary and recalculated when their
dependencies change:

```yaml
state:
  computed:
    - name: lineTotal
      formula: "state.quantity * state.unitPrice"
      depends_on: [quantity, unitPrice]
```

With the default `strict_schema: true`, every `state.*` reference in a formula
must appear in `depends_on`. Set it to false only while developing a fixture.

## Step 5: query the state graph

A query reads current state without appending an event. The CRM contract maps query parameters to filters, ordering, pagination, and sparse fields:

```sh
# Filter by a scalar field
curl -s "$STUB_URL/leads?status=QUALIFIED"

# Sort and paginate
curl -s "$STUB_URL/leads?sort=-createdAt,companyName&offset=0&limit=10"

# Match an array member
curl -s "$STUB_URL/leads?tags=enterprise"

# Ask for a sparse response where the contract supports it
curl -s "$STUB_URL/leads?fields=id,companyName,status"
```

The query layer supports equality, array membership, ordering by several fields, offset/limit pagination, sparse fields, and response envelopes defined by the contract. Invalid query shape is rejected before a behavior runs; business guards remain in the DSL.

Declare application-specific filters with `query_mapping`. The `query` object
contains parsed URL values and `state` is the candidate graph node:

```yaml
query_mapping:
  status: "state.status == query.status"
  campaignId: "state.campaignId == query.campaignId"
```

For policies that need explicit default ordering, page limits, cursor values,
or a targeted fallback, use the source-neutral `query` block. Its CEL fields
compile to the same `RuntimeQueryPolicy` used by the TypeScript SDK:

```yaml
query:
  fields:
    threshold: "state.score >= int(query.threshold)"
  filter: "state.active == true"
  sort:
    - field: score
      direction: desc
  page_size: 25
  max_page_size: 100
  cursor: "query.cursor"
  expand: [customer]
  pagination: envelope
  include_deleted: false
  fallback:
    code: ORDER_NOT_FOUND
```

The TypeScript query policy uses the parsed query and candidate state directly:

```ts
const lead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .queryMapping({
    status: ({ state, query }) => String(state.status) === String(query.status),
    campaignId: ({ state, query }) => String(state.campaignId) === String(query.campaignId),
  })
  .query({
    fields: {
      threshold: ({ state, query }) => Number(state.score ?? 0) >= Number(query.threshold),
    },
    filter: ({ state }) => state.active === true,
    sort: (left, right) => Number(left.score) - Number(right.score),
    pageSize: ({ query }) => Number(query.limit ?? 25),
    maxPageSize: 100,
    cursor: ({ query }) => (typeof query.cursor === "string" ? query.cursor : undefined),
    expand: ["customer"],
    pagination: "envelope",
    includeDeleted: false,
    fallback: () => ({ code: "ORDER_NOT_FOUND" }),
  })
  .build();
```

`fields` entries are active only when their matching query parameter is
present. `fallback` is returned for a targeted query that has no matching
entity. YAML and TypeScript compile these declarations into the same runtime
model; TypeScript supplies callbacks directly through `boundary(...).query(...)`.

## Consistency and identity

### Idempotency

Enable idempotency in the global module:

```yaml
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
```

The TypeScript global policy uses camelCase field names:

```ts
const model = simulation()
  .global({
    idempotency: {
      enabled: true,
      ttlSeconds: 86400,
      hashIncludesBody: true,
    },
  })
  .build();
```

Send the same key and request twice:

```sh
curl -s -X POST "$STUB_URL/leads" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-apex-001' \
  -d '{"companyName":"Apex Solutions Ltd","contactName":"Mina Cole","email":"mina@apex.example"}'

curl -s -X POST "$STUB_URL/leads" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-apex-001' \
  -d '{"companyName":"Apex Solutions Ltd","contactName":"Mina Cole","email":"mina@apex.example"}'
```

From TypeScript, repeat the request with the same key to receive the stored
response:

```ts
const body = JSON.stringify({
  companyName: "Apex Solutions Ltd",
  contactName: "Mina Cole",
  email: "mina@apex.example",
});

const headers = {
  "Content-Type": "application/json",
  "Idempotency-Key": "create-apex-001",
};
await fetch(`${STUB_URL}/leads`, { method: "POST", headers, body });
const replay = await fetch(`${STUB_URL}/leads`, { method: "POST", headers, body });
console.log(replay.headers.get("X-Potemkin-Idempotency-Replay"));
```

The second request replays the stored response instead of creating another event. Reusing the key with a different body is rejected.

### Optimistic concurrency and HTTP validators

Mutation responses include the current version and ETag when configured. Supply the version or `If-Match` value on the next write:

```sh
curl -s -X PATCH "$STUB_URL/leads/$LEAD_ID" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "3"' \
  -d '{"status":"QUALIFIED"}'
```

A stale `If-Match` value returns a concurrency error and does not commit. Conditional GET supports `If-None-Match` and returns `304` when the entity has not changed.

Optimistic concurrency is exercised through the same HTTP headers from a
TypeScript test or consumer:

```ts
const response = await fetch(`${STUB_URL}/leads/${LEAD_ID}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "If-Match": '"3"',
  },
  body: JSON.stringify({ status: "QUALIFIED" }),
});

if (response.status === 412) {
  console.log("stale version; no event was committed");
}
```

## Authentication and request identity

The default bearer-token mode is convenient for tests. The token is deliberately simple and is not cryptographically verified. Put the actor ID first, followed by comma-separated scopes:

```yaml
behaviors:
  - name: updateLead
    match:
      operationId: updateLead
      required_scopes:
        - lead:write
      condition: "true"
    emit: LeadUpdated
```

The TypeScript boundary builder attaches the required scope directly:

```ts
const updateLead = behavior("updateLead")
  .operation(operationId("updateLead"))
  .condition(() => true)
  .scopes("lead:write")
  .emit(eventType("LeadUpdated"))
  .build();

const model = simulation()
  .boundary(boundary(boundaryName("Lead"), contractPath(pathSegment("leads"))).behavior(updateLead))
  .global({ auth: { mode: "simple" } })
  .build();
```

```sh
curl -s "$STUB_URL/leads" \
  -H 'Authorization: Bearer alice:lead:read,lead:write'
```

The equivalent TypeScript consumer request is:

```ts
await fetch(`${STUB_URL}/leads`, {
  headers: { Authorization: "Bearer alice:lead:read,lead:write" },
});
```

Require a scope in a behavior with `match.required_scopes`, as shown earlier. The actor is available to CEL and event templates through `actor.id`, `actor.scopes`, and related fields.

JWT verification is also supported for tests that need a real token boundary. Configure the issuer, audience, algorithm, and key material in the global auth block. [`tests/e2e/forward-blocks-and-jwt.e2e-test.ts`](tests/e2e/forward-blocks-and-jwt.e2e-test.ts) covers valid, expired, and missing-token cases.

YAML JWT configuration:

```yaml
auth:
  mode: jwt
  jwt:
    secret: local-test-secret
    algorithm: HS256
    issuer: potemkin-tests
    audience: crm-client
    scopes_claim: scopes
```

The TypeScript equivalent is:

```ts
const jwtModel = simulation()
  .global({
    auth: {
      mode: "jwt",
      jwt: {
        secret: process.env.POTEMKIN_JWT_SECRET ?? "local-test-secret",
        algorithm: "HS256",
        issuer: "potemkin-tests",
        audience: "crm-client",
        scopesClaim: "scopes",
      },
    },
  })
  .build();
```

Send a JWT from TypeScript like any other authenticated request:

```ts
await fetch(`${STUB_URL}/leads`, {
  headers: { Authorization: `Bearer ${jwt}` },
});
```

Cookie sessions and CSRF checks are available for browser-shaped simulations. Configure the session cookie and CSRF header, then send both on a state-changing request:

YAML session configuration:

```yaml
auth:
  mode: session
  session:
    cookie_name: sid
    ttl_seconds: 3600
    csrf: true
    csrf_header: X-CSRF-Token
    login_path: /sessions
    logout_path: /sessions/logout
```

The TypeScript equivalent is:

```ts
const sessionModel = simulation()
  .global({
    auth: {
      mode: "session",
      session: {
        cookieName: "sid",
        ttlSeconds: 3600,
        csrf: true,
        csrfHeader: "X-CSRF-Token",
        loginPath: "/sessions",
        logoutPath: "/sessions/logout",
      },
    },
  })
  .build();
```

```sh
LOGIN_RESPONSE=$(curl -s -X POST "$STUB_URL/sessions" -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"actorId":"alice","scopes":["agent","viewer"]}')
CSRF_TOKEN=$(printf '%s' "$LOGIN_RESPONSE" | jq -r '.csrfToken')

curl -s -X POST "$STUB_URL/leads" -b cookies.txt \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"companyName":"Browser Client","contactName":"Alice","phone":"+61 2 0000 0001","email":"alice@example.com","source":"WEBSITE"}'
```

In a TypeScript client, carry the session cookie and CSRF token forward:

```ts
const login = await fetch(`${STUB_URL}/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ actorId: "alice", scopes: ["agent", "viewer"] }),
});
const csrfToken = (await login.json()).csrfToken;
const sessionCookie = login.headers.get("set-cookie") ?? "";

await fetch(`${STUB_URL}/leads`, {
  method: "POST",
  headers: {
    Cookie: sessionCookie,
    "X-CSRF-Token": csrfToken,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ companyName: "Browser Client", source: "WEBSITE" }),
});
```

Keep admin endpoints on a trusted network. Set `ADMIN_TOKEN` to require `Authorization: Bearer <token>` for reset, state, events, clock, and fault controls.

## Workflows and side effects

### Sagas

Use a saga for a multi-step workflow with compensation. This example creates an opportunity after a lead conversion and closes it if a later step fails:

```yaml
sagas:
  - name: LeadConversion
    trigger:
      boundary: Lead
      intent: mutation
      condition: "event.type == 'LeadConverted'"
    steps:
      - name: createOpportunity
        boundary: Opportunity
        intent: creation
        operationId: createOpportunity
        target_id: "$uuidv7()"
        payload:
          leadId: "event.aggregateId"
          value: "command.payload.value"
        compensation:
          intent: mutation
          operationId: closeOpportunity
          payload:
            stage: "'withdrawn'"
```

The TypeScript policy uses `defineSaga` and typed context callbacks:

```ts
import { boundaryName, defineSaga, operationId, sagaName, sagaStepName } from "potemkin/sdk";

const leadConversion = defineSaga({
  name: sagaName("LeadConversion"),
  trigger: {
    boundary: boundaryName("Lead"),
    intent: "mutation",
    condition: ({ event }) => event?.type === "LeadConverted",
  },
  steps: [
    {
      name: sagaStepName("createOpportunity"),
      boundary: boundaryName("Opportunity"),
      intent: "creation",
      operationId: operationId("createOpportunity"),
      targetId: ({ helpers }) => helpers.uuid(),
      payload: {
        leadId: ({ event }) => event?.aggregateId ?? "",
        value: ({ command }) => Number(command.payload.value ?? 0),
      },
      compensation: {
        intent: "mutation",
        operationId: operationId("closeOpportunity"),
        payload: { stage: "withdrawn" },
      },
    },
  ],
});

const workflowModel = simulation()
  .global({ sagas: [leadConversion] })
  .build();
```

The saga tests in [`tests/e2e/full-crm-flow.e2e-test.ts`](tests/e2e/full-crm-flow.e2e-test.ts) verify the success and compensation paths.

### Reactions

Reactions let the receiving boundary subscribe without changing the source boundary:

```yaml
# inventory.yaml
reactions:
  - name: reserve-inventory
    on: "Order:OrderPlaced"
    intent: creation
    emit: InventoryReserved

# notification.yaml
reactions:
  - name: queue-order-notification
    on: "Order:OrderPlaced"
    intent: creation
    emit: NotificationQueued
```

TypeScript can register both subscribers in the global policy:

```ts
import {
  boundaryName,
  defineReaction,
  eventReference,
  eventType,
  reactionName,
  simulation,
} from "potemkin/sdk";

const orderReactions = [
  defineReaction({
    name: reactionName("reserve-inventory"),
    on: eventReference(boundaryName("Order"), eventType("OrderPlaced")),
    boundary: boundaryName("Inventory"),
    intent: "creation",
    emit: eventType("InventoryReserved"),
  }),
  defineReaction({
    name: reactionName("queue-order-notification"),
    on: eventReference(boundaryName("Order"), eventType("OrderPlaced")),
    boundary: boundaryName("Notification"),
    intent: "creation",
    emit: eventType("NotificationQueued"),
  }),
];

const reactionModel = simulation().global({ reactions: orderReactions }).build();
```

Use `intent: mutation`, `when`, `target`, and `payload` to update an existing aggregate conditionally:

```yaml
reactions:
  - name: allocate-stock
    on: "Order:OrderPlaced"
    when: "event.payload.quantity > 0"
    intent: mutation
    target: "'warehouse-main'"
    emit: StockAllocated
    payload:
      orderId: "event.aggregateId"
      quantity: "event.payload.quantity"
```

The conditional mutation form uses callbacks for `when`, `target`, and
payload values:

```ts
import {
  boundaryName,
  defineReaction,
  eventReference,
  eventType,
  reactionName,
} from "potemkin/sdk";

const allocateStock = defineReaction({
  name: reactionName("allocate-stock"),
  on: eventReference(boundaryName("Order"), eventType("OrderPlaced")),
  boundary: boundaryName("Inventory"),
  intent: "mutation",
  when: ({ event }) => Number(event?.payload.quantity ?? 0) > 0,
  target: () => "warehouse-main",
  emit: eventType("StockAllocated"),
  payload: {
    orderId: ({ event }) => event?.aggregateId ?? "",
    quantity: ({ event }) => Number(event?.payload.quantity ?? 0),
  },
});
```

Reaction events are part of the same unit of work. A failure rolls back the source event and all reaction events. The fan-out and chaining example is [`tests/e2e/reactions-fanout.e2e-test.ts`](tests/e2e/reactions-fanout.e2e-test.ts).

### Derived projections

Derived projections build a read model from events across boundaries:

```yaml
derived_projections:
  - name: LeadSummary
    key: "event.aggregateId"
    subscribe:
      - "Lead:LeadCreated"
      - "Opportunity:OpportunityCreated"
    reduce:
      - on: LeadCreated
        patches:
          - op: replace
            path: /lead_id
            value: "${event.aggregateId}"
          - op: replace
            path: /companyName
            value: "${event.payload.companyName}"
      - on: OpportunityCreated
        patches:
          - op: increment
            path: /total_opportunities
            by: 1
```

The TypeScript projection uses a native reducer for its read model:

```ts
import {
  defineProjection,
  eventReference,
  eventType,
  boundaryName,
  projectionName,
} from "potemkin/sdk";

const leadSummary = defineProjection({
  name: projectionName("LeadSummary"),
  key: ({ event }) => event?.aggregateId ?? "",
  subscribe: [
    eventReference(boundaryName("Lead"), eventType("LeadCreated")),
    eventReference(boundaryName("Opportunity"), eventType("OpportunityCreated")),
  ],
  reduce: [
    reducerRule(eventType("LeadCreated"))
      .apply(({ state, event }) => ({
        ...state,
        lead_id: event.aggregateId,
        companyName: event.payload.companyName,
      }))
      .build(),
    reducerRule(eventType("OpportunityCreated"))
      .apply(({ state }) => ({
        ...state,
        total_opportunities: Number(state.total_opportunities ?? 0) + 1,
      }))
      .build(),
  ],
});

const projectionModel = simulation()
  .global({ derivedProjections: [leadSummary] })
  .build();
```

Inspect it during a test:

```sh
curl -s "$STUB_URL/_admin/derived/LeadSummary"
```

### Webhooks

Webhooks run after the unit of work commits. The engine sends an HMAC signature and retries failed deliveries:

```yaml
webhooks:
  - name: lead-converted
    trigger:
      boundary: Lead
      condition: "event.type == 'LeadConverted'"
    url: "'http://127.0.0.1:19876/webhook'"
    secret: "local-test-secret"
    payload:
      leadId: "${event.aggregateId}"
      event: "${event.type}"
    retry:
      maxAttempts: 3
      delayMs: 100
```

The TypeScript webhook definition supplies the URL and payload as callbacks:

```ts
import { defineWebhook, webhookName } from "potemkin/sdk";

const leadConvertedWebhook = defineWebhook({
  name: webhookName("lead-converted"),
  trigger: ({ event }) => event?.type === "LeadConverted",
  url: () => "http://127.0.0.1:19876/webhook",
  secret: process.env.LEAD_WEBHOOK_SECRET ?? "local-test-secret",
  payload: {
    leadId: ({ event }) => event?.aggregateId ?? "",
    event: ({ event }) => event?.type ?? "",
  },
  retry: { maxAttempts: 3, delayMs: 100 },
});

const webhookModel = simulation()
  .global({ webhooks: [leadConvertedWebhook] })
  .build();
```

The receiver test is [`tests/e2e/webhook-hmac.e2e-test.ts`](tests/e2e/webhook-hmac.e2e-test.ts).

## TypeScript authoring

TypeScript supplies the simulation model directly. Callbacks are phase-specific and typed; CEL
and DSL strings are parser inputs, not a second TypeScript expression language. Use the semantic
reference constructors from `potemkin/sdk` for boundary names, operation IDs, event types,
contract paths, and response field paths. The runtime model contains canonical strings at
the source-neutral boundary, but TypeScript authoring cannot interchange these identifier roles.
Import authoring from `potemkin/sdk` and runtime boot/transport from their explicit package
surfaces; application code does not need to import internal `src/` modules.

The SDK also exposes typed error classes. Invalid semantic references and invalid authoring
definitions report `TypeScriptReferenceError` or `TypeScriptAuthoringError` with a stable
diagnostic code and structured details. This makes configuration failures distinguishable from
ordinary application exceptions and keeps IDE completion useful at each authoring boundary.

This example boots the same HTTP runtime used by the YAML path:

```ts
import { bootRuntime, createRuntimeGateway } from "potemkin";
import {
  boundary,
  boundaryName,
  contractPath,
  defineComponent,
  defineFault,
  defineProjection,
  defineReaction,
  defineResource,
  defineSaga,
  defineWebhook,
  event,
  eventType,
  expression,
  field,
  fieldPath,
  include,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
  use,
  type EventContext,
  type IdentityContext,
} from "potemkin/sdk";

interface InvoiceInput {
  invoiceId: string;
  amount: number;
}

const invoice = boundary(boundaryName("Invoice"), contractPath(pathSegment("invoices")))
  .identity({
    generate: expression("identity", ({ payload }: IdentityContext) =>
      String((payload as InvoiceInput).invoiceId),
    ),
  })
  .eventCatalog(
    event(eventType("InvoiceCreated"), {
      id: expression("event", ({ command }: EventContext) => command.targetId ?? ""),
      amount: expression("event", ({ payload }: EventContext) => (payload as InvoiceInput).amount),
      status: expression("event", () => "OPEN"),
    }),
  )
  .behavior({
    name: "create-invoice",
    operationId: operationId("createInvoice"),
    condition: expression("behavior", () => true),
    emit: eventType("InvoiceCreated"),
  })
  .reducer(
    reducerRule(eventType("InvoiceCreated"))
      .apply(({ state, event }) => ({
        ...state,
        id: event.payload.id,
        amount: event.payload.amount,
        status: "OPEN",
      }))
      .build(),
  )
  .build();

const model = simulation().boundary(invoice).build();
const system = await bootRuntime({ openapi, definition: model });
const app = createRuntimeGateway(system);
```

For mixed authoring, compile both sources into the shared model and give the resulting
`RuntimeProgram` to the source-independent runtime:

```ts
import { compileMixedProgram } from "potemkin/parser/mixed";

const system = await bootRuntime({
  openapi,
  programFactory: (context) =>
    compileMixedProgram({ yaml: { modules, globalYaml }, direct: model }, context),
});
```

When YAML is the only source, use the parser-owned boot helper. It compiles YAML and then calls
the same runtime boot operation used by TypeScript:

```ts
import { bootYamlRuntime } from "potemkin/parser/runtime";

const system = await bootYamlRuntime({
  openapi,
  yamlProgram: {
    modules: [{ name: "invoices.yaml", yaml: invoiceYaml }],
    globalYaml,
  },
});
```

`createRuntimeGateway` is the only HTTP transport for both authoring forms. YAML is compiled before
the gateway is created; the core runtime receives only the shared model and does not inspect YAML,
DSL, or CEL values.

Resource expansion is also available without YAML:

```ts
const model = defineSimulation({
  boundaries: [],
  resources: [
    {
      resource: "Invoice",
      schema: "Invoice",
      eventCatalog: [
        event(eventType("InvoiceCreated"), {
          id: expression("event-hydration", ({ command }) => command.targetId ?? ""),
        }),
      ],
      reducers: [
        reducerRule(eventType("InvoiceCreated"))
          .apply(({ state, event }) => ({ ...state, id: event.payload.id }))
          .build(),
      ],
      operations: [
        { operationId: operationId("createInvoice"), emit: eventType("InvoiceCreated") },
        { operationId: operationId("listInvoices"), query: true },
      ],
    },
  ],
});
```

Pass the OpenAPI document to `defineSimulation` or the builder when operation IDs need to be
resolved to paths. The explicit `contractPath` form is useful in unit tests.

### `@PotemkinConfigure` and shared helpers

Declare one or more TypeScript include/exclude groups in `potemkin.yml`:

```yaml
typescript:
  scan:
    - include:
        - "scenarios/**/*.ts"
        - "shared/**/*.ts"
      exclude:
        - "**/*.test.ts"
        - "**/*.d.ts"
```

The AST scanner invokes only static methods decorated with the exact
`@PotemkinConfigure` decorator imported from `potemkin/sdk`:

```ts
import {
  PotemkinConfigure,
  behaviorName,
  boundaryName,
  contractPath,
  boundary,
  defineHelper,
  event,
  eventType,
  factoryName,
  helperName,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
} from "potemkin/sdk";

const sourceLabel = defineHelper(helperName("sourceLabel"), (source: string) => source);

class WidgetConfiguration {
  @PotemkinConfigure(factoryName("widgets"))
  static create() {
    return simulation()
      .helper(sourceLabel)
      .boundary(
        boundary(boundaryName("Widget"), contractPath(pathSegment("widgets")))
          .eventCatalog(
            event(eventType("WidgetCreated"), {
              source: ({ command }) => sourceLabel(String(command.payload.source ?? "")),
            }),
          )
          .behavior({
            name: behaviorName("createWidget"),
            operationId: operationId("createWidget"),
            emit: eventType("WidgetCreated"),
          })
          .reducer(
            reducerRule(eventType("WidgetCreated"))
              .apply(({ state, event }) => ({ ...state, source: event.payload.source }))
              .build(),
          )
          .build(),
      )
      .build();
  }
}
```

`defineHelper` returns a callable typed function. Register it on the simulation
with `.helper()` or `.helpers()` and YAML can invoke the same function from CEL:

```yaml
event_catalog:
  - type: ThingCreated
    payload_template:
      source: "sourceLabel(command.payload.source)"
```

Helpers are pure JSON-in/JSON-out functions. The loader registers them before
the YAML compiler runs, so a YAML-only boundary can use a helper supplied by a
TypeScript factory without a sentinel or runtime source
branch. Both loaders produce the same canonical model before the engine runs.

### Configuration-driven TypeScript scenarios

The same `typescript.scan` include/exclude globs can select full TypeScript
scenario modules as well as `@PotemkinConfigure` helpers. A selected scenario module is
configured only through a static method annotated with `@PotemkinConfigure`:

```yaml
version: 1
specmatic: ./specmatic.yaml
openapi:
  - "openapi/**/*.yaml"
modules:
  - "dsl/**/*.yaml"
typescript:
  scan:
    - include: ["scenarios/**/*.ts"]
      exclude: ["**/*.test.ts", "**/*.d.ts"]
  watchIntervalMs: 10000
```

```ts
import {
  boundary,
  boundaryName,
  contractPath,
  factoryName,
  pathSegment,
  simulation,
  PotemkinConfigure,
  type FactoryContext,
} from "potemkin/sdk";

class WidgetScenario {
  @PotemkinConfigure(factoryName("widgets"))
  static create(_context: FactoryContext) {
    return simulation()
      .boundary(boundary(boundaryName("Widget"), contractPath(pathSegment("widgets"))).build())
      .build();
  }
}
```

The annotation is the complete discovery contract: default exports, named
simulation exports, and free-standing factory functions are not loaded as
engine configuration. All selected TypeScript files are evaluated for
dependencies and registration, then the annotated static factories are invoked
in deterministic source/name order. YAML modules are loaded by the separate
YAML source loader and both authoring forms compile into the same runtime model.

Discovery is AST-based rather than a text search. Comments, strings, instance
methods, unrelated decorators, and decorator-like text do not make a file an
entry point. The canonical decorator import is `PotemkinConfigure` from
`potemkin/sdk`; additional single-purpose annotations may be added to the SDK
when they carry typed discovery or metadata semantics, but they must remain
canonical exports with loader and runtime tests.

`modules` and `openapi` accept multiple globs. The server always polls the single
`potemkin.yml` and every selected YAML, OpenAPI, and TypeScript file every ten
seconds by default. The TypeScript dependency graph is included in the watched
set, while the configuration file itself is always watched. A detected change
clears the runtime and boots the new configuration from its initialization
state; if a reload fails, the previous active runtime remains in service and
the error is reported. Start the server with the one configuration path
supplied by environment or command line:

```sh
POTEMKIN_CONFIG_PATH=/workspace/potemkin.yml pnpm run start:server
# or: pnpm run start:server -- --config /workspace/potemkin.yml
```

#### Running the real Specmatic stack in Docker

The repository includes a Docker Compose stack with the production Potemkin
server and Specmatic/plugin. Mount the directory containing the one
`potemkin.yml` into `/workspace`; both services read that same file, including
its multiple OpenAPI globs:

```sh
docker compose up --build
```

Specmatic is exposed on port `9000` and Potemkin on port `3000`. Override the
configuration location with `POTEMKIN_CONFIG_PATH` in both services when the
mounted file is not `/workspace/potemkin.yml`.

### Native reducers

TypeScript reducers are ordinary immutable functions. A reducer receives the
current state and event and returns the complete next state; it does not use a
decorator, path string, or operation string:

```ts
import { eventType, reducerRule } from "potemkin/sdk";

reducerRule(eventType("LeadQualified"))
  .apply(({ state, event }) => ({
    ...state,
    status: "QUALIFIED",
    qualificationCount: Number(state.qualificationCount ?? 0) + 1,
    id: event.payload.id,
  }))
  .build();
```

### Testing a pure TypeScript model

The API uses typed interfaces, immutable values, functional composition, and builders. It can
compile a TypeScript-authored boundary or resource directly, install native TypeScript reducers,
run typed expressions in the evaluator phases, and retain lifecycle declarations. The runtime
authoring checks live under `tests/runtime/`, while public behavior is proved by the
Specmatic-backed suites under `tests/e2e/`.

Run the lower-level authoring checks directly while working on the API:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
  pnpm exec jest --runInBand \
  tests/runtime/authoring-typescript.runtime.test.ts \
  tests/runtime/typescript-resource.runtime.test.ts
```

The source-specific authoring tests are `tests/runtime/authoring-yaml.runtime.test.ts` and
`tests/runtime/authoring-typescript.runtime.test.ts`. The observable authoring trace is
`tests/runtime/pure-authoring-observables.runtime.test.ts`.

### Using the source-independent runtime directly

For lower-level tests and embedding, compile the same TypeScript authoring definition into the
source-independent `RuntimeModel` and give that model to the runtime system. This path has no YAML
module, CEL expression, or parser representation in it; the YAML loader produces the same model.

```ts
import { bootRuntime } from "potemkin";
import { boundary, boundaryName, contractPath, pathSegment, simulation } from "potemkin/sdk";

const definition = simulation()
  .boundary(boundary(boundaryName("Order"), contractPath(pathSegment("orders"))).build())
  .build();

const system = await bootRuntime({ openapi, definition });
```

Use the SDK's `reducerRule(...).apply(...)` contract for native reducers in this path. The reducer
returns the complete next state; JSON Patch operations are a YAML authoring concern and are
compiled by the YAML loader before the runtime starts. The runtime itself receives only the common
model and does not inspect YAML, TypeScript, DSL, or CEL values.

The usual development sequence is:

1. Put the typed definition in a normal `.ts` test or configuration module.
2. Inject deterministic helpers, the OpenAPI contract, and test transports at boot.
3. Send requests through `createRuntimeGateway` or the Specmatic/plugin path.
4. Inspect the response, committed events, and `engine.snapshot()` alongside the request.
5. Call `system.engine.reset()` between scenarios; it clears state, events, projections,
   idempotency records, and fault effects before reseeding.

Use `bootYamlRuntime({ yamlProgram })`, or call `compileYamlProgram` from the `parser` subpath when
the source is YAML. Faults, reactions, dispatch, sagas and compensation, projections, HMAC
webhooks, response policies, lifecycle hooks, queries, auth, idempotency, optimistic concurrency,
fallback, and reset are runtime capabilities; their authoring syntax belongs to the TypeScript
definition or the parser, not to the core.

## Response shaping

Response shaping happens after the state transition and before the response is checked against the contract.

### HATEOAS

Enable dynamic self links globally and add static links directly to a boundary file:

```yaml
hateoas:
  enabled: true
  self_links: true
```

In `dsl/leads.yaml`, add a static link:

```yaml
boundary: Lead
contract_path: /leads
hateoas:
  - rel: campaign
    href: /campaigns
```

The TypeScript form puts global link settings in `defineGlobal` and boundary
links in the response policy:

```ts
const leadWithLinks = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .response({
    hateoas: [{ rel: "campaign", href: () => "/campaigns" }],
  })
  .build();

const linksModel = simulation()
  .boundary(leadWithLinks)
  .global({ hateoas: { enabled: true, selfLinks: true } })
  .build();
```

The global form can also add action links with `link_name` and `link_condition`. See [`tests/e2e/hateoas.e2e-test.ts`](tests/e2e/hateoas.e2e-test.ts).

### Masking, deprecation, and headers

Hide internal fields, advertise an endpoint sunset, and add security headers:

```yaml
mask:
  - internalNotes

deprecated:
  date: "2025-01-01"
  sunset: "2027-01-01T00:00:00Z"
  replacement: /v2/leads

security_headers:
  enabled: true
  hsts: true
  nosniff: true
  frame_deny: true
  referrer_policy: strict-origin-when-cross-origin
  custom_headers:
    X-Custom-Sim-Header: potemkin-sim
```

The TypeScript equivalents use field references, boundary response policies,
and camelCase global security options:

```ts
const securedLead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .mask(fieldPath(field("internalNotes")))
  .deprecated({
    date: "2025-01-01",
    sunset: "2027-01-01T00:00:00Z",
    replacement: "/v2/leads",
  })
  .build();

const securityModel = simulation()
  .boundary(securedLead)
  .global({
    securityHeaders: {
      enabled: true,
      hsts: true,
      nosniff: true,
      frameDeny: true,
      referrerPolicy: "strict-origin-when-cross-origin",
      customHeaders: { "X-Custom-Sim-Header": "potemkin-sim" },
    },
  })
  .build();
```

Masking is applied to responses and does not change stored state. Deprecation produces `Deprecation`, `Sunset`, and `Link` headers. Security headers also apply to errors and admin responses.

### Latency and version routing

Add deterministic delay to a boundary:

```yaml
latency:
  fixed_ms: 20
  min_ms: 30
  max_ms: 60
```

Configure URL versions in the global module:

```yaml
versioning:
  enabled: true
  versions:
    - version: v1
      prefix: /v1
    - version: v2
      prefix: /v2
      default: true
```

The TypeScript form is:

```ts
const delayedLead = boundary(boundaryName("Lead"), contractPath(pathSegment("leads")))
  .latency({ fixedMs: 20, minMs: 30, maxMs: 60 })
  .build();

const versionedModel = simulation()
  .boundary(delayedLead)
  .global({
    versioning: {
      enabled: true,
      versions: [
        { version: "v1", prefix: "/v1" },
        { version: "v2", prefix: "/v2", default: true },
      ],
    },
  })
  .build();
```

The gateway strips the prefix for contract lookup and reports the selected version in
`X-Potemkin-Version`. Specmatic-facing versioned requests are included in route discovery and
are resolved by the same gateway logic after the plugin forwards them to the Node engine.

## Fault injection and runtime controls

Fault rules run before behavior matching:

```yaml
fault_rules:
  - name: dnc-registry-timeout
    match:
      boundary: Lead
      intent: mutation
      condition: "command.payload.reason == 'REGISTRY_CHECK'"
    response:
      status: 504
      body:
        error: DNC_REGISTRY_TIMEOUT
      delay_ms: 100

  - name: rate-limit-header
    match:
      condition: "true"
      potemkin:
        rate_limit: "*"
    response:
      status: 429
      body:
        error: RATE_LIMITED
      headers:
        Retry-After: "30"
```

TypeScript fault rules use typed predicates and direct runtime controls:

```ts
const maintenanceFault = defineFault({
  name: "dnc-registry-timeout",
  matches: ({ command }) => String(command.payload.reason) === "REGISTRY_CHECK",
  response: {
    status: 504,
    body: { error: "DNC_REGISTRY_TIMEOUT" },
  },
  delayMs: 100,
});

const rateLimitFault = defineFault({
  name: "rate-limit-header",
  matches: ({ request }) => request.controls?.rateLimit === true,
  response: {
    status: 429,
    body: { error: "RATE_LIMITED" },
    headers: { "Retry-After": "30" },
  },
});

const faultModel = simulation()
  .global({ faults: [maintenanceFault, rateLimitFault] })
  .build();
```

For one request, use chaos headers instead of editing YAML:

```sh
curl -s "$STUB_URL/leads/$LEAD_ID" \
  -H 'X-Potemkin-Force-Latency: 250'

curl -s "$STUB_URL/leads/$LEAD_ID" \
  -H 'X-Potemkin-Force-Status: 503'
```

A TypeScript consumer sends the same request-scoped controls as ordinary
headers:

```ts
await fetch(`${STUB_URL}/leads/${LEAD_ID}`, {
  headers: { "X-Potemkin-Force-Latency": "250" },
});

await fetch(`${STUB_URL}/leads/${LEAD_ID}`, {
  headers: { "X-Potemkin-Force-Status": "503" },
});
```

Other control headers support dry runs, time-travel reads, clock offsets, response format control, observability injection, and admin-gated validation controls. The canonical names are in [`src/http/potemkinHeaders.ts`](src/http/potemkinHeaders.ts). The matrix is exercised by [`tests/e2e/chaos-headers.e2e-test.ts`](tests/e2e/chaos-headers.e2e-test.ts) and [`tests/e2e/control-headers.e2e-test.ts`](tests/e2e/control-headers.e2e-test.ts).

The controls most often used in a consumer test are:

| Header                                   | Example          | Effect                                                            |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `X-Potemkin-Dry-Run`                     | `true`           | Run the unit of work, then discard its events and state changes.  |
| `X-Potemkin-Include-Events`              | `true`           | Add the staged events to the response for assertions.             |
| `X-Potemkin-Skip-Sagas`                  | `true`           | Commit primary events without running saga triggers.              |
| `X-Potemkin-Skip-Webhooks`               | `true`           | Commit state without delivering webhooks.                         |
| `X-Potemkin-Skip-Projections`            | `true`           | Commit events without applying derived projections.               |
| `X-Potemkin-Skip-Reactions`              | `true`           | Commit events without running reaction subscribers.               |
| `X-Potemkin-Skip-Dispatch`               | `true`           | Stop secondary command cascades for this request.                 |
| `X-Potemkin-Max-Cascade-Depth`           | `3`              | Override the cascade depth for one request.                       |
| `X-Potemkin-Bulk-Transactional`          | `true`           | Make an array-body request all-or-nothing.                        |
| `X-Potemkin-Seed`                        | `42`             | Seed `$fake()` and `$uuidv7()` deterministically for one request. |
| `X-Potemkin-Echo`                        | `true`           | Add request routing details to the response.                      |
| `X-Potemkin-Actor`                       | `alice:admin`    | Supply an admin-gated actor override.                             |
| `X-Potemkin-Impersonate`                 | `bob:agent`      | Run as another actor while recording the original actor.          |
| `X-Potemkin-Caused-By`                   | `<event-id>`     | Set the `causedBy` field on emitted events.                       |
| `X-Potemkin-Read-At-Version`             | `12`             | Read state at an earlier event sequence.                          |
| `X-Potemkin-Replay-Event`                | `<event-id>`     | Re-emit a historic event.                                         |
| `X-Potemkin-Response-Format`             | `hal`            | Select `hal`, `jsonapi`, or `plain` response shaping.             |
| `X-Potemkin-Pagination-Style`            | `link-header`    | Select collection envelope, raw, or link-header pagination.       |
| `X-Potemkin-Mask`                        | `internalNotes`  | Replace named response fields with `[MASKED]`.                    |
| `X-Potemkin-Trace-Id`                    | `test-123`       | Inject a trace ID into the response and telemetry.                |
| `X-Potemkin-Span-Name`                   | `checkout`       | Set the request span name.                                        |
| `X-Potemkin-Log-Level`                   | `debug`          | Change the request log level.                                     |
| `X-Potemkin-Metric-Tag`                  | `scenario=retry` | Attach a tag to request metrics.                                  |
| `X-Potemkin-Skip-Request-Validation`     | `true`           | Skip request validation; admin-gated.                             |
| `X-Potemkin-Skip-Response-Validation`    | `true`           | Skip response validation; admin-gated.                            |
| `X-Potemkin-Allow-Additional-Properties` | `true`           | Relax a closed object schema; admin-gated.                        |

For direct TypeScript runtime calls, the same controls are grouped in the
request object instead of HTTP headers:

```ts
const controls = {
  dryRun: true,
  includeEvents: true,
  seed: "42",
  responseFormat: "plain" as const,
  traceId: "test-123",
  forceLatencyMs: 250,
};

// Pass `controls` on RuntimeRequest when calling the source-independent engine.
```

For deterministic clock-dependent responses:

```sh
curl -s "$STUB_URL/leads/$LEAD_ID" \
  -H 'X-Potemkin-Clock-Offset: 86400000'
```

## Observability

Potemkin has source-neutral observability ports. The production server connects
them to OpenTelemetry, while tests and embedders can inject deterministic
observers. Each handled request produces one final exchange observation after
matching, state changes, response policies, side effects, validation, and
transport outcome have completed. The observation preserves the original
request, final response, trace/command correlation, status, headers, captured
body sizes, truncation flags, and connection-close outcome.

Request and response bodies are redacted and byte-limited before they reach the
observer. The same observation contract is used for direct HTTP and
Specmatic-forwarded requests, including successful responses, reads, faults,
chaos outcomes, validation failures, transactional rollback, and closed
connections. Runtime counters and histograms are also exposed through the
OpenTelemetry metrics port.

Enable OTLP export for the server with the standard environment variables:

```sh
OTEL_SERVICE_NAME=potemkin \
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
pnpm run start:server -- --config /workspace/potemkin.yml
```

Set `OTEL_SDK_DISABLED=true` to disable the production SDK. The observability
matrix is exercised by [`tests/e2e/runtime-observability.e2e-test.ts`](tests/e2e/runtime-observability.e2e-test.ts)
and the lower-level request/response tests under [`tests/unit/observability`](tests/unit/observability).

## Composition and resource expansion

### Components, `use`, and `include`

Extract a reusable component:

```yaml
kind: component
name: AuditedEntity

parameters:
  actorField:
    type: string
    default: lastActor

reducers:
  - on: AuditLogged
    patches:
      - op: replace
        path: "/{{actorField}}"
        value: "${event.payload.actor}"
```

Instantiate it at two paths:

```yaml
use:
  - component: AuditedEntity
    as: Document
    contract_path: /documents
    with:
      actorField: lastActor
  - component: AuditedEntity
    as: Invoice
    contract_path: /invoices
    with:
      actorField: updatedBy
```

TypeScript components are factories, so parameters become ordinary values:

```ts
import {
  componentName,
  defineComponent,
  eventType,
  include,
  reducerRule,
  simulation,
  use,
  boundaryName,
  contractPath,
  pathSegment,
} from "potemkin/sdk";

const auditedEntity = defineComponent(componentName("AuditedEntity"), (parameters) => {
  const actorField = String(parameters.actorField ?? "lastActor");
  return {
    reducers: [
      reducerRule(eventType("AuditLogged"))
        .apply(({ state, event }) => ({
          ...state,
          [actorField]: event.payload.actor,
        }))
        .build(),
    ],
  };
});

const composedModel = simulation()
  .use(
    use(auditedEntity, boundaryName("Document"), contractPath(pathSegment("documents")), {
      actorField: "lastActor",
    }),
    use(auditedEntity, boundaryName("Invoice"), contractPath(pathSegment("invoices")), {
      actorField: "updatedBy",
    }),
  )
  .boundary(
    boundary(boundaryName("Note"), contractPath(pathSegment("notes")))
      .include(include(auditedEntity, { actorField: "updatedBy" }))
      .build(),
  )
  .build();
```

Use `include` when a live boundary or component should inherit a fragment. Local behavior and event names override included entries; reducers are additive. Duplicate or unresolved composition references fail at boot. The full example is [`tests/e2e/composition.e2e-test.ts`](tests/e2e/composition.e2e-test.ts).

### Resource files

For an API with repeated CRUD conventions, a `*.resource.yaml` file expands one resource declaration into operation-specific boundaries:

```yaml
resource: Product
schema: product
operations:
  - { op: PostProducts, emit: ProductCreated }
  - { op: GetProducts, query: true }
  - { op: GetProductsId, query: true }
  - { op: PostProductsId, emit: ProductUpdated }
```

The TypeScript resource definition expands from the same OpenAPI operation IDs:

```ts
import {
  defineResource,
  event,
  eventType,
  operationId,
  resourceName,
  schemaReference,
  reducerRule,
  simulation,
} from "potemkin/sdk";

const productResource = defineResource({
  resource: resourceName("Product"),
  schema: schemaReference("product"),
  eventCatalog: [
    event(eventType("ProductCreated"), {
      id: ({ command }) => command.targetId ?? "",
    }),
    event(eventType("ProductUpdated"), {
      id: ({ command }) => command.targetId ?? "",
    }),
  ],
  reducers: [
    reducerRule(eventType("ProductCreated"))
      .apply(({ state, event }) => ({ ...state, id: event.payload.id }))
      .build(),
    reducerRule(eventType("ProductUpdated"))
      .apply(({ state, event }) => ({ ...state, id: event.payload.id }))
      .build(),
  ],
  operations: [
    { operationId: operationId("PostProducts"), emit: eventType("ProductCreated") },
    { operationId: operationId("GetProducts"), query: true },
    { operationId: operationId("GetProductsId"), query: true },
    { operationId: operationId("PostProductsId"), emit: eventType("ProductUpdated") },
  ],
});

const resourceModel = simulation().resource(productResource).build();
```

The Stripe example uses this for customers, products, prices, payment intents, charges, and refunds. The expansion is in [`src/dsl/resourceExpander.ts`](src/dsl/resourceExpander.ts), and concrete files are in [`examples/stripe/dsl`](examples/stripe/dsl).

## Admin and inspection endpoints

Use these endpoints while developing a simulation:

```sh
curl -s "$ENGINE_URL/_admin/health"
curl -s "$ENGINE_URL/_admin/state"
curl -s "$ENGINE_URL/_admin/events"
curl -s "$ENGINE_URL/_admin/derived/LeadSummary"
curl -s "$ENGINE_URL/_engine/routes"
curl -s "$ENGINE_URL/_engine/fixtures"
curl -s "$ENGINE_URL/_engine/state"
curl -s -X POST "$ENGINE_URL/_admin/reset"
```

The same inspection endpoints are ordinary TypeScript HTTP calls:

```ts
const routes = await fetch(`${ENGINE_URL}/_engine/routes`).then((response) => response.json());
const state = await fetch(`${ENGINE_URL}/_admin/state`).then((response) => response.json());
const events = await fetch(`${ENGINE_URL}/_admin/events`).then((response) => response.json());
const projection = await fetch(`${ENGINE_URL}/_admin/derived/LeadSummary`).then((response) =>
  response.json(),
);

await fetch(`${ENGINE_URL}/_admin/reset`, { method: "POST" });
```

Reload the configured source graph immediately, without waiting for the polling interval, with:

```sh
curl -s -X POST "$ENGINE_URL/_admin/force-reload"
```

From a TypeScript test or development script:

```ts
await fetch(`${ENGINE_URL}/_admin/force-reload`, { method: "POST" });
```

The force-reload endpoint clears the active runtime and compiles the current YAML, TypeScript, and
OpenAPI sources into one canonical `RuntimeModel`.

The plugin uses `/_engine/forward` for requests intercepted by Specmatic. It discovers stateful routes through `/_engine/routes`, pushes seeded fixtures through `/_engine/fixtures`, and monitors `/_potemkin/ready` during startup and restart.

Admin routes are fail-open when `ADMIN_TOKEN` is unset. Set it before exposing the
engine outside a trusted test process:

```sh
ADMIN_TOKEN='local-admin-token' pnpm run start:example
curl -s "$ENGINE_URL/_admin/state" \
  -H 'Authorization: Bearer local-admin-token'
```

The authenticated TypeScript request is:

```ts
await fetch(`${ENGINE_URL}/_admin/state`, {
  headers: { Authorization: "Bearer local-admin-token" },
});
```

State and event admin responses are raw diagnostic data. They are not subject to
the response `mask` policy.

## Specmatic and cross-boundary testing

The full topology is:

```text
consumer test
  -> Specmatic stub
  -> Kotlin Potemkin plugin
  -> Node engine /_engine/forward
```

Build and run the full stack:

```sh
cd plugin
./gradlew shadowJar
cd ..
pnpm run test:e2e
```

The plugin can forward control operations for seeds, workflows, overlays, governance, reset, and JWT-authenticated requests. The forwarding fixtures are in [`tests/e2e/forward-blocks-and-jwt.e2e-test.ts`](tests/e2e/forward-blocks-and-jwt.e2e-test.ts).

Engine restarts are covered by [`tests/e2e/reliability.e2e-test.ts`](tests/e2e/reliability.e2e-test.ts), shutdown notifications by [`tests/e2e/shutdown-notification.e2e-test.ts`](tests/e2e/shutdown-notification.e2e-test.ts), and fixture refresh by [`tests/e2e/fixture-hot-reload.e2e-test.ts`](tests/e2e/fixture-hot-reload.e2e-test.ts).

The plugin is a working integration path. `pnpm run test:conformance` and
`pnpm run export:examples` are available. Stripe behavior is tested locally against the vendored
OpenAPI contract through Specmatic; the test suite does not call Stripe's network APIs.

The E2E harness boots one Specmatic JVM for the suite and rewrites the single
`potemkin.yml` between scenarios. It calls `POST /_admin/force-reload` after
each rewrite, so tests do not wait for the ten-second polling interval. The
requests still travel through the real Specmatic stub and Kotlin plugin before
reaching Potemkin; direct `/_engine/forward` calls are not the E2E proof path.

The conformance gate is a separate real Specmatic test-mode process. CRM Layer
A and the bounded Stripe Layer A run as blocking CI checks, Layer B verifies
deterministically seeded positive reads, and Layer C uses only exact,
staleness-guarded stateful-divergence entries. The gate proves contract-floor
conformance (status, response shape, and error-body shape), while behavioral
fidelity is covered by the consumer-side example suites.

## Testing

Run the relevant check after changing a simulation:

```sh
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec jest --runInBand
pnpm run test:bdd
pnpm run test:e2e
pnpm run test:examples
pnpm run test:coverage
```

## Reference material

- [`docs/dsl.md`](docs/dsl.md): YAML grammar, lifecycle, errors, composition, response generation, and limits.
- [`docs/cel.md`](docs/cel.md): CEL operators, built-ins, phase rules, and shared TypeScript helpers.
- [`docs/specmatic.md`](docs/specmatic.md): plugin and forwarding notes.
- [`src/sdk/index.ts`](src/sdk/index.ts): TypeScript SDK exports and authoring surface.
- [`tests/e2e/README.md`](tests/e2e/README.md): Specmatic-backed E2E harness.
- [`examples/crm/README.md`](examples/crm/README.md): complete CRM simulation.
- [`examples/stripe/README.md`](examples/stripe/README.md): stateful Stripe subset.

## Contributing

When behavior changes, update the relevant documentation, add a focused test, and update the example that demonstrates the behavior. Avoid adding a configuration field without documenting its phase, error behavior, and reset behavior.
