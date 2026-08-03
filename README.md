# Potemkin

Potemkin is a stateful HTTP simulator. An OpenAPI contract describes the wire format. YAML describes the state transitions. The Node engine keeps an in-memory event log and state graph, and the Kotlin plugin lets Specmatic drive the same simulation through HTTP.

This repository has two authoring surfaces with one execution model:

- TypeScript definitions are the primary runtime model. Engineers use interfaces, builders, pure
  functions, and typed callbacks.
- YAML is parsed and compiled into those same runtime types. CEL and the YAML DSL exist only in
  the parser; they are not evaluated by the core engine.

Both surfaces lower to one immutable `RuntimeProgram` and execute through the same core engine,
policies, storage ports, and HTTP gateway. The parser is an authoring layer; it is not a second
runtime. The less-common combinations and their evidence are tracked in [`requirements.md`](requirements.md)
and the [parity design](docs/design/typescript-yaml-parity.md).

## Current status

The authoritative feature baseline is the README on `main`, recorded in
[`docs/design/main-readme-feature-completeness.md`](docs/design/main-readme-feature-completeness.md).
The canonical runtime is the only supported execution path. Remaining combinations that need
additional evidence are listed in
[`docs/design/main-readme-operational-feature-completeness.md`](docs/design/main-readme-operational-feature-completeness.md).

The bounded checks below passed in the current checkout. The suites are run separately to keep the
canonical runtime, parser, and Specmatic fixtures within the local Node heap limit.

```text
pnpm exec jest --runInBand tests/unit tests/runtime tests/integration
                                                         194 suites, 2,718 tests
pnpm run test:e2e                                      Specmatic-backed E2E suites
pnpm run test:bdd                                       48 scenarios
pnpm exec tsc --noEmit                                 passed
pnpm run lint                                           passed (warnings remain)
```

The full Specmatic stack and the examples suite require Java and the built plugin. Their results
depend on the local Specmatic cache. Lower-level runtime/parser checks are kept under
`tests/runtime` and run with the normal Jest configuration. The
OpenTelemetry exchange requirement has direct YAML/TypeScript coverage and real
Specmatic-forwarding coverage, including the nested forwarded request and complete final response
envelope, in [`tests/runtime/runtime-otel.runtime.test.ts`](tests/runtime/runtime-otel.runtime.test.ts)
and [`tests/e2e/runtime-observability.e2e-test.ts`](tests/e2e/runtime-observability.e2e-test.ts).

### Open backlog

`REQ-76` is complete. The runtime emits one final OpenTelemetry exchange observation per handled
request, preserving the original inbound request and the exact response (or transport-close
outcome) after matching, mutation, projections, sagas, webhooks, response shaping, masking,
validation, chaos, and rollback. The observation uses the same trace and Potemkin command
correlation for YAML and TypeScript authoring, with injected redaction and byte-size policies.
Direct-gateway and real Specmatic-forwarding coverage includes success, rejection, faults, chaos,
admin, bulk rollback, and closed-connection cases. The full acceptance criteria and evidence are
recorded in [`requirements.md`](requirements.md), under `Observability backlog`, `REQ-76`, and the
`Agent backlog task for REQ-76` checklist.

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

typescript:
  scan:
    - include:
        - "typescript/**/*.ts"
      exclude:
        - "**/*.test.ts"
        - "**/*.d.ts"
plugin:
  engine:
    url: "${POTEMKIN_ENGINE_URL:http://localhost:3000}"
    timeoutMs: 30000
  controlPort: 0
```

The OpenAPI file is configured in `specmatic.yaml`. Potemkin uses the operation IDs from that contract when it selects a behavior. A route that is in the contract but has no behavior uses the configured fallback policy. A path that is not in the contract returns `404 NO_ROUTE`.

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

Run the simulation linter before starting the stack:

```sh

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

Set `audit_fields: true` on a boundary to stamp `updatedAt` and `updatedBy` on
non-baseline events. `updatedBy` comes from the authenticated actor, or is null
when the request has no actor:

```yaml
boundary: Note
contract_path: /notes
audit_fields: true
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

```sh
curl -s "$STUB_URL/leads" \
  -H 'Authorization: Bearer alice:lead:read,lead:write'
```

Require a scope in a behavior with `match.required_scopes`, as shown earlier. The actor is available to CEL and event templates through `actor.id`, `actor.scopes`, and related fields.

JWT verification is also supported for tests that need a real token boundary. Configure the issuer, audience, algorithm, and key material in the global auth block. [`tests/e2e/forward-blocks-and-jwt.e2e-test.ts`](tests/e2e/forward-blocks-and-jwt.e2e-test.ts) covers valid, expired, and missing-token cases.

Cookie sessions and CSRF checks are available for browser-shaped simulations. Configure the session cookie and CSRF header, then send both on a state-changing request:

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

The receiver test is [`tests/e2e/webhook-hmac.e2e-test.ts`](tests/e2e/webhook-hmac.e2e-test.ts).

## TypeScript authoring

TypeScript supplies the simulation model directly. Callbacks are phase-specific and typed; CEL
and DSL strings are parser inputs, not a second TypeScript expression language. Use the semantic
reference constructors from `potemkin/sdk` for boundary names, operation IDs, event types,
contract paths, and response field paths. The runtime model still contains canonical strings at
the source-neutral boundary, but TypeScript authoring cannot interchange these identifier roles.
Import authoring from `potemkin/sdk` and runtime boot/transport from their explicit package
surfaces; application code does not need to import internal `src/` modules.

This example boots the same HTTP runtime used by the YAML path:

```ts
import { bootRuntime, createRuntimeGateway } from "potemkin";
import {
  boundary,
  boundaryName,
  contractPath,
  event,
  eventType,
  expression,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
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
  boundaryName,
  contractPath,
  boundary,
  defineHelper,
  event,
  eventType,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
} from "potemkin/sdk";

const sourceLabel = defineHelper("sourceLabel", (source: string) => source);

class WidgetConfiguration {
  @PotemkinConfigure("widgets")
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
            name: "createWidget",
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
  pathSegment,
  simulation,
  PotemkinConfigure,
  type FactoryContext,
} from "potemkin/sdk";

class WidgetScenario {
  @PotemkinConfigure("widgets")
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

`modules` and `openapi` accept multiple globs. The server always polls the single
`potemkin.yml` and every selected YAML, OpenAPI, and TypeScript file every ten
seconds by default. A detected change clears the runtime and boots the new
configuration from its initialization state. Start the server with
the one configuration path supplied by environment or command line:

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

REQ-48 through REQ-75 require every YAML type, variant, and combination to have a TypeScript equivalent. That includes boundaries, resources, initialization, identity, event catalogues, behaviors, guards, reducers, queries, reactions, sagas, derived projections, response shaping, auth, idempotency, concurrency, faults, forwarding, webhooks, composition, and resource expansion.

The API uses typed interfaces, immutable values, functional composition, and builders. It can
compile a TypeScript-authored boundary or resource directly, install direct TypeScript reducers,
run typed expressions in the current evaluator phases, and retain lifecycle declarations. The
runtime authoring checks live under `tests/runtime/`, while public behavior is proved by the
Specmatic-backed suites under `tests/e2e/`.

Run the lower-level authoring checks directly while working on the API:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
  pnpm exec jest --runInBand \
  tests/runtime/authoring-typescript.runtime.test.ts \
  tests/runtime/typescript-resource.runtime.test.ts
```

The YAML-only counterpart is `tests/runtime/authoring-yaml.runtime.test.ts`.
The observable parity trace is `tests/runtime/pure-authoring-observables.runtime.test.ts` and
boots one YAML system and one TypeScript system, then compares their responses, events, state,
headers, and side-effect observations.

### Using the source-independent runtime directly

For lower-level runtime tests, use the runtime builders. This path has no YAML module, CEL expression, or
YAML parser representation in it. The parser module described below produces the same
`RuntimeProgram` when the source is YAML.

```ts
import {
  createRuntimeEngine,
  runtimeBehavior,
  runtimeBoundary,
  runtimeEvent,
  runtimeProgram,
  runtimeReducer,
} from "potemkin";

const orders = runtimeBoundary("Order", "/orders")
  .event(
    runtimeEvent("OrderCreated")
      .payload({
        id: ({ payload }) => payload.id,
        total: ({ payload }) => payload.total,
      })
      .build(),
  )
  .behavior(
    runtimeBehavior("createOrder")
      .operation("createOrder")
      .emit("OrderCreated")
      .scopes("orders:write")
      .build(),
  )
  .reducer(
    runtimeReducer("OrderCreated")
      .apply(({ event }) => [
        { op: "replace", path: "/id", value: event.payload.id },
        { op: "replace", path: "/total", value: event.payload.total },
      ])
      .build(),
  )
  .response({
    mask: ["/internalNote"],
    deprecated: { date: "2027-01-01", replacement: "/v2/orders" },
  })
  .build();

const engine = createRuntimeEngine(
  runtimeProgram()
    .boundary(orders)
    .policies({
      faults: [
        {
          name: "maintenance",
          matches: ({ headers }) => headers["x-maintenance"] === "on",
          response: { status: 503, body: { error: "MAINTENANCE" } },
        },
      ],
      sagas: [
        {
          name: "fulfil-order",
          trigger: { boundary: "Order", intent: "creation", condition: () => true },
          steps: [],
        },
      ],
      webhooks: [
        {
          name: "order-created",
          trigger: ({ event }) => event?.type === "OrderCreated",
          url: () => "https://hooks.example.test/orders",
          secret: process.env.ORDER_WEBHOOK_SECRET,
        },
      ],
    })
    .compile({
      contract: { operationIdFor: () => "createOrder" },
      helpers: {
        now: () => new Date().toISOString(),
        uuid: () => crypto.randomUUID(),
        random: Math.random,
        clone: structuredClone,
      },
      webhooks: {
        deliver: async (delivery) =>
          fetch(delivery.url, {
            method: "POST",
            headers: delivery.headers,
            body: delivery.body,
          }).then(() => undefined),
      },
    }),
);
```

The usual development sequence is:

1. Put the runtime definition in a normal `.ts` test or module.
2. Inject deterministic `helpers`, a contract binding, and test transports.
3. Call `engine.execute` with a `Command` and request headers.
4. Inspect `result.events` and `engine.snapshot()` alongside the response.
5. Call `engine.reset()` between scenarios; it clears state, events, projections,
   idempotency records, and fault effects before reseeding.

Use `bootYamlRuntime({ yamlProgram })`, or call `compileYamlProgram` from the `parser` subpath when
the source is YAML. Faults, reactions,
dispatch, sagas and compensation, projections, HMAC webhooks, response policies, lifecycle hooks,
queries, auth, idempotency, optimistic concurrency, fallback, and reset are runtime capabilities;
their authoring syntax belongs to the TypeScript definition or the parser, not to the core.

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

For one request, use chaos headers instead of editing YAML:

```sh
curl -s "$STUB_URL/leads/$LEAD_ID" \
  -H 'X-Potemkin-Force-Latency: 250'

curl -s "$STUB_URL/leads/$LEAD_ID" \
  -H 'X-Potemkin-Force-Status: 503'
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

For deterministic clock-dependent responses:

```sh
curl -s "$STUB_URL/leads/$LEAD_ID" \
  -H 'X-Potemkin-Clock-Offset: 86400000'
```

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

Reload the configured source graph immediately, without waiting for the polling interval, with:

```sh
curl -s -X POST "$ENGINE_URL/_admin/force-reload"
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
`pnpm run export:examples` are available. The repository contains reusable pieces for
contract-backed model equivalence—normalization, identifier mapping, sequence generation,
shrinkers, metamorphic relations, and divergence ledgers. Stripe behavior is tested locally
against the vendored OpenAPI contract through Specmatic; the test suite does not call Stripe's
network APIs.

## Testing and known repository issues

Run the relevant check after changing a simulation:

```sh
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec jest --runInBand
pnpm run test:bdd
pnpm run test:e2e
pnpm run test:examples
pnpm run test:coverage
```

The current caveats are:

- The default conformance command covers the contract-invalid 400 layer. Stateful 404/422 cases
  remain a separate behaviour concern and are not silently folded into that gate.
- The positive conformance layer needs Java, the plugin JAR, and the cached Specmatic artifact.
- MakerX Verify passes the lint, formatting, type, unused-code, duplication, and test gates.

## Current work

The remaining implementation work is concentrated in these areas:

1. **Complete TypeScript/YAML parity.** The direct definition model, builders, functional helpers,
   typed contexts, direct boot path, lifecycle runtime, and parity normalizer exist. The remaining
   work is the long tail of typed constructors and runtime coverage for every YAML variant,
   optional field, discriminated union, and valid cross-feature combination. The authoritative
   inventory is §17 of [`docs/design/typescript-yaml-parity.md`](docs/design/typescript-yaml-parity.md).

2. **Specmatic conformance gate — implemented for the bounded 400 layer.** The verifier, JUnit
   parser, allowlist handling, CLI, generated negative cases, and positive-example selection exist.
   The default run is the contract-invalid layer; the exported positive corpus and fixture Layer-B
   verifier are also wired through the real Specmatic JVM path. Route- and status-scoped stateful
   runs remain the bounded conformance checks while the broader generated mutation surface is
   completed. See [`docs/design/specmatic-conformance-gate.md`](docs/design/specmatic-conformance-gate.md).

3. **Specmatic example export — implemented for the deterministic engine path.**
   `pnpm run export:examples` writes stable request/response examples and supports `--check`.
   The CRM and Stripe repositories contain generated Tier-1 baseline and contract-backed Tier-2
   state-machine/side-effect snapshots, including explicit branch and saga drives declared by
   boundary `export:` blocks. The plain Specmatic harness independently serves every
   generated example without the Potemkin engine or plugin, including Tier-3 declared-error
   examples. See [`docs/design/specmatic-export-examples.md`](docs/design/specmatic-export-examples.md).

4. **Contract-backed behavioral equivalence — implemented locally.** The retained equivalence
   harness compares local Potemkin runtimes, while the Stripe example is exercised through its
   vendored OpenAPI contract and the Specmatic JVM. No external provider or Stripe API credentials
   are used by the repository test path. See [`docs/design/specmatic-equivalence-testing.md`](docs/design/specmatic-equivalence-testing.md).

5. **Contract-shaped errors — implemented.** Fallback, gateway, and forwarding failures use the
   matched operation's exact or default error schema, with deterministic values and boot-time
   validation for static fault bodies.

6. **Static model analysis — implemented as MODEL1/MODEL2.** `/_admin/model`
   exposes the extracted model, and lint reports structural findings. Inference-uncertain dead
   states are warnings; explicit unreachable states and invalid suppressions remain errors.

7. **Plugin reflection hardening — implemented.** Reflection is centralized, version-checked, and
   covered by Kotlin tests so an incompatible Specmatic surface fails clearly.

8. **Tooling and documentation cleanup.** Node 24, pnpm, the production build, contract test
   script, and lint errors are fixed. Remaining work is broader example coverage for the parity
   long tail and keeping the README and design matrices aligned with the implementation.

9. **Test suite re-packaging and value review.** Inventory the tests by behavior and layer,
   regroup them under descriptive unnumbered names, and remove migration-only, duplicate, or
   low-value tests only after their useful assertions are protected by canonical unit, runtime,
   YAML/TypeScript parity, or real Specmatic-backed E2E coverage. The acceptance checklist is
   tracked as REQ-98 in [`requirements.md`](requirements.md).

10. **Full layer and module-structure sweep.** Audit the source tree and public package boundaries,
    then refactor misplaced or mixed-responsibility code so the YAML/CEL, TypeScript SDK/loader,
    model, runtime, transport, CLI, and composition layers follow clear conventional TypeScript
    module boundaries. The acceptance checklist is tracked as REQ-99 in
    [`requirements.md`](requirements.md).

## Reference material

- [`requirements.md`](requirements.md): EARS requirements and BDD traceability.
- [`docs/dsl.md`](docs/dsl.md): YAML grammar, lifecycle, errors, composition, response generation, and limits.
- [`docs/cel.md`](docs/cel.md): CEL operators, built-ins, phase rules, and shared TypeScript helpers.
- [`docs/specmatic.md`](docs/specmatic.md): plugin and forwarding notes.
- [`docs/design/typescript-yaml-parity.md`](docs/design/typescript-yaml-parity.md): planned TypeScript authoring model.
- [`tests/e2e/README.md`](tests/e2e/README.md): Specmatic-backed E2E harness.
- [`examples/crm/README.md`](examples/crm/README.md): complete CRM simulation.
- [`examples/stripe/README.md`](examples/stripe/README.md): stateful Stripe subset.

## Contributing

When behavior changes, update the requirement or design document, add a focused test, and update the example that demonstrates the behavior. Keep YAML and the future TypeScript model semantically equivalent. Avoid adding a configuration field without documenting its phase, error behavior, and reset behavior.
