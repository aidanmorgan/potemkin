# DSL Reference

The Specmatic Stateful Simulation Engine is configured entirely through YAML files that follow this DSL. Each file describes one **State Boundary** (a logical aggregate root), and an optional global configuration file declares cross-cutting concerns such as sagas, idempotency, and derived projections.

This document is the canonical developer reference for the DSL. It covers every field, the execution semantics, boot-time and runtime errors, and complete worked examples.

**Related documentation**

- [CEL expression language — see docs/cel.md](./cel.md)
- [Specmatic integration guide — see docs/specmatic.md](./specmatic.md)

---

## 1. Overview

### What the DSL is

The DSL is a **declarative behavioral overlay** on top of an OpenAPI contract. It tells the engine:

1. Which HTTP routes are handled by which boundaries.
2. What domain events to emit in response to commands (behaviors).
3. How those events mutate aggregate state (reducers).
4. What initial state to seed at boot (initialization).

The engine is a CQRS/Event Sourcing runtime. The DSL never directly mutates state — it declares events, and the engine's projection layer applies them. This separation is fundamental: the write model (event log) is append-only, and the read model (state graph) is rebuilt by replaying events.

### What the DSL is not

- It is **not** a programming language. Complex logic should be expressed in CEL or, as a last resort, inline TypeScript scripts (see [Section 10](#10-inline-typescript-scripts-tier-1)).
- It is **not** a database schema. Structural shape is owned by the OpenAPI contract (`contract_path`).
- It is **not** executed at request time by an interpreter. All DSL expressions are compiled at boot and validated against the contract before the server accepts traffic.

### File layout

One YAML file per boundary is the standard convention:

```
sim/
  customer.yaml        # Customer boundary
  loan-account.yaml    # LoanAccount boundary
  global.yaml          # sagas, idempotency, derived_projections (Tier 2)
```

Multiple boundary files may coexist; the engine merges them into a single execution matrix at boot. The global config file is a separate file (or section) containing the Tier 2 keys `sagas`, `idempotency`, and `derived_projections`.

### Boot-time vs runtime concerns

| Phase | What happens |
|-------|-------------|
| **Boot** | YAML parsed, CEL compiled, cross-references validated, scripts transpiled, OpenAPI bound, initialization data seeded |
| **Runtime** | HTTP request arrives, command assembled, pattern matcher evaluates behaviors, events staged, projected, committed |

Any error in a boot-time concern halts startup with a `BOOT_ERR_*` code (see [Section 12](#12-error-reference)).

---

## 2. Boundary configuration

A boundary file is a YAML mapping. The top-level keys are:

| YAML key (snake_case) | TypeScript field (camelCase) | Type | Required | Description |
|---|---|---|---|---|
| `boundary` | `boundary` | `string` | yes | Logical namespace for this aggregate (e.g. `LoanAccount`). Used in event routing and cross-boundary dispatch. |
| `contract_path` | `contractPath` | `string` | yes | The OpenAPI route this boundary handles (e.g. `/loans`). |
| `fallback_override` | `fallbackOverride` | `boolean` | no (default `false`) | When `true`, unmatched commands use a generic CRUD fallback instead of returning an error. |
| `identity` | `identity` | object | no | Identity generation config for creation intents. |
| `identity.creation.generate` | `identity.creation.generate` | CEL string | no | Expression producing the aggregate ID on creation. Typically `"$uuidv7()"`. |
| `query_mapping` | `queryMapping` | `map<string, string>` | no | Maps URL query parameter names to CEL filter expressions. |
| `event_catalog` | `eventCatalog` | array | no | Defines named event types and their payload templates. |
| `behaviors` | `behaviors` | array | no | Rules matching commands to events. |
| `reducers` | `reducers` | array | no | Rules projecting events onto aggregate state. |
| `initialization` | `initialization` | array | no | Seed records loaded at boot as baseline state. |
| `scripts` | `scripts` | array | no | Named TypeScript modules (Tier 1 escape hatch). |

> ⚠️ All YAML keys use `snake_case`. The schema validator (`src/dsl/schema.ts`) maps them to `camelCase` TypeScript fields. Do not use camelCase in YAML.

### `fallback_override`

When `true`, any command that matches no behavior rule is handled automatically:

- **Query (`GET`)**: Returns the current state graph node directly (HTTP 200).
- **Mutation or creation**: Generates a `System.GenericUpdateEvent` that deep-merges the request payload into the entity state (HTTP 200/201).

When `false` (default), unmatched commands return HTTP 422 `UnhandledOperationError`.

### `identity.creation.generate`

The CEL expression evaluated to produce the new aggregate ID during a creation intent. If omitted, the engine uses an internal UUIDv7. The expression is evaluated in the `EventHydration` phase so `$uuidv7()` and `$now()` are available.

```yaml
identity:
  creation:
    generate: "$uuidv7()"
```

### `query_mapping`

Maps URL query parameter keys to CEL boolean expressions used to filter the state graph at read time. The variable `query` holds the parsed query params; `state` holds each candidate entity.

```yaml
query_mapping:
  riskBand: "state.riskBand == query.riskBand"
  status: "state.status == query.status"
```

A `GET /customers?riskBand=LOW` request returns only entities where `state.riskBand == "LOW"`.

---

## 3. Event catalog

The `event_catalog` block declares the named event types that behaviors may emit. Each entry defines a type key and a payload template.

```yaml
event_catalog:
  - type: LoanOpened
    payload_template:
      id: "command.targetId"
      customerId: "command.payload.customerId"
      principal: "command.payload.principal"
      openedAt: "$now()"
  - type: LoanDisbursed
    schema_ref: "#/components/schemas/LoanDisbursedEvent"
    payload_template:
      txId: "$uuidv7()"
      amount: "command.payload.amount"
      at: "$now()"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Unique event type key within the boundary. Referenced by `emit` and `on` in behaviors/reducers. |
| `payload_template` | `map<string, CEL>` | yes (may be empty `{}`) | Map of event payload fields to CEL expressions. Evaluated in the `EventHydration` phase. |
| `schema_ref` | string | no | OpenAPI `$ref` path (e.g. `#/components/schemas/LoanDisbursedEvent`) for runtime payload validation (Tier 1). |

### Payload template CEL context

During event hydration the following variables are available ([CEL — see docs/cel.md](./cel.md)):

| Variable | Type | Description |
|----------|------|-------------|
| `command` | object | The full command envelope including `targetId`, `payload`, `intent`, `path`, `commandId` |
| `state` | object | Current shadow-graph state for the aggregate at the time of emit |
| `payload` | object | Alias for `command.payload` |

Because templates run in the `EventHydration` phase, `$uuidv7()`, `$now()`, and `now()` are all permitted. These functions are **banned in reducers** to preserve replay determinism.

### `schema_ref` (Tier 1)

When present, the engine resolves the `$ref` at boot against the loaded OpenAPI document. An unresolvable reference halts boot with `BOOT_ERR_DSL_SCHEMA_VIOLATION`. At runtime, after the payload template is evaluated, the resulting object is validated with AJV against the resolved schema. A violation aborts the Unit of Work with `SCHEMA_TYPE_MISMATCH` (HTTP 500).

See `src/engine/projection.ts` for the AJV validation implementation.

---

## 4. Behaviors

`behaviors` is an ordered array of rules. The engine evaluates them top-to-bottom and executes the **first match** only (first-match-wins).

```yaml
behaviors:
  - name: openLoan
    match:
      intent: creation
      condition: "command.payload.principal > 0"
    emit: LoanOpened
    dispatch_commands:
      - boundary: Customer
        intent: mutation
        target_id: "command.payload.customerId"
        payload:
          loanId: "command.targetId"
```

### `match.intent`

One of `creation`, `mutation`, or `query`. Behaviors with a non-matching intent are skipped without evaluating `condition`.

- `creation` — mapped from `POST` when `identity.creation` is defined.
- `mutation` — mapped from `PUT`, `PATCH`, `DELETE`, and `POST` without identity creation.
- `query` — mapped from `GET`.

### `match.condition`

A CEL boolean expression evaluated against the command and current shadow-graph state. When `true`, the behavior is selected. The CEL context variables are `command`, `state`, and `payload` (alias for `command.payload`).

```yaml
condition: "command.path == $concat('/loans/', command.targetId, '/disburse') && command.payload.amount > 0"
```

See [CEL — see docs/cel.md](./cel.md) for the full expression language reference.

### `match.requires[]` (Tier 1)

Named guard conditions evaluated **before** `match.condition`. If any guard evaluates to `false`, the engine immediately returns HTTP 422 with the guard's message — it does **not** fall through to the next behavior. This is distinct from `condition` (which simply skips the rule on false).

```yaml
match:
  intent: mutation
  requires:
    - name: validRiskBand
      condition: "command.payload.riskBand == 'LOW' || command.payload.riskBand == 'MED' || command.payload.riskBand == 'HIGH'"
      error_code: INVALID_RISK_BAND
      message: "riskBand must be LOW, MED, or HIGH"
  condition: "command.payload.riskBand != null"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable guard name for trace logs |
| `condition` | CEL string | yes | Boolean expression |
| `error_code` | string | no | Error code included in the 422 response body |
| `message` | string | no | Human-readable error message in the 422 body |

> ⚠️ `requires[]` guards run before `match.condition`. A failing guard terminates the entire evaluation — subsequent behaviors are never tried.

### `match.required_scopes` (Tier 2)

List of scope strings that the caller's actor must possess. Evaluated before `requires[]` and `condition`. See [Section 8](#8-actor-identity-and-rbac-tier-2) for the full RBAC semantics.

```yaml
match:
  intent: creation
  required_scopes: [admin, loan:write]
  condition: "true"
```

### `emit`

The event catalog key to emit when the behavior matches. The payload template for that event type is evaluated and the resulting domain event is staged in the Unit of Work.

```yaml
emit: LoanOpened
```

### `emit_when[]` (Tier 1)

Replaces the top-level `emit` string when conditional multi-event emission is needed. Each entry is evaluated in document order; those whose `when` condition is `true` emit their event. After each emit the shadow graph is updated, so later `when` expressions can reference state written by earlier events.

```yaml
emit_when:
  - when: "command.payload.amount < state.balance"
    emit: LoanRepaid
  - when: "command.payload.amount == state.balance"
    emit: LoanSettled
```

| Field | Type | Description |
|-------|------|-------------|
| `when` | CEL boolean | Evaluated against the current shadow graph state |
| `emit` | string | Event catalog key to stage if `when` is `true` |

> ⚠️ `emit` and `emit_when` are mutually exclusive within a single behavior entry. Providing both halts boot with `BOOT_ERR_DSL_SYNTAX`.

### `postcondition` (Tier 1)

A CEL invariant evaluated against the shadow graph **after** the behavior's events have been projected but **before** the Unit of Work commits. If it evaluates to `false`, the UoW is aborted and all staged events are discarded.

```yaml
postcondition: "state.balance >= 0"
```

A violated postcondition returns HTTP 500 with code `POSTCONDITION_VIOLATED`.

### `dispatch_commands[]`

Secondary commands queued for execution within the same Unit of Work. Each secondary command is routed to another boundary (or the same boundary) and executed recursively before the UoW commits.

```yaml
dispatch_commands:
  - boundary: Customer
    intent: mutation
    target_id: "command.payload.customerId"
    payload:
      loanId: "command.targetId"
    condition: "command.payload.customerId != null"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `boundary` | string | yes | Target boundary logical name |
| `intent` | string | yes | `creation`, `mutation`, or `query` |
| `target_id` | CEL string | yes | CEL expression resolving to the target aggregate ID |
| `payload` | `map<string, CEL>` | no | Payload fields (each value is a CEL expression) |
| `condition` | CEL boolean | no | When present and `false`, this entry is silently skipped (Tier 1) |

Secondary commands execute inside the same UoW. All events (primary and secondary) are appended atomically when the UoW commits. The maximum recursion depth is 5 (`max_uow_depth`); exceeding it aborts with HTTP 508 `INFINITE_LOOP_DETECTED`.

### Execution order (the §5.1 algorithm)

1. Filter behaviors by `match.intent` (skip mismatches immediately).
2. Evaluate `match.required_scopes` — throw 401/403 on failure.
3. Evaluate `match.requires[]` in document order — throw 422 on first failure.
4. Evaluate `match.condition` — skip (continue to next behavior) on `false`.
5. Resolve aggregate ID (generate if `creation`).
6. If `emit` is present: evaluate payload template, stage event, project to shadow graph.
7. For each `emit_when[]` entry: evaluate `when` against updated shadow, stage + project if `true`.
8. Evaluate `postcondition` against shadow — abort UoW on `false`.
9. Evaluate and queue `dispatch_commands[]` — skip entries whose `condition` is `false`.
10. Return the matched outcome; the UoW commits all staged events atomically.

---

## 5. Reducers

Reducers project domain events onto aggregate state. Each reducer subscribes to one event type and declares `assign` and/or `append` operations.

```yaml
reducers:
  - on: LoanOpened
    assign:
      id: "event.payload.id"
      customerId: "event.payload.customerId"
      principal: "event.payload.principal"
      balance: "0"
      status: "'DRAFT'"
      transactions: "[]"
  - on: LoanDisbursed
    assign:
      balance: "state.balance + event.payload.amount"
      status: "'ACTIVE'"
    append:
      transactions: "{'txId': event.payload.txId, 'kind': 'DISBURSEMENT', 'amount': event.payload.amount, 'at': event.payload.at}"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `on` | string | yes | Event catalog key to subscribe to |
| `assign` | `map<string, CEL>` | no | Dot-path keys mapped to CEL expressions. Overwrites the field at that path. |
| `append` | `map<string, CEL>` | no | Dot-path keys mapped to CEL expressions. The evaluated value is pushed onto the array at that path. |

### CEL context in reducers

| Variable | Description |
|----------|-------------|
| `event` | The domain event being projected (includes `event.payload`, `event.type`, `event.aggregateId`, `event.sequenceVersion`) |
| `state` | The current state of the aggregate (before this reducer runs) |
| `payload` | Alias for `event.payload` |

### Phase ban: reducer determinism

Reducers **must not** use non-deterministic functions. The following are banned in the reducer phase and will throw `CEL_PHASE_BANNED` at runtime:

- `$uuidv7()` / `$now()` / `now()` / `timestamp()`

The `ts:` script sentinel is also banned in reducer fields at boot time (`BOOT_ERR_DSL_SYNTAX` / `BOOT_ERR_SCRIPT_IN_REDUCER`).

This restriction preserves event-sourcing determinism: replaying the event log from epoch must always produce identical state.

### Dot-path notation

Both `assign` and `append` keys support dot-path notation to address nested fields:

```yaml
assign:
  address.city: "event.payload.city"
  transactions[0].amount: "event.payload.amount"
```

The projection engine (`src/engine/projection.ts`) initialises missing intermediate objects/arrays automatically.

---

## 6. Sagas (Tier 2)

Sagas coordinate multi-step workflows spanning multiple boundaries. They execute **after** the primary Unit of Work commits (post-commit model), so the triggering event is durable before any saga step runs.

Sagas are declared in the **global config file** (not inside a boundary file).

```yaml
sagas:
  - name: LoanApproval
    trigger:
      boundary: LoanAccount
      intent: creation
      condition: "command.payload.principal > 50000"
    steps:
      - name: reserveCredit
        boundary: CreditBureau
        intent: mutation
        target_id: "command.payload.customerId"
        payload:
          amount: "command.payload.principal"
        compensation:
          intent: mutation
          target_id: "command.payload.customerId"
          payload:
            release: "command.payload.principal"
      - name: notifyRiskTeam
        boundary: Notification
        intent: creation
        payload:
          subject: "'Large loan approval required'"
          loanId: "command.targetId"
```

### DSL schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique saga name |
| `trigger.boundary` | string | yes | Boundary whose committed event triggers the saga |
| `trigger.intent` | string | yes | Command intent that triggers (`creation`, `mutation`, `query`) |
| `trigger.condition` | CEL boolean | yes | Evaluated against command and event context; `false` suppresses the saga |
| `steps[].name` | string | yes | Step name for trace logging |
| `steps[].boundary` | string | yes | Target boundary for the step command |
| `steps[].intent` | string | yes | Command intent for the step |
| `steps[].target_id` | CEL string | no | Resolves to the target aggregate ID |
| `steps[].payload` | `map<string, CEL>` | no | Payload fields (each value is a CEL expression) |
| `steps[].compensation` | object | no | Compensation command dispatched on step failure |
| `steps[].compensation.intent` | string | yes | Intent for the compensation command |
| `steps[].compensation.target_id` | CEL string | no | Target ID for the compensation command |
| `steps[].compensation.payload` | `map<string, CEL>` | no | Payload for compensation |

### Post-commit lifecycle

```
Primary UoW commits
       |
  SagaStarted  (recorded under __saga__ boundary)
       |
  [step 0 executes]
       |-- success --> SagaStepCompleted
       |-- failure --> SagaStepFailed
                          |
                     [compensate steps N-1..0 in reverse]
                          |-- success --> SagaCompensated
                          |-- failure --> SagaCompensationFailed (chain continues)
                          |
                      SagaFailed
       |
  [step 1..N]
       |
  SagaCompleted
```

All lifecycle events are stored under the `__saga__` boundary with the saga instance ID as `aggregateId`. Compensation failures do **not** abort the compensation chain — all compensations are attempted even if individual ones fail.

See `src/sagas/orchestrator.ts` for the implementation.

---

## 7. Idempotency (Tier 2)

Idempotency ensures that a command with a client-supplied `Idempotency-Key` header is executed at most once within a TTL window. Declared in the global config file.

```yaml
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable idempotency checking |
| `ttl_seconds` | `86400` | Expiry window in seconds for stored entries |
| `hash_includes_body` | `true` | Include request body in the deduplication hash |

### HTTP behaviour

- Include `Idempotency-Key: <client-key>` in any non-GET request.
- On a cache hit with matching hash: response is returned unchanged with `X-Idempotency-Replay: true`.
- On a cache hit with **different** body (when `hash_includes_body: true`): HTTP 409 with code `IDEMPOTENCY_KEY_CONFLICT`.

The deduplication hash is:

```
SHA-256( METHOD + "\n" + PATH + "\n" + idempotencyKey [+ "\n" + body] )
```

See `src/idempotency/store.ts` for the store implementation.

> ⚠️ Idempotency checking applies only to non-query (non-GET) operations.

---

## 8. Actor identity and RBAC (Tier 2)

The engine supports a lightweight simulation of bearer-token authentication. No signature verification is performed — this is a simulation shortcut for testing role-based scenarios.

### Token format

```
Authorization: Bearer <actorId>:<scope1>,<scope2>,...
```

Example: `Authorization: Bearer alice:admin,loan:write`

The engine parses this into an `actor` object attached to the command envelope:

```typescript
{ id: "alice", scopes: ["admin", "loan:write"] }
```

> ⚠️ This format is a simulation shortcut only. It is not suitable for production use. No cryptographic verification is performed.

### `match.required_scopes`

Declared on individual behaviors. All listed scopes must be present in the actor's scope set (superset check).

```yaml
behaviors:
  - name: approveLoan
    match:
      intent: mutation
      required_scopes: [admin, loan:approve]
      condition: "true"
    emit: LoanApproved
```

### Error semantics

| Condition | Error class | HTTP status | Code |
|-----------|-------------|-------------|------|
| `required_scopes` declared, no actor | `AuthenticationRequiredError` | 401 | `AUTH_MISSING` |
| Actor present, scopes insufficient | `AuthorizationDeniedError` | 403 | `AUTH_INSUFFICIENT_SCOPES` |

See `src/identity/scopeChecker.ts` for the implementation.

---

## 9. Derived projections (Tier 2)

Derived projections aggregate events from multiple boundaries into a separate read model, exposed via an admin endpoint. Declared in the global config file.

```yaml
derived_projections:
  - name: CustomerSummary
    key: "event.aggregateId"
    subscribe:
      - Customer:CustomerRegistered
      - LoanAccount:LoanOpened
    reduce:
      - on: CustomerRegistered
        assign:
          customer_id: "event.aggregateId"
          name: "event.payload.name"
          total_loans: "0"
      - on: LoanOpened
        assign:
          total_loans: "coalesce(state.total_loans, 0) + 1"
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique projection name |
| `key` | yes | CEL expression returning the string key for the derived entity |
| `subscribe[]` | yes | Event subscriptions as `<Boundary>:<EventType>` or bare `<EventType>` |
| `reduce[].on` | yes | Event type this reduce rule handles |
| `reduce[].assign` | no | Dot-path → CEL assignments |
| `reduce[].append` | no | Dot-path → CEL array appends |

### `key` expression

The `key` CEL expression is evaluated against the event context and must return a string. This string becomes the map key for the derived entity within the projection's state. If the expression returns a non-string or throws, the event is silently skipped (logged as WARN).

### Admin endpoint

```
GET /_admin/derived/:name
```

Returns the full derived state map as JSON:

```json
{
  "cust-001": { "customer_id": "cust-001", "name": "Acme", "total_loans": 3 },
  "cust-002": { "customer_id": "cust-002", "name": "Beta", "total_loans": 1 }
}
```

Returns HTTP 404 if the projection name does not exist.

See `src/projections/engine.ts` for the implementation.

---

## 10. Inline TypeScript scripts (Tier 1)

When CEL is not expressive enough for a particular computation, you may declare named TypeScript modules in the `scripts[]` block and reference them with a `ts:<name>` sentinel anywhere a CEL expression is accepted.

### Declaration

```yaml
scripts:
  - name: computeRiskScore
    code: |
      export default function(ctx) {
        const utilisation = ctx.state.balance / ctx.state.creditLimit;
        return Math.round(utilisation * ctx.command.payload.riskMultiplier * 100);
      }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier within the boundary. Referenced as `ts:<name>`. |
| `code` | string | yes | TypeScript source. Must have a default-exported function. |

### `ts:` sentinel

Use `ts:<name>` in place of a CEL expression string:

```yaml
event_catalog:
  - type: RiskAssessmentCreated
    payload_template:
      score: "ts:computeRiskScore"
```

The sentinel is permitted in:

- `behaviors[].match.condition`
- `behaviors[].match.requires[].condition`
- `event_catalog[].payload_template` field values
- `behaviors[].postcondition`
- `dispatch_commands[].condition`
- `behaviors[].emit_when[].when`

> ⚠️ The `ts:` sentinel is **banned** in all reducer-phase fields (`reducers[].assign`, `reducers[].append`). Presence halts boot with `BOOT_ERR_DSL_SYNTAX`.

### Boot-time compilation

At boot, each `scripts[].code` is transpiled from TypeScript to JavaScript using `esbuild.transformSync`. This is transpile-only — no TypeScript type-checking is performed. The compiled JavaScript is cached in the execution matrix.

- Syntax error → `BOOT_ERR_SCRIPT_SYNTAX` (boot halt)
- `ts:` sentinel referencing unknown script → `BOOT_ERR_DSL_SYNTAX` (boot halt)

### Runtime execution

Scripts run inside a `node:vm` sandbox with a stripped context:

```
Allowed: console.log (no-op), ScriptContext argument
Blocked: fs, net, process, require, __dirname, global
```

CPU timeout: **50 ms** per invocation (configurable at boundary level). Exceeding it returns HTTP 500 `SCRIPT_TIMEOUT`.

### ScriptContext shape

Every script receives a single `ctx` argument of the following shape (see `src/scripts/types.ts`):

| Property | Available phases | Description |
|----------|-----------------|-------------|
| `ctx.command` | All | Full command envelope (`intent`, `targetId`, `payload`, `path`, `commandId`, `actor`) |
| `ctx.state` | All | Current shadow-graph state for the aggregate (or `null` for new entities) |
| `ctx.event` | EventHydration | Domain event being hydrated (only in `payload_template` scripts) |
| `ctx.payload` | EventHydration | Partially materialized event payload |
| `ctx.helpers.uuid()` | Behavior, EventHydration | Generates a UUIDv7 |
| `ctx.helpers.now()` | Behavior, EventHydration | Returns current UTC ISO-8601 timestamp |
| `ctx.helpers.deepClone(v)` | All | Deep clones a value |
| `ctx.helpers.deepMerge(a, b)` | All | Deep merges two objects |
| `ctx.logger` | All | Scoped pino child-logger |

### Failure semantics

| Condition | Code | HTTP status |
|-----------|------|-------------|
| `esbuild.transformSync` fails | `BOOT_ERR_SCRIPT_SYNTAX` | boot halt |
| `ts:<name>` references unknown script | `BOOT_ERR_DSL_SYNTAX` | boot halt |
| `ts:` in reducer-phase field | `BOOT_ERR_DSL_SYNTAX` | boot halt |
| Script CPU timeout (50 ms) | `SCRIPT_TIMEOUT` | 500 |
| Script throws unhandled exception | `INTERNAL_EXECUTION_FAILURE` | 500 |

---

## 11. Initialization data

The `initialization` array seeds baseline state at boot. Each entry is an arbitrary JSON object representing one aggregate entity.

```yaml
initialization:
  - id: "00000000-0000-7000-8000-000000000001"
    name: "Acme Coffee Ltd"
    riskBand: LOW
    createdAt: "1970-01-01T00:00:00.000Z"
    loanIds: []
```

Each entry is translated into a `BaselineEntityCreatedEvent` whose payload is the entry object. These events are appended to the event log and projected via the normal projection engine. The aggregate ID is taken from the `id` field of the entry.

### Deterministic reset

Baseline events are assigned **static UUIDv7s anchored at Unix epoch 0**, making the post-reset state mathematically identical to the boot state. The `FrozenBaseline` array is kept in memory and replayed verbatim on `POST /_admin/reset` — the engine never re-evaluates initialization records at runtime.

This is the mechanism that ensures `GET /customers` returns the same seed data after a reset as it does after cold boot.

---

## 12. Error reference

### Boot-time errors (`BOOT_ERR_*`)

| Code | Cause |
|------|-------|
| `BOOT_ERR_DSL_SYNTAX` | YAML parse failure, invalid field type, `emit` + `emit_when` co-presence, `ts:` in reducer, malformed CEL expression |
| `BOOT_ERR_DSL_REFERENCE` | `emit` or `on` references an event type not in `event_catalog` |
| `BOOT_ERR_DSL_SCHEMA_VIOLATION` | `assign`/`append` path references unknown field in OpenAPI schema; `schema_ref` cannot be resolved |
| `BOOT_ERR_DSL_EMIT_REQUIRED` | Behavior has neither `emit` nor `emit_when` |
| `BOOT_ERR_SCRIPT_SYNTAX` | `esbuild.transformSync` failed for a `scripts[]` entry |
| `BOOT_ERR_SCRIPT_IN_REDUCER` | `ts:` sentinel found in `reducers[].assign` or `reducers[].append` |

### Runtime errors

| Code | HTTP | Cause |
|------|------|-------|
| `ENTITY_ABSENT` | 404 | Mutation command targeting non-existent aggregate |
| `ENTITY_CONFLICT` | 409 | Creation command for already-existing aggregate |
| `UnhandledOperationError` | 422 | No matching behavior and no fallback; also returned when `requires[]` guard fails |
| `PRECONDITION_FAILED` | 428 | `If-Match` header required but missing |
| `CONCURRENCY_CONFLICT` | 412 | `If-Match` sequence version mismatch |
| `POSTCONDITION_VIOLATED` | 500 | `postcondition` expression evaluated to `false` |
| `SCHEMA_TYPE_MISMATCH` | 500 | `assign`/`append` value violates OpenAPI schema; event payload violates `schema_ref` |
| `INTERNAL_EXECUTION_FAILURE` | 500 | Uncaught exception in CEL or script during UoW |
| `SCRIPT_TIMEOUT` | 500 | Inline TypeScript script exceeded 50 ms CPU budget |
| `AUTH_MISSING` | 401 | `required_scopes` declared, but no `Authorization` header present |
| `AUTH_INSUFFICIENT_SCOPES` | 403 | Actor present but scopes are not a superset of `required_scopes` |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Idempotency key reused with a different request body |
| `INFINITE_LOOP_DETECTED` | 508 | Secondary command recursion exceeded `max_uow_depth = 5` |
| `CEL_PHASE_BANNED` | 500 | Non-deterministic function called in reducer phase |

---

## 13. Complete worked example

This example uses both boundary files from `docs/_examples/dsl/` and the global config to walk through a realistic loan-opening scenario.

### The boundaries

**Customer** (`docs/_examples/dsl/customer.yaml`): Manages customer profiles. `fallback_override: true` so GET requests work without explicit query behaviors.

**LoanAccount** (`docs/_examples/dsl/loan-account.yaml`): Manages loan accounts with three behaviors: `openLoan`, `disburse`, and `repay`. The `repay` behavior uses `emit_when` to emit either `LoanRepaid` or `LoanSettled` based on remaining balance.

### Request trace: `POST /loans`

Payload:

```json
{ "customerId": "00000000-0000-7000-8000-000000000001", "principal": 10000 }
```

1. **Contract Gateway** validates the payload against the OpenAPI spec.
2. **Command Router** translates to a `creation` command for the `LoanAccount` boundary. A new UUIDv7 is generated as `targetId` (via `identity.creation.generate`).
3. **Pattern Matcher** iterates `LoanAccount.behaviors`:
   - `openLoan`: intent matches `creation`, `command.payload.principal > 0` → `true`. Match!
4. **Event hydration**: `LoanOpened` payload template evaluated — `id`, `customerId`, `principal`, `openedAt` populated.
5. **Shadow projection**: `LoanOpened` projected into shadow graph. Loan state now has `balance: 0, status: 'DRAFT'`.
6. **Secondary command**: `dispatch_commands` queues a `mutation` command to `Customer` with `target_id = "00000000-0000-7000-8000-000000000001"` and `payload.loanId = <new-loan-id>`.
7. **Secondary execution**: `Customer.attachLoan` behavior matches, emits `LoanAttachedToCustomer`.
8. **UoW commit**: Both events (`LoanOpened`, `LoanAttachedToCustomer`) are appended atomically to the event log.
9. **Global projection**: Both events projected to global state graph. Customer's `loanIds` array now includes the new loan ID.
10. **Response**: HTTP 201 with the new loan entity.

### Request trace: `POST /loans/<id>/repay` (full repayment)

Payload: `{ "amount": 10000 }` (equal to `state.balance`)

1. Pattern matcher evaluates `repay` behavior — `command.payload.amount <= state.balance` → `true`.
2. `emit_when` evaluates:
   - Entry 1: `command.payload.amount < state.balance` → `10000 < 10000` → `false`. Skip.
   - Entry 2: `command.payload.amount == state.balance` → `true`. Emit `LoanSettled`.
3. `LoanSettled` reducer sets `balance: 0, status: 'SETTLED'`.

### Testing the fixture (jest + supertest)

```typescript
import request from 'supertest';
import { buildApp } from '../src/app.js';

describe('LoanAccount boundary', () => {
  let app: Express;

  beforeEach(async () => {
    app = await buildApp({ dslDir: 'docs/_examples/dsl' });
    await request(app).post('/_admin/reset').expect(204);
  });

  it('opens a loan and attaches it to the customer', async () => {
    const res = await request(app)
      .post('/loans')
      .send({ customerId: '00000000-0000-7000-8000-000000000001', principal: 5000 })
      .expect(201);

    const loanId = res.body.id;

    const customer = await request(app)
      .get('/customers/00000000-0000-7000-8000-000000000001')
      .expect(200);

    expect(customer.body.loanIds).toContain(loanId);
  });

  it('settles a loan when the repayment equals the balance', async () => {
    const loanRes = await request(app)
      .post('/loans')
      .send({ customerId: '00000000-0000-7000-8000-000000000001', principal: 1000 })
      .expect(201);

    const id = loanRes.body.id;

    await request(app)
      .post(`/loans/${id}/disburse`)
      .send({ amount: 1000 })
      .expect(200);

    await request(app)
      .post(`/loans/${id}/repay`)
      .send({ amount: 1000 })
      .expect(200);

    const loan = await request(app).get(`/loans/${id}`).expect(200);
    expect(loan.body.status).toBe('SETTLED');
    expect(loan.body.balance).toBe(0);
  });
});
```

---

## 14. Advanced patterns and idioms

### Cross-boundary aggregation

Use `dispatch_commands` to push state references between boundaries when one aggregate needs to know about another. In the loan example, `openLoan` dispatches to `Customer` to attach the loan ID. This keeps each boundary authoritative over its own state while still linking related entities.

For **read-side aggregation** without mutations, use derived projections (Section 9). Derived projections subscribe to events from multiple boundaries and maintain a separate read model — they do not interfere with the primary state graph.

### Multi-step approval chains (sagas)

For workflows requiring coordination across more than two boundaries — such as credit reservation, regulatory notification, and ledger posting — declare a saga (Section 6). The post-commit model means the primary transaction is always durable; saga compensation is always a genuine compensating transaction, never a rollback.

```yaml
sagas:
  - name: LoanApproval
    trigger:
      boundary: LoanAccount
      intent: creation
      condition: "command.payload.principal > 50000"
    steps:
      - name: reserveCredit
        boundary: CreditBureau
        intent: mutation
        target_id: "command.payload.customerId"
        payload:
          amount: "command.payload.principal"
        compensation:
          intent: mutation
          target_id: "command.payload.customerId"
          payload:
            release: "command.payload.principal"
```

### Tag-based filtering via `query_mapping`

```yaml
query_mapping:
  status: "state.status == query.status"
  riskBand: "state.riskBand == query.riskBand"
  minPrincipal: "state.principal >= int(query.minPrincipal)"
```

Multiple filter parameters compose as AND: `GET /loans?status=ACTIVE&minPrincipal=5000` returns only active loans with principal ≥ 5 000. Type-coercion functions from CEL (`int()`, `double()`) are useful here since query parameters arrive as strings.

### Derived KPIs via `derived_projections`

Cross-boundary metrics that would otherwise require joining two state graphs in application code can be materialised as derived projections:

```yaml
derived_projections:
  - name: CustomerSummary
    key: "event.aggregateId"
    subscribe:
      - Customer:CustomerRegistered
      - LoanAccount:LoanOpened
    reduce:
      - on: CustomerRegistered
        assign:
          name: "event.payload.name"
          total_loans: "0"
      - on: LoanOpened
        assign:
          total_loans: "coalesce(state.total_loans, 0) + 1"
```

Poll `GET /_admin/derived/CustomerSummary` to retrieve the aggregated map.

### Long-running scripts (caution)

The 50 ms script timeout is a hard ceiling. Scripts that iterate large arrays or perform complex numeric derivations can exceed it easily. If a computation is too slow:

1. Pre-compute and store partial results in aggregate state via reducers.
2. Simplify the logic in CEL (which is typically faster for straightforward expressions).
3. Consider whether the computation belongs in application code rather than the simulation layer.

### Avoiding common pitfalls

**Reducer phase ban**: Do not call `$now()`, `$uuidv7()`, or `now()` in `assign`/`append` expressions. Use `event.payload.someTimestamp` instead, computed during event hydration.

**Secondary command `target_id` resolution**: The `target_id` expression is evaluated against the post-projection shadow graph. If the primary event modifies state that `target_id` depends on, the projection happens first. Verify the expression against the expected shadow state.

**Staleness with `If-Match`**: If you omit `If-Match` on mutation requests and concurrency validation is required by the contract, the engine returns HTTP 428 `PRECONDITION_REQUIRED`. Always send the `sequenceVersion` from a prior GET response.

**`emit` + `emit_when` co-presence**: Including both fields in the same behavior entry halts boot with `BOOT_ERR_DSL_SYNTAX`. Use `emit_when` alone when conditional multi-emit is needed.

---

## 15. Schema and type checklist

### snake_case → camelCase field map (YAML → TypeScript)

| YAML key | TypeScript field | Notes |
|----------|-----------------|-------|
| `contract_path` | `contractPath` | |
| `fallback_override` | `fallbackOverride` | |
| `event_catalog` | `eventCatalog` | |
| `payload_template` | `payloadTemplate` | |
| `schema_ref` | `schemaRef` | |
| `query_mapping` | `queryMapping` | |
| `dispatch_commands` | `dispatchCommands` | |
| `target_id` | `targetId` | |
| `emit_when` | `emitWhen` | |
| `required_scopes` | `requiredScopes` | |
| `error_code` | `errorCode` | |
| `error_message` | `errorMessage` | |
| `ttl_seconds` | `ttlSeconds` | |
| `hash_includes_body` | `hashIncludesBody` | |
| `derived_projections` | `derivedProjections` | |

The schema validator (`src/dsl/schema.ts`) accepts both `snake_case` and `camelCase` for some fields (e.g. `error_code`/`errorCode`). Use `snake_case` in YAML files for consistency.

### Required vs optional fields summary

**Boundary config (required):**
- `boundary`
- `contract_path`

**Boundary config (optional, default noted):**
- `fallback_override` (default `false`)
- `identity`
- `query_mapping`
- `event_catalog` (default `[]`)
- `behaviors` (default `[]`)
- `reducers` (default `[]`)
- `initialization` (default absent)
- `scripts` (default absent)

**Behavior `match` (required):**
- `intent`
- `condition`

**Behavior (required — one of):**
- `emit` OR `emit_when`

**Event catalog entry (required):**
- `type`
- `payload_template`

**Reducer rule (required):**
- `on`

---

## 16. Static checks performed at boot

The boot sequence performs the following validation steps in order:

1. **YAML parse** — Each file must be a valid YAML mapping. Arrays, scalars at root, or null documents halt with `BOOT_ERR_DSL_SYNTAX`.

2. **Schema validation** (`src/dsl/schema.ts`) — Required fields present, correct types, `emit`/`emit_when` mutual exclusion, `ts:` sentinel format validation (`[A-Za-z_][A-Za-z0-9_]*` after prefix).

3. **CEL pre-compilation** — All CEL expressions in `match.condition`, `match.requires[].condition`, `postcondition`, `emit_when[].when`, `dispatch_commands[].condition`, and `payload_template` field values are compiled with `celEvaluator.compile()`. Parse errors produce `BOOT_ERR_DSL_SYNTAX`.

4. **Cross-reference validation** — Every `emit` value and every `on` value must match an event type key in the boundary's `event_catalog`. `ts:` sentinels must resolve to a `scripts[].name` in the same boundary. Failures produce `BOOT_ERR_DSL_REFERENCE`.

5. **Reducer phase check** — `ts:` sentinels in `reducers[].assign` or `reducers[].append` produce `BOOT_ERR_SCRIPT_IN_REDUCER`.

6. **Contract binding** — `contract_path` values are validated against the loaded OpenAPI document. `schema_ref` values are resolved against `#/components/schemas/`. Failures produce `BOOT_ERR_DSL_SCHEMA_VIOLATION`.

7. **Object-Graph Schema Registry** — `assign`/`append` dot-paths are validated against the entity schema derived from the OpenAPI components. Unknown paths produce `BOOT_ERR_DSL_SCHEMA_VIOLATION`.

8. **Script transpilation** — `scripts[].code` entries are transpiled via `esbuild.transformSync`. Syntax failures produce `BOOT_ERR_SCRIPT_SYNTAX`.

9. **Initialization ingestion** — Seed records are projected into the initial state graph. Projection errors abort boot.

---

## 17. Limits and quotas

| Limit | Value | Error on breach |
|-------|-------|----------------|
| `max_uow_depth` | 5 levels of secondary command recursion | HTTP 508 `INFINITE_LOOP_DETECTED` |
| Script CPU timeout | 50 ms per invocation | HTTP 500 `SCRIPT_TIMEOUT` |
| Pattern-match priority | First-match-wins, source document order | n/a |
| Reducer determinism | `$uuidv7`/`$now`/`now`/`timestamp` banned | `CEL_PHASE_BANNED` |
| `emit` + `emit_when` co-presence | Mutually exclusive | `BOOT_ERR_DSL_SYNTAX` (boot halt) |
| Script name characters | `[A-Za-z_][A-Za-z0-9_]*` | `BOOT_ERR_DSL_SYNTAX` (boot halt) |

### Legacy field names

The schema validator accepts the following legacy field name aliases for backward compatibility. They parse identically to the canonical names but emit a `DEBUG`-level log at boot time: `DSL: deprecated field 'X', use 'Y' instead`.

| Canonical (preferred) | Legacy (accepted) | Location |
|---|---|---|
| `scripts[].code` | `scripts[].source` | `scripts[]` block |
| `requires[].condition` | `requires[].expression` | `match.requires[]` block |
| `postcondition: "<expr>"` | `postcondition: {expression: "<expr>"}` | `behaviors[]` |

New DSL files should use the canonical names. Legacy names will continue to be accepted indefinitely but may be removed in a future major version.

### Reducer determinism guarantee

The event log is an immutable, append-only record. The current state graph can be rebuilt at any time by replaying events through reducers. This guarantee holds only if reducers are pure functions of `event` and `state` — which is why `$uuidv7()`, `$now()`, and `ts:` scripts are banned in the reducer phase.

### First-match-wins semantics

Behaviors are evaluated in the order they appear in the YAML file. The engine stops at the first behavior whose `requires[]` guards pass and whose `condition` evaluates to `true`. To ensure predictable matching:

- Place more specific conditions before more general ones.
- Use `requires[]` guards for domain invariants that should always be checked, regardless of which behavior would otherwise match.
- Be aware that a `requires[]` failure terminates the evaluation entirely; it does not fall through.
