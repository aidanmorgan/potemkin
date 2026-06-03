# Potemkin — Specmatic Stateful Simulation Engine

A high-performance, strictly in-memory middleware that simulates stateful HTTP services
**declaratively**, using an OpenAPI contract for structure and a YAML + CEL behavioural DSL
for behaviour. You describe *what* a service does in YAML; Potemkin runs it as a real,
stateful HTTP server you can drive end-to-end — no application code required.

It runs in two modes:

- **Standalone engine** — an Express gateway you boot directly (`bootSystem` + `createGateway`).
- **Specmatic plugin** — a Kotlin plugin that sits inside a Specmatic stub, intercepts stateful
  routes, and forwards them to the engine, so the same contract can serve both stateless stubs
  and stateful simulation.

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [The e2e tests are the examples](#the-e2e-tests-are-the-examples)
- [Feature guide](#feature-guide)
  - [A. Defining a simulation](#a-defining-a-simulation)
  - [B. Behaviours (the write side)](#b-behaviours-the-write-side)
  - [C. Reducers and state projection](#c-reducers-and-state-projection)
  - [D. Querying (the read side)](#d-querying-the-read-side)
  - [E. Consistency and authentication](#e-consistency-and-authentication)
  - [F. Workflows and side effects](#f-workflows-and-side-effects)
  - [G. Response generation](#g-response-generation)
  - [H. Chaos and control](#h-chaos-and-control)
  - [I. Specmatic integration and lifecycle](#i-specmatic-integration-and-lifecycle)
- [Further reference](#further-reference)

---

## Architecture

Potemkin enforces **CQRS** (Command Query Responsibility Segregation) and **Event Sourcing**:

- **Write model (event log):** an append-only ledger of immutable domain events, indexed via UUIDv7.
- **Read model (state graph):** a `Map<TargetId, JsonObject>` continuously projected from events.
- **DSL behaviours:** YAML-declared rules evaluated by a sandboxed CEL expression engine.
- **Pattern matcher:** compares each inbound command against ordered behaviour rules; first match wins.
- **Unit of Work:** an atomic transaction boundary managing the shadow graph and secondary commands.

Every inbound request is validated against the OpenAPI contract, translated into a command,
matched against behaviours, turned into events, projected into state, and committed atomically.
All state is volatile — nothing is persisted — and a frozen baseline makes
`POST /_admin/reset` mathematically deterministic.

## Quick start

```sh
npm install
npm test                 # full unit + integration suite (no Java required)

# Engine-only e2e examples — boot the real engine in-process, no Java/JVM needed
npm run test:e2e:engine

# Full Specmatic-stack e2e (requires Java 17+; builds the Kotlin plugin JAR)
npm run test:e2e:build
```

Boot the engine yourself from compiled DSL + an OpenAPI document:

```ts
import { loadOpenApi, bootSystem, createGateway } from './src/index.js';
// compiledDsl comes from parseDslYaml + compileDsl (or loadPotemkinConfig for a fixture dir)
const sys = await bootSystem({ openapi, compiledDsl });
const app = createGateway(sys);   // a standard Express app
app.listen(3000);
```

## The e2e tests are the examples

Every feature below links to an end-to-end test under [`tests/e2e/`](tests/e2e/). These tests are
**both proof the system works and the canonical worked example** of each feature. The behaviour is
declared entirely in YAML fixtures (under [`tests/fixtures/`](tests/fixtures/)) — the test files only
send HTTP requests and assert responses and state. To learn a feature, read its fixture YAML (the
*system under test*) alongside the linked test (the *assertions*).

Tests come in two flavours:

- **Engine-only** (e.g. `60`–`65`) boot the engine in-process via `startEngineOnlyApp` and need **no Java**.
- **Full-stack** boot a real Specmatic JVM with the Kotlin plugin and exercise the complete wire.

---

## Feature guide

### A. Defining a simulation

#### Boundaries and OpenAPI binding

**What it's for.** A *boundary* is one aggregate root (e.g. `Lead`). It binds an OpenAPI route
(`contract_path`) to a set of behaviours and reducers. The OpenAPI document owns the structural
shape; the DSL owns behaviour. Multiple boundary files are merged into one execution matrix at boot.

**How to use.** One YAML file per boundary:

```yaml
boundary: Lead
contract_path: /leads
fallback_override: false
event_catalog: [ ... ]
behaviors: [ ... ]
reducers: [ ... ]
```

→ [`13-crm-smoke`](tests/e2e/13-crm-smoke.e2e-test.ts) exercises all five CRM boundaries through the full stack.

#### Multi-file composition

**What it's for.** Split a large simulation across many module files; the loader globs them
together (via `modules: "dsl/**/*.yaml"` in `potemkin.yaml`) and resolves cross-boundary references.

**How to use.** Drop additional `*.yaml` files in the module directory — no registration needed.

→ [`50-multi-yaml-composition`](tests/e2e/50-multi-yaml-composition.e2e-test.ts)

#### Initialization (seed data) and deterministic reset

**What it's for.** Seed baseline entities at boot. Seeds are replayed verbatim on
`POST /_admin/reset`, so post-reset state is identical to cold boot.

**How to use.**

```yaml
initialization:
  - id: "00000000-0000-7000-8000-000000000010"
    companyName: "Apex Solutions Ltd"
    status: "NEW"
    callIds: []
```

→ [`16-initialization-queries`](tests/e2e/16-initialization-queries.e2e-test.ts) ·
deterministic reset & isolation → [`24-ephemeral-lifecycle`](tests/e2e/24-ephemeral-lifecycle.e2e-test.ts)

#### Identity generation (`identity.creation.generate`)

**What it's for.** Produce the aggregate id on a creation request, typically a UUIDv7.

**How to use.**

```yaml
identity:
  creation:
    generate: "$uuidv7()"
```

→ [`16-initialization-queries`](tests/e2e/16-initialization-queries.e2e-test.ts)

#### Identity key extraction (`identity.key`)

**What it's for.** Derive the aggregate id from somewhere *other* than the URL `{id}` path
parameter — a request header, query parameter, or a pointer into the body.

**How to use.**

```yaml
identity:
  key:
    from: header        # path | query | header | payload
    name: x-token-id    # header/query name, or payload pointer (use `pointer:` for nested)
```

→ [`61-identity-key`](tests/e2e/61-identity-key.e2e-test.ts)

#### Event catalog and payload templates

**What it's for.** Declare the named event types a boundary can emit, and how each event's payload
is built from the command. Payload templates are CEL, evaluated in the event-hydration phase
(so `$uuidv7()` / `$now()` are allowed).

**How to use.**

```yaml
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
      companyName: "command.payload.companyName"
      createdAt: "$now()"
```

→ [`14-object-graph-mutations`](tests/e2e/14-object-graph-mutations.e2e-test.ts)

#### Runtime payload validation (`schema_ref`)

**What it's for.** Validate an event's payload against an OpenAPI component schema at runtime; a
violation aborts the Unit of Work with `SCHEMA_TYPE_MISMATCH` (HTTP 500).

**How to use.**

```yaml
event_catalog:
  - type: PaymentRecorded
    schema_ref: "#/components/schemas/StrictPayload"
    payload_template: { amount: "command.payload.amount" }
```

→ [`60-reducer-patch-ops`](tests/e2e/60-reducer-patch-ops.e2e-test.ts) (the `schema_ref` describe block)

### B. Behaviours (the write side)

Behaviours are an ordered list; the engine evaluates them top-to-bottom and runs the **first match**.

#### `operationId` dispatch

**What it's for.** Bind a behaviour to a specific OpenAPI `operationId`. Behaviours whose
`operationId` does not match the incoming operation are skipped.

**How to use.**

```yaml
behaviors:
  - name: createLead
    match: { operationId: createLead, condition: "true" }
    emit: LeadCreated
```

→ [`55-operationid-dispatch`](tests/e2e/55-operationid-dispatch.e2e-test.ts)

#### `match.condition` and state transitions

**What it's for.** Select a behaviour only when a CEL predicate over the command and current state
is true — the mechanism behind valid/invalid state-machine transitions.

**How to use.**

```yaml
match:
  operationId: qualifyLead
  condition: "state.status == 'CONTACTED'"
```

→ [`21-state-transitions`](tests/e2e/21-state-transitions.e2e-test.ts)

#### Guards (`match.requires`)

**What it's for.** Domain invariants checked *before* `condition`. A failing guard returns HTTP 422
with your error code/message and terminates evaluation (it does **not** fall through).

**How to use.**

```yaml
match:
  operationId: contactLead
  requires:
    - name: not-dnc
      condition: "state.status != 'DNC'"
      error_code: LEAD_IS_DNC
      error_message: "Cannot contact a lead marked Do Not Call"
```

→ [`18-guard-failures`](tests/e2e/18-guard-failures.e2e-test.ts)

#### Header-driven behaviour selection (`match.headers`)

**What it's for.** Pick between two behaviours bound to the **same** `operationId` based on request
headers (AND semantics: all declared headers must match).

**How to use.**

```yaml
behaviors:
  - name: submitOrder.mobile
    match: { operationId: submitOrder, headers: { x-channel: mobile } }
    emit: MobileOrderPlaced
  - name: submitOrder.default          # first-match-wins: place the general rule last
    match: { operationId: submitOrder, condition: "true" }
    emit: OrderPlaced
```

→ [`62-behavior-header-match`](tests/e2e/62-behavior-header-match.e2e-test.ts) ·
header/method matching for fault rules → [`40-header-matching`](tests/e2e/40-header-matching.e2e-test.ts)

#### Conditional multi-emit (`emit_when`) and postconditions

**What it's for.** `emit_when` emits different events depending on state evaluated *between* emits;
`postcondition` is a CEL invariant checked after projection — a false result aborts the Unit of Work.

**How to use.**

```yaml
emit_when:
  - when: "command.payload.amount == state.balance"
    emit: LoanSettled
  - when: "command.payload.amount < state.balance"
    emit: LoanRepaid
postcondition: "state.balance >= 0"
```

→ [`20-features-combined`](tests/e2e/20-features-combined.e2e-test.ts) ·
lifecycle branching → [`19-campaign-lifecycle`](tests/e2e/19-campaign-lifecycle.e2e-test.ts)

#### Cross-boundary dispatch (`dispatch_commands`)

**What it's for.** Queue secondary commands to other boundaries within the same Unit of Work — all
events commit atomically. Recursion is bounded at depth 5 (HTTP 508 on breach).

**How to use.**

```yaml
dispatch_commands:
  - boundary: Lead
    intent: mutation
    operationId: patchLead
    target_id: "command.payload.leadId"
    payload: { opportunityId: "command.targetId" }
    condition: "command.payload.leadId != null"
```

→ [`22-cross-boundary-dispatch`](tests/e2e/22-cross-boundary-dispatch.e2e-test.ts) ·
secondary-command cascade → [`04-cqrs-cascade`](tests/e2e/04-cqrs-cascade.e2e-test.ts) ·
multi-boundary → [`17-multi-boundary-cascades`](tests/e2e/17-multi-boundary-cascades.e2e-test.ts)

### C. Reducers and state projection

#### Reducers and patch ops

**What it's for.** Project an event onto aggregate state with an ordered list of JSON-Patch-style
operations. Bare strings are literals; only `${...}` is evaluated as CEL (with type preservation).

**How to use.** Supported `op`s: `add`, `replace`, `remove`, `append`, `prepend`, `increment`,
`merge`, `upsert` (array element by `key`), `copy`/`move` (via `from`).

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

→ [`60-reducer-patch-ops`](tests/e2e/60-reducer-patch-ops.e2e-test.ts) is the canonical example,
with one describe block per op.

#### Nested paths and computed fields

**What it's for.** Patch paths are JSON Pointers that auto-vivify intermediate objects/arrays;
combined with derived/computed state you can maintain running totals.

**How to use.**

```yaml
- op: replace
  path: /address/city
  value: "${event.payload.city}"
```

→ computed totals (`totalValue = sum(lineItems.*.lineTotal)`) →
[`54-computed-totals-end-to-end`](tests/e2e/54-computed-totals-end-to-end.e2e-test.ts) ·
long mutation sequences → [`51-object-graph-evolution`](tests/e2e/51-object-graph-evolution.e2e-test.ts)

### D. Querying (the read side)

#### Query filtering (`query_mapping`)

**What it's for.** Map URL query parameters to CEL predicates that filter the state graph at read
time. Multiple params compose as AND.

**How to use.**

```yaml
query_mapping:
  status: "state.status == query.status"
  minValue: "state.value >= double(query.minValue)"
```

`GET /leads?status=NEW` → only `NEW` leads. →
[`34-query-edge-cases`](tests/e2e/34-query-edge-cases.e2e-test.ts) ·
returning subsets of the graph → [`52-get-subsets-of-graph`](tests/e2e/52-get-subsets-of-graph.e2e-test.ts)

#### Pagination envelope and `Link` headers

**What it's for.** When `?limit` is present the engine wraps results in
`{ items, totalCount, offset, limit, hasMore }` and emits RFC 5988 `Link` headers
(`rel="next"`/`"prev"`). Without `?limit`, the raw array is returned (backward-compatible).

**How to use.** `GET /leads?limit=10&offset=20`

→ [`36-pagination-envelope`](tests/e2e/36-pagination-envelope.e2e-test.ts)

#### Multi-sort and array operators

**What it's for.** Multi-field sort and array-membership filters without any YAML — built into the
query engine.

**How to use.** `?sort=status,-score` · `?callIds:contains=<uuid>` · `?callIds:arrayContains=<uuid>`

→ [`39-multisort-array-operators`](tests/e2e/39-multisort-array-operators.e2e-test.ts)

#### Query extensions (sparse fieldsets and more)

**What it's for.** Return only selected fields and other read-shaping extensions.

**How to use.** `?fields=id,companyName,score`

→ [`43-query-extensions`](tests/e2e/43-query-extensions.e2e-test.ts)

### E. Consistency and authentication

#### Idempotency

**What it's for.** Execute a non-GET command at most once per `Idempotency-Key` within a TTL. A
replay returns the original response with `X-Idempotency-Replay: true`; a key reused with a
different body returns 409.

**How to use.** (global config)

```yaml
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
```

→ [`06-idempotency`](tests/e2e/06-idempotency.e2e-test.ts) ·
key lifecycle & races → [`26-concurrency-idempotency`](tests/e2e/26-concurrency-idempotency.e2e-test.ts)

#### Optimistic concurrency and conditional requests

**What it's for.** Single-entity GETs return an `ETag` (from the entity's sequence version) and
`Last-Modified`. `If-None-Match`/`If-Modified-Since` yield `304`; `If-Match` enforces optimistic
concurrency (`412` on mismatch, `428` when required and missing).

**How to use.** Send `If-Match: "5"` on a mutation, or `If-None-Match: "5"` on a GET.

→ [`37-conditional-requests`](tests/e2e/37-conditional-requests.e2e-test.ts)

#### RBAC (`required_scopes`)

**What it's for.** Gate a behaviour on the caller's scopes. Missing actor → 401; insufficient
scopes → 403.

**How to use.**

```yaml
match:
  operationId: markLeadDNC
  required_scopes: [manager]
```

With the simulation bearer format `Authorization: Bearer alice:manager,lead:write`.

→ [`05-rbac`](tests/e2e/05-rbac.e2e-test.ts)

#### JWT authentication

**What it's for.** Verify real HS256 JWTs (signature, `alg` allow-list, `exp`/`nbf`/`iss`/`aud`,
required claims) and derive the actor's id and scopes from configured claims.

**How to use.** (global config)

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

→ [`41-jwt-auth`](tests/e2e/41-jwt-auth.e2e-test.ts)

#### Session + CSRF authentication

**What it's for.** Cookie-based sessions with a login/logout path and CSRF-header enforcement on
mutations.

**How to use.** (global config)

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

→ [`42-session-auth`](tests/e2e/42-session-auth.e2e-test.ts)

### F. Workflows and side effects

#### Sagas and compensation

**What it's for.** Coordinate multi-step workflows across boundaries *after* the primary Unit of
Work commits. If a step fails, completed steps are compensated in reverse order; lifecycle events
(`SagaStarted`/`SagaStepCompleted`/`SagaStepFailed`/`SagaCompensated`/`SagaFailed`) are recorded
under the `__saga__` boundary.

**How to use.** (global config)

```yaml
sagas:
  - name: OrderFulfillmentSaga
    trigger: { boundary: Order, intent: mutation, condition: "event.type == 'OrderPlaced'" }
    steps:
      - name: reserveInventory
        boundary: Reservation
        intent: creation
        target_id: "$uuidv7()"
        payload: { orderId: "event.aggregateId" }
        compensation:
          intent: mutation
          operationId: cancelReservation
          payload: { reason: "'saga-failed'" }
```

→ compensation, driven by a forced step failure → [`63-saga-compensation`](tests/e2e/63-saga-compensation.e2e-test.ts) ·
happy path → [`12-saga-compensation`](tests/e2e/12-saga-compensation.e2e-test.ts)

#### Derived projections

**What it's for.** Materialise a cross-boundary read model from events of multiple boundaries,
exposed at `GET /_admin/derived/:name`.

**How to use.** (global config)

```yaml
derived_projections:
  - name: CampaignDashboard
    key: "event.payload.campaignId"
    subscribe: ["Lead:LeadCreated", "Opportunity:OpportunityCreated"]
    reduce:
      - on: "Lead:LeadCreated"
        patches:
          - { op: add, path: /leads, value: "${0}" }
```

→ [`10-full-crm-flow`](tests/e2e/10-full-crm-flow.e2e-test.ts) updates and verifies the dashboard projection.

#### Inline TypeScript scripts (`ts:`)

**What it's for.** An escape hatch for computation CEL can't express. Declare a named script and
reference it as `ts:<name>` anywhere a CEL expression is accepted (banned in reducers). Runs in a
sandboxed `node:vm` with a 50 ms budget.

**How to use.**

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
    payload_template: { score: "ts:computeScore" }
```

→ [`11-inline-typescript`](tests/e2e/11-inline-typescript.e2e-test.ts)

#### TypeScript reducers

**What it's for.** Own an event's state projection with a TypeScript `reducer()` instead of YAML
patches (scanned and registered at boot).

**How to use.** Declare a `typescript.scan` glob in `potemkin.yaml` and export a reducer for a
`(boundary, eventType)` pair.

→ [`53-ts-reducer-end-to-end`](tests/e2e/53-ts-reducer-end-to-end.e2e-test.ts)

#### Outbound webhooks (HMAC-signed)

**What it's for.** POST a payload to an external URL when a subscribed event is emitted, signed with
`x-potemkin-signature: sha256=<hmac>` over the body, with retry/backoff and a delivery timeout.

**How to use.** (global config)

```yaml
webhooks:
  - name: shipment-created-webhook
    trigger: { boundary: Shipment, condition: "event.type == 'ShipmentCreated'" }
    url: "'http://127.0.0.1:19877/webhook'"
    secret: "your-webhook-secret"
    payload:
      shipmentId: "${event.aggregateId}"
      event: "${event.type}"
    retry: { maxAttempts: 3, delayMs: 100 }
```

→ [`64-webhook-hmac`](tests/e2e/64-webhook-hmac.e2e-test.ts)

### G. Response generation

#### HATEOAS hypermedia links

**What it's for.** Add `_links.self` to responses and state-dependent action links surfaced from
behaviours (`link_name` + `link_condition`).

**How to use.** Enable globally and annotate behaviours:

```yaml
# global config
hateoas: { enabled: true, self_links: true }
# behaviour
- name: qualifyLead
  link_name: qualify
  link_condition: "state.status == 'CONTACTED'"
  match: { operationId: qualifyLead, method: POST }
```

A per-boundary static form (`hateoas: [{ rel, href }]`) also exists.

→ [`44-hateoas`](tests/e2e/44-hateoas.e2e-test.ts)

#### Field masking and deprecation headers

**What it's for.** Remove fields from a response (`mask:`) and emit RFC 8594 deprecation headers
(`Deprecation`, `Sunset` as HTTP-dates, and a successor `Link`) from `deprecated:`.

**How to use.** (per boundary)

```yaml
mask:
  - internalNotes
deprecated:
  date: "2025-01-01"
  sunset: "2027-01-01T00:00:00Z"
  replacement: /v2/documents
```

→ [`56-response-mutations`](tests/e2e/56-response-mutations.e2e-test.ts) ·
deprecation/sunset headers → [`45-polish-features`](tests/e2e/45-polish-features.e2e-test.ts)

#### Security headers

**What it's for.** Inject standard security headers on **every** response (success, error, admin).

**How to use.** (global config)

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

→ [`38-security-headers`](tests/e2e/38-security-headers.e2e-test.ts)

#### Per-boundary latency

**What it's for.** Simulate a slow downstream by delaying responses on a boundary.

**How to use.**

```yaml
latency:
  fixed_ms: 60        # deterministic; or min_ms/max_ms for a uniform-random sample
```

→ [`65-latency`](tests/e2e/65-latency.e2e-test.ts)

#### API versioning

**What it's for.** Route by URL prefix to a labelled version; each response is tagged with
`X-Potemkin-Version`.

**How to use.** (global config)

```yaml
versioning:
  enabled: true
  versions:
    - { version: "v1", prefix: "/v1" }
    - { version: "v2", prefix: "/v2", default: true }
```

→ [`47-api-versioning`](tests/e2e/47-api-versioning.e2e-test.ts)

### H. Chaos and control

#### Fault injection (`fault_rules`)

**What it's for.** Declaratively return error responses for requests matching headers/conditions —
chaos engineering driven from YAML, evaluated before behaviours.

**How to use.**

```yaml
fault_rules:
  - name: dnc-registry-slow
    match:
      boundary: LeadDNC
      intent: mutation
      condition: "command.payload.reason == 'REGISTRY_CHECK'"
    response:
      status: 504
      body: { error: DNC_REGISTRY_TIMEOUT }
      delay_ms: 100        # delay lives inside `response:`
  # Header-matched via the convenience `potemkin:` block (expands to X-Potemkin-*):
  - name: rate-limit-via-header
    match: { condition: "true", potemkin: { rate_limit: "*" } }
    response: { status: 429, body: { error: RATE_LIMITED } }
```

→ [`30-fault-injection`](tests/e2e/30-fault-injection.e2e-test.ts) ·
resilience & cascade tolerance → [`25-fault-resilience`](tests/e2e/25-fault-resilience.e2e-test.ts)

#### Chaos headers

**What it's for.** Per-request chaos that stacks on top of YAML rules, via request headers.

**How to use.** `X-Potemkin-Force-Latency: <ms>`, `X-Potemkin-Force-Status: <code>`,
`X-Potemkin-Error-Class: <name>`.

→ [`46-chaos-headers`](tests/e2e/46-chaos-headers.e2e-test.ts)

#### Control headers (`X-Potemkin-*`, Tiers 1–7)

**What it's for.** A family of request headers that drive engine behaviour at runtime — time-travel
reads, dry-run, forced responses, and more — without changing YAML. Canonical names live in
[`src/http/potemkinHeaders.ts`](src/http/potemkinHeaders.ts).

**How to use.** e.g. `X-Potemkin-Read-At-Version: <n>` (time-travel a read),
`X-Potemkin-Dry-Run: true` (evaluate without committing).

→ [`48-control-headers`](tests/e2e/48-control-headers.e2e-test.ts)

### I. Specmatic integration and lifecycle

#### Forwarding pipeline

**What it's for.** With the Kotlin plugin on the Specmatic classpath, stateful routes are
intercepted and forwarded to the engine (`/_engine/forward`), so one contract serves both stateless
stubs and stateful simulation.

→ [`03-forwarding`](tests/e2e/03-forwarding.e2e-test.ts)

#### Route discovery and fixture push

**What it's for.** The plugin discovers which routes are stateful (`/_engine/routes`) and pushes
seeded entities into Specmatic's stub registry (`/_engine/fixtures`) so seeded GETs are served
directly.

→ route discovery → [`01-route-discovery`](tests/e2e/01-route-discovery.e2e-test.ts) ·
fixture push → [`02-fixture-push`](tests/e2e/02-fixture-push.e2e-test.ts)

#### Forward blocks (seeds / workflow / overlay)

**What it's for.** Drive seeded data, scripted workflows, and response overlays through the Specmatic
stub (not only the engine), so the client sees them via Specmatic.

→ [`57-forward-blocks-and-jwt`](tests/e2e/57-forward-blocks-and-jwt.e2e-test.ts)

#### Lifecycle: readiness, shutdown, hot reload, health

**What it's for.** The engine notifies the plugin on boot (`/ready`) and shutdown (`/shutdown`); the
plugin monitors engine health and re-fetches fixtures after a restart.

→ shutdown/ready signals → [`08-shutdown-notification`](tests/e2e/08-shutdown-notification.e2e-test.ts) ·
hot reload → [`09-fixture-hot-reload`](tests/e2e/09-fixture-hot-reload.e2e-test.ts) ·
health monitoring → [`07-reliability`](tests/e2e/07-reliability.e2e-test.ts)

#### Contract validation

**What it's for.** Every inbound request is validated against the OpenAPI contract; violations
return `400 CONTRACT_VIOLATION` and produce no events.

→ [`33-contract-validation`](tests/e2e/33-contract-validation.e2e-test.ts)

---

## Further reference

- **[docs/dsl.md](docs/dsl.md)** — the complete DSL reference (every field, boot/runtime errors,
  worked examples, and the response-generation section).
- **[docs/cel.md](docs/cel.md)** — the CEL expression language: built-ins, operators, phase
  restrictions, and determinism guarantees.
- **[docs/specmatic.md](docs/specmatic.md)** — the Specmatic integration guide.
- **[tests/e2e/README.md](tests/e2e/README.md)** — how to run the e2e harness (engine-only vs full stack).
