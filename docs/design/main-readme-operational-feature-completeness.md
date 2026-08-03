# Operational feature matrix against the authoritative README

This document is the operational audit for the Potemkin refactor. The product
baseline is the committed README, not the working-tree README:

```sh
git show main:README.md
```

The audited baseline is commit `812f1c0d672af34337a983aed9c424d9a2f71cf4`.
The current document is deliberately more precise than that README where the
README names a control but leaves its wire contract implicit. Those expansions
are cross-checked against the current control-header implementation and the
existing E2E suites; they are not evidence that the feature is complete.

## Status and proof standard

`Specified` means the committed README requires the behavior. `Observed` means
an existing test exercises it somewhere in the repository. `Partial` means
there is evidence, but it is on the pre-refactor gateway, covers only one
authoring form, or proves only part of the contract. `Gap` means the required
behavior or its evidence is still missing.

For a feature to be complete in the new design, the evidence must include all
of the following:

1. a real HTTP E2E test booting YAML through `parser`;
2. a real HTTP E2E test booting the equivalent TypeScript program directly;
3. the same source-independent core runtime operation in both cases;
4. response status, headers, body, state, event-log, and side-effect
   assertions wherever those values can change; and
5. a forwarding/Specmatic E2E test when the README advertises the behavior
   across that transport.

A parser unit test or a test of the existing gateway is useful evidence, but it
does not close the TypeScript-parity requirement.

## Baseline operational contract

The README establishes these runtime facts in its Architecture, Quick start,
Chaos and runtime control, and Specmatic sections:

| Contract                               | Required behavior                                                                                                        | Baseline evidence                                                                      | Current status                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Volatile event log and projected graph | Requests become commands; matched behavior emits events; reducers project state; reset returns to the frozen seed state. | README architecture; `initialization-queries`; `ephemeral-lifecycle`; mutation suites. | Observed: `runtime-derived-projection` and `admin-surface-authoring-parity` prove seeded projections, raw state/event views, and reset parity for YAML, TypeScript, and mixed loading.                                                                                                                                                  |
| Ordered behavior matching              | The first matching behavior wins, including its explicit response status.                                                | README behavior section; behavior E2E suites.                                          | `authoring-parity` proves two same-operation behaviors, the first header-selected branch, the fallback branch, and the resulting event/state/status shape through Specmatic for YAML, TypeScript, and mixed loading. YAML `response_status` and TypeScript `.status(202)` compile to the same runtime behavior field. `G-04` is closed. |
| Atomic unit of work                    | Primary events and secondary work commit atomically; failed work leaves no partial state or side effects.                | README architecture; saga/reaction/fault suites.                                       | Observed: `bulk-side-effects-authoring-parity.e2e-test.ts` proves successful and failed transactional bulk with dispatch, saga, reaction, projection, and webhook work for YAML, TypeScript, and mixed loading.                                                                                                                         |
| Contract validation                    | Invalid OpenAPI requests are rejected with `400 CONTRACT_VIOLATION` before behavior evaluation and produce no events.    | `contract-validation`; README Specmatic section.                                       | Observed: `validation-controls-authoring-parity` proves strict request/response validation, administrator-gated bypasses, no-mutation failures, and relaxed Specmatic forwarding for YAML, TypeScript, and mixed loading.                                                                                                               |

## Query policy and source parity

The query surface is source-neutral. YAML `query:` declarations are compiled
into the same `RuntimeQueryPolicy` shape that TypeScript supplies through
`BoundaryBuilder.query(...)`; `query_mapping` and the built-in URL operators
remain available for simpler filters.

| Capability                                     | YAML form                                                | TypeScript form                                  | Evidence                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Candidate filtering and query-field predicates | `query.filter`, `query.fields` with CEL                  | `filter`, `fields` callbacks over `QueryContext` | `tests/unit/dsl/queryPolicy.test.ts`; `tests/e2e/query-policy-authoring-parity.e2e-test.ts` |
| Ordering and pagination                        | `query.sort`, `page_size`, `max_page_size`, `pagination` | `sort`, `pageSize`, `maxPageSize`, `pagination`  | Real Specmatic collection requests pass for YAML, TypeScript, and mixed configurations      |
| Targeted fallback and shared policy shape      | `query.fallback`                                         | `query.fallback` callback                        | Real Specmatic `GET /orders/missing` returns the same configured result for all three modes |

## Time adjustment and time travel

The committed README explicitly uses `$now()` and `$uuidv7()`, requires
deterministic reset, and mentions clock manipulation in the admin surface. The
current control contract expands that into a runtime clock, request-local
offsets, seeded helpers, read-at-version, and replay controls. YAML may express
the source syntax; the core must receive typed clock, random, and identifier
providers.

| Feature                          | Wire/YAML form                                                                                                         | TypeScript/runtime form                                                                               | Required observable behavior                                                                                                                                                            | Evidence and gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administrative virtual clock     | `POST /_admin/clock/advance` with `{ "ms": n }`; `POST /_admin/clock/reset`. TTL-bearing YAML policies use this clock. | Inject a `RuntimeClock`; expose the same admin port on the gateway.                                   | Advances virtual time without sleeping; returns the new offset; reset restores zero offset and is isolated per runtime. It must govern idempotency, sessions, and dynamic-fault expiry. | `admin-surface-authoring-parity.e2e-test.ts` proves advance/reset and timestamp movement; `runtime-ttl.runtime.test.ts` proves idempotency and session expiry; `configured-admin-faults.e2e-test.ts` proves dynamic-fault expiry and reset through Specmatic for YAML, TypeScript, static-factory, and mixed configurations; `authoring-parity.e2e-test.ts` proves idempotency expiry and clock reset through Specmatic for all three modes; `session-authoring-parity.e2e-test.ts` proves session expiry, logout, reset invalidation, clock reset, and concurrent session expiry isolation for all three modes; `configured-admin-faults.e2e-test.ts` proves concurrent dynamic-fault TTL isolation. `G-01` is closed. |
| Request-local clock adjustment   | `X-Potemkin-Clock-Offset: <signed-ms>`.                                                                                | `RuntimeControls.clockOffsetMs`, applied by the injected clock/helper layer.                          | Positive, negative, and zero offsets affect `$now()`-equivalent values and request-local expiry decisions without changing the base clock or another concurrent request.                | `runtime-clock-offset` and `runtime-ttl` prove timestamp and session-TTL isolation for YAML and TypeScript; `runtime-controls` proves positive and negative offsets remain isolated across concurrent requests; `latency` proves the same isolation through the real Specmatic/plugin forwarding path for all three authoring modes; `authoring-parity`, `session-authoring-parity`, and `configured-admin-faults` prove concurrent idempotency, session, and dynamic-fault TTL decisions. G-01 and G-02 are closed.                                                                                                                                                                                                    |
| Request-local deterministic seed | `X-Potemkin-Seed: <seed>` for `$fake()`/`$uuidv7()` behavior.                                                          | Typed random/UUID provider or request control; no CEL string in direct TypeScript.                    | Equal seeds produce equal generated values; different seeds do not; seed state does not leak between requests or reset.                                                                 | `runtime-seeded-parity` proves equal/different seeded IDs and generated values for YAML and TypeScript; `runtime-controls` proves distinct seeded UUIDs remain isolated across concurrent requests; `latency` proves seeded identity determinism and concurrent seed isolation through Specmatic for YAML, TypeScript, and mixed modes. G-03 is closed.                                                                                                                                                                                                                                                                                                                                                                 |
| Read at event version            | `X-Potemkin-Read-At-Version: <n>`.                                                                                     | `RuntimeControls.readAtVersion`; transient replay through the same reducers and computed-field logic. | Reads state as of version `n`, including the 404 case when no state existed; does not append events, mutate live state, or change the next ordinary read.                               | `runtime-time-travel` proves direct YAML/TypeScript historical reads, isolation, and ETag/Last-Modified headers; `authoring-parity` proves normal, dry-run, and concurrent historical reads through Specmatic for YAML, TypeScript, and mixed configurations.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Historic event replay            | `X-Potemkin-Replay-Event: <event-id>`.                                                                                 | `RuntimeControls.replayEvent` and a typed event replay operation.                                     | A known event is re-emitted according to the runtime's projection/idempotency rules; an unknown ID is a typed 404 with no partial write.                                                | `runtime-time-travel` proves direct YAML/TypeScript known replay, idempotency-key deduplication, sequence growth, and non-mutating unknown replay; `authoring-parity` proves known/unknown, normal, dry-run, and concurrent replay plus sequence growth through Specmatic for YAML, TypeScript, and mixed configurations.                                                                                                                                                                                                                                                                                                                                                                                               |

### Time invariants

- Virtual time must never be implemented by sleeping the process.
- A request offset is not an update to the shared clock.
- Reset must clear events, state, projections, idempotency entries, sessions,
  dynamic faults, and virtual-clock offset together.
- Time-travel reads and event replay must not create ordinary command events
  unless replay is explicitly defined to do so.
- Every clock-dependent behavior needs a deterministic test clock; wall-clock
  sleeps are not sufficient evidence.

## Delays, fixed/random latency, jitter, and connection drops

### Boundary and response latency matrix

The committed README defines this exact boundary configuration:

```yaml
latency:
  fixed_ms: 20
  min_ms: 30
  max_ms: 60
```

The required formula is `fixed_ms + one uniform sample in [min_ms, max_ms]`.
The fixed and random portions are independently optional and stack when both
are present. The random source must be injectable in TypeScript.

| Feature                   | Required semantics                                                                                    | Existing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Gap                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `latency.fixed_ms`        | Deterministic delay on each response owned by the boundary.                                           | `latency` measures the fixed floor, reset behavior, idempotency replay, forwarding path, and no-configuration contrast through the real Specmatic JVM for YAML, TypeScript, and mixed configurations; `runtime-latency-parity` covers injected direct ports.                                                                                                                                                                                                                            | `G-06` is closed for the documented fixed-latency combinations.            |
| `latency.min_ms`/`max_ms` | Fresh uniform sample per request, with valid bounds and no accidental negative delay.                 | `latency` measures a configured range in all three authoring modes; `runtime-latency-parity` uses injected random sources and checks exact bounds; YAML parser and TypeScript SDK tests reject malformed, negative, unknown, and reversed ranges.                                                                                                                                                                                                                                       | `G-07` is closed for configuration validation and valid forwarding parity. |
| Stacked boundary latency  | Fixed delay plus random sample, not either/or.                                                        | `latency` checks the lower stacked floor through Specmatic; `runtime-latency-parity` asserts exact `[20, 30]` sleep calls for YAML and TypeScript and verifies the event commits once; reset, replay, and side-effect checks run for all three loading modes.                                                                                                                                                                                                                           | `G-08` is closed for the covered stacked combinations.                     |
| Fault/error latency       | Fault `delay_ms`, fixed latency, force/slow latency, and jitter must have an explicit stacking order. | `latency` proves additive declarative/typed fault delay, selected 503 body, and zero committed events for YAML, TypeScript, and mixed modes; it also proves forced-error plus force/slow/jitter stacking; `chaos-headers` and `runtime-controls` cover generic controls. `authoring-parity` additionally proves a fresh idempotency key remains uncommitted when forwarded drop, fixed latency, slow response, non-zero jitter, response shaping, masking, and truncation are combined. | `G-09`: broader multi-fault/replay permutations remain.                    |

### Per-request latency and network shaping

| Header                                      | Meaning                                                                                  | Parsing/limits                                                                                                        | Current evidence and gap                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Potemkin-Force-Latency: <ms>`            | Add fixed latency to the response.                                                       | Non-negative finite milliseconds; the current chaos implementation caps the header-driven delay at 30 seconds.        | `chaos-headers` proves the existing path; `runtime-latency-parity` proves it stacks with the YAML/TypeScript boundary plan.                                                                                                                                                                                                      |
| `X-Potemkin-Slow-Response: <ms>`            | Vocabulary alias for fixed latency; it stacks with `Force-Latency` and boundary latency. | Same validation and cap as force latency.                                                                             | Existing-path evidence in `chaos-headers.e2e-test.ts`; `runtime-latency-parity.runtime.test.ts` proves both aliases are additive on the new runtime.                                                                                                                                                                             |
| `X-Potemkin-Jitter: <max>` or `<min>:<max>` | Add a uniform random delay; a single value means `[0,max]`.                              | Non-negative finite values up to 30 seconds; `max >= min`; malformed, reversed, and over-limit values are ignored.    | `authoring-parity` proves valid fixed jitter on an authored fault while force-status/error-class compete, plus invalid reversed-range behavior, for YAML, TypeScript, and mixed loading; `runtime-latency-parity` proves deterministic YAML+TypeScript composition.                                                              |
| `X-Potemkin-Body-Truncate: <bytes>`         | Serialize the winning response and truncate it after status/fault selection.             | Non-negative integer; the runtime truncates UTF-8 bytes and the transport writes the result without quoting it again. | `RuntimeEngine` uses `TextEncoder`/`TextDecoder`; `runtimeExchange` covers bounded capture; `authoring-parity` proves multibyte JSON:API success, selected 418 error, and no mutation through YAML, TypeScript, and mixed Specmatic paths; `query-policy-authoring-parity` proves paginated-envelope truncation. G-11 is closed. |
| `X-Potemkin-Retry-After: <seconds>`         | Add `Retry-After` to the selected chaos response without changing the response status.   | Non-negative numeric seconds; integer serialization is required by the current contract.                              | `chaos-headers.e2e-test.ts` covers force-status and error-class combinations; `authoring-parity.e2e-test.ts` proves the new-runtime YAML/TypeScript/mixed matrix and named-fault precedence.                                                                                                                                     |

### Connection drops

`X-Potemkin-Drop-Connection: <ms>` is a transport-specific failure, not an
ordinary 504 response on the direct gateway:

1. evaluate the request and selected fault before mutation;
2. wait for the bounded interval;
3. close the direct HTTP connection without writing a response body; and
4. for `/_engine/forward`, return a synthetic `504`, `body: null`, and
   `X-Potemkin-Dropped: true`, because a request handler cannot reset the
   caller's socket.

| Transport           | Required evidence                                                                                                                                                                                         | Current status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct gateway      | YAML and TypeScript requests observe a closed connection; no event, state, saga, projection, webhook, or idempotency entry is created. Test zero delay, a positive delay, and the maximum accepted delay. | `runtime-direct-chaos` proves a real TCP client observes the closed connection for both authoring forms at zero and positive delay, uses an injected sleep port to prove the accepted 30-second bound without waiting 30 seconds, and proves a dropped idempotent request creates neither replay metadata nor derived projection state before a healthy same-key request commits once and then replays.                                                                                                                            |
| Forwarding envelope | YAML and TypeScript receive the synthetic 504, dropped marker, and no state mutation.                                                                                                                     | `runtime-observability` proves a positive 25ms drop through the Specmatic JVM for YAML, TypeScript, and mixed modes, including zero events and entities. `authoring-parity` additionally proves a dropped idempotent replay does not poison the cached success, mutation drops leave events, state, projections, and webhooks untouched before a subsequent healthy request, and a read-path drop leaves existing events/state unchanged before a healthy read. Invalid/over-limit drop values are ignored across all three modes. |

## Fault, chaos, rate-limit, and shorthand matrix

### Declarative fault rules

The README's canonical rule is:

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

The rule is evaluated before behavior evaluation. A match therefore produces
no guard evaluation, event, state projection, secondary command, saga, or
webhook. Ordered rules use first match. Matching must compose boundary, intent,
operation/method, request headers, condition, required scopes, and probability
where those fields are present.

| Fault capability      | YAML/parser form                                                                     | TypeScript/core form                                                                                      | Required assertions                                                                                 | Evidence/status                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static fault          | `fault_rules[]` with typed response and optional `delay_ms`.                         | A `RuntimeFault` with a typed predicate and response value/callback.                                      | Status, body, headers, delay, no mutation, no secondary work.                                       | `runtime-controls` proves the canonical path; `authoring-parity` proves authored header, selector, boundary/intent/condition, operationId/method, required-scope, requires-guard, probability, fixed jitter, and precedence faults with no mutation through Specmatic for YAML, TypeScript, and mixed modes.                                             |
| Dynamic fault         | `POST /_admin/faults` accepts the wire rule and optional `ttlMs`/`expiresAt`.        | Register a `RuntimeFault` in the runtime fault store; no CEL or YAML-shaped object should enter the core. | Registration/list/removal, TTL expiry, reset, and no state mutation on match.                       | `runtime-controls` proves typed registration, expiry, and reset; `configured-admin-faults` proves registration, listing, removal, invalid status/TTL/expiry, expiry, reset, and no mutation through Specmatic across YAML, TypeScript, static-factory, and mixed configurations. `G-14` is closed; broader typed-fault precedence remains `G-13`/`G-15`. |
| Header-selected fault | YAML `match.headers` or `match.potemkin`; parser expands aliases before compilation. | Typed header/signal predicate or a typed fault-selection policy.                                          | Exact and wildcard matching; selected YAML response overrides generic chaos response.               | `header-matching.e2e-test.ts`, `chaos-headers.e2e-test.ts`, `runtime-controls.runtime.test.ts`, and `authoring-parity.e2e-test.ts` cover the new-runtime selector path, including force-response, scenario, feature-flag, ordered first-match, wildcard, and forwarding combinations for YAML, TypeScript, and mixed modes.                              |
| Probability           | YAML fault probability or a typed random gate.                                       | Injected `RuntimeHelpers.random()` / typed policy.                                                        | `0` never fires, `1` always fires, intermediate values are reproducible under a seeded test source. | `authoring-parity` proves probability `0`, `1`, and `0.5` YAML/TypeScript fault selection through Specmatic in all three modes, with deterministic seeds proving both the selected and skipped outcomes.                                                                                                                                                 | —   |

### Rate-limit behavior

There are two related but distinct contracts:

| Form                             | Required behavior                                                                                                                                                                      | Status                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Potemkin-Rate-Limit: <value>` | A truthy value triggers a synthetic 429 with a rate-limit body; false-like values (`false`, `0`, `off`, `no`) do not trigger it. `Retry-After` may be layered on the winning response. | `authoring-parity.e2e-test.ts` proves truthy and false-like values, retry behavior, and no-event assertions for YAML, TypeScript, and mixed configurations.                                           |
| YAML shorthand                   | `match.potemkin.rate_limit: "*"` expands to a match for the canonical rate-limit header.                                                                                               | `header-matching.e2e-test.ts` and `chaos-headers.e2e-test.ts` cover the parser/gateway path; `authoring-parity.e2e-test.ts` proves the direct TypeScript equivalent and new-parser-to-runtime parity. |
| Application policy               | A real counter/window/token-bucket is not implied by the README. A rate-limit response selected by a header is scenario injection, not production throttling.                          | Any algorithm must be an explicit typed policy with its own state and tests.                                                                                                                          | No evidence of a complete typed window algorithm is required by this baseline. |

### Chaos precedence

For the new runtime, the selection order must be documented and tested as a
single matrix. The required order is:

| Priority | Signal                                        | Behavior                                                                                                       |
| -------: | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
|        1 | `X-Potemkin-Use-Fault`                        | Named fault response wins verbatim. Unknown names do not create a fault.                                       |
|        2 | Matching declarative header fault             | The first ordered YAML/typed fault whose header predicate matches owns the response shape.                     |
|        3 | `X-Potemkin-Force-Status`                     | Valid integer `100..599`; generic forced-status body unless a matching fault supplied the body.                |
|        4 | `X-Potemkin-Error-Class`                      | `timeout` 504, `throttle` 429, `outage` 503, `bad_gateway` 502, `conflict` 409, `auth` 401, `forbidden` 403.   |
|        5 | `X-Potemkin-Drop-Connection`                  | Close direct connection or return forwarding synthetic 504. It must prevent the mutation from being committed. |
|        6 | `X-Potemkin-Rate-Limit` / `signal=rate_limit` | Synthetic 429.                                                                                                 |
|        7 | `X-Potemkin-Success-Rate`                     | A failed random gate returns 503; a passing gate continues normally. `0..1` and `0..100` forms are accepted.   |

Latency controls (`Force-Latency`, `Slow-Response`, `Jitter`) stack with
boundary/fault latency and do not change which response wins. `Retry-After` and
`Body-Truncate` apply after response selection. Every precedence row needs a
test with at least one competing signal, plus status/body/header/event/state
assertions. `chaos-headers.e2e-test.ts` proves the existing gateway path;
`authoring-parity.e2e-test.ts` proves rate-limit and forwarding drop behavior on
the new runtime, and `runtime-controls.runtime.test.ts` proves selector
variants without mutation.

### Additional signal names requiring an explicit decision

The current header contract also names `X-Potemkin-Signal`,
`X-Potemkin-Force-Response`, `X-Potemkin-Scenario`, and
`X-Potemkin-Feature-Flag`. These are selector controls: a matching typed
`RuntimeFault` (or parser-compiled YAML fault) owns the response. They do not
invent a response or implement a production feature-flag service.
`authoring-parity.e2e-test.ts` proves the direct and parser paths for the named
selectors; `G-15` remains for the
complete first-match, wildcard, and forwarding matrix.

## Seven control tiers

The README says the `X-Potemkin-*` controls cover seven tiers and points to
`control-headers`. The complete operational matrix is:

| Tier                            | Controls                                                                                                                        | Required behavior                                                                                                                                                                                         | Existing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Gap                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. Transparency and determinism | `Dry-Run`, `Include-Events`, `Echo`, `Seed`, `Clock-Offset`                                                                     | Run evaluation and optionally expose generated events/debug data; dry-run discards state/events; seeded values and request time are isolated.                                                             | `control-headers.e2e-test.ts` proves dry-run, events, and echo on forwarding; `runtime-seeded-parity.runtime.test.ts` proves seeded YAML/TypeScript values; `runtime-clock-offset.runtime.test.ts` proves request-local clock offsets; `runtime-controls.runtime.test.ts` proves direct concurrent isolation; `latency.e2e-test.ts` proves concurrent seed/clock forwarding for all three authoring modes; `authoring-parity.e2e-test.ts` proves all five controls composed in one dry-run request through Specmatic; `session-authoring-parity.e2e-test.ts` proves concurrent future/historical session expiry decisions do not evict shared sessions; `configured-admin-faults.e2e-test.ts` proves the equivalent dynamic-fault TTL behavior. | Closed by `authoring-parity`, `session-authoring-parity`, and `configured-admin-faults`. |
| 2. Side-effect control          | `Skip-Sagas`, `Skip-Webhooks`, `Skip-Projections`, `Skip-Reactions`, `Skip-Dispatch`, `Max-Cascade-Depth`, `Bulk-Transactional` | Primary events may commit while the selected secondary work is suppressed; cascade limit returns a typed failure; transactional bulk commits all items or none and defers post-commit work until success. | `control-headers.e2e-test.ts` proves skip-dispatch. `bulk-side-effects-authoring-parity.e2e-test.ts` proves transactional bulk rollback, webhook deferral, derived-projection initialization/mutation/reset, and all independent/combined side-effect controls for YAML, TypeScript, and mixed modes through Specmatic.                                                                                                                                                                                                                                                                                                                                                                                                                         | Closed by `bulk-side-effects-authoring-parity`.                                          |
| 3. Identity and audit           | `Actor`, `Caused-By`, `Impersonate`                                                                                             | Actor override and impersonation are admin-gated; events and audit fields record the effective actor, original actor where applicable, and causal event.                                                  | `control-headers.e2e-test.ts` proves actor 401/403 and caused-by on forwarding. `authoring-parity.e2e-test.ts` proves caused-by linkage, unauthorized/authorized overrides, and effective/original actor event metadata through Specmatic for YAML, TypeScript, and mixed modes, including both unauthorized and authorized impersonation.                                                                                                                                                                                                                                                                                                                                                                                                      | Closed by `authoring-parity`.                                                            |
| 4. Event-sourcing time travel   | `Read-At-Version`, `Replay-Event`                                                                                               | Historical reads are isolated; replay has defined event/projection/idempotency semantics; unknown IDs are non-mutating typed errors.                                                                      | `control-headers.e2e-test.ts` proves the forwarding envelope; `runtime-time-travel.runtime.test.ts` proves direct YAML/TypeScript semantics; `authoring-parity.e2e-test.ts` proves historical reads and known/unknown replay, including dry-run and concurrent aggregates, through Specmatic for all three authoring modes.                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                        |
| 5. Response format              | `Response-Format: hal/jsonapi/plain`, `Pagination-Style: envelope/raw/link-header`, `Mask`                                      | Apply pagination and format transforms in a defined order; preserve headers and contract rules; masks affect served responses but not raw admin state/events.                                             | `runtime-response-shaping` proves YAML/TypeScript raw, envelope, link-header, HAL, JSON:API, mask, and raw-admin-state behavior. `authoring-parity` proves HAL, JSON:API, plain, request-mask combinations, and canonical error documents when HAL/JSON:API are requested on 404/418 responses; `bulk-side-effects-authoring-parity` additionally proves JSON:API and HAL response items for transactional bulk in all three loading modes; `query-policy-authoring-parity` proves the complete 3×3 collection cross-product (plain/HAL/JSON:API × envelope/raw/link-header) with masking, HATEOAS, cursors, and link headers for YAML, TypeScript, and mixed loading. The shared runtime limits HATEOAS/action links to successful responses.  | Closed by the dedicated response-format parity matrix.                                   |
| 6. Observability injection      | `Trace-Id`, `Span-Name`, `Log-Level`, `Metric-Tag`                                                                              | Controls reach the typed observability dependency and are isolated per request; response echoes are optional transport evidence, not the OTEL implementation.                                             | `control-headers.e2e-test.ts` proves trace/span reflection; unit observability tests prove core request/result callbacks; `runtime-observability.e2e-test.ts` proves injected transport observations, all four controls, and production OTLP/HTTP span exports for successful and faulted final outcomes through Specmatic for YAML, TypeScript, and mixed configurations; `server.integration.test.ts` proves production-server injection.                                                                                                                                                                                                                                                                                                     | Broader OTEL metrics and observability outcome combinations remain in the gap register.  |
| 7. Validation control           | `Skip-Request-Validation`, `Skip-Response-Validation`, `Allow-Additional-Properties`                                            | All are admin-gated. Normal request validation remains enabled; bypassing structural validation does not bypass domain guards, auth, authorization, or event-schema validation.                           | `validation-controls-authoring-parity` proves strict request/response failures, no mutation, independent response bypass and additional-property relaxation, combined request/response bypass, administrator authorization, and real Specmatic forwarding for YAML, TypeScript, and mixed loading.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Closed by the dedicated validation-control matrix.                                       |

## Validation and side-effect ordering

These ordering rules prevent a control header from accidentally weakening the
domain model:

| Stage                              | Required rule                                                                                                                                                                             | Failure/no-side-effect assertion                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Request binding and validation     | Bind OpenAPI method/path/query/body first. Unless the request-validation control is authorized, reject structural violations before behavior evaluation.                                  | `400 CONTRACT_VIOLATION`; no event, state, saga, projection, webhook, or idempotency reservation.                  |
| Authentication and authorization   | Authentication, session/CSRF, scope checks, and admin checks are independent of request-validation bypass.                                                                                | 401 for no actor, 403 for known actor without scope; no mutation.                                                  |
| Fault/chaos selection              | Faults and direct chaos short-circuit mutation. Latency does not turn a fault into a committed command.                                                                                   | Status/body/header match selected fault; event and state counts unchanged.                                         |
| Behavior/guard/reaction evaluation | Dry-run evaluates the full path but discards the transaction. Skip controls suppress only their named side effects.                                                                       | Returned debug/events may show attempted work; committed state/events and selected side effects match the control. |
| Commit and post-commit             | A successful primary transaction commits before sagas/webhooks; transactional bulk defers post-commit work until every item succeeds.                                                     | Failed bulk has no earlier item, webhook, saga, reaction, projection, or idempotency residue.                      |
| Response validation and shaping    | The README requires masking after contract validation and forwarding `_patches` for required fields. Pagination/alternate formats must not be confused with the contract-shaped response. | Invalid normal response fails validation; authorized bypass is explicit; served body/header shape is stable.       |

The new engine validates the contract-shaped response in `src/core/engine.ts`
before applying boundary/request masks or alternate representations.
`validation-controls-authoring-parity.e2e-test.ts` proves
this ordering for both authoring forms, including a required field that is masked
from the served response while remaining present in the raw admin state. The
`bulk-side-effects-authoring-parity.e2e-test.ts` matrix now also proves that
plain and JSON:API transactional bulk items are masked while committed primary
state and secondary work retain their original values. The same matrix now
proves that a JSON:API alternate-format mask is forwarded as a patch journal
for bulk arrays, applied to array-shaped responses, and removed before the
caller receives the response. `G-22` remains only for broader forwarded
patch-journal combinations; the validation-controls parity
matrix proves an invalid response still fails before a mask can hide the
invalid field. The authoring-parity matrix also proves a multi-operation
forwarded patch journal (boundary removal, HATEOAS addition, and request-mask
replacement) is applied in the transport envelope and stripped from the
caller-facing response. Its YAML, TypeScript, and mixed cases now replay that
journal consistently across create, read, and update requests. The bulk
alternate-format case is also covered for YAML, TypeScript, and mixed loading;
retain the gap only for pagination or root-shape combinations not represented
by the canonical matrix.

## Administrative APIs

The committed README explicitly names reset, state, events, clock
manipulation, and fault injection. The current operational contract makes the
following routes concrete. Admin responses are raw debugging surfaces: they are
not subject to normal response masking.

| Endpoint                     | Contract                                                                                                                                                                          | Current implementation/evidence                                                                                                                                                                                                                                                                                                                                                               | Gap                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /_admin/reset`         | Reset volatile state to the deterministic seed baseline. Clear event log, projections, sessions, idempotency, dynamic faults, and virtual clock.                                  | New engine reset code clears these stores; `runtime-ttl` proves event/state/idempotency/session/fault/clock clearing for YAML and TypeScript; `runtime-derived-projection` proves seeded projection restoration; `session-authoring-parity` proves an active session is invalidated and the clock returns to a known offset through Specmatic for YAML, TypeScript, and mixed configurations. | `G-23` remains for fresh-boot comparison and the wider reset/admin matrix.                              |
| `POST /_admin/clock/advance` | Body `{ ms: finite number }`; advance virtual time without sleeping; return `{ offsetMs }`.                                                                                       | `admin-surface-authoring-parity.e2e-test.ts` proves the response and timestamp movement for both paths; `session-authoring-parity.e2e-test.ts` proves TTL expiry and the post-reset offset for all three authoring modes through Specmatic; the concurrent session, idempotency, and dynamic-fault cases prove request-local offsets do not mutate the shared clock or TTL stores.            | —                                                                                                       |
| `POST /_admin/clock/reset`   | Restore offset to zero; return `{ offsetMs: 0 }`.                                                                                                                                 | `admin-surface-authoring-parity.e2e-test.ts` proves both paths; `session-authoring-parity.e2e-test.ts` proves reset invalidates a live session and the next advance starts from zero for YAML, TypeScript, and mixed configurations; the concurrency matrix proves historical/future observations remain isolated.                                                                            | —                                                                                                       |
| `GET /_admin/health`         | Return readiness/liveness information.                                                                                                                                            | New runtime gateway returns `{ status: "ok", ready: true }`; `admin-surface-authoring-parity` asserts readiness and entity/event counts for YAML, TypeScript, and mixed loading.                                                                                                                                                                                                              | —                                                                                                       |
| `GET /_admin/state`          | Return raw entities; `?boundary=<name>` scopes the result; unknown boundary is 404.                                                                                               | New runtime gateway implements it; `bulk-side-effects-authoring-parity.e2e-test.ts` reads state and uses it for rollback assertions; `admin-surface-authoring-parity.e2e-test.ts` proves unscoped and boundary-scoped raw state, unknown-boundary 404, unmasked fields, and reset parity for all three modes.                                                                                 | —                                                                                                       |
| `GET /_admin/events`         | Return raw events; filter by `aggregateId` and `type`; support `count`, `limit`, and `offset`.                                                                                    | New runtime gateway implements all listed query fields; `admin-surface-authoring-parity.e2e-test.ts` filters by aggregate and proves both filters, count, bounded pages, empty offset, and reset parity for all three modes.                                                                                                                                                                  | —                                                                                                       |
| `GET /_admin/derived/:name`  | Return named derived projection state; unknown projection is 404.                                                                                                                 | New runtime gateway implements declared-projection lookup and raw entries; `runtime-derived-projection`, `admin-surface-authoring-parity`, and `bulk-side-effects-authoring-parity` prove seeded, post-mutation, reset, unknown-projection, and side-effect suppression behavior for YAML, TypeScript, and mixed loading.                                                                     | —                                                                                                       |
| `POST /_admin/faults`        | Validate `match`/`response`, require status `100..599`, accept optional positive `ttlMs` or future `expiresAt`, compile YAML conditions at the parser boundary, and return an ID. | `admin-surface-authoring-parity.e2e-test.ts` registers a dynamic fault for both YAML and TypeScript boot paths; `configured-admin-faults.e2e-test.ts` proves the parser-owned wire path and invalid status/TTL/expiry behavior through Specmatic.                                                                                                                                             | `G-13`/`G-15`: typed-fault precedence and complete selector combinations remain.                        |
| `GET /_admin/faults`         | List active dynamic faults and normalized typed metadata; expired entries are absent. Parser source text must not enter the core runtime.                                         | New runtime gateway and unit TTL tests exist; `configured-admin-faults` and `admin-surface-authoring-parity` exercise listing on the new YAML, TypeScript, static-factory, and mixed paths with bearer protection.                                                                                                                                                                            | —                                                                                                       |
| `DELETE /_admin/faults/:id`  | Remove a fault; unknown IDs are 404; successful removal is 204.                                                                                                                   | `admin-surface-authoring-parity.e2e-test.ts` and `configured-admin-faults.e2e-test.ts` prove successful deletion and unknown-ID behavior for each new authoring mode.                                                                                                                                                                                                                         | —                                                                                                       |
| `GET /_admin/model`          | Current runtime diagnostic endpoint listing boundaries and operation IDs; not named by the committed README.                                                                      | Implemented by the new runtime gateway.                                                                                                                                                                                                                                                                                                                                                       | Treat as diagnostic surface, not baseline feature evidence; add a decision on whether it is public API. |

### Admin access policy

- With no `ADMIN_TOKEN`, the README specifies fail-open admin routes for local
  development and CI.
- With `ADMIN_TOKEN` set, every `/_admin/*` route requires
  `Authorization: Bearer <token>`.
- Raw state and event payloads remain unmasked even when the token is set and
  must not be exposed to an untrusted network.
- Admin-gated request controls must preserve the 401/403 distinction: no
  recognizable actor is 401; a recognized actor without admin authority is 403.

The new runtime gateway has a token guard for admin routes and a separate
admin-control check for request headers. `admin-surface-authoring-parity` proves
missing, incorrect, and correct bearer-token handling across every administrative
route for YAML, TypeScript, and mixed loading; `validation-controls-authoring-parity`
proves the separate 401/403 scope distinction for admin-gated request controls.

## Forwarding and transport parity

The README's Specmatic section requires stateful route discovery, forwarding,
fixtures, health/restart signaling, hot reload, and contract validation. For
the operational controls in this document:

| Forwarded behavior             | Required result                                                                                    | Current status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/_engine/forward`             | Bind forwarded method/path/query/body/headers into the same runtime request as direct HTTP.        | `authoring-parity.e2e-test.ts` and `bulk-side-effects-authoring-parity.e2e-test.ts` prove single requests and transactional bulk through the real Specmatic path for YAML, TypeScript, and mixed loading.                                                                                                                                                                                                                                                                                                                   |
| Chaos headers                  | Preserve status, headers, body, latency controls, drops, and no-side-effect semantics.             | `authoring-parity.e2e-test.ts` proves rate-limit and synthetic drop; `runtime-observability.e2e-test.ts` adds positive-delay forwarding drop and no-mutation assertions; complete chaos matrix is `G-10`, `G-12`, and `G-13`.                                                                                                                                                                                                                                                                                               |
| Control tiers                  | Preserve all seven tiers and their authorization through the forwarding envelope.                  | `control-headers.e2e-test.ts` proves selected controls on the existing full stack; `authoring-parity.e2e-test.ts` and `validation-controls-authoring-parity.e2e-test.ts` cover the new direct-TypeScript and mixed forwarding controls.                                                                                                                                                                                                                                                                                     |
| Contract validation            | Invalid requests are rejected before behavior and produce no events.                               | `contract-validation.e2e-test.ts` plus `validation-controls-authoring-parity.e2e-test.ts` prove new-runtime YAML/TypeScript/mixed request and response validation through Specmatic.                                                                                                                                                                                                                                                                                                                                        |
| Route/fixture/restart surfaces | Route discovery, fixture push, ready/shutdown, health monitoring, and hot reload remain available. | Existing suites cover route discovery, fixtures, readiness/health, and shutdown; `query-policy-authoring-parity` proves an initialized entity is pushed and served with identical state through Specmatic for YAML, TypeScript, and mixed loading. `configured-source-matrix` proves an edited watched YAML source is reloaded automatically through the configured polling watcher, while `fixture-hot-reload` proves explicit reload and Node engine restart while the Specmatic JVM remains unchanged. `G-25` is closed. |

## Gap register

The matrix above identifies the work needed to claim operational completeness:

- `G-01` is closed: `authoring-parity` proves concurrent request-local
  idempotency expiry decisions; `session-authoring-parity` proves concurrent
  session expiry decisions; and `configured-admin-faults` proves concurrent
  dynamic-fault TTL decisions. Each runs through Specmatic across YAML,
  TypeScript, and mixed loading and checks that request-local time does not
  evict shared state or advance the shared clock.
- `G-02` and `G-03` are closed: `runtime-controls` proves direct concurrent
  YAML/TypeScript isolation and `latency` proves concurrent offset/seed
  isolation through the Specmatic forwarding path for YAML, TypeScript, and
  mixed configurations.
- `G-04` is closed: `authoring-parity` proves ordered same-operation behavior
  matching through the real Specmatic path. YAML, TypeScript, and mixed
  configurations select the first header-matched branch and otherwise select
  the following fallback, with event, response-state, and explicit response
  status assertions. YAML `response_status` and TypeScript `.status(202)` are
  compiled into the same runtime behavior shape.
- Dispatch-only behavior parity is covered by the same authoring matrix:
  YAML `dispatch_commands` and TypeScript `.dispatch(...)` can execute
  secondary work without a primary event, and all three Specmatic modes prove
  that the primary aggregate remains unchanged.
- `G-06`–`G-08` are closed: `latency` and `runtime-latency-parity` prove fixed,
  ranged, stacked, reset, replay, forwarding, and no-mutation behavior for
  YAML, TypeScript, and mixed loading; parser and SDK tests reject malformed
  latency consistently before the runtime model is built.
- `G-09`: `authoring-parity` now proves declarative-fault precedence over an
  existing idempotency replay, confirms the failed fault does not poison the
  cached success, and combines force-latency, slow-response, and deterministic
  jitter controls. It also proves that a forwarded connection drop does not
  poison a cached idempotent success or any primary/secondary side effect,
  with a healthy follow-up request after the drop. `latency.e2e-test.ts` now
  adds the same no-poison replay proof for the typed YAML/TypeScript fault
  delay combined with boundary latency. The same Specmatic path now combines
  forwarding drop with response format, masking, and truncation controls and
  proves the empty drop envelope and no mutation. `runtime-direct-chaos` also
  proves direct connection-drop isolation from idempotency and derived
  projections. It also proves a forwarded GET drop against an existing
  aggregate leaves the event log and state unchanged before a healthy read.
  A fresh idempotency key combined with forwarded drop, fixed/slow latency,
  non-zero jitter, response shaping, masking, and truncation is also shown to
  remain absent after the drop, then commit once and replay on a healthy retry.
  `G-10` and `G-12` remain open only for broader jitter and
  direct/forwarded connection-drop permutations. `session-authoring-parity`
  now adds the authenticated cookie/CSRF cross-product: a named fault wins
  over drop and other chaos controls, a dropped request does not persist its
  idempotency key, and a healthy retry commits once and then replays through
  Specmatic for YAML, TypeScript, and mixed loading.
- `G-11` is closed: the real Specmatic authoring-parity suites cover UTF-8-safe
  truncation on shaped success, selected error, and paginated responses for
  YAML, TypeScript, and mixed configurations, including no-mutation checks.
- `G-13` and `G-15`: ordered and wildcard header, boundary/intent/condition,
  operationId/method, required-scope and requires-guard selection, seeded
  intermediate probability, and scenario/feature selector combinations are
  covered by `authoring-parity`. The real Specmatic matrix now also exercises
  the highest-priority named-fault path while force-status, error-class,
  rate-limit, success-rate, response-format, masking, truncation, latency, and
  idempotency controls compete; it verifies the named response wins, no work is
  committed, and a subsequent same-key healthy request commits once and then
  replays. `configured-admin-faults` now proves the same precedence for a
  dynamically registered named fault across YAML, TypeScript, static-factory,
  and mixed loading, including a competing connection drop. The session parity
  matrix also proves valid session and CSRF authentication precedes that same
  dynamic fault and that recovery works after removal. It now also proves the
  authenticated dynamic-fault/drop/idempotency sequence and its one-commit,
  one-replay recovery. Remaining work is broader forwarded-drop/auth/session
  permutations, not a missing YAML or TypeScript fault primitive. The JWT
  parity matrix now also proves invalid authentication wins over competing
  drop/status/error-class controls and that a valid authenticated drop leaves
  no idempotency reservation before healthy commit/replay recovery.
  `G-14` is covered by `configured-admin-faults` and the parser/wire unit tests.
- `G-17` is closed: `bulk-side-effects-authoring-parity` proves the complete
  primary/secondary event graph, selected side-effect suppression, webhook
  delivery, and transactional rollback for YAML, TypeScript, and mixed loading
  through Specmatic.
- `G-18` is closed: `authoring-parity` proves caused-by, effective/original
  actor metadata, unauthorized and authorized actor override, and unauthorized
  and authorized impersonation through the real Specmatic path for YAML,
  TypeScript, and mixed loading.
- `G-19` is closed: `query-policy-authoring-parity` covers the complete 3×3
  response-format/pagination cross-product with masking, HATEOAS, cursors, and
  link headers through Specmatic for YAML, TypeScript, and mixed loading.
  Existing authoring-parity and bulk-side-effects coverage supplies the
  canonical formatted-error and transactional collection cases.
- `G-20` is reduced to broader OTEL metrics and observability outcome
  combinations. The `runtime-observability` Specmatic matrix now proves the
  production OTLP/HTTP exporter emits final spans containing the request,
  correlation, transport, and serialized Potemkin outcome for both successful
  and faulted requests across YAML, TypeScript, and mixed loading. It also
  proves source-independent OTLP metrics for committed writes, successful
  reads, faulted requests, appended events, and transactional bulk committed
  and rolled-back outcomes, including operation/status/outcome attributes,
  across all three loading modes. Request-scoped trace ID,
  span name, log-level override, and metric-tag propagation remain covered by
  the injected runtime ports.
- `G-21` is closed: `validation-controls-authoring-parity` proves request and
  response validation, both response controls, combined request/response
  bypass, administrator authorization, and no-mutation failures through
  Specmatic for YAML, TypeScript, and mixed loading.
- `G-22`: response-mask ordering is implemented and unit-tested. The
  `authoring-parity` Specmatic matrix now proves boundary and request masks
  together for plain, HAL, and JSON:API responses across YAML, TypeScript,
  and mixed loading, while `bulk-side-effects-authoring-parity` proves plain
  and JSON:API masking across every transactional bulk item without changing
  committed state or secondary work. `validation-controls-authoring-parity`
  proves invalid response validation wins over a request mask. The bulk matrix
  also proves an alternate-format mask is represented by a patch journal and
  applied to an array-shaped response by the Specmatic plugin before the
  caller-facing response is returned. Retain the gap only for pagination or
  root-shape combinations not represented by the canonical matrix; the
  existing matrix proves the multi-operation journal is forwarded and removed
  from caller-facing responses.
- `G-23` and `G-24` are closed: `admin-surface-authoring-parity` proves fresh
  baseline versus reset state, health, raw state, event filters/count/pagination,
  derived projections, model, reload, clocks, and dynamic fault lifecycle across
  YAML, TypeScript, and mixed loading, while checking missing/wrong/correct bearer
  authorization on every admin route.
- `G-25` is closed: route, fixture push, health, readiness, ETag,
  forward-envelope parity, automatic watched-source reload, explicit
  configuration reload, and true Node process-restart fixture refresh while the
  Specmatic JVM remains running are covered by `runtime-specmatic-surface`,
  `runtime-reload`, `configured-source-matrix`, `query-policy-authoring-parity`,
  and `fixture-hot-reload`.

Until each gap has a typed core operation, a direct TypeScript authoring path, a
YAML parser projection, and the required E2E evidence, the corresponding row
must remain `Partial` or `Gap`. Existing YAML or pre-refactor gateway tests do
not close the parity requirement.

Latest verification (2026-08-03): the complete real Specmatic-backed E2E run
uses one shared Specmatic JVM and passes 76 suites and 958 tests with zero
skipped tests. The configured-source suite passes 13/13, including automatic
watched-source reload through Specmatic. `pnpm run verify` exits 0, including
the no-skip, VerifyX, example-export, TypeScript, formatting, and whitespace
checks. The bulk-side-effects suite now includes request-mask parity for plain
and JSON:API bulk responses plus forwarded alternate-format patch journals
across YAML, TypeScript, and mixed loading. The
generated Specmatic conformance gate remains green at 1,429 tests.
