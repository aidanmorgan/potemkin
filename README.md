# Potemkin — stateful HTTP simulation engine

Potemkin turns a pair of files — an OpenAPI contract and a YAML behaviour file — into a real, stateful HTTP server you can drive end-to-end. You describe what a service does; Potemkin runs it. No application code required.

The engine applies CQRS and event sourcing: every inbound request becomes a command, commands match against your YAML rules, matched rules emit events, and events project into an in-memory state graph. That cycle is the whole machine. Because all state is volatile and the boot-time seed is frozen, `POST /_admin/reset` always returns you to exactly the same starting point.

It runs in two modes:

- **Standalone** — an Express gateway you boot directly with `bootSystem` + `createGateway`.
- **Specmatic plugin** — a Kotlin plugin that sits inside a Specmatic stub, intercepts stateful routes, and forwards them to the engine. The same contract then serves both stateless stubs and stateful simulation.

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [The e2e tests are the examples](#the-e2e-tests-are-the-examples)
- [Defining what you are simulating](#defining-what-you-are-simulating)
  - [Binding a boundary to an OpenAPI contract](#binding-a-boundary-to-an-openapi-contract)
  - [Splitting the simulation across multiple files](#splitting-the-simulation-across-multiple-files)
  - [Seeding initial state and resetting to a known baseline](#seeding-initial-state-and-resetting-to-a-known-baseline)
  - [Generating an entity id on creation](#generating-an-entity-id-on-creation)
  - [Taking the entity id from a header instead of the URL](#taking-the-entity-id-from-a-header-instead-of-the-url)
  - [Declaring the events a boundary can emit](#declaring-the-events-a-boundary-can-emit)
  - [Validating an event payload against an OpenAPI schema](#validating-an-event-payload-against-an-openapi-schema)
- [Writing behaviour: turning requests into events](#writing-behaviour-turning-requests-into-events)
  - [Routing a request to a behaviour by operation](#routing-a-request-to-a-behaviour-by-operation)
  - [Allowing a transition only from certain states](#allowing-a-transition-only-from-certain-states)
  - [Enforcing domain invariants before a transition runs](#enforcing-domain-invariants-before-a-transition-runs)
  - [Selecting a behaviour based on request headers](#selecting-a-behaviour-based-on-request-headers)
  - [Emitting different events depending on intermediate state](#emitting-different-events-depending-on-intermediate-state)
  - [Updating another entity in the same request](#updating-another-entity-in-the-same-request)
- [Projecting events onto state](#projecting-events-onto-state)
  - [Updating entity state when an event happens](#updating-entity-state-when-an-event-happens)
  - [Choosing the right patch op](#choosing-the-right-patch-op)
  - [Writing to nested paths and maintaining computed totals](#writing-to-nested-paths-and-maintaining-computed-totals)
- [Reading and querying the graph](#reading-and-querying-the-graph)
  - [Filtering a collection by a field](#filtering-a-collection-by-a-field)
  - [Returning one page at a time](#returning-one-page-at-a-time)
  - [Sorting by multiple fields](#sorting-by-multiple-fields)
  - [Filtering by array membership](#filtering-by-array-membership)
  - [Letting clients pick which fields come back](#letting-clients-pick-which-fields-come-back)
- [Consistency, idempotency, and auth](#consistency-idempotency-and-auth)
  - [Making a request safe to retry](#making-a-request-safe-to-retry)
  - [Rejecting a stale update](#rejecting-a-stale-update)
  - [Requiring a scope to call an operation](#requiring-a-scope-to-call-an-operation)
  - [Verifying real JWTs from your auth server](#verifying-real-jwts-from-your-auth-server)
  - [Simulating cookie-based login and CSRF protection](#simulating-cookie-based-login-and-csrf-protection)
- [Workflows, reactions, and side effects](#workflows-reactions-and-side-effects)
  - [Coordinating a multi-step workflow with automatic rollback](#coordinating-a-multi-step-workflow-with-automatic-rollback)
  - [Building a cross-boundary read model](#building-a-cross-boundary-read-model)
  - [Reacting to another boundary's events without coupling the source](#reacting-to-another-boundarys-events-without-coupling-the-source)
  - [Running custom logic that CEL can't express](#running-custom-logic-that-cel-cant-express)
  - [Owning an event's projection in TypeScript](#owning-an-events-projection-in-typescript)
  - [Calling out to another service when an event fires](#calling-out-to-another-service-when-an-event-fires)
- [Shaping responses](#shaping-responses)
  - [Adding hypermedia links to a response](#adding-hypermedia-links-to-a-response)
  - [Hiding a field from a response](#hiding-a-field-from-a-response)
  - [Marking an endpoint deprecated](#marking-an-endpoint-deprecated)
  - [Adding security headers to every response](#adding-security-headers-to-every-response)
  - [Slowing a boundary down on purpose](#slowing-a-boundary-down-on-purpose)
  - [Routing by URL version prefix](#routing-by-url-version-prefix)
- [Chaos and runtime control](#chaos-and-runtime-control)
  - [Returning an error for matching requests](#returning-an-error-for-matching-requests)
  - [Injecting chaos per request](#injecting-chaos-per-request)
  - [Driving engine behaviour at request time with control headers](#driving-engine-behaviour-at-request-time-with-control-headers)
- [Running inside Specmatic](#running-inside-specmatic)
  - [Connecting the engine to the Specmatic stub](#connecting-the-engine-to-the-specmatic-stub)
  - [Letting the plugin find your stateful routes](#letting-the-plugin-find-your-stateful-routes)
  - [Driving seeds, workflows, and overlays through the stub](#driving-seeds-workflows-and-overlays-through-the-stub)
  - [Handling engine restarts and hot reload](#handling-engine-restarts-and-hot-reload)
  - [Validating requests against the contract](#validating-requests-against-the-contract)
- [Further reference](#further-reference)

---

## Architecture

Five layers, each with a single job:

- **Write model (event log)** — an append-only ledger of immutable domain events, keyed by UUIDv7.
- **Read model (state graph)** — a `Map<TargetId, JsonObject>` continuously projected from that log.
- **DSL behaviours** — YAML-declared rules evaluated by a sandboxed CEL expression engine.
- **Pattern matcher** — compares each inbound command against the ordered behaviour list; the first match wins.
- **Unit of Work** — an atomic transaction boundary that manages the shadow graph and any secondary commands before committing.

All state is in-memory and intentionally volatile. Nothing is persisted to disk. The frozen baseline is what makes `POST /_admin/reset` deterministic: it replays seeds, not a database.

## Quick start

```sh
npm install
npm test                 # full unit + integration suite (no Java required)

# Engine-only e2e examples — boot the real engine in-process, no Java/JVM needed
npm run test:e2e:engine

# Full Specmatic-stack e2e (requires Java 17+; builds the Kotlin plugin JAR)
npm run test:e2e:build
```

To boot the engine yourself from a compiled DSL and an OpenAPI document:

```ts
import { loadOpenApi, bootSystem, createGateway } from './src/index.js';
// compiledDsl comes from parseDslYaml + compileDsl (or loadPotemkinConfig for a fixture dir)
const sys = await bootSystem({ openapi, compiledDsl });
const app = createGateway(sys);   // a standard Express app
app.listen(3000);
```

## The e2e tests are the examples

Every feature in this guide links to an end-to-end test under [`tests/e2e/`](tests/e2e/). Each test is both proof the system works and the canonical worked example for its feature. The behaviour is declared entirely in YAML fixtures under [`tests/fixtures/`](tests/fixtures/) — the test files only send HTTP requests and assert on responses and state.

To understand a feature, read the fixture YAML (the system under test) alongside the linked test file (the assertions). They are the recipe and the result.

Two harness flavours:

- **Engine-only** tests (e.g. `60`–`65`) boot the engine in-process via `startEngineOnlyApp` and need no Java.
- **Full-stack** tests boot a real Specmatic JVM with the Kotlin plugin and exercise the complete wire.

---

## Defining what you are simulating

### Binding a boundary to an OpenAPI contract

If you want to introduce a new aggregate root into the simulation, you declare a *boundary*. A boundary is the unit of composition in Potemkin: it names the aggregate (`boundary: Lead`), points at the OpenAPI base path (`contract_path: /leads`), and carries the event catalog, behaviours, and reducers that govern that slice of the domain. The OpenAPI document owns the structural shape of every request and response; the YAML DSL owns what happens when those requests arrive.

One boundary, one file is the natural grain, though nothing prevents you from splitting further:

```yaml
boundary: Lead
contract_path: /leads
fallback_override: false
event_catalog: []
behaviors: []
reducers: []
```

The [`13-crm-smoke`](tests/e2e/13-crm-smoke.e2e-test.ts) test drives all five CRM boundaries through the full Specmatic stack and is a good first read if you want to see a realistic multi-boundary setup.

### Splitting the simulation across multiple files

If you want to keep a large simulation manageable, you can spread it across as many YAML files as you like. The loader globs everything matching the `modules:` pattern in `potemkin.yaml` (typically `dsl/**/*.yaml`), merges the boundaries, and resolves cross-boundary references at boot. You don't register files individually — drop a new `*.yaml` into the module directory and it's picked up automatically.

The [`50-multi-yaml-composition`](tests/e2e/50-multi-yaml-composition.e2e-test.ts) test verifies that boundaries defined in separate files compose correctly at runtime.

### Seeding initial state and resetting to a known baseline

If you want the simulation to start with pre-existing entities — or to snap back to a predictable state between test runs — use `initialization`. Each entry is a plain object that becomes a seeded entity in the state graph. Seeds are replayed verbatim on `POST /_admin/reset`, so post-reset state is byte-for-byte identical to a cold boot. There is no randomness in the reset path.

```yaml
initialization:
  - id: "00000000-0000-7000-8000-000000000010"
    companyName: "Apex Solutions Ltd"
    status: "NEW"
    callIds: []
```

[`16-initialization-queries`](tests/e2e/16-initialization-queries.e2e-test.ts) shows seeded entities being queried immediately after boot. Deterministic reset and test isolation are covered in [`24-ephemeral-lifecycle`](tests/e2e/24-ephemeral-lifecycle.e2e-test.ts).

### Generating an entity id on creation

If you want the simulation to mint a new aggregate id when a creation request arrives, declare `identity.creation.generate`. The expression is CEL and is evaluated at creation time — `$uuidv7()` is the standard choice because it embeds a sortable timestamp.

```yaml
identity:
  creation:
    generate: "$uuidv7()"
```

[`16-initialization-queries`](tests/e2e/16-initialization-queries.e2e-test.ts) exercises this alongside seeded entities.

### Taking the entity id from a header instead of the URL

If you want to identify the aggregate from somewhere other than the `{id}` path parameter — a request header, a query parameter, or a pointer into the request body — use `identity.key`. This is common when the aggregate id is a token or correlation id supplied by the caller rather than assigned by the server.

```yaml
identity:
  key:
    from: header        # path | query | header | payload
    name: x-token-id    # header/query name, or payload pointer (use `pointer:` for nested)
```

The [`61-identity-key`](tests/e2e/61-identity-key.e2e-test.ts) test covers the header-derived id together with the generated-id fallback.

### Declaring the events a boundary can emit

If you want to name the domain events a boundary produces and control how their payloads are built from the incoming command, use `event_catalog`. Each entry names the event type and provides a `payload_template` — a map of field names to CEL expressions evaluated during event hydration. You can call `$uuidv7()` and `$now()` here because this phase runs after the command is matched but before the event is committed.

```yaml
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
      companyName: "command.payload.companyName"
      createdAt: "$now()"
```

[`14-object-graph-mutations`](tests/e2e/14-object-graph-mutations.e2e-test.ts) shows event catalog entries being exercised across a sequence of mutations.

### Validating an event payload against an OpenAPI schema

If you want a hard guarantee that an event's payload conforms to a schema you've already defined in your OpenAPI document, add `schema_ref` to the event catalog entry. The engine validates the hydrated payload against the referenced component schema before committing. A mismatch aborts the Unit of Work with `SCHEMA_TYPE_MISMATCH` and returns HTTP 500 — fail fast, no silent drift.

```yaml
event_catalog:
  - type: PaymentRecorded
    schema_ref: "#/components/schemas/StrictPayload"
    payload_template:
      amount: "command.payload.amount"
```

The `schema_ref` describe block in [`60-reducer-patch-ops`](tests/e2e/60-reducer-patch-ops.e2e-test.ts) demonstrates both the happy path and the validation failure.

---

## Writing behaviour: turning requests into events

Behaviours are an ordered list. The engine evaluates them top-to-bottom and runs the first match. Order matters: put more specific rules before general ones.

### Routing a request to a behaviour by operation

If you want a behaviour to fire only for a specific OpenAPI `operationId`, set `match.operationId`. Behaviours whose `operationId` doesn't match the incoming operation are skipped entirely, so you can have multiple behaviours for the same boundary without worrying about accidental cross-operation matches.

```yaml
behaviors:
  - name: createLead
    match:
      operationId: createLead
      condition: "true"
    emit: LeadCreated
```

[`55-operationid-dispatch`](tests/e2e/55-operationid-dispatch.e2e-test.ts) verifies that each operation routes to its intended behaviour and not its neighbours.

### Allowing a transition only from certain states

If you want a behaviour to fire only when the aggregate is in a particular state — enforcing valid state-machine transitions — use `match.condition`. The condition is a CEL predicate with access to both `command` (the incoming request) and `state` (the current projected aggregate). When the condition is false, the engine moves to the next behaviour; if no behaviour matches, the request is rejected.

```yaml
match:
  operationId: qualifyLead
  condition: "state.status == 'CONTACTED'"
```

[`21-state-transitions`](tests/e2e/21-state-transitions.e2e-test.ts) walks through a full state machine with valid and invalid transition attempts.

### Enforcing domain invariants before a transition runs

If you want to block a request outright when a domain invariant is violated — rather than falling through to the next behaviour — use `match.requires`. Guards are evaluated before `condition`. A failing guard returns HTTP 422 with your `error_code` and `error_message` immediately; evaluation stops there and does not continue down the behaviour list.

```yaml
match:
  operationId: contactLead
  requires:
    - name: not-dnc
      condition: "state.status != 'DNC'"
      error_code: LEAD_IS_DNC
      error_message: "Cannot contact a lead marked Do Not Call"
```

[`18-guard-failures`](tests/e2e/18-guard-failures.e2e-test.ts) covers multiple guard scenarios including chained invariants.

### Selecting a behaviour based on request headers

If you want two behaviours bound to the same `operationId` to diverge based on a request header — for example, routing mobile and desktop clients to different event flows — use `match.headers`. All declared headers must match (AND semantics). Because the engine uses first-match-wins, place the more specific header-matched rule before the general fallback.

```yaml
behaviors:
  - name: submitOrder.mobile
    match:
      operationId: submitOrder
      headers:
        x-channel: mobile
    emit: MobileOrderPlaced
  - name: submitOrder.default
    match:
      operationId: submitOrder
      condition: "true"
    emit: OrderPlaced
```

Behaviour-level header matching is exercised in [`62-behavior-header-match`](tests/e2e/62-behavior-header-match.e2e-test.ts). Header and method matching for fault rules is covered separately in [`40-header-matching`](tests/e2e/40-header-matching.e2e-test.ts).

### Emitting different events depending on intermediate state

If you want a single behaviour to branch — emitting one event or another based on a condition evaluated against state that may have changed during the same Unit of Work — use `emit_when`. Each `when` clause is a CEL predicate checked in order; the first truthy clause wins and its `emit` fires. You can also attach a `postcondition`: a CEL invariant checked after projection completes. A false postcondition aborts the entire Unit of Work, so you can express hard constraints like "balance must never go negative."

```yaml
emit_when:
  - when: "command.payload.amount == state.balance"
    emit: LoanSettled
  - when: "command.payload.amount < state.balance"
    emit: LoanRepaid
postcondition: "state.balance >= 0"
```

[`20-features-combined`](tests/e2e/20-features-combined.e2e-test.ts) demonstrates `emit_when` and `postcondition` together. Lifecycle branching across a longer sequence is covered in [`19-campaign-lifecycle`](tests/e2e/19-campaign-lifecycle.e2e-test.ts).

### Updating another entity in the same request

If you want a single request to mutate entities in more than one boundary — atomically — use `dispatch_commands`. Secondary commands are queued within the current Unit of Work and processed depth-first; all events across all boundaries commit together or not at all. The recursion depth is capped at 5; exceeding it returns HTTP 508. The `condition` field lets you skip the dispatch when the payload doesn't warrant it.

```yaml
dispatch_commands:
  - boundary: Lead
    intent: mutation
    operationId: patchLead
    target_id: "command.payload.leadId"
    payload:
      opportunityId: "command.targetId"
    condition: "command.payload.leadId != null"
```

[`22-cross-boundary-dispatch`](tests/e2e/22-cross-boundary-dispatch.e2e-test.ts) is the canonical example. A deeper secondary-command cascade is in [`04-cqrs-cascade`](tests/e2e/04-cqrs-cascade.e2e-test.ts), and a multi-boundary variant is in [`17-multi-boundary-cascades`](tests/e2e/17-multi-boundary-cascades.e2e-test.ts). When you want the *other* boundaries to react on their own terms instead of being driven from here, see [Reacting to another boundary's events without coupling the source](#reacting-to-another-boundarys-events-without-coupling-the-source) below.

---

## Projecting events onto state

### Updating entity state when an event happens

If you want to update entity state when a specific event fires, declare a reducer that binds to an event type and lists patch operations. Each operation targets a path expressed as a JSON Pointer, and the value may be a bare string literal or a `${...}` expression that CEL evaluates at projection time — type is preserved, so a numeric expression stays a number.

```yaml
reducers:
  - on: LeadContacted
    patches:
      - op: replace
        path: /status
        value: "${'CONTACTED'}"
      - op: append
        path: /callIds
        value: "${event.payload.callId}"
      - op: increment
        path: /contactAttempts
        by: 1
```

The engine applies each patch in order against the current aggregate snapshot. Reducers are deterministic: replaying the same event log always produces the same state, which is what makes `POST /_admin/reset` work.

### Choosing the right patch op

If you want to know which operation to reach for, here are all ten, with a short description of each:

- `add` — write a value at a path that does not yet exist (errors if the path already exists).
- `replace` — overwrite a value at an existing path.
- `remove` — delete a key or array element.
- `append` — push a value onto the end of an array.
- `prepend` — push a value onto the front of an array.
- `increment` — add a numeric `by` delta to the value at the path.
- `merge` — shallow-merge an object into the value at the path.
- `upsert` — find an element in an array by a `key` field and replace it, or append if absent.
- `copy` — copy the value at `from` to `path`.
- `move` — move the value at `from` to `path`, removing the source.

[`60-reducer-patch-ops`](tests/e2e/60-reducer-patch-ops.e2e-test.ts) has one focused `describe` block per op, so it is the quickest way to see each one exercised end-to-end.

### Writing to nested paths and maintaining computed totals

If you want to patch a field inside a nested object, write the path as a full JSON Pointer. Intermediate objects and arrays are created automatically if they do not exist, so you do not need a prior `add` for the parent.

```yaml
- op: replace
  path: /address/city
  value: "${event.payload.city}"
```

For running totals across a collection, use a computed field. Computed state is derived after every projection pass — for example, `totalValue` can be expressed as `sum(lineItems.*.lineTotal)` and will reflect the current array contents without any explicit accumulator patch. See [`54-computed-totals-end-to-end`](tests/e2e/54-computed-totals-end-to-end.e2e-test.ts) for a full worked example, and [`51-object-graph-evolution`](tests/e2e/51-object-graph-evolution.e2e-test.ts) for a long mutation sequence that exercises nested paths across many events.

---

## Reading and querying the graph

### Filtering a collection by a field

If you want URL query parameters to filter the state graph, declare a `query_mapping` block that translates each parameter name into a CEL predicate. Multiple parameters compose as AND — only entities that satisfy every active predicate are returned.

```yaml
query_mapping:
  status: "state.status == query.status"
  minValue: "state.value >= double(query.minValue)"
```

`GET /leads?status=NEW` returns only entities where `state.status` equals `"NEW"`. You can use any CEL expression here, including type coercions and comparisons against nested fields. [`34-query-edge-cases`](tests/e2e/34-query-edge-cases.e2e-test.ts) covers edge cases in filter evaluation, and [`52-get-subsets-of-graph`](tests/e2e/52-get-subsets-of-graph.e2e-test.ts) shows returning controlled subsets of the full graph.

### Returning one page at a time

If you want paginated results, add a `?limit` parameter to the request. The engine wraps the filtered set in an envelope and adds RFC 5988 `Link` headers for cursor navigation.

```
GET /leads?limit=10&offset=20
```

The response body becomes `{ items, totalCount, offset, limit, hasMore }` rather than a bare array, and the `Link` header carries `rel="next"` and `rel="prev"` entries with the correct offset values. Clients that omit `?limit` continue to receive the raw array, so the change is backward-compatible. [`36-pagination-envelope`](tests/e2e/36-pagination-envelope.e2e-test.ts) demonstrates the envelope shape and verifies the `Link` header values.

### Sorting by multiple fields

If you want to sort results by more than one field, pass a comma-separated `?sort` parameter. Prefix a field name with `-` for descending order.

```
GET /leads?sort=status,-score
```

No YAML is required — the query engine parses the `sort` parameter directly. [`39-multisort-array-operators`](tests/e2e/39-multisort-array-operators.e2e-test.ts) covers multi-field sort together with array operators.

### Filtering by array membership

If you want to return only entities whose array field contains a given value, use the `:contains` or `:arrayContains` suffix on any query parameter.

```
GET /leads?callIds:contains=<uuid>
GET /leads?callIds:arrayContains=<uuid>
```

Both forms are built into the query engine; no `query_mapping` entry is needed. The same test file, [`39-multisort-array-operators`](tests/e2e/39-multisort-array-operators.e2e-test.ts), exercises these alongside sort.

### Letting clients pick which fields come back

If you want to return a sparse fieldset rather than the full entity, clients pass a `?fields` parameter with a comma-separated list of top-level field names.

```
GET /leads?fields=id,companyName,score
```

The engine projects each entity down to the requested fields before serialising the response. This works alongside pagination and filters, and requires no YAML configuration. [`43-query-extensions`](tests/e2e/43-query-extensions.e2e-test.ts) covers sparse fieldsets and other read-shaping extensions.

---

## Consistency, idempotency, and auth

### Making a request safe to retry

If you want to guarantee that a non-GET command executes at most once, configure idempotency in the global config. When the engine receives a request carrying an `Idempotency-Key` header it has seen before, it replays the original response verbatim and adds `X-Idempotency-Replay: true` — no events are emitted, no state changes. If the same key arrives with a different request body, the engine returns 409.

The TTL controls how long keys are remembered. Setting `hash_includes_body: true` means the conflict check covers the payload, not just the key string.

```yaml
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
```

[`06-idempotency`](tests/e2e/06-idempotency.e2e-test.ts) shows the replay path, and [`26-concurrency-idempotency`](tests/e2e/26-concurrency-idempotency.e2e-test.ts) covers key lifecycle and races.

### Rejecting a stale update

If you want to prevent lost updates when two clients edit the same resource concurrently, use the ETag and conditional-request support. Every single-entity GET response includes an `ETag` derived from the entity's sequence version and a `Last-Modified` header. A subsequent mutation that sends `If-Match: "5"` gets a `412 Precondition Failed` if the entity has moved on since version 5; if you require the header to be present and it's missing, the engine returns `428`.

On the read side, `If-None-Match` and `If-Modified-Since` work as you'd expect — a matching version yields `304 Not Modified` with no body.

[`37-conditional-requests`](tests/e2e/37-conditional-requests.e2e-test.ts) covers the full set of status codes.

### Requiring a scope to call an operation

If you want to gate a behaviour on the caller's permissions, add `required_scopes` to the `match` block. The engine reads the actor from the request (either the simulation bearer token or a verified JWT, depending on your auth mode). A request with no recognisable actor returns 401; a recognised actor that lacks the required scope returns 403.

```yaml
match:
  operationId: markLeadDNC
  required_scopes:
    - manager
```

The simulation bearer format is `Authorization: Bearer alice:manager,lead:write`, which lets you test different role combinations without issuing real tokens.

[`05-rbac`](tests/e2e/05-rbac.e2e-test.ts) exercises both the allowed and denied paths.

### Verifying real JWTs from your auth server

If you want the simulation to enforce the same token rules as your production service, configure JWT auth. The engine verifies the signature, checks `alg` against your allow-list, and validates `exp`, `nbf`, `iss`, and `aud`. The actor id and scopes are extracted from whichever claims you name in `subject_claim` and `scopes_claim`, so the same RBAC rules apply regardless of auth mode.

```yaml
auth:
  mode: jwt
  jwt:
    secret: "your-shared-secret"
    algorithm: HS256
    issuer: "potemkin-test"
    audience: "potemkin-api"
    subject_claim: "sub"
    scopes_claim: "scopes"
```

[`41-jwt-auth`](tests/e2e/41-jwt-auth.e2e-test.ts) is the worked example.

### Simulating cookie-based login and CSRF protection

If you want to test a session-authenticated flow — including login, logout, and CSRF enforcement — configure session auth. Clients POST credentials to `login_path` and receive a `Set-Cookie`; subsequent requests carry that cookie. Mutations must also supply the `csrf_header` value; requests that omit it are rejected before any behaviour is evaluated. Sessions expire after `ttl_seconds`.

```yaml
auth:
  mode: session
  session:
    cookie_name: "potemkin_sid"
    ttl_seconds: 3600
    login_path: "/sessions"
    logout_path: "/sessions/current"
    csrf_header: "x-csrf-token"
```

[`42-session-auth`](tests/e2e/42-session-auth.e2e-test.ts) walks through login, an authenticated mutation, and a CSRF rejection.

---

## Workflows, reactions, and side effects

### Coordinating a multi-step workflow with automatic rollback

If you want to model a saga — a sequence of operations across boundaries that must all succeed or all be undone — declare it in the global `sagas` config. The saga runs after the primary Unit of Work commits, so the trigger event is already persisted when the steps begin. Each step dispatches a command to a boundary; if any step fails, the engine compensates the already-completed steps in reverse order.

Lifecycle events (`SagaStarted`, `SagaStepCompleted`, `SagaStepFailed`, `SagaCompensated`, `SagaFailed`) are recorded under the `__saga__` boundary, giving you a full audit trail you can query.

```yaml
sagas:
  - name: OrderFulfillmentSaga
    trigger:
      boundary: Order
      intent: mutation
      condition: "event.type == 'OrderPlaced'"
    steps:
      - name: reserveInventory
        boundary: Reservation
        intent: creation
        target_id: "$uuidv7()"
        payload:
          orderId: "event.aggregateId"
        compensation:
          intent: mutation
          operationId: cancelReservation
          payload:
            reason: "'saga-failed'"
```

[`63-saga-compensation`](tests/e2e/63-saga-compensation.e2e-test.ts) forces a step failure and asserts the compensation chain; the happy path is in [`12-saga-compensation`](tests/e2e/12-saga-compensation.e2e-test.ts).

### Building a cross-boundary read model

If you want a materialised view that aggregates events from more than one boundary — say, a campaign dashboard that counts leads and opportunities together — use a derived projection. The projection subscribes to named event types across boundaries, applies patch operations as events arrive, and is exposed at `GET /_admin/derived/:name`.

The `key` field is a CEL expression evaluated on each event to determine which projection entry to update, so you can fan events from multiple aggregates into a single keyed read model.

```yaml
derived_projections:
  - name: CampaignDashboard
    key: "event.payload.campaignId"
    subscribe:
      - "Lead:LeadCreated"
      - "Opportunity:OpportunityCreated"
    reduce:
      - on: "Lead:LeadCreated"
        patches:
          - op: add
            path: /leads
            value: "${0}"
```

[`10-full-crm-flow`](tests/e2e/10-full-crm-flow.e2e-test.ts) updates and verifies the dashboard projection.

### Running custom logic that CEL can't express

If you want to compute something — a scoring algorithm, a lookup table, a transformation — that goes beyond what CEL supports, write an inline TypeScript script. Declare it under `scripts:` with a name, then reference it as `ts:<name>` anywhere a CEL expression is accepted (reducers excepted). The script runs in a sandboxed `node:vm` context with a 50 ms budget and receives the full command context.

```yaml
scripts:
  - name: computeScore
    code: |
      export default function(ctx) {
        const base = { REFERRAL: 80, WEBSITE: 50 };
        return base[ctx.command.payload.source] ?? 30;
      }
event_catalog:
  - type: LeadCreated
    payload_template:
      score: "ts:computeScore"
```

[`11-inline-typescript`](tests/e2e/11-inline-typescript.e2e-test.ts) shows the script setting a score on lead creation.

### Owning an event's projection in TypeScript

If you want full programmatic control over how an event updates aggregate state — beyond what patch operations can express — export a TypeScript `reducer()` for a `(boundary, eventType)` pair. Potemkin scans and registers these at boot via a glob declared in `potemkin.yaml` under `typescript.scan`; the TypeScript reducer takes precedence over any YAML patches declared for the same event.

[`53-ts-reducer-end-to-end`](tests/e2e/53-ts-reducer-end-to-end.e2e-test.ts) runs a function-style reducer through the full stack.

### Reacting to another boundary's events without coupling the source

If you want one operation to atomically update several boundaries — and you want each downstream boundary to subscribe on its own terms, without the source knowing about any of them — declare `reactions` in the reacting boundaries' files. Each reaction names the event it subscribes to, the event it will emit, and a `target` CEL expression that resolves to the affected aggregate id. The source boundary needs no changes at all: add a new subscriber by dropping a new YAML file with a `reactions:` block, and the source is unmodified.

All reaction-emitted events are committed in the same atomic Unit of Work as the original event. Any reaction failure aborts the entire transaction. Reactions can chain — a reaction-emitted event may itself trigger further reactions in other boundaries — without being bounded by the `dispatch_commands` depth limit of 5. Termination is guaranteed by a fired-set that allows each `(reaction, aggregate)` pair to fire at most once per UoW, plus an event budget backstop.

```yaml
# inventory.yaml — declares its own subscription; order.yaml is untouched
reactions:
  - name: reserve-inventory-on-order-placed
    on: "Order:OrderPlaced"
    intent: creation
    emit: InventoryReserved
```

```yaml
# notification.yaml — independently subscribes to the same source event
reactions:
  - name: queue-notification-on-order-placed
    on: "Order:OrderPlaced"
    intent: creation
    emit: NotificationQueued
```

```yaml
# audit.yaml — a third subscriber; source still has no reactions key
reactions:
  - name: record-audit-on-order-placed
    on: "Order:OrderPlaced"
    intent: creation
    emit: AuditRecorded
```

A single `POST /orders` then commits four events — `OrderPlaced`, `InventoryReserved`, `NotificationQueued`, and `AuditRecorded` — atomically. The nine-boundary variant in [`66-reactions-fanout`](tests/e2e/66-reactions-fanout.e2e-test.ts) chains six hops deep (past the dispatch depth limit) and fans out to three independent legs, all in one request.

### Calling out to another service when an event fires

If you want to notify an external system whenever a subscribed event is emitted — a payment processor, a fulfillment service, a logging endpoint — configure an outbound webhook. The engine POSTs the payload to your URL after the Unit of Work commits, signs the body with `x-potemkin-signature: sha256=<hmac>`, and retries with backoff up to `maxAttempts` times on failure.

The `url` and `payload` fields are CEL expressions, so you can construct the destination and body dynamically from the event.

```yaml
webhooks:
  - name: shipment-created-webhook
    trigger:
      boundary: Shipment
      condition: "event.type == 'ShipmentCreated'"
    url: "'http://127.0.0.1:19877/webhook'"
    secret: "your-webhook-secret"
    payload:
      shipmentId: "${event.aggregateId}"
      event: "${event.type}"
    retry:
      maxAttempts: 3
      delayMs: 100
```

[`64-webhook-hmac`](tests/e2e/64-webhook-hmac.e2e-test.ts) stands up a local receiver and verifies the signature.

---

## Shaping responses

### Adding hypermedia links to a response

If you want responses to carry discoverable action links alongside data, enable HATEOAS in your global config and annotate each behaviour that should surface a link. The engine adds `_links.self` automatically; conditional action links appear only when their predicate is true for the current state.

In the global config:

```yaml
hateoas:
  enabled: true
  self_links: true
```

On each behaviour that should surface an action link:

```yaml
- name: qualifyLead
  link_name: qualify
  link_condition: "state.status == 'CONTACTED'"
  match:
    operationId: qualifyLead
    method: POST
```

Per-boundary static links (a list of `rel`/`href` pairs under `hateoas:`) are also available when you just need fixed URLs that do not depend on state. [`44-hateoas`](tests/e2e/44-hateoas.e2e-test.ts) verifies both the self link and the state-dependent action links.

### Hiding a field from a response

If you want to strip an internal field so it never reaches the caller, list it under `mask:` on the boundary. The field is removed from every response that boundary emits — collections, single-entity GETs, and mutation responses alike.

```yaml
mask:
  - internalNotes
```

[`56-response-mutations`](tests/e2e/56-response-mutations.e2e-test.ts) confirms the masked field is gone from the served response.

### Marking an endpoint deprecated

If you want the engine to emit RFC 8594 deprecation headers on a boundary's responses, add a `deprecated:` block with a date, an optional sunset timestamp, and a successor URL. The engine sets `Deprecation` and `Sunset` as HTTP-dates and adds a `Link` header pointing to the replacement.

```yaml
deprecated:
  date: "2025-01-01"
  sunset: "2027-01-01T00:00:00Z"
  replacement: /v2/documents
```

The deprecation/sunset headers are checked in [`45-polish-features`](tests/e2e/45-polish-features.e2e-test.ts), and masking combined with deprecation in [`56-response-mutations`](tests/e2e/56-response-mutations.e2e-test.ts).

### Adding security headers to every response

If you want standard hardening headers on every response the engine emits — including error and admin responses — enable `security_headers` in your global config. Each flag maps to the corresponding header, and `custom_headers` lets you append anything else.

```yaml
security_headers:
  enabled: true
  hsts: true
  nosniff: true
  frame_deny: true
  referrer_policy: "strict-origin-when-cross-origin"
  custom_headers:
    X-Custom-Sim-Header: "potemkin-sim"
```

[`38-security-headers`](tests/e2e/38-security-headers.e2e-test.ts) checks the headers on success, error, and admin responses.

### Slowing a boundary down on purpose

If you want to simulate a sluggish downstream, add a `latency:` block to the boundary. Use `fixed_ms` for a deterministic delay, or `min_ms`/`max_ms` for a uniform-random sample on each request.

```yaml
latency:
  fixed_ms: 60
```

[`65-latency`](tests/e2e/65-latency.e2e-test.ts) measures that the response is held back by at least the configured floor.

### Routing by URL version prefix

If you want requests under `/v1/...` and `/v2/...` to resolve to the same boundaries while tagging each response with which version handled it, enable versioning in the global config. The engine strips the prefix before matching routes and sets `X-Potemkin-Version` on every response.

```yaml
versioning:
  enabled: true
  versions:
    - version: "v1"
      prefix: "/v1"
    - version: "v2"
      prefix: "/v2"
      default: true
```

[`47-api-versioning`](tests/e2e/47-api-versioning.e2e-test.ts) checks that each prefix routes to the right version label.

---

## Chaos and runtime control

### Returning an error for matching requests

If you want a deterministic error response for a specific scenario — a registry timeout, a downstream that rejects certain payloads — declare a fault rule. Fault rules are evaluated before behaviours, so the matched request never reaches event processing.

```yaml
fault_rules:
  - name: dnc-registry-slow
    match:
      boundary: LeadDNC
      intent: mutation
      condition: "command.payload.reason == 'REGISTRY_CHECK'"
    response:
      status: 504
      body:
        error: DNC_REGISTRY_TIMEOUT
      delay_ms: 100
```

You can also target requests by header. The `potemkin:` shorthand in a `match` block expands to the corresponding `X-Potemkin-*` header check, so you do not need to spell out the full header name:

```yaml
  - name: rate-limit-via-header
    match:
      condition: "true"
      potemkin:
        rate_limit: "*"
    response:
      status: 429
      body:
        error: RATE_LIMITED
```

[`30-fault-injection`](tests/e2e/30-fault-injection.e2e-test.ts) is the main example; resilience and cascade tolerance are in [`25-fault-resilience`](tests/e2e/25-fault-resilience.e2e-test.ts), and header/method matching in [`40-header-matching`](tests/e2e/40-header-matching.e2e-test.ts).

### Injecting chaos per request

If you want to trigger a fault on a single request without touching YAML, send one of the chaos request headers. They stack on top of any YAML fault rules and take effect for that request only.

- `X-Potemkin-Force-Latency: <ms>` — add a delay before the response.
- `X-Potemkin-Force-Status: <code>` — override the response status code.
- `X-Potemkin-Error-Class: <name>` — return a named error class.

This is useful during exploratory testing or when you want to script a flaky-dependency scenario from a test without changing fixture files. [`46-chaos-headers`](tests/e2e/46-chaos-headers.e2e-test.ts) exercises each header.

### Driving engine behaviour at request time with control headers

If you want to inspect what a mutation would produce without committing it, travel a read back to an earlier version, or otherwise adjust engine behaviour for one call, use the `X-Potemkin-*` control headers. They cover seven tiers of runtime behaviour. Canonical header names are defined in [`src/http/potemkinHeaders.ts`](src/http/potemkinHeaders.ts).

Two common ones:

- `X-Potemkin-Read-At-Version: <n>` — return state as it was at event sequence `n` (time-travel read).
- `X-Potemkin-Dry-Run: true` — run the full evaluation pipeline including guards, conditions, and event hydration, then discard the result without writing to the event log.

These headers are how you build test assertions around idempotency, version history, and speculative execution without spinning up separate engine instances. [`48-control-headers`](tests/e2e/48-control-headers.e2e-test.ts) drives every tier through the stack.

---

## Running inside Specmatic

### Connecting the engine to the Specmatic stub

If you want the same OpenAPI contract to serve both Specmatic's stateless stub and Potemkin's stateful simulation, add the Kotlin plugin to the Specmatic classpath. The plugin intercepts requests for routes registered as stateful and forwards them to the engine at `/_engine/forward`; requests for unregistered routes fall through to the normal Specmatic stub.

[`03-forwarding`](tests/e2e/03-forwarding.e2e-test.ts) drives a request through the full Specmatic → plugin → engine path.

### Letting the plugin find your stateful routes

If you want the plugin to know which routes are handled by the engine rather than the stub, the engine exposes `/_engine/routes`. The plugin calls this on startup and uses the result to decide which incoming requests to intercept. Seeded entities are pushed into Specmatic's stub registry via `/_engine/fixtures` so a seeded GET is served without a round-trip to the engine.

Route discovery is covered in [`01-route-discovery`](tests/e2e/01-route-discovery.e2e-test.ts) and fixture push in [`02-fixture-push`](tests/e2e/02-fixture-push.e2e-test.ts).

### Driving seeds, workflows, and overlays through the stub

If you want seeded data, scripted multi-step workflows, or response overlays to be visible to a client that talks to the Specmatic stub address (rather than the engine directly), use forward blocks. The plugin routes these through the stub, so the client sees a consistent view regardless of which layer handled each request.

[`57-forward-blocks-and-jwt`](tests/e2e/57-forward-blocks-and-jwt.e2e-test.ts) proves the seeds, workflow, and overlay forms all reach the client through Specmatic.

### Handling engine restarts and hot reload

If you want the Specmatic plugin to stay in sync when the engine restarts — for example, during test isolation resets or fixture changes — the engine sends a `/ready` signal on boot and a `/shutdown` signal before stopping. The plugin monitors health and re-fetches fixtures after a restart, so the stub registry stays consistent.

The shutdown and ready signals are in [`08-shutdown-notification`](tests/e2e/08-shutdown-notification.e2e-test.ts), hot reload in [`09-fixture-hot-reload`](tests/e2e/09-fixture-hot-reload.e2e-test.ts), and health monitoring in [`07-reliability`](tests/e2e/07-reliability.e2e-test.ts).

### Validating requests against the contract

If you want the engine to reject structurally invalid requests before they reach behaviour evaluation, that happens by default. Every inbound request is validated against the OpenAPI contract; anything that violates it gets a `400 CONTRACT_VIOLATION` response and produces no events.

[`33-contract-validation`](tests/e2e/33-contract-validation.e2e-test.ts) sends a range of invalid payloads and confirms no events are written.

---

## Further reference

- **[docs/dsl.md](docs/dsl.md)** — the complete DSL reference (every field, boot/runtime errors, worked examples, and the response-generation section).
- **[docs/cel.md](docs/cel.md)** — the CEL expression language: built-ins, operators, phase restrictions, and determinism guarantees.
- **[docs/specmatic.md](docs/specmatic.md)** — the Specmatic integration guide.
- **[docs/design/multi-boundary-reactions.md](docs/design/multi-boundary-reactions.md)** — design spec for multi-boundary atomic reactions (R1–R5, R7 shipped); covers grammar, semantics, CEL context, termination, and ordering.
- **[tests/e2e/README.md](tests/e2e/README.md)** — how to run the e2e harness (engine-only vs full stack).
