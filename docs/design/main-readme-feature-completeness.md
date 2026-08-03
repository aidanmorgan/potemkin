# Main README feature-completeness baseline

This is the audit inventory for the implementation migration. The scope comes
from the committed file `main:README.md`, currently resolved at commit
`812f1c0d672af34337a983aed9c424d9a2f71cf4` in this worktree. The editable
`README.md` is documentation output; it is not the source of the completeness
claim.

The operational details are expanded in
[`main-readme-operational-feature-completeness.md`](./main-readme-operational-feature-completeness.md).
That companion inventory is part of this baseline; it covers the individual
clock, delay, rate-limit, fault, control-header, and admin behaviours that would
otherwise disappear inside the broad “chaos” and “consistency” rows below.

The additive cross-check in
[`main-readme-feature-audit-review.md`](./main-readme-feature-audit-review.md)
also records variants exposed by the linked baseline tests, such as soft delete,
bulk transactions, advanced query operators, HTTP protocol behaviour, and the
required feature combinations.

Every row below must have all of the following before the migration is complete:

1. a source-independent runtime implementation in the TypeScript engine;
2. a typed TypeScript authoring form using values, callbacks, builders, or
   dependency-injected ports rather than semantic strings;
3. a YAML parser/compiler that produces the same runtime shape, retaining
   CEL/DSL syntax only at the parser boundary; and
4. a real-use end-to-end test for both authoring forms.

The feature names and ordering follow the committed README. A test that only
exercises the historical YAML coordinator does not satisfy the TypeScript or
runtime columns.

## Feature inventory

### Runtime and transport foundations

The README's architecture and quick-start sections are part of the feature
contract even though they are not individual how-to headings:

- Maintain an append-only event log of immutable UUIDv7 domain events and a
  projected in-memory state graph keyed by aggregate id.
- Preserve aggregate sequence versions, event timestamps, actor/causal
  metadata, and deterministic replay. Rejected contract, auth, guard,
  concurrency, and fault paths must not append events or mutate state.
- Match behaviours in declaration order; the first matching rule wins. A
  Unit of Work owns the shadow graph, primary event, secondary commands, and
  atomic commit/rollback boundary.
- Keep state volatile and make `POST /_admin/reset` replay the frozen seed
  baseline deterministically, including the event log, projections, virtual
  clock, sessions, and dynamic faults.
- Support both documented transports: a standalone Express gateway and the
  Specmatic plugin path. Engine-only tests are not evidence for the full
  Specmatic wire, and a YAML-only coordinator is not evidence for the direct
  TypeScript runtime.
- Validate OpenAPI requests before behaviour evaluation and validate responses
  through the configured contract port. Preserve stable error codes/statuses,
  no-event failure semantics, and the boundary `fallback_override` policy for
  unhandled reads and mutations.
- Preserve ordinary HTTP behavior at the gateway boundary: method and route
  matching, JSON round-tripping, `OPTIONS` preflight, CORS allowlists and
  credentials, and the same response/error behavior on direct and forwarded
  requests.

### Defining the simulation

- Bind a boundary to an OpenAPI contract.
- Split a simulation across multiple YAML files.
- Seed initial state and reset to a known baseline.
- Generate an entity id on creation.
- Resolve an entity id from a header, query parameter, path segment, or request body.
- Declare the events a boundary can emit.
- Validate an event payload against an OpenAPI schema.
- Define an entity once and reuse it across paths.
- Share events and reducers across entities.
- Preserve contract defaults, optional properties, additional-properties
  policy, and boot-time validation of duplicate or unknown boundary/component
  references.

### Turning requests into events

- Route a request to a behaviour by operation.
- Allow a transition only from selected states.
- Enforce domain invariants before a transition runs.
- Select a behaviour using request headers.
- Emit different events according to intermediate state.
- Update another entity atomically in the same request.
- Match HTTP method as well as operation id, combine header predicates with
  command/state predicates using AND semantics, and preserve ordered
  first-match dispatch.
- Evaluate `requires` guards before ordinary conditions; a failed guard is a
  fail-fast typed 422 response and must not fall through to another behavior.
- Support `emit_when` branches, postconditions, and whole-Unit-of-Work
  rollback when a postcondition or secondary command fails.
- Support conditional, depth-first `dispatch_commands` for creation and
  mutation intents, with target/payload resolution, a maximum depth of five,
  and HTTP 508 loop protection.

### Projecting events

- Update entity state when an event happens.
- Support all ten patch operations: `add`, `replace`, `remove`, `append`,
  `prepend`, `increment`, `merge`, `upsert`, `copy`, and `move`.
- Write to nested paths and maintain computed totals.
- Record who changed an entity and when.
- Enforce declared computed-field dependencies at boot, with strict failure by
  default and `strict_schema: false` warning behavior.
- Preserve nested graph evolution and referential integrity across arrays,
  related aggregates, and sequential commands.
- Support soft deletion: mark an entity deleted with a deletion timestamp,
  hide it from ordinary collections, and expose it only when the documented
  include-deleted query control is used.
- Support array-body bulk create/update, including an explicit all-or-nothing
  transactional bulk mode with rollback of prior items and side effects.

### Reading the graph

- Filter a collection by a field.
- Return one page at a time with navigation links.
- Sort by multiple fields.
- Filter by array membership.
- Let clients select returned fields.
- Support the built-in query operators used by the baseline (`gt`, `gte`,
  `lt`, `lte`, `ne`, `startsWith`, `endsWith`, `contains`, `arrayContains`,
  and `in`) with correct scalar, string, number, and array semantics.
- Support full-text `q` search and relationship expansion with `include`,
  while retaining the source relationship id fields.
- Keep raw-array, pagination-envelope, and link-header forms distinct; make
  filtering, sorting, sparse fields, pagination, masking, links, and response
  formats composable without changing state or event semantics.

### Consistency and authentication

- Make a request safe to retry with idempotency keys.
- Reject a stale update with conditional requests and ETags.
- Require scopes for operations.
- Verify real JWTs.
- Simulate cookie sessions and CSRF protection.
- Preserve the simulation bearer-token form and its 401-versus-403 behavior,
  JWT signature/algorithm/claim validation, session login/logout/expiry, and
  CSRF rejection before behaviour evaluation.

### Workflows and side effects

- Coordinate a multi-step workflow with rollback compensation.
- Build a cross-boundary read model with derived projections.
- Run custom logic that CEL cannot express.
- Own an event projection in TypeScript.
- React to another boundary's events without coupling the source.
- Mutate an existing entity from a conditional reaction.
- Call another service through an event-triggered webhook.
- Record saga lifecycle events, run saga steps after the primary commit, and
  compensate completed steps in reverse order.
- Keep derived projections, reactions, sagas, and webhooks distinct: derived
  projections are queryable read models, reactions are atomic in-Unit-of-Work
  subscriptions that can chain/fan out, sagas are post-commit workflows, and
  webhooks are post-commit external deliveries.
- Support AST-discovered TypeScript configuration factories and typed helpers at
  the YAML boundary, while the direct TypeScript API registers typed
  callbacks/reducers without source-specific identifiers or scan-time runtime
  branches.

### Response shaping

- Add hypermedia links.
- Hide fields from responses.
- Mark endpoints deprecated.
- Add security headers.
- Add deliberate boundary latency.
- Route by URL version prefix.
- Apply RFC 8594 deprecation/sunset/replacement headers and security headers
  on success, error, and admin responses.
- Preserve HATEOAS self/action/static links, boundary field removal, and
  forwarding `_patches` response handling for masked contract-required fields.

### Chaos and request-time control

- Return an error for matching requests.
- Inject chaos per request.
- Drive engine behaviour with request control headers.
- Protect the administrative surface with the documented token policy.

These are separate capabilities, not one generic “chaos” row:

- Match a fault by boundary, intent, condition, request method, required scope,
  request headers, or a `potemkin:` header alias.
- Return a configured status, body, headers, and delay without running the
  behaviour or committing an event.
- Invoke a named fault rule with `X-Potemkin-Use-Fault`.
- Force a status with `X-Potemkin-Force-Status`, while allowing a matching YAML
  rule to supply the body and headers.
- Select an error class (`timeout`, `throttle`, `outage`, `bad_gateway`,
  `conflict`, `auth`, or `forbidden`) and produce its canonical response.
- Force or stack fixed delays with `X-Potemkin-Force-Latency` and
  `X-Potemkin-Slow-Response`.
- Add uniform random jitter with `X-Potemkin-Jitter`.
- Drop the connection after a bounded delay with
  `X-Potemkin-Drop-Connection`.
- Gate requests by a configured success rate with
  `X-Potemkin-Success-Rate`.
- Simulate a rate limit with `X-Potemkin-Rate-Limit` or the `rate_limit` alias,
  including YAML-owned `429` response bodies and `Retry-After` headers.
- Add `Retry-After` with `X-Potemkin-Retry-After` and truncate response bytes
  with `X-Potemkin-Body-Truncate`.
- Support named response/scenario controls (`X-Potemkin-Force-Response`,
  `X-Potemkin-Scenario`) and the generic signal/rate-limit aliases without
  making those names part of the core runtime model.
- Preserve the precedence rules between named faults, YAML header overrides,
  forced statuses, error classes, connection drops, success-rate gates, and
  additive latency controls.

The latency and rate-limit combinations must be tested separately. Boundary
`latency.fixed_ms` is a deterministic floor; `latency.min_ms` and
`latency.max_ms` produce an injectable uniform-random delay; the configured
values stack with `delay_ms`, `X-Potemkin-Force-Latency`,
`X-Potemkin-Slow-Response`, and `X-Potemkin-Jitter`. A rate-limit response must
preserve a YAML-owned body and headers when a matching rule supplies them, and
the generic response must include the documented 429/`Retry-After` behavior.
Connection drops must not commit state, and body truncation must be measured
in serialized response bytes.

The clock and control-header surface is also part of the baseline:

- Advance or reset the per-runtime virtual clock with
  `POST /_admin/clock/advance` (`{ "ms": n }`) and
  `POST /_admin/clock/reset`; use that clock for `$now()`-equivalent values,
  idempotency TTLs, session expiry, dynamic-fault expiry, and reset behavior
  without sleeping in real time.
- Add a signed per-request clock offset with `X-Potemkin-Clock-Offset`.
- Seed request-scoped fake values with `X-Potemkin-Seed`.
- Dry-run a complete command, expose produced events, and expose a debug echo
  without leaking those controls into later requests.
- Skip sagas, webhooks, projections, dispatch, or validation independently;
  make array-body bulk processing transactional; and override cascade depth.
- Set causal metadata with `X-Potemkin-Caused-By`, and override or impersonate
  the actor with `X-Potemkin-Actor` / `X-Potemkin-Impersonate` only with admin
  authorization.
- Read historical state at a sequence version and replay a named event.
- Select HAL, JSON:API, or plain response format; choose pagination envelope,
  raw, or link-header output; and mask response fields.
- Inject trace id, span name, log level, and a metric tag into the request's
  observability context.
- Independently control validation with `X-Potemkin-Skip-Request-Validation`,
  `X-Potemkin-Skip-Response-Validation`, and
  `X-Potemkin-Allow-Additional-Properties`; these controls must not bypass
  domain guards, authentication, authorization, or event validation unless a
  separate policy explicitly says so.

The complete named control set is an auditable contract, not merely a parser
constant:

| Control family          | Headers and required behavior                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transparency            | `X-Potemkin-Dry-Run`, `X-Potemkin-Include-Events`, `X-Potemkin-Echo`, `X-Potemkin-Seed`, `X-Potemkin-Clock-Offset`                                                              |
| Side effects            | `X-Potemkin-Skip-Sagas`, `X-Potemkin-Skip-Webhooks`, `X-Potemkin-Skip-Projections`, `X-Potemkin-Skip-Dispatch`, `X-Potemkin-Max-Cascade-Depth`, `X-Potemkin-Bulk-Transactional` |
| Identity and causality  | `X-Potemkin-Actor`, `X-Potemkin-Caused-By`, `X-Potemkin-Impersonate`                                                                                                            |
| Event sourcing          | `X-Potemkin-Read-At-Version`, `X-Potemkin-Replay-Event`                                                                                                                         |
| Response representation | `X-Potemkin-Response-Format`, `X-Potemkin-Pagination-Style`, `X-Potemkin-Mask`                                                                                                  |
| Observability           | `X-Potemkin-Trace-Id`, `X-Potemkin-Span-Name`, `X-Potemkin-Log-Level`, `X-Potemkin-Metric-Tag`                                                                                  |
| Validation              | `X-Potemkin-Skip-Request-Validation`, `X-Potemkin-Skip-Response-Validation`, `X-Potemkin-Allow-Additional-Properties`                                                           |

For every control, YAML shorthand and raw headers are parser concerns; direct
TypeScript receives typed request controls and policy values. Each control
needs isolation tests proving that one request cannot alter another request's
clock, random seed, actor, side effects, format, validation, or observability
context.

The implementation audit must check each primitive and each documented
combination in both authoring forms. A single test that proves one `503` fault
does not prove the chaos/control surface.

### Specmatic integration

- Connect the engine to a Specmatic stub.
- Let the plugin discover stateful routes.
- Drive seeds, workflows, and overlays through the stub.
- Handle engine restarts and hot reload.
- Validate requests against the contract.
- Expose and test the complete control-plane surface: `/_engine/routes`,
  `/_engine/fixtures`, and `/_engine/forward`, including successful and failed
  single requests and array-body bulk requests.
- Send `/_potemkin/ready` on boot and `/shutdown` before stopping; preserve
  health monitoring, fixture re-fetch after restart, and hot-reload behavior.
- Let unregistered routes fall through to the normal Specmatic stub while
  registered stateful routes use the same runtime projection as direct HTTP.
- Make forward blocks carry seeds, workflows, and response overlays through
  the stub, and preserve request controls, response masking, CORS, API
  versioning, chaos, time travel, and validation behavior on that wire.

### Administrative surface and access model

The administrative API is part of the feature surface, not test-only plumbing:

- `POST /_admin/reset` restores state, events, projections, sessions, virtual
  time, and dynamic faults to the boot baseline.
- `GET /_admin/health` reports liveness/readiness.
- `GET /_admin/state` returns raw, unmasked state and supports the documented
  boundary filter.
- `GET /_admin/events` returns raw events and supports aggregate/type filters,
  count, limit, and offset controls.
- `GET /_admin/derived/:name` returns a declared derived projection.
- `POST /_admin/faults` registers a dynamic fault with optional TTL/expiry;
  `GET /_admin/faults` lists active faults; and
  `DELETE /_admin/faults/:id` removes one.
- When `ADMIN_TOKEN` is unset, the documented local-development policy is
  fail-open. When it is set, every admin endpoint and every admin-gated
  request control requires `Authorization: Bearer <token>`, with distinct
  401 and 403 outcomes.
- Raw admin state and event payloads remain unmasked debugging data even when
  token protection is enabled.

## Gaps found in the current implementation

This is an audit of the working tree against the inventory above. These are
implementation or evidence gaps, not reasons to reduce the baseline:

- **The parity matrix is intentionally still being expanded.** The real-use
  Specmatic matrix now covers YAML, TypeScript, and mixed loading for the
  principal state, event, projection, idempotency, fault, selector, response,
  replay, session, and forwarding behaviours. Remaining work is broader
  cross-product coverage for virtual-clock TTL expiry, every control-header
  tier, CORS, admin authorization, and combinations that are not yet valuable
  enough to retain as permanent end-to-end cases.
- **Boundary latency now has both source-independent and real-forwarding parity.**
  `runtime-latency-parity` boots YAML and direct TypeScript through the same
  HTTP gateway, injects the same random source and sleep port, and asserts the
  fixed-plus-ranged delay plan and committed event. The real Specmatic-backed
  `latency` suite runs fixed, ranged, stacked, fault-plus-boundary delay,
  seeded identity, delayed idempotency replay, and combined forced-error chaos
  through YAML, TypeScript, and mixed configurations. The fresh-key stacked
  drop case in `authoring-parity` also proves that forwarded connection close,
  latency, slow response, jitter, shaping, masking, and truncation do not
  commit state, and that a healthy retry commits exactly once. Broader reset,
  replay, and forwarding cross-products remain open.
- **Historic event replay now has real HTTP parity evidence.**
  `src/core/engine.ts` re-emits a known event with a new id, sequence, request
  snapshot, reducer pass, commit, and post-commit processing; unknown ids return
  a typed 404 without a write. `authoring-parity` now covers replay,
  read-at-version, conditional headers, dry-run, unknown replay, and concurrent
  historical reads through Specmatic for YAML, TypeScript, and mixed loading.
  Wider combinations with the remaining transport and admin controls remain
  open.
- **Selector and dynamic-fault precedence now have real forwarding evidence.**
  `runtime-controls`, `authoring-parity`, and `configured-admin-faults` cover
  typed selectors, named and dynamic faults, transport controls, response
  formats, and parser-owned response bodies. The authenticated session matrix
  also proves that valid cookie/CSRF authentication precedes a competing
  dynamic fault. Remaining work is the broader cross-product with every
  control-header tier, CORS, and unauthenticated/session failure combinations.
- **Transactional bulk rollback now stages idempotency metadata and defers
  post-commit observation/side effects.** Unit and runtime parity tests prove
  that a failed batch leaves no state, event, retry metadata, webhook, or
  derived projection for an item that was rolled back. The wider saga,
  reaction, and custom-store matrix remains open.
- **The canonical public paths are now isolated.** `src/index.ts`, the E2E
  harness, examples, and the export CLI use `bootRuntime`/`bootYamlRuntime`
  and `createRuntimeGateway`; both authoring forms use the same runtime and
  transport. Parser extensions only compile YAML reload payloads and register
  parser-owned control operations on that generic gateway.
- **The OTEL backlog requirement is complete.** `runtime-otel` and
  `runtime-observability` verify original-request capture, final masked
  responses, validation failures, bounded redaction, trace correlation, and
  forwarding for YAML, TypeScript, and mixed loading; `requirements.md` marks
  REQ-76 complete. Broader metric and outcome combinations remain optional
  evidence work tracked in the operational gap register.

## Completion evidence

The audit should record evidence beside each row as implementation proceeds. The
minimum evidence is a source path for the runtime, a source path for each
authoring compiler, and test paths for YAML and TypeScript. “Implemented in the
old gateway” or “covered by a unit test for a helper” is not sufficient evidence
for the row.

The working README may be rewritten for clarity and developer experience, but
its examples and claims must be regenerated from this inventory and the passing
E2E matrix. It must not be used to reduce the required feature set.

## Completed backlog requirement: final OTEL request/response observation

In addition to the README feature rows, the runtime must emit an OpenTelemetry
observation for each handled request that contains:

- the original inbound request as received by the transport boundary;
- the final response actually returned after matching, mutation, projection,
  reactions, sagas, response shaping, chaos, masking, and validation have all
  completed; and
- one correlation context linking the request and response observations,
  including the trace id and Potemkin command id where available.

The final response observation must describe the response sent to the client,
not an intermediate behaviour result. Body capture must use an explicit
dependency-injected redaction or size policy; it must never be inferred from a
debug log. This is implemented in the core observability port, with YAML and
TypeScript real-use E2E coverage proving the same OTEL observation shape.
