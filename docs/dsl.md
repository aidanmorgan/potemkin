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
  lead.yaml            # Lead boundary
  opportunity.yaml     # Opportunity boundary
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
| `boundary` | `boundary` | `string` | yes | Logical namespace for this aggregate (e.g. `Opportunity`). Used in event routing and cross-boundary dispatch. |
| `contract_path` | `contractPath` | `string` | yes | The OpenAPI route this boundary handles (e.g. `/opportunities`). |
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
  status: "state.status == query.status"
  campaignId: "state.assignedCampaignId == query.campaignId"
```

A `GET /leads?status=NEW` request returns only entities where `state.status == "NEW"`.

---

## 3. Event catalog

The `event_catalog` block declares the named event types that behaviors may emit. Each entry defines a type key and a payload template.

```yaml
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
      companyName: "command.payload.companyName"
      contactName: "command.payload.contactName"
      score: "ts:computeScore"
      createdAt: "$now()"
  - type: LeadConverted
    schema_ref: "#/components/schemas/LeadCreated"
    payload_template:
      convertedAt: "$now()"
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
  - name: createLead
    match:
      operationId: createLead
      condition: "true"
    emit: LeadCreated
    dispatch_commands:
      - boundary: Campaign
        intent: mutation
        operationId: getCampaign
        target_id: "command.payload.assignedCampaignId"
        payload:
          leadSource: "command.payload.source"
        condition: "command.payload?.assignedCampaignId != null"
```

### `match.operationId`

The OpenAPI `operationId` that this behavior handles (e.g. `createLead`, `qualifyLead`). Behaviors whose `operationId` does not match the incoming operation are skipped without evaluating `condition`. This field is **required** — omitting it halts boot with `BOOT_ERR_MISSING_OPERATION_ID`.

> ⚠️ `match.intent` is removed. Using it halts boot with `BOOT_ERR_REMOVED_SYNTAX`. Replace all `intent:` fields in `match` blocks with `operationId:` pointing to the OpenAPI operationId.

### `match.condition`

A CEL boolean expression evaluated against the command and current shadow-graph state. When `true`, the behavior is selected. The CEL context variables are `command`, `state`, and `payload` (alias for `command.payload`).

```yaml
condition: "command.path == $concat('/leads/', command.targetId, '/qualify') && state.status == 'CONTACTED'"
```

See [CEL — see docs/cel.md](./cel.md) for the full expression language reference.

### `match.requires[]` (Tier 1)

Named guard conditions evaluated **before** `match.condition`. If any guard evaluates to `false`, the engine immediately returns HTTP 422 with the guard's message — it does **not** fall through to the next behavior. This is distinct from `condition` (which simply skips the rule on false).

```yaml
match:
  operationId: contactLead
  requires:
    - name: not-dnc
      condition: "state.status != 'DNC'"
      error_code: LEAD_IS_DNC
      error_message: "Cannot contact a lead that has been marked Do Not Call"
    - name: not-converted
      condition: "state.status != 'CONVERTED'"
      error_code: LEAD_ALREADY_CONVERTED
      error_message: "Cannot contact a lead that has already been converted"
  condition: "$concat('/leads/', command.targetId, '/contact') == command.path"
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
  operationId: createLead
  required_scopes:
    - admin
    - "lead:write"
  condition: "true"
```

### `emit`

The event catalog key to emit when the behavior matches. The payload template for that event type is evaluated and the resulting domain event is staged in the Unit of Work.

```yaml
emit: LeadCreated
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
  - boundary: Lead
    intent: mutation
    operationId: patchLead
    target_id: "command.payload.leadId"
    payload:
      opportunityId: "command.targetId"
    condition: "command.payload.leadId != null"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `boundary` | string | yes | Target boundary logical name |
| `intent` | string | yes | `creation`, `mutation`, or `query` |
| `operationId` | string | yes | OpenAPI operationId for the secondary command |
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

Reducers project domain events onto aggregate state. Each reducer subscribes to one event type and declares a list of `patches` — RFC 6902 JSON-Patch operations extended with a few Potemkin-specific ops. (The legacy `assign:` / `append:` map form was removed; using either now halts boot with `BOOT_ERR_REMOVED_SYNTAX`.)

```yaml
reducers:
  - on: LeadCreated
    patches:
      - op: add
        path: /id
        value: "${event.payload.id}"
      - op: add
        path: /companyName
        value: "${event.payload.companyName}"
      - op: add
        path: /status
        value: "${'NEW'}"
      - op: add
        path: /callIds
        value: "${[]}"
  - on: LeadContacted
    patches:
      - op: replace
        path: /status
        value: "${'CONTACTED'}"
      - op: append            # push onto the array at /callIds
        path: /callIds
        value: "${event.payload.callId}"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `on` | string | yes | Event catalog key to subscribe to |
| `patches` | `Patch[]` | yes | Ordered list of patch operations applied in sequence |

Each patch has `op`, `path` (a JSON Pointer like `/status` or `/address/city`), and — for value-bearing ops — `value`.

**Patch `op` vocabulary** (see `src/dsl/patches.ts`):

| `op` | Effect |
|------|--------|
| `add` | Set the field (creating it), or insert into an array at the pointer index |
| `replace` | Overwrite an existing field |
| `remove` | Delete the field |
| `append` / `prepend` | Push `value` onto the end / front of the array at `path` |
| `increment` | Add the numeric `value` (default `1`) to the number at `path` |
| `merge` | Shallow-merge the object `value` into the object at `path` |
| `upsert` | Insert-or-replace an array element matched by a key field |
| `copy` / `move` | Copy/move from a `from` pointer to `path` |

**`value` interpolation:** a bare string is a **literal**; only `${...}` is evaluated as CEL (with type preservation — `value: "${0}"` is the number `0`, `value: "ACTIVE"` is the string `"ACTIVE"`). This is why the examples above wrap CEL in `${…}` (e.g. `"${event.payload.id}"`, `"${'NEW'}"`, `"${[]}"`).

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

### JSON Pointer paths

Patch `path` values are JSON Pointers (`/segment/segment`) and can address nested fields and array indices:

```yaml
patches:
  - op: replace
    path: /address/city
    value: "${event.payload.city}"
  - op: replace
    path: /transactions/0/amount
    value: "${event.payload.amount}"
```

The projection engine (`src/engine/projection.ts`) auto-vivifies missing intermediate objects/arrays.

---

## 6. Sagas (Tier 2)

Sagas coordinate multi-step workflows spanning multiple boundaries. They execute **after** the primary Unit of Work commits (post-commit model), so the triggering event is durable before any saga step runs.

Sagas are declared in the **global config file** (not inside a boundary file).

```yaml
sagas:
  - name: LeadConversion
    trigger:
      boundary: Lead
      intent: mutation
      condition: "$concat('/leads/', command.targetId, '/convert') == command.path"
    steps:
      - name: createOpportunity
        boundary: Opportunity
        intent: creation
        target_id: "$uuidv7()"
        payload:
          leadId: "command.targetId"
          value: "command.payload.value"
        compensation:
          intent: mutation
          target_id: "command.payload.opportunityId"
          payload:
            stage: "'withdrawn'"
      - name: notifySalesTeam
        boundary: Notification
        intent: creation
        payload:
          subject: "'New opportunity created'"
          leadId: "command.targetId"
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

Example: `Authorization: Bearer alice:admin,lead:write`

The engine parses this into an `actor` object attached to the command envelope:

```typescript
{ id: "alice", scopes: ["admin", "lead:write"] }
```

> ⚠️ This format is a simulation shortcut only. It is not suitable for production use. No cryptographic verification is performed.

### `match.required_scopes`

Declared on individual behaviors. All listed scopes must be present in the actor's scope set (superset check).

```yaml
behaviors:
  - name: markLeadDNC
    match:
      operationId: markLeadDNC
      required_scopes:
        - manager
      condition: "state.status != 'DNC'"
    emit: LeadMarkedDNC
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

Each `reduce` rule uses the same `patches:` vocabulary as boundary reducers (§5) — the legacy `assign:`/`append:` map form was removed here too.

```yaml
derived_projections:
  - name: LeadSummary
    key: "event.aggregateId"
    subscribe:
      - "Lead:LeadCreated"
      - "Opportunity:OpportunityCreated"
    reduce:
      - on: "Lead:LeadCreated"
        patches:
          - op: add
            path: /lead_id
            value: "${event.aggregateId}"
          - op: add
            path: /companyName
            value: "${event.payload.companyName}"
          - op: add
            path: /total_opportunities
            value: "${0}"
      - on: "Opportunity:OpportunityCreated"
        patches:
          - op: replace
            path: /total_opportunities
            value: "${coalesce(state.total_opportunities, 0) + 1}"
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique projection name |
| `key` | yes | CEL expression returning the string key for the derived entity |
| `subscribe[]` | yes | Event subscriptions as `<Boundary>:<EventType>` or bare `<EventType>` |
| `reduce[].on` | yes | Event subscription this reduce rule handles (`<Boundary>:<EventType>` or bare `<EventType>`) |
| `reduce[].patches` | yes | Ordered patch operations (same vocabulary as §5 reducers) |

### `key` expression

The `key` CEL expression is evaluated against the event context and must return a string. This string becomes the map key for the derived entity within the projection's state. If the expression returns a non-string or throws, the event is silently skipped (logged as WARN).

### Admin endpoint

```
GET /_admin/derived/:name
```

Returns the full derived state map as JSON:

```json
{
  "lead-001": { "lead_id": "lead-001", "companyName": "Apex Solutions", "total_opportunities": 3 },
  "lead-002": { "lead_id": "lead-002", "companyName": "Beta Corp", "total_opportunities": 1 }
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
  - name: computeScore
    code: |
      export default function(ctx) {
        const source = ctx.command.payload.source;
        const baseScore = { REFERRAL: 80, PARTNER: 70, WEBSITE: 50, COLD_LIST: 20 };
        return baseScore[source] ?? 30;
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
  - type: LeadCreated
    payload_template:
      score: "ts:computeScore"
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
  - id: "00000000-0000-7000-8000-000000000010"
    companyName: "Apex Solutions Ltd"
    contactName: "Jordan Walsh"
    phone: "+61 2 9000 0001"
    email: "jordan@apexsolutions.com"
    source: "WEBSITE"
    status: "NEW"
    score: 50
    createdAt: "1970-01-01T00:00:00.000Z"
    callIds: []
```

Each entry is translated into a `BaselineEntityCreatedEvent` whose payload is the entry object. These events are appended to the event log and projected via the normal projection engine. The aggregate ID is taken from the `id` field of the entry.

### Deterministic reset

Baseline events are assigned **static UUIDv7s anchored at Unix epoch 0**, making the post-reset state mathematically identical to the boot state. The `FrozenBaseline` array is kept in memory and replayed verbatim on `POST /_admin/reset` — the engine never re-evaluates initialization records at runtime.

This is the mechanism that ensures `GET /leads` returns the same seed data after a reset as it does after cold boot.

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
| `SCHEMA_TYPE_MISMATCH` | 500 | reducer `patches` value violates OpenAPI schema; event payload violates `schema_ref` |
| `INTERNAL_EXECUTION_FAILURE` | 500 | Uncaught exception in CEL or script during UoW |
| `SCRIPT_TIMEOUT` | 500 | Inline TypeScript script exceeded 50 ms CPU budget |
| `AUTH_MISSING` | 401 | `required_scopes` declared, but no `Authorization` header present |
| `AUTH_INSUFFICIENT_SCOPES` | 403 | Actor present but scopes are not a superset of `required_scopes` |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Idempotency key reused with a different request body |
| `INFINITE_LOOP_DETECTED` | 508 | Secondary command recursion exceeded `max_uow_depth = 5` |
| `REACTION_BUDGET_EXCEEDED` | 508 | Reaction fan-out exceeded the per-UoW event budget (see [Section 19](#19-reactions-choreography)) |
| `CEL_PHASE_BANNED` | 500 | Non-deterministic function called in reducer phase |

---

## 13. Complete worked example

This example uses both boundary files from `docs/_examples/dsl/` and the global config to walk through a realistic lead-to-opportunity conversion scenario in The Nuisance Bureau CRM.

### The boundaries

**Lead** (`docs/_examples/dsl/lead.yaml`): Manages CRM leads with lifecycle transitions (NEW → CONTACTED → QUALIFIED → CONVERTED). `fallback_override: true` so GET requests work without explicit query behaviors. Uses an inline TypeScript script for lead scoring.

**Opportunity** (`docs/_examples/dsl/opportunity.yaml`): Manages sales opportunities with three behaviors: `createOpportunity`, `advanceOpportunity`, and `closeWon`/`closeLost`. The `closeLost` behavior uses `emit_when` to emit `OpportunityLost` from either PROPOSED or NEGOTIATING stage.

### Request trace: `POST /leads` (create a new lead)

Payload:

```json
{ "companyName": "Apex Solutions Ltd", "contactName": "Jordan Walsh", "phone": "+61 2 9000 0001", "email": "jordan@apexsolutions.com", "source": "WEBSITE" }
```

1. **Contract Gateway** validates the payload against the OpenAPI spec.
2. **Command Router** translates to a `creation` command for the `Lead` boundary. A new UUIDv7 is generated as `targetId` (via `identity.creation.generate`).
3. **Pattern Matcher** iterates `Lead.behaviors`:
   - `createLead`: `match.operationId` matches the `createLead` operation, `condition` → `true`. Match!
4. **Event hydration**: `LeadCreated` payload template evaluated — `id`, `companyName`, `contactName`, `score` (via `ts:computeScore`) populated.
5. **Shadow projection**: `LeadCreated` projected into shadow graph. Lead state now has `status: 'NEW'`.
6. **UoW commit**: `LeadCreated` event appended atomically to the event log.
7. **Response**: HTTP 201 with the new lead entity.

### Request trace: `POST /opportunities/<id>/close` (close as LOST)

Payload: `{ "outcome": "LOST", "closureReason": "Budget constraints" }`

1. Pattern matcher evaluates `closeLost` behavior — `command.payload.outcome == 'LOST'` → `true`.
2. `emit_when` evaluates:
   - Entry 1: `state.stage == 'NEGOTIATING'` → depends on current stage.
   - Entry 2: `state.stage == 'PROPOSED'` → if true, emit `OpportunityLost`.
3. `OpportunityLost` reducer sets `stage: 'LOST'`, records `closedAt` and `closureReason`.

### Testing the fixture (jest + supertest)

There is no `buildApp` helper — the public API is `bootSystem` (boot the engine from compiled DSL + an OpenAPI doc) followed by `createGateway` (mount the Express app). Both are exported from `src/index.ts`:

```typescript
import request from 'supertest';
import { readFileSync } from 'node:fs';
import {
  parseDslYaml, compileDsl, loadOpenApi,
  bootSystem, createGateway, resetSystem,
} from '../src/index.js';

describe('Lead boundary', () => {
  let app: import('express').Express;
  let sys: Awaited<ReturnType<typeof bootSystem>>;

  beforeEach(async () => {
    // Compile the boundary + global YAML and load the OpenAPI contract.
    const modules = ['lead', 'opportunity'].map((n) =>
      parseDslYaml(readFileSync(`docs/_examples/dsl/${n}.yaml`, 'utf8'), `${n}.yaml`),
    );
    const globalYaml = readFileSync('docs/_examples/dsl/global.yaml', 'utf8');
    const compiledDsl = compileDsl(modules, globalYaml);
    const openapi = await loadOpenApi('docs/_examples/openapi.yaml');

    sys = await bootSystem({ openapi, compiledDsl });
    app = createGateway(sys);
  });

  afterEach(() => resetSystem(sys));

  it('creates a lead and scores it by source', async () => {
    const res = await request(app)
      .post('/leads')
      .send({ companyName: 'Apex Solutions', contactName: 'Jordan', phone: '+61 2 9000 0001', email: 'jordan@apex.com', source: 'REFERRAL' })
      .expect(201);

    expect(res.body.score).toBe(80); // REFERRAL score
    expect(res.body.status).toBe('NEW');
  });

  it('converts a qualified lead to an opportunity', async () => {
    const leadRes = await request(app)
      .post('/leads')
      .send({ companyName: 'Beta Corp', contactName: 'Alex', phone: '+61 2 9000 0002', email: 'alex@beta.com', source: 'WEBSITE' })
      .expect(201);

    const leadId = leadRes.body.id;

    await request(app)
      .post(`/leads/${leadId}/contact`)
      .expect(200);

    await request(app)
      .post(`/leads/${leadId}/qualify`)
      .expect(200);

    const oppRes = await request(app)
      .post(`/leads/${leadId}/convert`)
      .send({ value: 5000 })
      .expect(200);

    expect(oppRes.body.status).toBe('CONVERTED');
  });
});
```

---

## 14. Advanced patterns and idioms

### Cross-boundary aggregation

Use `dispatch_commands` to push state references between boundaries when one aggregate needs to know about another. In the CRM example, `createOpportunity` dispatches to `Lead` to attach the opportunity ID. This keeps each boundary authoritative over its own state while still linking related entities.

For **read-side aggregation** without mutations, use derived projections (Section 9). Derived projections subscribe to events from multiple boundaries and maintain a separate read model — they do not interfere with the primary state graph.

### Multi-step approval chains (sagas)

For workflows requiring coordination across more than two boundaries — such as credit reservation, regulatory notification, and ledger posting — declare a saga (Section 6). The post-commit model means the primary transaction is always durable; saga compensation is always a genuine compensating transaction, never a rollback.

```yaml
sagas:
  - name: LeadConversion
    trigger:
      boundary: Lead
      intent: mutation
      condition: "$concat('/leads/', command.targetId, '/convert') == command.path"
    steps:
      - name: createOpportunity
        boundary: Opportunity
        intent: creation
        target_id: "$uuidv7()"
        payload:
          leadId: "command.targetId"
          value: "command.payload.value"
        compensation:
          intent: mutation
          target_id: "command.payload.opportunityId"
          payload:
            stage: "'withdrawn'"
```

### Tag-based filtering via `query_mapping`

```yaml
query_mapping:
  stage: "state.stage == query.stage"
  campaignId: "state.campaignId == query.campaignId"
  minValue: "state.value >= double(query.minValue)"
```

Multiple filter parameters compose as AND: `GET /opportunities?stage=negotiating&minValue=5000` returns only negotiating opportunities with value ≥ 5 000. Type-coercion functions from CEL (`int()`, `double()`) are useful here since query parameters arrive as strings.

### Derived KPIs via `derived_projections`

Cross-boundary metrics that would otherwise require joining two state graphs in application code can be materialised as derived projections:

```yaml
derived_projections:
  - name: LeadSummary
    key: "event.aggregateId"
    subscribe:
      - "Lead:LeadCreated"
      - "Opportunity:OpportunityCreated"
    reduce:
      - on: "Lead:LeadCreated"
        patches:
          - op: add
            path: /companyName
            value: "${event.payload.companyName}"
          - op: add
            path: /total_opportunities
            value: "${0}"
      - on: "Opportunity:OpportunityCreated"
        patches:
          - op: replace
            path: /total_opportunities
            value: "${coalesce(state.total_opportunities, 0) + 1}"
```

Poll `GET /_admin/derived/LeadSummary` to retrieve the aggregated map.

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
| `max_uow_depth` | 5 levels of secondary command recursion (`dispatch_commands`) | HTTP 508 `INFINITE_LOOP_DETECTED` |
| Reaction event budget | 1000 events per UoW (reactions only; separate from depth) | HTTP 508 `ReactionBudgetExceeded` |
| Script CPU timeout | 50 ms per invocation | HTTP 500 `SCRIPT_TIMEOUT` |
| Pattern-match priority | First-match-wins, source document order | n/a |
| Reducer determinism | `$uuidv7`/`$now`/`now`/`timestamp` banned | `CEL_PHASE_BANNED` |
| `emit` + `emit_when` co-presence | Mutually exclusive | `BOOT_ERR_DSL_SYNTAX` (boot halt) |
| Script name characters | `[A-Za-z_][A-Za-z0-9_]*` | `BOOT_ERR_DSL_SYNTAX` (boot halt) |

### Dispatch depth vs reaction termination

`dispatch_commands` and `reactions` use **different** termination mechanisms and must not be confused:

- **`dispatch_commands` depth cap** (`max_uow_depth = 5`): secondary commands are dispatched recursively with an incrementing `depth` counter. Any secondary command at depth > 5 throws `InfiniteLoopError` (HTTP 508 `INFINITE_LOOP_DETECTED`) immediately. This governs explicit orchestration declared in `behaviors[].dispatch_commands`.

- **Reaction termination** (fired-set dedup + event budget): reactions are **not** governed by the depth counter. Instead, the UoW maintains a fired-set `Set<reactionId@aggregateId>` — a reaction fires at most once per target aggregate per UoW, breaking cycles regardless of chain depth. A separate per-UoW event budget (default 1000) is a backstop against unbounded fan-out across distinct aggregates; exceeding it throws `ReactionBudgetExceededError` (HTTP 508). Reactions can therefore chain to depths greater than 5 as long as they visit distinct aggregates and remain within the budget.

The two mechanisms coexist: a behaviour that uses both `dispatch_commands` and fires reactions operates under both limits independently.

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

---

## 18. Response generation

The keys in this section shape the HTTP response the gateway returns, independent of domain-event logic. They are all optional. Each is schema-validated at boot; unknown or misspelled keys halt with `BOOT_ERR_DSL_SYNTAX` or `BOOT_ERR_UNKNOWN_KEY`.

**Where each key lives:**

| Key | File | Scope |
|-----|------|-------|
| `hateoas` (static array) | boundary file | per-boundary, per-response |
| `mask` | boundary file | per-boundary, per-response |
| `deprecated` | boundary file | per-boundary, per-response |
| `latency` | boundary file | per-boundary, every response |
| `fault_rules` (boundary) | boundary file | boundary-scoped chaos |
| `link_name` / `link_condition` | behavior inside a boundary file | per-behavior action link |
| `hateoas` (global block) | global config file | cross-boundary dynamic links |
| `security_headers` | global config file | every response |
| `fault_rules` (global) | global config file | global chaos rules |
| `versioning` | global config file | URL prefix routing + response tag |
| `webhooks` | global config file | post-commit outbound HTTP |

Pagination shape, ETag/conditional caching, and the `X-Potemkin-*` control headers are **runtime behaviors of the gateway pipeline** — they are not configured with YAML keys. They are documented in sub-sections 18.8–18.11 below.

---

### 18.1 Static HATEOAS links (`hateoas:` on a boundary)

Injects a fixed `_links` map into every successful 2xx response body from that boundary. Applied to single entities, bare arrays, and pagination envelopes (each `items[]` entry receives its own `_links`).

```yaml
# tests/fixtures/governance/dsl/document.yaml
boundary: Document
contract_path: /documents
hateoas:
  - rel: self
    href: /documents
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `rel` | string | yes | Relation name (key in `_links`, e.g. `self`, `collection`) |
| `href` | string | yes | Link href (literal path) |

**HTTP effect:** the response body gains `_links: { "<rel>": { "href": "<href>" } }`. The boundary-level static list **overrides** any `links:` entries from the OpenAPI document for that operation.

See: [`tests/fixtures/governance/dsl/document.yaml`](../tests/fixtures/governance/dsl/document.yaml), [`tests/fixtures/governance/dsl/document-by-id.yaml`](../tests/fixtures/governance/dsl/document-by-id.yaml), [`tests/e2e/56-response-mutations.e2e-test.ts`](../tests/e2e/56-response-mutations.e2e-test.ts)

---

### 18.2 Dynamic HATEOAS links (`hateoas:` in global config + per-behavior `link_name` / `link_condition`)

The global `hateoas:` block enables automatic `_links` generation on every query (GET) response. The engine scans all sub-path boundaries for behaviors that declare `link_name`; each qualifying link is injected when its gate condition holds for the entity.

**Global config block** (in the global config YAML file):

```yaml
# tests/fixtures/crm/dsl/global.yaml
hateoas:
  enabled: true
  self_links: true
  # base_url: "https://api.example.com"   # optional — prefixes all hrefs
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch. Must be `true` for any dynamic links to be injected. |
| `self_links` | `true` | Inject a `self` link pointing at the entity's canonical GET path (resolved via `{id}` path template). |
| `base_url` | absent | When set, every generated href is prefixed with this value (e.g. `https://api.example.com/leads/abc`). |

**Per-behavior fields** (on any behavior in any boundary):

```yaml
# Sub-path boundary — e.g. lead-convert.yaml
behaviors:
  - name: convertLead
    match:
      operationId: convertLead
      condition: "state.status == 'QUALIFIED'"
    link_name: convert
    link_condition: "state.status == 'QUALIFIED'"
    emit: LeadConverted
```

| Field | Type | Description |
|-------|------|-------------|
| `link_name` | string | The relation key emitted in `_links` (e.g. `convert` → `_links.convert`). When set and the gate passes, the link is added to entities served from the parent boundary. |
| `link_condition` | CEL boolean | Independent gate for link visibility. Evaluated against `state`. When absent, `match.condition` is used as the gate. |

**HTTP effect:** query responses from the parent collection boundary receive `_links` per entity. Example:

```json
{
  "id": "abc",
  "status": "QUALIFIED",
  "_links": {
    "self":    { "href": "/leads/abc",         "method": "GET" },
    "convert": { "href": "/leads/abc/convert", "method": "POST" }
  }
}
```

`_links` is suppressed when `?fields=` is present (sparse-fieldset requests are explicit projections).

See: [`tests/e2e/44-hateoas.e2e-test.ts`](../tests/e2e/44-hateoas.e2e-test.ts)

---

### 18.3 Field masking (`mask:`)

Removes named fields from the response body before the response is sent. Applied to every entity in the response (single objects, bare arrays, and `items[]` in pagination envelopes). Does not affect event payloads or state.

```yaml
# tests/fixtures/governance/dsl/document.yaml
boundary: Document
contract_path: /documents
mask:
  - internalNotes
```

- Values are bare field names (`internalNotes`) or RFC 6901 JSON Pointers (`/address/street`).
- A field that is already absent is silently skipped (no error).
- `mask:` removes the field entirely. The runtime `X-Potemkin-Mask` header (§18.11) is a different operation — it replaces the field value with the `"[MASKED]"` sentinel rather than removing it.

**HTTP effect:** `internalNotes` is absent from every response body on this boundary.

See: [`tests/fixtures/governance/dsl/document.yaml`](../tests/fixtures/governance/dsl/document.yaml), [`tests/e2e/56-response-mutations.e2e-test.ts`](../tests/e2e/56-response-mutations.e2e-test.ts)

---

### 18.4 Deprecation headers (`deprecated:`)

Emits HTTP `Deprecation`, `Sunset`, and `Link` headers on every successful 2xx response from that boundary, signalling to clients that the API is scheduled for retirement.

```yaml
# tests/fixtures/crm/dsl/lead-add-note.yaml
deprecated:
  date: "2025-01-01"
  sunset: "2025-06-01"
  replacement: "/v2/leads/{id}/notes"
```

```yaml
# tests/fixtures/governance/dsl/document-by-id.yaml
deprecated:
  sunset: "2027-01-01T00:00:00Z"
  replacement: /v2/documents
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | ISO-8601 string | no | Deprecation date. Becomes the `Deprecation` header value formatted as an HTTP-date per RFC 8594 (e.g. `Wed, 01 Jan 2025 00:00:00 GMT`). When omitted the header value is the literal string `true`. |
| `sunset` | ISO-8601 string | no | When present, emits `Sunset: <HTTP-date>` (RFC 8594). |
| `replacement` | string | no | When present, emits `Link: <replacement>; rel="successor-version"`. |

**HTTP effect (with all three fields):**

```
Deprecation: Wed, 01 Jan 2025 00:00:00 GMT
Sunset:      Sun, 01 Jun 2025 00:00:00 GMT
Link:        </v2/leads/{id}/notes>; rel="successor-version"
```

When `deprecated:` is absent but the OpenAPI operation carries `deprecated: true`, the engine falls back to `Deprecation: true` with no Sunset or Link header.

See: [`tests/fixtures/crm/dsl/lead-add-note.yaml`](../tests/fixtures/crm/dsl/lead-add-note.yaml), [`tests/fixtures/governance/dsl/document-by-id.yaml`](../tests/fixtures/governance/dsl/document-by-id.yaml), [`tests/e2e/56-response-mutations.e2e-test.ts`](../tests/e2e/56-response-mutations.e2e-test.ts)

---

### 18.5 Per-boundary response latency (`latency:`)

Injects a pre-response delay on every request handled by the boundary, regardless of intent. Useful for simulating slow dependencies or exercising client retry/timeout logic without injecting chaos headers.

```yaml
# tests/fixtures/latency/dsl/job.yaml
boundary: Job
contract_path: /jobs
latency:
  fixed_ms: 60
```

```yaml
# tests/fixtures/crm/dsl/lead-add-note.yaml
latency:
  min_ms: 20
  max_ms: 200
  fixed_ms: 50
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fixed_ms` | number | absent | Fixed additional delay in milliseconds, applied on every response. |
| `min_ms` | number | absent | Lower bound (ms) of a uniform-random delay range. |
| `max_ms` | number | absent | Upper bound (ms) of a uniform-random delay range. |

All present fields are additive: `fixed_ms` adds its value first, then a uniform-random sample from `[min_ms, max_ms]` is added on top. The combined delay is capped at **30 000 ms**. Latency is also additive with `X-Potemkin-Force-Latency` / `X-Potemkin-Slow-Response` chaos headers.

Latency is boundary-scoped: configuring `latency:` on `/jobs` does not affect `/jobs/{id}`.

See: [`tests/fixtures/latency/dsl/job.yaml`](../tests/fixtures/latency/dsl/job.yaml), [`tests/e2e/65-latency.e2e-test.ts`](../tests/e2e/65-latency.e2e-test.ts)

---

### 18.6 Security headers (`security_headers:`)

Injects HTTP security response headers on **every** response from the gateway (applied as Express middleware before any route handler). Declared in the global config file.

```yaml
# tests/fixtures/crm/dsl/global.yaml
security_headers:
  enabled: true
  hsts: true
  nosniff: true
  frame_deny: true
  referrer_policy: "strict-origin-when-cross-origin"
  custom_headers:
    X-Custom-Sim-Header: "potemkin-sim"
```

| Field | Type | Default | Emitted header |
|-------|------|---------|----------------|
| `enabled` | boolean | `true` | Master switch. Set to `false` to disable all headers without removing the block. |
| `hsts` | boolean | absent | `Strict-Transport-Security: max-age=31536000; includeSubDomains` |
| `nosniff` | boolean | absent | `X-Content-Type-Options: nosniff` |
| `frame_deny` | boolean | absent | `X-Frame-Options: DENY` |
| `referrer_policy` | string | absent | `Referrer-Policy: <value>` |
| `custom_headers` | `map<string, string>` | absent | Each entry emitted verbatim as `<name>: <value>` |

See: [`tests/fixtures/crm/dsl/global.yaml`](../tests/fixtures/crm/dsl/global.yaml), [`tests/e2e/38-security-headers.e2e-test.ts`](../tests/e2e/38-security-headers.e2e-test.ts)

---

### 18.7 Fault rules / chaos injection (`fault_rules:`)

Declarative chaos rules evaluated before any behavior logic on every inbound request. A matching rule short-circuits the Unit of Work and returns a canned error response — no state is mutated.

`fault_rules:` may be declared at two scopes:

- **Global** (in the global config file): evaluated for every request.
- **Boundary** (in a boundary file): evaluated only for requests on that boundary, before global rules.

Within each scope, rules are evaluated in document order; the **first match wins**.

```yaml
# tests/fixtures/crm/dsl/global.yaml — global fault rules
fault_rules:
  - name: rate-limit-via-header
    match:
      condition: "true"
      potemkin:
        rate_limit: "*"
    response:
      status: 429
      body:
        error: RATE_LIMITED
        message: Simulated rate limit (header-triggered)
      headers:
        Retry-After: "30"

  - name: dnc-registry-slow
    match:
      boundary: LeadDNC
      intent: mutation
      condition: "command.payload.reason == 'REGISTRY_CHECK'"
    response:
      status: 504
      body:
        error: DNC_REGISTRY_TIMEOUT
        message: External DNC registry check timed out
      delay_ms: 100

  - name: call-logging-intermittent
    match:
      boundary: Call
      intent: creation
      condition: "command.payload.outcome == 'NOT_INTERESTED'"
      probability: 0.1
    response:
      status: 503
      body:
        error: CALL_LOGGING_UNAVAILABLE
```

```yaml
# tests/fixtures/crm/dsl/lead.yaml — boundary-scoped fault rule
fault_rules:
  - name: duplicate-check-slow
    match:
      intent: creation
      condition: "command.payload.checkDuplicates == true"
    response:
      status: 504
      body:
        error: DUPLICATE_CHECK_TIMEOUT
      delay_ms: 50
```

**`match` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `boundary` | string | Restrict to a specific boundary name. Ignored on boundary-scoped rules (they are already scoped). |
| `intent` | string | `creation`, `mutation`, or `query`. |
| `condition` | CEL boolean | Guard expression evaluated against `command` and `state`. Default: `"true"`. |
| `headers` | `map<string, string>` | Header name → expected value. `"*"` matches any non-empty value (presence check). AND semantics. |
| `potemkin` | `map<string, string>` | Convenience aliases expanding to `X-Potemkin-*` headers (see §18.11). Equivalent to `headers:` with the expanded names. |
| `probability` | number (0..1) | Probabilistic gate. When present, the rule fires only when `random() > probability`. |

**`response` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | integer | HTTP status code to return. |
| `body` | JSON value | Response body. |
| `headers` | `map<string, string>` | Response headers to set. |
| `delay_ms` | number | Pre-response delay in milliseconds (stacks with `latency:`). |

**Precedence (highest first):** boundary fault rules → global fault rules → chaos headers (§18.11). The `X-Potemkin-Skip-Dispatch: true` control header bypasses fault injection for a single request.

See: [`tests/fixtures/crm/dsl/global.yaml`](../tests/fixtures/crm/dsl/global.yaml), [`tests/fixtures/crm/dsl/lead.yaml`](../tests/fixtures/crm/dsl/lead.yaml), [`tests/e2e/46-chaos-headers.e2e-test.ts`](../tests/e2e/46-chaos-headers.e2e-test.ts)

---

### 18.8 Pagination envelope and `Link` headers

The engine automatically wraps collection query results in a metadata envelope when `?limit` is present in the request. No YAML configuration is required — this is a built-in gateway behaviour.

**Request:** `GET /leads?limit=2&offset=0`

**Response body:**

```json
{
  "items": [ { "id": "...", ... }, { "id": "...", ... } ],
  "totalCount": 5,
  "offset": 0,
  "limit": 2,
  "hasMore": true
}
```

**Cursor-based pagination** is also supported. When `?cursor=<opaque>` is supplied (in place of or alongside `?offset`), the engine uses the cursor for positioning and emits `nextCursor` in the envelope when `hasMore` is `true`.

**`X-Potemkin-Pagination-Style` control header** (Tier 5, §18.11) overrides the default style per request:

| Value | Effect |
|-------|--------|
| `envelope` | Always wrap in `{ items, totalCount, offset, limit, hasMore }`. |
| `raw` | Always return a bare array (unwrap any envelope). |
| `link-header` | Bare array body + RFC 5988 `Link:` header with `rel="next"` and `rel="prev"` when more pages exist. |

The `Link:` header preserves all original query parameters (filters, sort) and only overrides `offset`/`limit`.

**Multi-sort:** `?sort=field1,-field2` sorts by `field1` ascending then `field2` descending. Backward-compatible with the legacy `?sort=field&order=desc` form.

**Array operators:** `?callIds:contains=<value>` tests membership/substring in the `callIds` field. `?callIds:arrayContains=<value>` applies strict array-only membership (non-arrays evaluate to false).

**Sparse fieldsets:** `?fields=id,companyName,score` returns only the named fields per entity. `id` is always preserved. Applied after derived properties, before relationship expansion.

See: [`tests/e2e/36-pagination-envelope.e2e-test.ts`](../tests/e2e/36-pagination-envelope.e2e-test.ts), [`tests/e2e/39-multisort-array-operators.e2e-test.ts`](../tests/e2e/39-multisort-array-operators.e2e-test.ts), [`tests/e2e/43-query-extensions.e2e-test.ts`](../tests/e2e/43-query-extensions.e2e-test.ts)

---

### 18.9 ETag and conditional requests

The gateway automatically manages ETags and conditional-request semantics for single-entity GET responses. No YAML configuration is required.

**ETag generation:**

- **Mutation / creation (POST/PUT/PATCH):** the `ETag` response header is set to `"<sequenceVersion>"` (quoted integer, RFC 7232) reflecting the final event's `sequenceVersion` for the primary aggregate.
- **Single-entity GET:** `ETag` is `"<currentSequenceVersion>"`. When the entity carries an `updatedAt` field, `Last-Modified` is also emitted as an HTTP-date.

**Conditional request handling (single-entity GET only):**

| Request header | Engine behaviour |
|----------------|-----------------|
| `If-None-Match: "<n>"` | Returns **304 Not Modified** (empty body) when the ETag matches. `*` always matches. |
| `If-Modified-Since: <http-date>` | Returns **304 Not Modified** when `Last-Modified ≤ If-Modified-Since`. Malformed dates are ignored. |
| `If-Match: "<n>"` (on mutations) | Returns **412 Precondition Failed** when the supplied value does not match the stored `sequenceVersion`. Returns **428 Precondition Required** when the header is absent but required. |

Weak validators (`W/"5"`) on `If-Match` are rejected with HTTP 400.

304 responses carry `ETag` and `Last-Modified` headers but no body.

See: [`tests/e2e/37-conditional-requests.e2e-test.ts`](../tests/e2e/37-conditional-requests.e2e-test.ts)

---

### 18.10 API versioning (`versioning:`)

Strips a URL version prefix from every inbound request path before contract route matching, and tags the response with `X-Potemkin-Version`. Declared in the global config file.

```yaml
# tests/fixtures/crm-versioned/dsl/global.yaml
versioning:
  enabled: true
  versions:
    - version: "v1"
      prefix: "/v1"
    - version: "v2"
      prefix: "/v2"
      default: true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | no (default `false`) | Master switch. |
| `versions[].version` | string | yes | Version label (e.g. `"v1"`). Echoed in the `X-Potemkin-Version` response header. |
| `versions[].prefix` | string | yes | URL prefix that selects this version (e.g. `"/v1"`). Stripped before contract matching. |
| `versions[].default` | boolean | no | When `true`, requests without a recognised version prefix are routed to this version. At most one version may be the default. |

**HTTP effect:** `POST /v2/leads` → contract is matched against `/leads`; response carries `X-Potemkin-Version: v2`. Requests to un-prefixed paths route to the `default` version when one is declared.

`/_engine` and `/_admin` paths are excluded from version resolution.

See: [`tests/fixtures/crm-versioned/dsl/global.yaml`](../tests/fixtures/crm-versioned/dsl/global.yaml), [`tests/e2e/47-api-versioning.e2e-test.ts`](../tests/e2e/47-api-versioning.e2e-test.ts)

---

### 18.11 Outbound webhooks (`webhooks:`)

Declares HTTP POST callbacks dispatched after a Unit of Work commits. The POST body is HMAC-SHA256-signed. Declared in the global config file.

```yaml
# tests/fixtures/webhook-hmac/dsl/global.yaml
webhooks:
  - name: shipment-created-webhook
    trigger:
      boundary: Shipment
      condition: "event.type == 'ShipmentCreated'"
    url: "'http://127.0.0.1:19877/webhook'"
    secret: "hmac-example-secret-do-not-use-in-prod"
    payload:
      shipmentId: "${event.aggregateId}"
      trackingRef: "${event.payload.trackingRef}"
      event: "${event.type}"
    retry:
      maxAttempts: 3
      delayMs: 50
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique webhook name. |
| `trigger.boundary` | string | no | Restrict to events emitted by this boundary. |
| `trigger.intent` | string | no | `creation`, `mutation`, or `query`. |
| `trigger.condition` | CEL boolean | yes | Evaluated against the emitted event context (`event.type`, `event.aggregateId`, `event.payload`). |
| `url` | CEL string expression | yes | Destination URL. Must be a CEL expression (wrap a literal in single quotes: `"'https://...'"`) |
| `secret` | string | no | Shared secret for HMAC-SHA256 signing. When present, the POST carries `x-potemkin-signature: sha256=<hex>`. |
| `payload` | `map<string, CEL>` | no | Template for the POST body. Each key's value is a CEL expression evaluated against event context. When absent, the full event is delivered. |
| `retry.maxAttempts` | integer | no | Maximum delivery attempts on transient failures (default: 1). |
| `retry.delayMs` | integer | no | Delay between retry attempts in milliseconds. |

**Delivery pipeline:**

1. Evaluate `trigger.condition` — skip when false.
2. Resolve `url` CEL expression.
3. Evaluate each `payload` template field.
4. Serialise the payload to canonical JSON (the same bytes that are HMAC-signed).
5. Compute `HMAC-SHA256(secret, canonicalJSON)` and set `x-potemkin-signature: sha256=<hex>`.
6. POST the signed body; retry on transient HTTP errors up to `maxAttempts`.

Webhooks fire **after** the primary Unit of Work commits. The `X-Potemkin-Skip-Webhooks: true` request header suppresses all webhook dispatch for a single request.

See: [`tests/fixtures/webhook-hmac/dsl/global.yaml`](../tests/fixtures/webhook-hmac/dsl/global.yaml), [`tests/e2e/64-webhook-hmac.e2e-test.ts`](../tests/e2e/64-webhook-hmac.e2e-test.ts)

---

### 18.12 Chaos / `X-Potemkin-*` control headers

In addition to the YAML `fault_rules:` block, clients can drive chaos-engineering scenarios by sending `X-Potemkin-*` request headers. Every chaos header has a default built-in behaviour; a YAML fault rule can override the response body by matching the same header in its `match.headers:` or `match.potemkin:` block.

All constants live in `src/http/potemkinHeaders.ts`.

#### Chaos and fault headers

| Header | Value | Default effect |
|--------|-------|----------------|
| `x-potemkin-use-fault` | `<rule-name>` | Invoke the named YAML fault rule verbatim (highest precedence). |
| `x-potemkin-force-status` | `<100..599>` | Short-circuit with the given HTTP status and a generic `FORCED_STATUS` body. |
| `x-potemkin-error-class` | `timeout\|throttle\|outage\|bad_gateway\|conflict\|auth\|forbidden` | Map to canonical HTTP status (504/429/503/502/409/401/403) with a standard error body. |
| `x-potemkin-force-latency` | `<int ms>` | Add a fixed delay before the response. Additive with `latency:`. |
| `x-potemkin-slow-response` | `<int ms>` | Synonym for `x-potemkin-force-latency`. |
| `x-potemkin-jitter` | `<max>` or `<min>:<max>` | Add uniform-random jitter in the given range. |
| `x-potemkin-drop-connection` | `<int ms>` | Sleep then close the socket; no response body. |
| `x-potemkin-success-rate` | `<0..1>` or `<0..100>` | Probabilistic gate: fails with 503 when `random() >= rate`. |
| `x-potemkin-retry-after` | `<int seconds>` | Attach `Retry-After:` to any chaos response. |
| `x-potemkin-body-truncate` | `<int bytes>` | Serialise the normal body then slice to N bytes (network shaping). |

Chaos header precedence (highest first): `use-fault` → `force-status` → `error-class` → `drop-connection` → `success-rate`. Latency headers stack additively. `body-truncate` and `retry-after` are applied to whichever response wins.

#### Tier 1 — Test transparency

| Header | Effect |
|--------|--------|
| `x-potemkin-dry-run: true` | Execute the full UoW but do not commit events. Response carries `X-Potemkin-Dry-Run: true`. |
| `x-potemkin-include-events: true` | Append `_events: [...]` to the response body showing events produced. |
| `x-potemkin-echo: true` | Append `_debug: { boundary, intent, targetId, dryRun, method, path }` to the response. |
| `x-potemkin-seed: <int>` | Deterministic seed for `$fake()` / `$uuidv7()` in this request. |
| `x-potemkin-clock-offset: <ms>` | Per-request `$now()` offset (signed ms). Additive to the admin clock. |

#### Tier 2 — Side-effect control

| Header | Effect |
|--------|--------|
| `x-potemkin-skip-sagas: true` | Commit primary events but skip saga triggers. |
| `x-potemkin-skip-webhooks: true` | Commit primary events but skip outbound webhook dispatch. |
| `x-potemkin-skip-projections: true` | Commit events but skip derived projection application. |
| `x-potemkin-skip-dispatch: true` | Block secondary command cascading (depth-0 only). Also bypasses `fault_rules:` injection. |
| `x-potemkin-max-cascade-depth: <n>` | Override UoW max cascade depth for this request. |
| `x-potemkin-bulk-transactional: true` | Make an array-body request all-or-nothing (atomic batch). |

#### Tier 3 — Identity override (admin-gated)

| Header | Effect |
|--------|--------|
| `x-potemkin-actor: <id>:<scope1>,<scope2>` | Override actor identity for this request. Requires the caller to hold `admin` scope. |
| `x-potemkin-impersonate: <id>:<scopes>` | Run as another actor; logs both original and impersonated actors. Admin-gated. |
| `x-potemkin-caused-by: <eventId>` | Set the `causedBy` field on emitted events. |

#### Tier 4 — Event-sourcing time travel

| Header | Effect |
|--------|--------|
| `x-potemkin-read-at-version: <n>` | Query the entity's state as of sequence version `n`. |
| `x-potemkin-replay-event: <eventId>` | Re-emit a historic event by ID. |

#### Tier 5 — Response format control

| Header | Values | Effect |
|--------|--------|--------|
| `x-potemkin-response-format` | `hal` \| `jsonapi` \| `plain` | Reshape response body to HAL+JSON, JSON:API, or plain (default). |
| `x-potemkin-pagination-style` | `envelope` \| `raw` \| `link-header` | Override collection response shape (see §18.8). |
| `x-potemkin-mask` | comma-separated field names | Replace named fields with `"[MASKED]"` sentinel in the response body. |

#### Tier 6 — Observability injection

| Header | Effect |
|--------|--------|
| `x-potemkin-trace-id: <id>` | Echo the supplied trace ID in the response header `X-Potemkin-Trace-Id`. |
| `x-potemkin-span-name: <name>` | Name the `http.request` OTel span; echoed in `X-Potemkin-Span-Name`. |
| `x-potemkin-log-level: debug\|info\|warn\|error` | Per-request log level. |
| `x-potemkin-metric-tag: <key>=<value>` | Attach a custom tag to metrics emitted by this request. |

#### Tier 7 — Validation control (admin-gated)

| Header | Effect |
|--------|--------|
| `x-potemkin-skip-request-validation: true` | Skip OpenAPI request validation. Admin-gated. |
| `x-potemkin-skip-response-validation: true` | Skip OpenAPI response validation. Admin-gated. |
| `x-potemkin-allow-additional-properties: true` | Relax `additionalProperties: false` for this request. Admin-gated. |

**`potemkin:` convenience block** — in `fault_rules[].match`, the shorthand `potemkin:` block expands alias names to the full `X-Potemkin-*` header names. The full alias table is in `src/http/potemkinHeaders.ts` (`POTEMKIN_SIGNAL_ALIASES`).

```yaml
# Expand rate_limit → x-potemkin-rate-limit
fault_rules:
  - name: rate-limit-via-header
    match:
      condition: "true"
      potemkin:
        rate_limit: "*"
    response:
      status: 429
```

See: [`tests/e2e/46-chaos-headers.e2e-test.ts`](../tests/e2e/46-chaos-headers.e2e-test.ts), [`tests/e2e/48-control-headers.e2e-test.ts`](../tests/e2e/48-control-headers.e2e-test.ts)

---

## 19. Reactions (choreography)

`reactions` is an array that may appear in any boundary file (or in the global config). Each entry declares that a boundary subscribes to another boundary's committed-to-shadow event and emits its own event inside the **same Unit of Work** — atomically, with no coupling to the source boundary.

This is the write-side analogue of `derived_projections` (§9): where derived projections subscribe to events and build a read model, reactions subscribe to events and mutate write state. The canonical worked example is [`tests/e2e/66-reactions-fanout.e2e-test.ts`](../tests/e2e/66-reactions-fanout.e2e-test.ts).

### Grammar

```yaml
reactions:
  - name: record-conversion-on-campaign
    on: "Lead:LeadConverted"
    when: "event.payload.campaignId != null"
    boundary: Campaign
    emit: CampaignConversionRecorded
    intent: mutation
    target: "event.payload.campaignId"
    payload:
      leadId: "event.aggregateId"
```

| Field | Required | Meaning |
|-------|----------|---------|
| `on` | yes | Trigger subscription: `Boundary:EventType` or bare `EventType` (matches any boundary). |
| `emit` | yes | Event type to emit, resolved against the reacting boundary's `event_catalog`. |
| `target` | yes (mutation) | CEL expression resolving to the aggregate id the emitted event applies to. For `creation`, may be omitted — the reacting boundary's `identity.creation.generate` is used instead. |
| `boundary` | no | Reacting boundary name. Defaults to the boundary of the file the reaction is declared in. Required when the reaction is declared in the global config. |
| `name` | no | Human-readable label used in trace logs and error messages. |
| `when` | no | CEL gate; the reaction fires only when this expression evaluates to `true`. Omitting it is equivalent to `"true"`. |
| `intent` | no | `mutation` (default) or `creation`. |
| `payload` | no | Map of field names to CEL expressions, merged over the emitted event's `payload_template`. Each value is a CEL expression. |

A reaction requires **no behaviour** on the reacting boundary — only the event in its `event_catalog` and a reducer for it.

### In-UoW atomic semantics

Reactions fire inside the running Unit of Work, not after commit:

1. After each event is staged and projected to the shadow graph, the reaction registry is consulted for entries whose `on` subscription matches `<boundary>:<eventType>` (or bare `<eventType>`).
2. `when` is evaluated against the trigger context; `false` skips the reaction.
3. `target` and `payload` are evaluated; the emitted event type's `payload_template` is hydrated and the reaction's `payload` overrides are merged on top.
4. The emitted event is appended to the same `stagedEvents` queue and projected into the same shadow graph via the reacting boundary's reducers. Its staging can trigger further reactions (recursive fan-out), processed by the same FIFO queue.
5. All events — primary, dispatched, and reaction-emitted — are committed in a single `eventStore.append(stagedEvents)` call. Any reaction error aborts the entire UoW (atomic, all-or-nothing).

### CEL context

The `when`, `target`, and `payload` expressions evaluate against the trigger event context:

| Variable | Description |
|----------|-------------|
| `event` | The trigger domain event (`type`, `aggregateId`, `payload`, `sequenceVersion`, `boundary`) |
| `payload` | Alias for `event.payload` |

The emitted event's `payload_template` hydrates in the EventHydration phase — `$uuidv7()` and `$now()` are permitted there. In addition to `event` and `payload`, the `payload_template` context also exposes `state`, the current shadow-graph state of the reacting aggregate (the target identified by `target`), so a hydrated field may reference existing state on that aggregate. The reducer-phase ban on non-deterministic functions is preserved for reactions' reducers.

### Termination (fired-set dedup + event budget)

Reactions are **not** bounded by the `dispatch_commands` depth-5 cap (`max_uow_depth`). Instead the UoW maintains:

- A **fired-set**: `Set<reactionId + '@' + targetAggregateId>`. A given reaction fires at most once per target aggregate within a UoW. This breaks cycles and deduplicates fan-out without a fixed depth ceiling.
- A per-UoW **event budget** (`max_uow_events`, default 1000) as a backstop against runaway fan-out across unbounded distinct aggregates. Exceeding it throws `ReactionBudgetExceededError` (HTTP 508) and names the offending reaction.

This guarantees halt while allowing unbounded breadth and depth across distinct aggregates.

### Deterministic ordering

For a single trigger event, matching reactions fire in a stable order:

1. Reacting boundary name ascending (lexicographic).
2. Declaration index within that boundary (document order).

This ordering is deterministic so that event-log replay reproduces identical state. Reactions fire from primary and dispatched events within the UoW; saga-step events (post-commit UoWs) trigger reactions within their own UoW.

### Boot-time errors

| Code | Cause |
|------|-------|
| `BOOT_ERR_DSL_SYNTAX` | YAML parse failure, invalid field type, malformed CEL expression in `when`/`target`/`payload`, or `ts:` script sentinel in a reaction CEL field |
| `BOOT_ERR_DSL_REFERENCE` | `emit` references an event type not in the reacting boundary's `event_catalog`, or `boundary` names an unknown boundary, or `on` references a boundary that does not exist |

### Example: three-boundary fan-out

The following files show a single `POST /orders` request atomically updating three independent boundaries — with zero modifications to `order.yaml`. Each subscriber declares its own reaction:

```yaml
# inventory.yaml
reactions:
  - name: reserve-inventory-on-order-placed
    on: "Order:OrderPlaced"
    intent: creation
    emit: InventoryReserved
```

```yaml
# notification.yaml
reactions:
  - name: queue-notification-on-order-placed
    on: "Order:OrderPlaced"
    intent: creation
    emit: NotificationQueued
```

```yaml
# audit.yaml
reactions:
  - name: record-audit-on-order-placed
    on: "Order:OrderPlaced"
    intent: creation
    emit: AuditRecorded
```

One `POST /orders` emits `OrderPlaced` once; Inventory, Notification, and Audit each receive their events in the same atomic commit. The Order boundary has no `reactions` key and no knowledge of its subscribers.

See [`tests/e2e/66-reactions-fanout.e2e-test.ts`](../tests/e2e/66-reactions-fanout.e2e-test.ts) for a nine-boundary variant that includes a six-hop chain (deeper than the `dispatch_commands` depth limit).
