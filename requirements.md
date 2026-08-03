# Requirements

Behavioural requirements for the Specmatic Stateful Simulation Engine, in EARS form.
Each requirement is covered by at least one BDD scenario whose title references its
`REQ-N` number (verified by the traceability scenario in
[`tests/bdd/features/traceability.feature`](tests/bdd/features/traceability.feature)).

## Architecture and write/read model

1. **The System shall** treat the OpenAPI contract as the authoritative schema source.
2. **The System shall** keep the write model (event log) and the read model (state graph) as independent stores.
3. **The System shall** ensure appended events cannot be modified.
4. **The System shall** make every state change traceable to an event.
5. **The System shall** generate events from DSL rules rather than mutating state directly.

## Commands and the Unit of Work

6. **The System shall** allow boundary A to emit a secondary command to boundary B.
7. **The System shall** treat primary and secondary commands as one atomic Unit of Work.
8. **The System shall** compile distributed DSL modules into a unified execution matrix at boot.
9. **The System shall** bind DSL boundaries to their contract routes.
10. **The System shall** turn initialization records into baseline events.
11. **The System shall** reflect the baseline in the state graph after boot.
12. **The System shall** reject an invalid request payload with a contract violation.
13. **The System shall** identify creation versus mutation intent during the identity phase.
14. **The System shall** create a command from an inbound request.
15. **The System shall** route a command to the correct boundary.
16. **The System shall** evaluate a command against the boundary's behavior rules in the pattern matcher.
17. **The System shall** fire only the first matching rule when multiple rules match.
18. **The System shall** have a matched rule produce an event rather than a direct state write.
19. **The System shall** stage secondary commands declared by a matched rule.
20. **The System shall** append events atomically after the Unit of Work completes.
21. **The System shall** advance the sequence version per appended event.
22. **The System shall** reflect a committed event in the state graph instantly.

## Errors and faults

23. **The System shall** fail fast on a DSL syntax error at boot.
24. **The System shall** return 400 CONTRACT_VIOLATION for an invalid request.
25. **The System shall** return 404 ENTITY_ABSENCE for a mutation of an absent entity.
26. **The System shall** return 409 ENTITY_CONFLICT for a creation of an existing entity.
27. **The System shall** return 422 UNHANDLED_OPERATION for an unmatched command with no fallback.
28. **The System shall** return 412 CONCURRENCY_CONFLICT for a stale sequence version.
29. **The System shall** return 428 MISSING_PRECONDITION for a missing required sequence version.
30. **The System shall** discard staged events and abort when an exception occurs in the Unit of Work.
31. **The System shall** return a simulated fault response when the fault signal header is present.
32. **The System shall** return 508 INFINITE_LOOP when a cascade exceeds the maximum depth.

## Queries and fallback

33. **The System shall** return the current entity state via read fallback when no rule matches.
34. **The System shall** generate a generic update event via mutation fallback.
35. **The System shall** return the matching subset for a collection query with filters.
36. **The System shall** include computed derived property values in a response.

## Lifecycle and reset

37. **The System shall** clear all events from the event log on reset.
38. **The System shall** clear all entities from the state graph on reset.
39. **The System shall** restore the baseline state after reset.
40. **The System shall** perform no disk writes during normal operation.

## Observability and schema

41. **The System shall** boot using pino, ajv, swagger-parser, and uuidv7.
42. **The System shall** emit pino logs at boot, Unit of Work, and projection.
43. **The System shall** create an OpenTelemetry span per Unit of Work execution.
44. **The System shall** populate the schema registry with an entry for each boundary after boot.
45. **The System shall** fail boot with BOOT_ERR_DSL_SCHEMA_VIOLATION for a DSL with an unknown state path.
46. **The System shall** abort the Unit of Work with SCHEMA_TYPE_MISMATCH for a wrong-typed reducer value.

## Traceability

47. **The System shall** ensure every requirement has at least one BDD scenario covering it.

## YAML and TypeScript authoring parity

The requirements in this section define a second authoring surface. They do not
replace the YAML DSL, and they do not require YAML to contain TypeScript source.
They require a developer to be able to describe the same simulation in TypeScript
when that is the better fit for the project. The TypeScript surface may use
interfaces, pure functions, builders, decorators, or a combination of them, but
the resulting simulation must have the same meaning as the equivalent YAML.

The canonical runtime model is source-independent. The YAML compiler converts YAML
declarations and CEL expressions into the same callback-based runtime definition
that direct TypeScript authoring supplies. The core engine shall
not consume YAML-shaped configuration, YAML field names, DSL strings, CEL source,
or parser registries; it shall consume only the normalized TypeScript runtime model
and explicit dependency-injected ports.

48. **The System shall** accept a TypeScript simulation definition whose normalized semantic model is equivalent to a YAML simulation definition containing the same boundary, global configuration, and contract bindings; both authoring forms shall produce the same callback-based runtime model before the core engine executes them. BDD scenario: `REQ-48 — equivalent YAML and TypeScript definitions produce the same normalized simulation model`.
49. **The System shall** provide TypeScript representations for every Potemkin configuration type exposed by the YAML DSL, including boundary definitions, global configuration, compiled definitions, component definitions, use mappings, include entries, and all nested declaration types. BDD scenario: `REQ-49 — every YAML declaration type can be constructed in TypeScript`.
50. **The System shall** provide TypeScript representations for every YAML variant, optional field, discriminated union, patch operation, authentication mode, fallback form, response form, and valid combination of those values. BDD scenario: `REQ-50 — YAML variants and combinations have TypeScript equivalents`.
51. **The System shall** provide a TypeScript representation for the top-level `potemkin.yml` configuration, including module sources, TypeScript scan configuration, plugin configuration, seeds, workflow configuration, overlays, and governance configuration, without requiring a developer to serialize that configuration to YAML first. BDD scenario: `REQ-51 — top-level Potemkin configuration can be supplied without YAML`.
52. **The System shall** apply the same canonicalization, defaulting, cross-reference checks, contract checks, and boot-time validation to TypeScript definitions as it applies to equivalent YAML definitions. BDD scenario: `REQ-52 — equivalent invalid YAML and TypeScript definitions fail with equivalent diagnostics`.
53. **The System shall** allow every YAML expression slot to be supplied either as an equivalent CEL expression or as a typed TypeScript expression with the same context, phase restrictions, determinism rules, and result semantics. BDD scenario: `REQ-53 — CEL and TypeScript expressions produce the same event and response values`.
54. **The System shall** expose typed functional interfaces for command, event, state, query, request, response, reducer, reaction, saga, projection, fault, webhook, and lifecycle contexts so TypeScript expressions do not require unchecked `any` values to access Potemkin data. BDD scenario: `REQ-54 — TypeScript callbacks receive typed phase-specific contexts`.
55. **The System shall** expose immutable builders and object-based interfaces for constructing every TypeScript definition, and each builder operation shall preserve the type and semantic information accumulated by earlier operations. BDD scenario: `REQ-55 — a TypeScript builder constructs a complete typed boundary without mutable configuration state`.
56. **The System shall** provide functional combinators for composing predicates, expressions, event emissions, patch lists, behaviours, reducers, reactions, sagas, projections, response transforms, and configuration fragments without requiring inheritance or framework-specific base classes. BDD scenario: `REQ-56 — composed pure functions produce the same result as equivalent declarative rules`.
57. **The System shall** expose all TypeScript parity types and construction functions through the supported Potemkin public API, rather than requiring consumers to import private implementation modules. BDD scenario: `REQ-57 — a consumer imports the complete TypeScript authoring surface from the public package entry point`.
58. **The System shall** bind TypeScript boundaries, components, and composed definitions to OpenAPI contracts using the same route, operation, request, response, and schema rules as YAML definitions. BDD scenario: `REQ-58 — a TypeScript boundary is routed and contract-validated like its YAML equivalent`.
59. **The System shall** support TypeScript declarations for boundary identity generation and key extraction, query mappings, fallback policy, event catalogues, payload templates, behaviours, first-match ordering, guards, required scopes, header matching, conditional emissions, postconditions, and secondary commands. BDD scenario: `REQ-59 — TypeScript declarations cover routing, identity, matching, events, and dispatch`.
60. **The System shall** support TypeScript declarations for every reducer form and every reducer patch operation currently accepted in YAML, including `add`, `remove`, `replace`, `append`, `prepend`, `increment`, `merge`, `upsert`, `move`, `copy`, whole-state replacement, and TypeScript reducer implementations. BDD scenario: `REQ-60 — every YAML reducer form and patch variant can be authored in TypeScript`.
61. **The System shall** support TypeScript declarations for initialization records, baseline seeds, seed request matchers, seed patches, deterministic reset behaviour, and any seed expectation or fixture data that can be supplied through YAML. BDD scenario: `REQ-61 — TypeScript seeds produce the same baseline and reset state as YAML seeds`.
62. **The System shall** support TypeScript declarations for collection and entity queries, query filters, pagination, sorting, array operators, computed fields, derived properties, fallback reads, and fallback mutations with the same observable results as YAML. BDD scenario: `REQ-62 — TypeScript query and fallback declarations return the same graph projections as YAML`.
63. **The System shall** support TypeScript declarations for cross-boundary dispatch, choreography reactions, sagas and compensation, derived projections, event subscriptions, target selection, payload overrides, and their valid compositions. BDD scenario: `REQ-63 — a TypeScript multi-boundary workflow preserves YAML atomicity and ordering`.
64. **The System shall** support TypeScript declarations for response shaping, including masks, audit fields, HATEOAS links, deprecation and sunset headers, response scripts, security headers, latency, API versioning, and response mutation rules. BDD scenario: `REQ-64 — TypeScript response policies produce the same body and headers as YAML policies`.
65. **The System shall** support TypeScript declarations for simple, JWT, and session authentication, scopes and claims, CSRF rules, idempotency, preconditions, sequence-version concurrency, and their valid combinations. BDD scenario: `REQ-65 — TypeScript security and consistency policies enforce the same requests as YAML policies`.
66. **The System shall** support TypeScript declarations for static and dynamic fault rules, probabilities, delays, control headers, forwarding policies, workflow and overlay data, webhook triggers, HMAC payloads, and retry policies. BDD scenario: `REQ-66 — TypeScript fault, forwarding, and webhook declarations preserve their YAML effects`.
67. **The System shall** support TypeScript declarations for resource expansion, reusable components, parameter declarations and substitution, `use` mappings, `include` fragments, aliases, cross-component reference rewriting, and all valid combinations of those composition mechanisms. BDD scenario: `REQ-67 — a composed TypeScript resource graph has the same concrete boundaries as a composed YAML graph`.
68. **The System shall** support TypeScript participation in every supported lifecycle phase and hook, including boot, validation, initialization, request execution, projection, post-commit side effects, reset, shutdown, and TypeScript watch or reload, with the same ordering, isolation, and failure semantics as YAML-driven behaviour. BDD scenario: `REQ-68 — TypeScript lifecycle hooks run in the same phases and order as YAML lifecycle behaviour`.
69. **The System shall** support typed helper functions, native reducers, response transforms, and other supported TypeScript extension points through explicit functional interfaces, with duplicate and missing registration diagnostics equivalent to YAML reference diagnostics. BDD scenario: `REQ-69 — functional TypeScript registrations resolve identically`.
70. **The System shall** preserve event sourcing, immutable event records, shadow-graph projection, Unit of Work atomicity, cascade termination, reaction budgets, saga compensation, concurrency checks, and reset determinism for TypeScript-authored definitions. BDD scenario: `REQ-70 — TypeScript-authored work commits and rolls back with YAML transaction semantics`.
71. **The System shall** preserve the same runtime error codes, HTTP statuses, structured error fields, logging fields, metrics, traces, and diagnostic source locations for equivalent YAML and TypeScript definitions. BDD scenario: `REQ-71 — equivalent YAML and TypeScript failures expose equivalent errors and observability data`.
72. **The System shall** provide a parity comparison or conformance mechanism that can execute equivalent YAML and TypeScript definitions against the same contract and compare normalized configuration, event logs, state graphs, responses, headers, errors, and side-effect records. This mechanism is test-harness infrastructure under `tests/equivalence/`; it shall not be imported by or exported from the core engine, YAML parser, direct TypeScript authoring API, or package root. BDD scenario: `REQ-72 — the parity harness detects a semantic difference between equivalent authoring forms`.
73. **The System shall** support mixed authoring in which YAML and TypeScript definitions are loaded together, composed, and validated without changing precedence, ordering, naming, or cross-reference semantics. BDD scenario: `REQ-73 — a mixed YAML and TypeScript simulation composes without semantic drift`.
74. **The System shall** report whether a TypeScript definition is complete, including unresolved references, unsupported combinations, missing contract bindings, missing registrations, invalid builder states, and values that cannot be represented by the active YAML/TypeScript parity model. BDD scenario: `REQ-74 — incomplete TypeScript definitions fail before the system accepts traffic`.
75. **The System shall** include at least one executable BDD scenario for every requirement in this section and shall include parity scenarios covering each supported Potemkin feature family and each material variant or combination. BDD scenario: `REQ-75 — parity requirements are traceable to executable BDD scenarios`.

## Observability backlog

76. **The System shall** emit exactly one OpenTelemetry request/response observation for every handled HTTP exchange on the direct gateway and the Specmatic forwarding path, including successful, validation, authentication, authorization, fault, chaos, admin, bulk, and rollback outcomes. The observation shall preserve the original request as received at the transport boundary and the final response actually returned to the caller after all Potemkin behaviour, side effects, response shaping, chaos, masking, validation, and rollback handling have completed. It shall include the final status, headers, and body, not an intermediate engine result; when the transport closes without a response it shall record that final transport outcome and any forwarding-layer synthetic response. Request and response data shall share the request's trace and Potemkin command correlation. Body capture shall be controlled by an explicit dependency-injected redaction and byte-size policy, with captured, truncated, and omitted states distinguishable; it shall not be inferred from debug logging or silently capture unrestricted payloads. BDD scenario: `REQ-76 — final OTEL observations contain the original request and post-behaviour response for YAML and TypeScript authoring`.

REQ-76 is only complete when the implementation and evidence cover all of the
following:

- successful requests whose response is changed by projections, sagas, webhooks,
  response shaping, masks, audit fields, HATEOAS, or security headers;
- rejected requests and declared or dynamic chaos, including the final error
  status, headers, and body returned by the HTTP boundary;
- validation failures, transactional rollback, and bulk/secondary-command
  paths without exposing a partially completed response as final;
- one consistent trace/command correlation record for YAML and direct
  TypeScript authoring; and
- real-use end-to-end tests that assert the captured observation for both
  authoring forms, plus tests for the injected redaction/size policy.

### Agent backlog task for REQ-76

- [x] Capture an immutable copy of the original HTTP request at the direct
      transport boundary, before parsing, matching, validation, mutation,
      masking, or other Potemkin processing changes the request representation.
- [x] Emit exactly one OTEL exchange observation after the HTTP transport has
      finished, containing the status, headers, and body actually sent to the
      caller. For a closed connection, record the close outcome instead of an
      invented response; for Specmatic forwarding, record the original caller
      request and the final forwarding response returned to Specmatic.
- [x] Ensure the observation is finalized after projections, reactions, sagas,
      webhooks, response shaping, chaos, response validation, masking,
      truncation, and rollback handling, including early validation/auth/admin
      failures and bulk failures.
- [x] Preserve the same trace and Potemkin command correlation on the request
      and response fields for YAML and direct TypeScript authoring.
- [x] Apply the injected redaction and byte-limit policy before exporting body
      data, and distinguish captured, truncated, and omitted payloads.
- [x] Add real-use E2E assertions for direct YAML, direct TypeScript, and
      Specmatic-forwarded success, rejection, fault/chaos, admin, bulk
      rollback, and closed-connection exchanges.

Implementation evidence recorded on 2026-08-02:

- The direct gateway captures a frozen method/path/query/header snapshot before
  body parsing, records exactly once on `finish` or a transport close, and
  applies the injected redaction and byte-limit policy to detached body values
  before invoking the observer. JSON request bodies are reconstructed from the
  captured raw bytes, so later parser/runtime mutation cannot rewrite the
  original transport request.
- The shared real Specmatic harness now injects a bounded observation collector
  into the canonical runtime. `tests/e2e/runtime-observability.e2e-test.ts`
  proves YAML, TypeScript, and mixed success and fault exchanges through the
  running Specmatic JVM and plugin, including nested forwarded response
  envelopes, trace correlation, and no event commit on a fault.
- The same real Specmatic suite now covers control-header chaos, an
  admin-plane response, the forwarding-layer synthetic closed-connection
  result, and transactional bulk success and rollback for YAML and
  TypeScript. Bulk requests and responses use the common runtime model's
  outer-document, item, and aggregate validation paths; no business assertion
  calls `/_engine/forward` directly.
- `tests/e2e/authoring-parity.e2e-test.ts` adds a real Specmatic-backed
  authoring matrix for direct YAML, direct TypeScript, and mixed YAML plus
  TypeScript configuration. Each mode proves final response shaping,
  dispatch, reactions, projections, saga-created state, webhook HMAC
  delivery, security headers, masking, HATEOAS, declared faults, and
  idempotency/replay semantics through the Specmatic JVM rather than by
  calling `/_engine/forward`. The complete E2E run now passes 76 suites and
  958 tests, including the 75 authoring-parity cases, the 30 session
  authoring-parity cases, and the 9 JWT authoring-parity cases. The identity
  case also
  proves caused-by linkage, admin-gated override authorization, and event
  snapshots that preserve both effective and original actor identities.
- `tests/e2e/latency.e2e-test.ts` now runs fixed, ranged, stacked, and
  fault-plus-boundary latency through Specmatic for YAML, TypeScript, and
  mixed configurations. Its 30 tests prove equivalent response bodies,
  boundary scoping, additive fault delay, and no event commit on the declared
  503 response.
- `tests/e2e/runtime-observability.e2e-test.ts` now includes a mixed
  YAML/TypeScript bulk configuration. The 33 transport-observability tests
  prove successful transactional bulk, rollback, and source-independent OTLP
  metrics through Specmatic for
  YAML, TypeScript, and mixed loading.
- The authoring matrix now proves virtual-clock idempotency expiry and clock
  reset for all three modes. The latency matrix now proves seeded identity
  determinism, delayed idempotency replay, and combined boundary/chaos delay
  with forced status; it passes 30 tests across the same three modes.
- The same authoring matrix now covers scenario and feature-flag selector
  faults through YAML and typed TypeScript definitions, with the mixed mode
  exercising the YAML declarations alongside TypeScript boundaries.
- `tests/e2e/session-authoring-parity.e2e-test.ts` proves session login,
  cookie authentication, CSRF enforcement, scope authorization, logout,
  virtual-clock expiry, and reset invalidation through the real Specmatic JVM
  for YAML, TypeScript, and mixed configurations. Its 30 tests are part of the
  76-suite / 958-test E2E run.
- `tests/runtime/authoring-http-parity.runtime.test.ts` proves the same
  configured YAML and TypeScript fixture semantics on the direct HTTP path,
  including one final observation after dispatch/reaction/projection/webhook
  work, original request capture, trace correlation, masking, and HATEOAS;
  the direct authoring parity runtime coverage passes 44 tests.
- The direct HTTP integration suite now covers configured YAML and configured
  TypeScript success, validation failure, chaos, admin, and transactional bulk
  success/rollback exchanges with one observed record per trace. Its injected
  redaction and byte-limit policy proves secret omission and distinguishable
  truncation. The direct TCP chaos parity suite also asserts the captured
  `connectionClosed` observation for both authoring forms.
- The one-JVM E2E collector is shared across Jest VMs through the existing
  owner registry, while assertions select the unique trace-correlated business
  exchange so health, reload, and warmup traffic cannot hide or duplicate the
  result under test.
- Request-scoped observability controls are now applied at the source-neutral
  runtime boundary: `logLevel` overrides injected diagnostic severity and
  `metricTag` is merged into every metric emitted for that request. Unit
  coverage proves the typed behavior, and `runtime-observability.e2e-test.ts`
  proves trace ID, span name, log level, and metric tag through the real
  Specmatic JVM for YAML, TypeScript, and mixed configurations.
- The production OTLP metrics path now consumes the same source-neutral runtime
  metric port. `runtime-observability.e2e-test.ts` proves committed-write,
  successful-read, faulted-request, and appended-event counters through the
  real Specmatic JVM for YAML, TypeScript, and mixed configurations, including
  operation, status, outcome, and request metric-tag attributes.
- The Specmatic-forwarding observer now applies the same immutable response
  patch journal as the plugin before exporting its response copy. The
  authoring-parity test asserts that the observed body is masked and contains
  HATEOAS links, while the observed headers contain security and custom
  response headers for YAML, TypeScript, and mixed configurations. The focused
  parity suite passes 57/57 and the dedicated transport-observability suite
  passes 33/33 across all three modes.
- REQ-76 is complete: the retained non-live Jest run passes 194 suites / 2,718
  tests, full real Specmatic-backed E2E passes 76 suites / 958 tests, and TypeScript, Verify,
  formatting, and whitespace checks pass.

## Explicit backlog from the committed main README

The following requirements refine capabilities that the committed baseline
describes in examples, control-header tables, linked tests, or Specmatic
documentation but that the numbered summary above currently groups too
coarsely. They are backlog requirements, not claims that the current runtime
is complete. Each requirement needs a source-independent TypeScript runtime,
direct typed TypeScript authoring, YAML parser/compiler parity, and real-use
end-to-end evidence for both authoring forms. Where a behavior belongs to the
Specmatic transport, the engine and plugin evidence must be kept separate.

77. **The System shall** preserve runtime correctness invariants across YAML and TypeScript authoring: domain events shall be immutable, use the documented UUIDv7 and metadata shape, have monotonically increasing per-aggregate sequence numbers and non-decreasing timestamps, and be the only source of projected state changes. Rejected requests, including contract, route, authentication, authorization, guard, concurrency, fallback, and fault failures, shall leave the event log and state graph unchanged and shall return a stable structured error without stack or filesystem-path leakage. BDD scenario: `REQ-77 — runtime event and failure invariants hold for YAML and TypeScript`.

78. **The System shall** support the complete baseline read-model surface in both authoring forms: soft deletion shall mark and timestamp an entity, exclude it from normal reads, and expose it only when `includeDeleted` is requested; collection queries shall support mapped filters, comparison and advanced operators, array membership, full-text search, sparse fields, sorting, pagination, and relationship expansion while preserving the source relationship identifiers. BDD scenario: `REQ-78 — query extensions and soft deletion compose identically for YAML and TypeScript`.

79. **The System shall** provide a typed deterministic data-generation and temporal-data port for direct TypeScript authoring, and the YAML parser shall compile `$fake()`, `$uuidv7()`, `$now()`, and equivalent seeded values to that port. Equal request seeds shall produce equal generated values, different seeds shall produce independently generated values, timestamps and nested sequence values shall obey the documented ordering rules, and schema or guard boundary values shall be enforced without leaking request-local randomness or time between concurrent requests. BDD scenario: `REQ-79 — seeded data generation and temporal values are isolated and equivalent`.

80. **The System shall** implement the complete side-effect lifecycle in both authoring forms: sagas shall execute after the triggering commit, record their lifecycle events, dispatch ordered creation or mutation steps, and compensate completed steps in reverse order; derived projections shall subscribe to cross-boundary events and update keyed read models; reactions shall be independent subscriptions that support fan-out, chaining, conditional existing-aggregate mutation, cycle prevention, stable ordering, and event budgets; and webhooks shall execute after commit with event-selected payloads, optional HMAC signatures, delays, bounded retries, and backoff. Failure, skip controls, and rollback shall not leave partial side effects. BDD scenario: `REQ-80 — saga, projection, reaction, and webhook lifecycle semantics match`.

81. **The System shall** preserve the complete HTTP response and protocol surface for YAML and TypeScript programs: HATEOAS shall support global, static, self, and conditional method-aware links; boundary masks shall remove fields while request masks may replace values with the documented sentinel; deprecation shall emit Deprecation, optional Sunset, and successor Link headers; security headers shall apply to success, error, and admin responses; fixed and random boundary latency shall be independently configurable and composable; API version prefixes shall route to the same boundary and emit the documented version header; ETag and Last-Modified behavior shall include creation responses; `HEAD` shall match GET status with an empty body; and `OPTIONS` shall provide the configured CORS preflight response. BDD scenario: `REQ-81 — response shaping and HTTP protocol behavior are equivalent for YAML and TypeScript`.

82. **The System shall** evaluate declarative fault rules before behavior matching and support global and boundary-scoped rules, ordered matching, boundary, intent, condition, method, request-header, and `potemkin:` alias predicates, and configured status, body, headers, and delay. A matched fault shall short-circuit guards, behaviors, event creation, projection, secondary dispatch, sagas, reactions, and webhooks, and shall leave state and the event log unchanged. BDD scenario: `REQ-82 — declarative fault matching short-circuits without mutation`.

83. **The System shall** support the full typed per-request chaos surface and its YAML equivalent: named fault selection, forced status, canonical error classes (`timeout`, `throttle`, `outage`, `bad_gateway`, `conflict`, `auth`, and `forbidden`), rate-limit simulation, success-rate gating, retry-after, response-body truncation, and connection-drop behavior. Rate-limit simulation shall remain an explicit request-triggered fault rather than an implicit token-bucket implementation. Direct HTTP shall distinguish a closed connection from a normal response, while the Specmatic forwarding path shall use the documented bounded synthetic response and drop marker. BDD scenario: `REQ-83 — every chaos signal has the documented direct and forwarding result`.

84. **The System shall** implement all delay controls as typed, bounded, injectable policies: boundary `fixed_ms` shall add deterministic latency; `min_ms` and `max_ms` shall sample a fresh uniform delay per request; fixed and random boundary latency shall stack; `Force-Latency` and its `Slow-Response` alias shall add fixed latency; `Jitter` shall accept both a maximum and a minimum-to-maximum range and add a uniform sample; and malformed, negative, or over-limit values shall be rejected or ignored according to one documented policy. These delays shall apply to the selected success or error response without creating duplicate commits or additional state transitions. BDD scenario: `REQ-84 — configured and request-scoped delays compose with deterministic bounds`.

85. **The System shall** enforce one documented fault and chaos precedence for both authoring forms: named fault selection shall take precedence over forced status, forced status over error class, error class over connection drop, connection drop over success-rate gating, and success-rate gating over normal behavior; latency, jitter, retry-after, and truncation shall apply to the winning response or transport outcome. YAML response bodies and headers shall remain authoritative when a matching YAML rule supplies them. BDD scenario: `REQ-85 — fault, rate-limit, status, and latency precedence is stable`.

86. **The System shall** support the complete transparency and side-effect control surface with typed request controls and equivalent YAML parsing: dry-run shall evaluate guards, conditions, hydration, and projection planning but commit nothing; include-events shall expose staged events; echo shall expose matched behavior, intent, and dispatched secondaries; skip-sagas, skip-webhooks, skip-projections, skip-reactions, and skip-dispatch shall operate independently; maximum cascade depth shall be overridable within policy; and bulk array requests shall support explicit transactional all-or-nothing and non-transactional modes. BDD scenario: `REQ-86 — transparency and side-effect controls compose without state leakage`.

87. **The System shall** support the complete time and event-history control surface: an authorized admin caller shall advance or reset the per-runtime virtual clock without sleeping; reset shall restore the clock and all TTL-bearing stores; a signed per-request clock offset shall apply only to that request; read-at-version shall reconstruct transient historical state without changing live state; and replay-by-event-id shall apply the documented event, idempotency, projection, and unknown-event rules without partial writes. BDD scenario: `REQ-87 — virtual time, historical reads, and event replay are isolated and deterministic`.

88. **The System shall** support typed equivalents for identity/audit, response, observability, and validation controls: actor override, caused-by linkage, and impersonation shall be admin-gated and preserve original and effective identities; response format shall select HAL, JSON:API, or plain output; pagination style shall select envelope, raw, or link-header output; per-request masks shall replace values independently of boundary masks; trace id, span name, log level, and metric tag shall be request-scoped; and request validation, response validation, and additional-property relaxation shall be independently controllable and admin-gated. These controls shall not bypass authentication, authorization, domain guards, or event-schema validation unless explicitly configured. BDD scenario: `REQ-88 — typed control policies preserve authorization, formatting, and validation boundaries`.

89. **The System shall** expose the documented administrative surface for both runtime authoring paths: reset, health, raw state with boundary filtering, raw events with aggregate/type/count/limit/offset filtering, derived projections, dynamic fault registration/listing/deletion with TTL or expiry, and virtual clock advance/reset. The surface shall be fail-open only when `ADMIN_TOKEN` is unset and shall require `Authorization: Bearer <token>` for every admin endpoint when it is set; raw state and event payloads shall remain explicitly unmasked debugging data. BDD scenario: `REQ-89 — administrative operations and access policy are complete for YAML and TypeScript`.

90. **The System shall** preserve the complete Specmatic integration contract for YAML and TypeScript runtime projections: the plugin shall intercept registered stateful routes and forward them to `/_engine/forward`, leave unregistered routes to the normal stub, discover routes through `/_engine/routes`, push seeded fixtures through `/_engine/fixtures`, and preserve separate runtime and forward-layer seed forms. Forward blocks shall propagate workflow identifiers, seed variants, response overlays, and JWT-authenticated requests. BDD scenario: `REQ-90 — Specmatic route discovery, fixture push, forwarding, and overlays match both authoring forms`.

91. **The System shall** support Specmatic lifecycle and reliability behavior without placing plugin concepts in the core engine: ready and shutdown notifications, health monitoring, circuit-breaker state, fixture refresh after engine restart, and hot reload shall keep the stub projection synchronized; direct TypeScript and YAML programs shall be able to boot, reset, shut down, and reload through the same lifecycle semantics. BDD scenario: `REQ-91 — Specmatic restart, readiness, reliability, and hot reload preserve runtime state contracts`.

92. **The System shall** validate every direct and forwarded request against the OpenAPI contract before behavior evaluation by default, return the documented `400 CONTRACT_VIOLATION` response with no event or state change, preserve the documented engine-forward request and response envelope, and keep request-validation bypass independent from response validation and domain authorization. BDD scenario: `REQ-92 — direct and forwarded contract validation fail consistently before behavior execution`.

Implementation evidence recorded on 2026-08-01:

- Request validation is implemented in the source-neutral
  `src/contract/requestValidator.ts` module and is used by both direct HTTP
  and `/_engine/forward` execution. It validates path, query, header, and
  complete request-body schemas before behavior evaluation; entity-tag
  normalization is shared with the gateway and declared operation schemas
  remain authoritative.
- The full one-JVM Specmatic-backed E2E suite passes with 68 suites and 689
  tests, while the generated Specmatic conformance gate passes with 1,426
  tests and no failures.

93. **The System shall** include parity E2E coverage for the required combinations rather than only isolated primitives: identity sources with seeds, reset, validation, and idempotency; behavior matching with guards, scopes, emit-when, postconditions, and failed dispatch; all patch operations with nested state, computed fields, audit, soft delete, and replay; advanced queries with masks, ETags, and HATEOAS; JWT, simulation bearer, sessions, CSRF, and admin-gated controls; saga failure and compensation with reactions, projections, and webhooks; all latency, chaos, rate-limit, retry-after, truncation, success-rate, and drop-connection controls; dry-run, echo, include-events, virtual time, clock offset, and seeded randomness; response formats with pagination, CORS, HEAD, versioning, deprecation, and validation; and direct HTTP plus the complete Specmatic lifecycle. BDD scenario: `REQ-93 — the YAML and TypeScript feature-combination matrix is executable and complete`.

Implementation evidence recorded on 2026-08-02:

- `tests/e2e/authoring-parity.e2e-test.ts` now exercises the same control
  combinations through the real Specmatic JVM for YAML, TypeScript, and mixed
  configurations. The matrix covers independent saga, webhook, projection,
  and dispatch suppression; dry-run with event/debug transparency; cascade
  depth rollback; and state, event, projection, response, and webhook
  assertions. It also proves isolated historical reads, ETag/version headers,
  known event replay, sequence growth, and non-mutating unknown replay. The
  matrix also proves a YAML header fault and a selector-only typed TypeScript
  fault beat forced-status and error-class chaos without mutation. The
  focused suite now passes 66 tests, including forwarded connection-drop
  isolation across events, state, projections, webhooks, and a healthy
  follow-up request. The complete one-JVM E2E suite now passes 76 suites and
  958 tests.
- The TypeScript AST discovery, factory scanner, and module loader now live in
  the parser loader layer (`src/parser/typescriptDiscovery.ts`,
  `typescriptFactorySyntax.ts`, `typescriptFactoryScanner.ts`, and
  `typescriptLoader.ts`). The SDK-facing authoring layer contains only model
  and registration contracts; no loader implementation remains under
  `src/authoring`.
- The single configuration filename is now canonicalized to `potemkin.yml`
  across the server default, CLI tooling, Docker/Specmatic integration,
  examples, fixtures, tests, and documentation. Source-tree audit coverage
  rejects the removed `.yaml` configuration filename rather than accepting a
  compatibility fallback.
- The forwarding response path now preserves `_events` and `_debug` when
  static mask/HATEOAS patches are sent out-of-band to the Specmatic plugin.
  This keeps control responses equivalent between direct HTTP and the real
  Specmatic transport.
- The forwarding response envelope now compiles request-scoped value masks
  into the same out-of-band patch journal as static response mutations when a
  boundary also declares masks or HATEOAS. The real Specmatic authoring-parity
  matrix proves plain, HAL, and JSON:API responses preserve the final masked
  shape for YAML, TypeScript, and mixed configurations, including nested mask
  patch compilation for objects and arrays.
- The same matrix now covers rate-limit truthy/false-like values, forced
  status, typed error classes with `Retry-After`, seeded intermediate
  probability (both selected and skipped outcomes), boundary/intent/condition
  and operation/method fault predicates, required scopes, `requires` guards,
  and declarative-fault
  precedence. The TypeScript fault uses the same typed header matcher,
  required scope, and guard as the YAML declaration, so both paths select the
  authored response before generic chaos controls.
- `tests/e2e/query-policy-authoring-parity.e2e-test.ts` now proves that YAML,
  TypeScript, and mixed query policies preserve a paginated collection's
  metadata and fixed HATEOAS link when HAL, JSON:API, and link-header
  pagination controls are combined through Specmatic, including request
  masking on a filtered HAL collection with no next-page link.
- `tests/e2e/authoring-parity.e2e-test.ts` now proves through Specmatic that a
  declarative fault wins over a previously cached idempotency response, that
  the failed fault does not poison the cached success, and that force-latency,
  slow-response, and deterministic jitter compose for YAML, TypeScript, and
  mixed loading.
- Latency parity is now strict at both authoring boundaries: malformed YAML
  latency and malformed TypeScript SDK latency produce typed configuration
  failures instead of silently changing the runtime model. Valid fixed,
  ranged, stacked, fault, replay, reset, and forced-error/jitter combinations
  pass through Specmatic for YAML, TypeScript, and mixed loading.
- Ordered behavior matching now has a real parity proof: the shared fixture
  defines two behaviors for the same OpenAPI operation, with a header-selected
  first branch and an unconditional fallback. Specmatic E2E assertions verify
  the selected event and response state for YAML, TypeScript, and mixed
  loading, including equivalent YAML `response_status` and TypeScript
  `.status(202)` values in the common runtime model.
- Dispatch-only behavior parity is now covered as well: YAML
  `dispatch_commands` without `emit` or `emit_when` and TypeScript
  `.dispatch(...)` without `.emit(...)` both leave the primary aggregate
  unchanged while committing the secondary command through the real
  Specmatic path in YAML, TypeScript, and mixed configurations.
- `tests/e2e/session-authoring-parity.e2e-test.ts` now proves the authenticated
  session/CSRF, named-fault precedence, forwarded connection-drop, and
  idempotency cross-product through Specmatic for YAML, TypeScript, and mixed
  loading. The fault and dropped request leave no event or replay entry; the
  healthy retry commits once and a subsequent identical request replays.
- `tests/e2e/jwt-authoring-parity.e2e-test.ts` now proves the equivalent JWT
  policy through YAML, TypeScript, and mixed loading: valid scoped tokens
  preserve actor identity and replay idempotently, while invalid signatures,
  expired tokens, and missing scopes win over competing drop/status/error-class
  controls. A valid authenticated connection drop leaves no event or
  idempotency reservation; a healthy retry commits once and then replays. The
  TypeScript model compiler now obtains the same authentication implementation
  through the injected `RuntimeAuthenticationPort` used by YAML compilation.

94. **Backlog task — shared TypeScript helpers for YAML and TypeScript:** remove the
    former script-registration annotation and concept entirely; there shall be no
    `@Script` discovery or compatibility surface. A static `@PotemkinConfigure`
    factory shall be able to register typed, callable helper functions in the
    canonical runtime model. The same registered helper shall be invokable from
    TypeScript definitions and from YAML CEL, including when the active behaviour
    is otherwise YAML-defined. YAML and TypeScript shall therefore consume one
    source-independent helper representation rather than separate registries,
    adapters, or shims. Helper names and JSON return values shall be validated,
    duplicate registrations shall fail during compilation, and real
    Specmatic-backed E2E coverage shall prove YAML, TypeScript, and mixed
    configurations use the same helper semantics.

    Acceptance checklist:

    - [x] `@PotemkinConfigure` static factories can register helper functions
          without a second helper/script annotation.
    - [x] YAML CEL can call a helper registered by a TypeScript factory.
    - [x] TypeScript behaviour can call the same registered helper.
    - [x] Both authoring paths receive the same validated helper definition in
          the common runtime model.
    - [x] Duplicate names, invalid CEL identifiers, and non-JSON results fail
          with clear compile-time diagnostics.
    - [x] Specmatic-backed E2E tests cover YAML-only, TypeScript-only, and mixed
          YAML/TypeScript configurations.

    Implementation evidence recorded on 2026-08-01:

    - `defineHelper` supplies one callable typed SDK value and one frozen
      `RuntimeHelperDefinition`; the mixed compiler passes that same model to
      both YAML CEL and TypeScript behavior compilation.
    - Per-load factory discovery has no global helper/script registry. Invalid
      CEL names, duplicate model registrations, and non-JSON helper results
      produce typed diagnostics.
    - `tests/e2e/configured-source-matrix.e2e-test.ts` passes YAML,
      TypeScript, static-factory, mixed, dispatch, and force-reload cases through
      the real Specmatic JVM/plugin path. Focused helper and loader tests pass
      23/23 and the parity BDD suite remains green.

95. **Backlog task — regroup and normalize the test suite:** reorganize all
    tests by the behavior or layer they verify rather than by historical numeric
    prefixes. Unit, runtime, integration, BDD, Specmatic-backed E2E, plugin, and
    example tests shall each have descriptive, normal-looking filenames and
    directory groupings. Remove numeric test prefixes and stale numbering from
    test names, comments, traceability links, scripts, and documentation. The
    regrouping shall preserve every test's coverage, keep direct-runtime and
    real-Specmatic paths distinguishable, and leave no duplicate or orphaned
    test references.

    Acceptance checklist:

    - [x] Every test type is grouped under a descriptive behavior/layer area.
    - [x] Test filenames and suite names no longer use historical numeric
          prefixes.
    - [x] BDD traceability, package scripts, Jest configuration, and docs point
          to the regrouped paths.
    - [x] Unit, runtime, integration, plugin, example, and real Specmatic E2E
          coverage remains executable after the move.
    - [x] The reorganized suite retains YAML, TypeScript, and mixed parity
          coverage without adding compatibility paths.

    Implementation evidence recorded on 2026-08-01:

    - Numeric prefixes were removed from all existing runtime and
      Specmatic-backed E2E filenames. The layer directories remain explicit:
      `tests/unit`, `tests/runtime`, `tests/integration`, `tests/bdd`,
      `tests/e2e`, `tests/property`, and example/plugin test areas.
    - Traceability, README/design references, fixture comments, and test
      documentation now use the descriptive filenames. Jest and Cucumber
      discover the same test classes through their layer-based patterns.
    - The real Specmatic E2E suites, direct runtime suites, unit/integration
      suites, and BDD suite remain executable; YAML, TypeScript, and mixed
      parity tests remain separate and unchanged in behavior.

96. **Backlog task — reduce static coupling and type the TypeScript error
    surface:** perform a focused architecture review to replace process-global
    state, static service lookups, and static factories used as implementation
    dependencies with explicit dependency injection wherever the behavior does
    not require a user-facing static `@PotemkinConfigure` discovery method.
    Inject clocks, randomness, identifiers, logging, observability, storage,
    transports, configuration, and lifecycle ports through the runtime/model
    boundaries. The TypeScript SDK and loader shall expose typed error classes
    or discriminated error results with stable error codes, structured details,
    source locations where available, and `unknown`-safe narrowing; generic
    `Error` shall not be the public diagnostic contract for expected authoring,
    loading, validation, or compilation failures.

    Acceptance checklist:

    - [x] Static mutable state and hidden global service access are identified
          and removed or justified at an explicit boundary.
    - [x] Runtime, YAML parser, TypeScript SDK, loader, watcher, and transport
          dependencies are supplied through interfaces/ports.
    - [x] `@PotemkinConfigure` remains only as the intentional static discovery
          contract; discovered factories receive or use injected services.
    - [x] Expected TypeScript authoring and loader failures use typed errors or
          discriminated results with stable codes and structured details.
    - [x] Tests verify narrowing, codes, diagnostics, and dependency isolation
          for both YAML and TypeScript paths.
    - [x] The refactor does not add adapters, shims, aliases, or compatibility
          boot paths.

    Implementation evidence recorded on 2026-08-02:

    - TypeScript factory discovery now uses a per-load `FactoryCollector`,
      injected SDK, and per-loader module cache; there is no process-global
      factory registry or reset path.
    - `@PotemkinConfigure` is the only intentional static discovery surface.
      Expected authoring and loader failures use `TypeScriptAuthoringError`
      with stable codes, structured details, source locations, and
      `unknown`-safe narrowing; AST discovery now wraps source inspection and
      glob-resolution failures with the same contract; runtime-model
      validation uses `RuntimeModelError`.
    - Runtime version, CORS policy, admin token, and runtime-fault clock are
      supplied at explicit boundaries. The fault parser now requires its
      clock dependency instead of reading wall-clock time implicitly.
    - Runtime command identifiers, lifecycle hook duration clocks, lifecycle
      UUIDs, YAML lifecycle compilation clocks, and runtime storage clocks are
      supplied through runtime dependencies; lifecycle execution no longer
      reads `Date.now()` or creates identifiers internally.
    - Runtime data generation, idempotency expiry, and session identity/token
      creation now require explicit factories. The plugin lifecycle client
      receives its fetch transport and duration clock through a dependency
      port and reports HTTP failures with `PluginControlError`.
    - Configured runtime boot no longer reaches for `globalThis.fetch` or
      `AbortSignal.timeout`; the production server and test/example hosts
      inject `RuntimeWebhookTransport` dependencies, and non-success delivery
      responses use `RuntimeWebhookDeliveryError`.
    - Runtime clock, helper, UUID, data, clone, and session-token defaults are
      centralized in the explicit `RuntimeHostServices` composition boundary;
      runtime lifecycle metadata uses the injected helper clock. The host
      service factory is exported for embedding hosts that need deterministic
      replacements.
    - Isolation, duplicate registration, forbidden imports, loader failures,
      diagnostics, and CORS behavior are covered by focused unit tests; the
      complete unit suite passes with 149 suites and 2,295 tests. The full
      real Specmatic-backed E2E suite passes with 68 suites and 689 tests, and
      the Specmatic conformance gate passes with 1,429 generated tests.
    - Contract request validation is now a separate source-neutral module and
      validates path, query, header, and body contracts before behavior
      evaluation. HTTP entity-tag parsing is centralized so quoted and weak
      `If-Match` values reach typed concurrency handling, while malformed tags
      remain typed 400 failures; generic error aliases are not added to the
      forwarded response contract.
    - The lowest-level `bootRuntime` boundary now requires explicit
      `RuntimeHostServices`; defaults are created only by the CLI/example
      composition roots. Runtime clock/helper/session identity construction is
      therefore never implicit inside the engine boot path. Remaining audit
      work is the final parity evidence. REQ-95's test regrouping is complete.

    - The remaining observability defaults have now been removed from the
      authoring/contract library paths: CEL syntax validation is stateless,
      CEL evaluator diagnostics are injected per evaluator, and YAML linking,
      OpenAPI loading, contract validation, and schema validation accept
      host-owned logger/tracer ports. Standalone calls use inert per-call
      implementations rather than module-level instances. Configured boot and
      watcher reloads carry those ports through the full source graph, and the
      watcher scheduler plus lifecycle timeout-signal factory are injectable.
      Contract-shaped error bodies now receive the runtime helper clock and
      optional per-contract error-code map through the canonical runtime
      contract boundary. Focused DI tests cover evaluator isolation, YAML and
      OpenAPI diagnostic-port use, lifecycle transport timing, and configured
      runtime reload behavior. The OpenTelemetry exchange observer uses an
      inert tracer when no tracer is supplied; only the server composition root
      selects the process-backed tracer. The repository Verify suite,
      TypeScript check, formatter, and whitespace checks pass after the
      refactor.
    - Logger and tracing configuration now accept host-provided environment
      values and diagnostic sinks; the logger root singleton and tracing's
      hidden root logger have been removed. The Specmatic process runner also
      receives its child environment explicitly from the conformance CLI. The
      remaining process-environment reads are at composition roots such as the
      Potemkin server, conformance CLI, and bind-host boundary.
    - New `ConfigurationError` diagnostics cover invalid TypeScript config,
      runtime boot/reload inputs, control policies, and lifecycle inputs with
      stable `CONFIG_INVALID` codes, field details, public SDK exports, and
      `unknown`-safe narrowing tests. Example coverage passes 7 suites and 26
      tests; the real Specmatic-backed E2E path passes 68 suites and 689 tests;
      and the JVM plugin suite passes 316 tests with zero failures or errors.
    - Tier-1 example export now has a canonical `src/cli/export-examples.ts`
      entry point. By-id examples reuse the runtime fixture projection;
      collection examples invoke the real `createRuntimeGateway` in-process,
      then undergo source-neutral contract validation before any file is
      written. `ExportError` reports the boundary and path for invalid output.
      `createDeterministicRuntimeHost` supplies a pinned clock, deterministic
      helper randomness, and one host-scoped monotonic UUID stream without
      changing the production UUID path. CRM export and `--check` are green.
    - The full real Specmatic-backed E2E suite now passes 68 suites and 693
      tests. The transition-model analyzer handles absent optional values
      safely, and the latency contrast test accounts for unavoidable JVM and
      loopback transport overhead while still asserting the configured delay
      floor. The final static/global and no-compatibility-path audit remains
      tracked by the open Bead `potemkin-dd5e`.
    - The final sequential verification rerun passes with 152 unit suites and
      2,326 tests; type checking, linting, formatting, whitespace checks, and
      the example export reproducibility check are green.
    - The explicit source audit is enforced by
      `tests/unit/audit/dependencyBoundaries.test.ts`: it rejects removed
      adapter/shim/legacy/compatibility surfaces, keeps process-environment
      access at executable composition roots, and limits native clock,
      randomness, and timer access to documented providers. The audit passes
      3 tests; TypeScript and `verifyx --no-tests --measure` also pass.
      The remaining open Bead tracks broader YAML/TypeScript source-parity
      evidence and the separate Specmatic conformance work; it does not leave
      a static-dependency or compatibility-path exception undocumented.

97. **Backlog task — attempt a second-pass static-to-DI design refactor and
    complete the TypeScript typed-error audit:** review the remaining static
    methods, static state, singleton access, and hidden process services in
    the Potemkin runtime, model, YAML parser, TypeScript SDK, loader, watcher,
    and transport layers. Replace each implementation dependency with an
    explicit interface/port and constructor or factory injection wherever
    practical; retain a static method only when it is the deliberate
    `@PotemkinConfigure` discovery surface or an otherwise documented
    composition-root boundary. At the same time, audit every public
    TypeScript authoring and loading operation so expected failures use stable,
    structured typed errors (or a discriminated result), never a bare generic
    `Error` as the public diagnostic contract.

    Acceptance checklist:

    - [x] Every remaining static/global dependency is either refactored to an
          injected port or documented with a concrete reason and composition
          boundary.
    - [x] The TypeScript SDK and loader expose typed errors with stable codes,
          structured details, source locations where available, and
          `unknown`-safe narrowing for authoring, discovery, loading,
          validation, and compilation failures.
    - [x] YAML and TypeScript continue to produce the same source-neutral model
          and runtime behavior after the refactor.
    - [x] Tests prove dependency isolation and typed-error narrowing for both
          authoring paths, including nested/unknown failures.
    - [x] No adapters, shims, aliases, legacy paths, or compatibility boot
          behavior are introduced.

    Implementation evidence recorded on 2026-08-02:

    - Added the source-neutral YAML `query` policy projection for CEL field
      predicates and filters, deterministic sort keys, page sizing, cursors,
      expansion, pagination mode, deleted-row inclusion, and targeted
      fallbacks. TypeScript already supplies the equivalent callbacks through
      `BoundaryBuilder.query(...)`; both now compile to `RuntimeQueryPolicy`.
    - Added focused schema/compiler coverage and a real Specmatic-backed
      `query-policy-authoring-parity` fixture covering YAML, TypeScript, and
      mixed loading. The shared-JVM E2E suite passes 76 suites and 958 tests
      with zero skipped tests. Stripe behavior is tested only through local
      Potemkin runtimes and the vendored OpenAPI contract; no Stripe API key or
      network provider is part of the test path. TypeScript, formatting,
      whitespace, and Verify checks pass.
    - Removed the non-discovery `SimError.fromJSON` static factory in favour of
      the explicit `deserializeSimError` module operation, exported from the
      public package surface and hardened to reject unknown wire values safely.
      The source audit now parses TypeScript ASTs and rejects static
      implementation methods outside the intentional `@PotemkinConfigure`
      discovery contract. Focused error/audit coverage passes 43 tests; the
      full unit suite passes 159 suites / 2,376 tests.
    - REQ-97 is complete: the source-wide dependency-boundary audit documents
      the deliberate composition-root providers, AST-checks the static-method
      discovery exception, and rejects hidden static implementation methods.
      The TypeScript SDK/loader expose stable typed diagnostics, preserve
      unknown nested causes, and have isolation/narrowing coverage. No adapter,
      shim, alias, legacy path, or compatibility boot behavior was introduced.
    - The TypeScript authoring surface now uses semantic reference constructors
      in `src/authoring/references.ts` for boundary names, operation IDs, event
      types, contract paths, schema references, and response field paths.
      Branded references are required by the authoring builders, components,
      resources, and reducers, then lower to the same canonical string fields
      used by YAML. Malformed references raise the typed
      `TS_REFERENCE_INVALID` diagnostic, and `JsonPointerError` replaces the
      remaining generic pointer parse failure. Focused reference and parity
      coverage passes; the full direct runtime suite passes 21 suites / 109
      tests and the real shared-JVM Specmatic suite passes 76 suites / 958
      tests with zero skipped registrations.

98. **Backlog task — re-package the test suite around behavior and evaluate
    test value:** inventory every test file and regroup the suite by the layer
    and behavior it verifies, using descriptive names and directories rather
    than historical migration numbering. For each test, identify the behavior
    or invariant it protects, its canonical lower-level or real Specmatic
    boundary, and whether it is redundant, migration-only, or otherwise low
    value. Remove tests only when their useful assertion is already protected
    by a clearer canonical test; preserve the distinguishing direct runtime,
    YAML, TypeScript, mixed-source, watcher/reload, and real
    Specmatic-backed paths needed to prove the product contract.

    Acceptance checklist:

    - [x] Every test file is assigned to a sensible behavior/layer package with
          a descriptive, unnumbered name and an explicit purpose.
    - [x] Test coverage and traceability are used to identify duplicate,
          migration-only, brittle, and low/no-value tests before removal.
    - [x] The retained suite covers the source-neutral model, YAML parser/DSL,
          TypeScript SDK/loader, runtime engine, watcher/reload behavior, and
          real Specmatic E2E behavior, including YAML/TypeScript parity and
          mixed configurations.
    - [x] Jest, Cucumber, Gradle, package scripts, documentation, and any
          traceability references are updated for the new layout; no stale
          numbered or deleted-test references remain.
    - [x] The complete retained suite passes with zero skipped, focused, or
          todo registrations, and static, formatting, type, and whitespace
          verification remains green.
    - [x] The final change introduces no adapters, shims, aliases, legacy
          paths, or compatibility-only tests.

    Implementation evidence recorded on 2026-08-02:

    - The test organization and value rules are documented in
      `docs/design/test-organization-and-value.md`. The redundant two-case
      `authoring-parity.runtime.test.ts` smoke suite was removed after its
      assertions were confirmed in the broader parameterized
      `runtime-authoring-parity.runtime.test.ts` suite, and BDD traceability was
      moved to the canonical file.
    - `tests/_support/testValueInventory.ts` and
      `tests/unit/audit/testValueTraceability.test.ts` now machine-check that
      every test artifact has an explicit role, purpose, canonical boundary,
      and canonical evidence target. The inventory includes the TypeScript
      example suites and Kotlin plugin suites as well as the tests under
      `tests/`. The audit also asserts that the 80% Jest coverage thresholds
      and no-skip package gate remain configured.
    - `tests/unit/audit/sourceTree.test.ts` enforces the allowed test-layer
      directories, rejects numeric E2E filenames, and rejects stale references
      to deleted numbered tests or the removed smoke path. The real Specmatic
      suites remain separate from direct runtime tests and continue to cover
      YAML, TypeScript, and mixed configurations.
    - Latest retained-suite verification completed with 194 suites and 2,718
      passing tests; no tests are skipped, focused, or marked todo. The real
      Specmatic E2E collection passes 76 suites and 958 tests through one shared
      JVM. Coverage reports 88.79% statements, 88.61% functions, 90.09% lines,
      and 80.08% branches, clearing the configured 80% branch gate.

99. **Backlog task — perform a full codebase layer and module-structure
    sweep:** review every production source directory, entry point, public
    export, test support module, and package boundary against the intended
    Potemkin architecture. Refactor code that is in an odd or misleading
    location, split modules that mix responsibilities, move shared contracts
    to the layer that owns them, and remove accidental dependency direction
    violations. The resulting TypeScript package should use conventional,
    discoverable module layout and clear dependency flow between the YAML
    definition/parser and CEL layer, TypeScript SDK/loader, source-neutral
    model, runtime engine, transport, CLI, and composition roots.

    Acceptance checklist:

    - [x] A source-tree inventory maps each production module and public export
          to one architectural layer and one primary responsibility.
    - [x] Dependency direction is explicit and acyclic: model contracts do not
          depend on transports or authoring formats, runtime code consumes the
          model without YAML/TypeScript branching, and composition roots wire
          infrastructure through interfaces.
    - [x] Misplaced, mixed-responsibility, duplicate, and orphaned modules are
          moved, split, consolidated, or removed; package exports and import
          paths use conventional TypeScript module boundaries with no stale
          references.
    - [x] YAML loading, TypeScript SDK/discovery/loading, runtime model,
          engine, HTTP/Specmatic transport, CLI, and test support remain
          independently understandable and directly testable.
    - [x] Architecture-boundary tests or static checks prove the intended
          dependency rules, and documentation diagrams/matrices match the
          final source tree.
    - [x] The complete retained suite, type checker, linter, formatter,
          whitespace check, Verify gate, and zero-skip check pass without
          introducing adapters, shims, aliases, legacy paths, or compatibility
          behavior.

    Beads tracking: `potemkin-zxyl`.

    Implementation evidence recorded on 2026-08-02:

    - `docs/design/source-tree-architecture.md` records ownership, dependency
      direction, public boundaries, and the YAML/TypeScript-to-model-to-runtime
      flow. It separates the YAML/CEL parser, TypeScript SDK/loader, model,
      engine, transport, tooling, and Specmatic plugin layers.
    - The HTTP gateway sweep extracted transport observation into
      `src/http/runtimeObservation.ts`, admin/control-plane routes into
      `src/http/runtimeAdminRoutes.ts`, and gateway extension contracts into
      `src/http/runtimeGatewayTypes.ts`. The gateway now composes those
      modules, while focused ownership assertions prevent the responsibilities
      from drifting back into the gateway.
    - The existing import-closure, no-re-export, dependency-boundary, static
      method, and source-tree tests enforce the documented direction. The new
      source-tree audit passed all three checks after the test regrouping.
    - The module sweep moved the source-neutral runtime contracts, model
      compiler, functional builders, patch operations, and deterministic data
      provider into `src/model/`. `src/core/` now contains execution and
      storage collaborators only; `bootRuntime` accepts a canonical
      `RuntimeProgram` or an explicit program factory and has no
      `SimulationDefinition` branch. The root package no longer republishes
      the TypeScript authoring DSL; developers use the explicit `potemkin/sdk`
      export, while `./model/*` exposes the source-neutral model boundaries.
      Import-boundary, source-tree, TypeScript, Verify, formatting, BDD, plugin,
      example, and 76-suite/958-test real Specmatic checks pass after this
      relocation. Stripe behavior is verified locally from the vendored OpenAPI
      contract.
    - Specmatic/JVM process control, binary acquisition, port allocation,
      exported-corpus seeding, and example-stack composition now live in
      `src/conformance/`. Production conformance code no longer imports from
      `tests/` or `examples/`; the dependency-boundary audit and the real
      Specmatic suite pass after this move.
    - The retained non-live Jest collection now reports 194 passing suites and
      2,718 passing tests; no external Stripe integration is collected. No test
      is skipped or marked todo. Verify, type checking, formatting, whitespace, BDD (48
      scenarios/50 steps), and the real Specmatic E2E collection (76 suites /
      958 tests) are green. The configured 80% branch threshold passes at
      80.08% and has not been weakened.
    - The TypeScript module loader now uses the already-owned TypeScript
      compiler for in-process transpilation, preserving decorator and relative
      dependency loading without a native transpiler service. Focused loader
      coverage passes 15/15, and the normal retained Jest run exits cleanly
      with the retained non-live run passing 194 suites / 2,718 tests.
      Session-store test fixtures now dispose every created sweep
      timer, eliminating the aggregate open-handle warning.
    - The final source-tree sweep corrected stale moved-module references in
      the Specmatic plugin documentation and added a resolvability audit for
      every documented `src/**/*.ts` path. The architecture boundary suites
      pass 27/27; real pinned Specmatic conformance passes 1,429 CRM scenarios
      and 15 Stripe Layer-A scenarios. The Stripe consumer examples pass 7
      suites / 27 tests. The official 7MB Stripe contract is the authoritative
      contract; no live Stripe provider run is part of acceptance.
