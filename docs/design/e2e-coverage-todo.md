# End-to-End Coverage TODO

## Purpose

This list contains the missing end-to-end tests found in the coverage audit.

Each test must use this path:

```text
test client -> Specmatic -> Potemkin plugin -> Potemkin -> Specmatic -> test client
```

Use `app.stubUrl` for every business request. Use `app.engineUrl` only to
reset state or to inspect state, events, and side effects.

Items E2E-023 and E2E-024 are boot tests. They do not send a business request
because the runtime must fail before it accepts traffic.

Most existing tests already cover the main state, event, query, fault,
authentication, side-effect, latency, validation, administration, and
observability features for YAML, TypeScript, and mixed loading. The items below
cover the remaining gaps. Do not copy an existing YAML-only test and change
only the file name. The new test must prove the requested authoring form.

## Work rules

Every item below is one test case. The item should add one `it(...)` test. Keep
the test independent from the other items. Give it its own fixture directory if
the existing fixtures do not support the case.

Size each item at about six hours:

- one hour to read the closest existing test;
- two hours to create the contract and authoring fixture;
- two hours to write the test and assertions;
- one hour to run the test and clean up the fixture.

Each item follows INVEST:

- Independent: it can run alone and does not need another TODO item;
- Valuable: it proves a user-visible feature;
- Estimable: it has one source, one scenario, and one test case;
- Small: it fits in about six hours;
- Testable: the pass conditions are written below.

## Protocol tests

### [x] E2E-001 — YAML CORS preflight

Source: YAML

Add one Specmatic-backed test for `OPTIONS` on a YAML boundary. Send the
preflight headers and verify the configured CORS status and headers. Verify
that no event or state change occurs.

Suggested test file: `tests/e2e/cors-yaml.e2e-test.ts`.

Pass conditions:

- The request goes to `app.stubUrl`.
- The response has the configured CORS headers.
- The response has the configured preflight status.
- The event count and state are unchanged.

Size: 6 hours.

### [x] E2E-002 — TypeScript CORS preflight

Source: TypeScript

Add one Specmatic-backed test for `OPTIONS` on a TypeScript boundary. Use the
TypeScript security or CORS builder in the fixture. Send a preflight request
and verify the same result as the YAML test.

Suggested test file: `tests/e2e/cors-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript configuration is loaded from a scan or factory.
- The request goes to `app.stubUrl`.
- The response has the expected CORS status and headers.
- The event count and state are unchanged.

Size: 6 hours.

### [x] E2E-003 — TypeScript API version routing

Source: TypeScript

Add one Specmatic-backed test for version prefixes and the default version.
Use the TypeScript versioning builder. Send one request with a version prefix
and one request without a prefix.

Suggested test file: `tests/e2e/api-versioning-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript fixture defines at least two versions.
- The versioned request returns the correct version header.
- The unversioned request returns the configured default version.
- Both requests return the expected resource body.

Size: 6 hours.

### [x] E2E-004a — TypeScript entity tags and last-modified dates

Source: TypeScript

Add one Specmatic-backed test for TypeScript `ETag` and `Last-Modified`
responses. Create an entity and read it.

Suggested test file: `tests/e2e/conditional-requests-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript fixture supplies the boundary and audit data.
- The first read returns `ETag` and `Last-Modified`.
- The `ETag` contains the current sequence version.
- `Last-Modified` contains the event update time.

Size: 6 hours.

### [x] E2E-004b — TypeScript conditional reads

Source: TypeScript

Add one Specmatic-backed test for `If-None-Match`, `If-Modified-Since`, and
`304`. Create an entity, save its response headers, and send both conditional
requests.

Suggested test file: `tests/e2e/conditional-reads-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript fixture supplies the boundary and audit data.
- A matching `If-None-Match` request returns `304` with no body.
- A matching `If-Modified-Since` request returns `304` with no body.
- A non-matching condition returns the normal resource response.

Size: 6 hours.

### [x] E2E-004c — TypeScript HEAD requests

Source: TypeScript

Add one Specmatic-backed test for TypeScript `HEAD` requests. Compare a GET
request with a HEAD request for the same entity.

Suggested test file: `tests/e2e/head-typescript.e2e-test.ts`.

Pass conditions:

- The GET and HEAD requests use the same TypeScript boundary.
- Both requests return the same status.
- The HEAD response has no body.
- Conditional headers still work for HEAD.

Size: 6 hours.

### [x] E2E-005 — TypeScript conditional and named response links

Source: TypeScript

Add one Specmatic-backed test for TypeScript response links. Test a self link,
an action link with a name, and a link with a false condition. Use the response
builder and the behavior link fields.

Suggested test file: `tests/e2e/hateoas-typescript.e2e-test.ts`.

Pass conditions:

- The self link is present.
- The named action link is present only when its condition is true.
- The false link is absent.
- The link method and URL are correct.

Size: 6 hours.

## Composition and resource tests

### [x] E2E-006 — YAML resource expansion

Source: YAML

Add one Specmatic-backed test for a YAML resource declaration that creates a
collection route, an item route, and at least one mutation route. Create an
item and read it back.

Suggested test file: `tests/e2e/resource-yaml.e2e-test.ts`.

Pass conditions:

- The resource declaration creates all expected routes.
- The create request succeeds through Specmatic.
- The item read returns the created state.
- The event log contains the expected event.

Size: 6 hours.

### [x] E2E-007 — TypeScript resource expansion

Source: TypeScript

Add one Specmatic-backed test for `defineResource` and the TypeScript resource
builder. Create and read one resource item.

Suggested test file: `tests/e2e/resource-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript resource creates the expected routes.
- The create and read requests go through `app.stubUrl`.
- The response body and event log are correct.
- No direct gateway request is used.

Size: 6 hours.

### [x] E2E-008 — TypeScript component include and use

Source: TypeScript

Add one Specmatic-backed test for `defineComponent`, `include`, and `use`.
Define one reusable component, include one fragment, and map the component to
one concrete boundary.

Suggested test file: `tests/e2e/composition-typescript.e2e-test.ts`.

Pass conditions:

- The component is loaded by the configured TypeScript factory.
- The included event and reducer work in the concrete boundary.
- The mapped contract path works through Specmatic.
- A create request returns the projected state.

Size: 6 hours.

### [x] E2E-009 — Mixed YAML and TypeScript component composition

Source: YAML and TypeScript

Keep the direct Supertest proof in `cross-language-composition.e2e-test.ts` as
lower-level evidence. Add one new Specmatic-backed test beside it. YAML must map or
include the TypeScript component. TypeScript must use a YAML component reference
where the feature requires it.

Suggested test file: `tests/e2e/composition-mixed.e2e-test.ts`.

Pass conditions:

- Both source types are loaded in one configured runtime.
- The business request goes to `app.stubUrl`.
- The YAML and TypeScript parts contribute to one result.
- The response, state, and event log prove the composition.

Size: 6 hours.

## TypeScript SDK tests

### [x] E2E-010a — TypeScript predicate helpers

Source: TypeScript

Add one Specmatic-backed test that uses the public SDK helpers `all`, `any`, and
`not` in a behavior or fault condition.

Suggested test file: `tests/e2e/sdk-functional-helpers.e2e-test.ts`.

Pass conditions:

- The test imports the helpers from `potemkin/sdk`.
- The true condition selects the expected response.
- The false condition does not commit an event.
- The HTTP response proves that the predicate helpers were used.

Size: 6 hours.

### [x] E2E-010b — TypeScript function composition helpers

Source: TypeScript

Add one Specmatic-backed test that uses `pipe`, `compose`, `mapReadonly`, and
`concatReadonly` from `potemkin/sdk`. Use the result in an event payload or
response body.

Suggested test file: `tests/e2e/sdk-function-composition.e2e-test.ts`.

Pass conditions:

- The test imports the helpers from `potemkin/sdk`.
- The response contains the transformed value.
- The event payload contains the same transformed value.
- The request goes through `app.stubUrl`.

Size: 6 hours.

### [x] E2E-010c — TypeScript expression helper

Source: TypeScript

Add one Specmatic-backed test for the public `expression` helper. Use its
result in a behavior condition and send a request that selects the condition.

Suggested test file: `tests/e2e/sdk-expression.e2e-test.ts`.

Pass conditions:

- The test imports `expression` from `potemkin/sdk`.
- The expression receives the expected context.
- The request selects the expected behavior.
- The event log proves that only the selected behavior ran.

Size: 6 hours.

### [x] E2E-011a — TypeScript event, behavior, and reducer builders

Source: TypeScript

Add one Specmatic-backed test that uses the public convenience functions for an
event, behavior, and reducer. Do not use plain object literals for these parts.

Suggested test file: `tests/e2e/sdk-core-builders.e2e-test.ts`.

Pass conditions:

- All three builders are imported from `potemkin/sdk`.
- A request creates an event and projects state.
- The response contains the projected state.

Size: 6 hours.

### [x] E2E-011b — TypeScript response, query, and global builders

Source: TypeScript

Add one Specmatic-backed test that uses the public convenience functions for a
response, query, and global definition.

Suggested test file: `tests/e2e/sdk-policy-builders.e2e-test.ts`.

Pass conditions:

- All three builders are imported from `potemkin/sdk`.
- The query changes the returned collection.
- The response definition changes a status or header.
- The global definition changes one observable policy.

Size: 6 hours.

### [x] E2E-012a — TypeScript fault builder

Source: TypeScript

Add one Specmatic-backed test that uses the public fault builder. Send a
matching request and then a normal request.

Suggested test file: `tests/e2e/sdk-side-effect-builders.e2e-test.ts`.

Pass conditions:

- Both requests go through Specmatic.
- The fault path does not commit state.
- The normal path commits one event.

Size: 6 hours.

### [x] E2E-012b — TypeScript reaction and projection builders

Source: TypeScript

Add one Specmatic-backed test that uses the public reaction and projection
builders. Create one source entity and check the reaction result and projection.

Suggested test file: `tests/e2e/sdk-reaction-projection-builders.e2e-test.ts`.

Pass conditions:

- Both builders are imported from `potemkin/sdk`.
- The reaction creates the expected secondary event.
- The projection contains the expected value.
- The request goes through `app.stubUrl`.

Size: 6 hours.

### [x] E2E-012c — TypeScript saga and webhook builders

Source: TypeScript

Add one Specmatic-backed test that uses the public saga and webhook builders.
Create one entity and check the saga event sequence and webhook body.

Suggested test file: `tests/e2e/sdk-saga-webhook-builders.e2e-test.ts`.

Pass conditions:

- Both builders are imported from `potemkin/sdk`.
- The saga emits the documented lifecycle events.
- The webhook receiver gets the expected body.
- The request goes through `app.stubUrl`.

Size: 6 hours.

### [x] E2E-013 — TypeScript query mapping

Source: TypeScript

Add one Specmatic-backed test for the TypeScript `queryMapping` declaration.
Create two entities and query them with a mapped field.

Suggested test file: `tests/e2e/query-mapping-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript fixture uses `queryMapping`.
- The query returns only the matching entity.
- A query with no match returns an empty result.
- The request and response use the Specmatic stub.

Size: 6 hours.

### [x] E2E-014 — TypeScript audit fields

Source: TypeScript

Add one Specmatic-backed test for TypeScript `auditFields`. Create and update
an entity with an authenticated actor.

Suggested test file: `tests/e2e/audit-fields-typescript.e2e-test.ts`.

Pass conditions:

- Creation writes the expected creation audit fields.
- Update writes a later update time and the correct actor.
- The fields are visible in the caller response or admin state as documented.
- The request goes through Specmatic.

Size: 6 hours.

### [x] E2E-015a — TypeScript computed and internal fields

Source: TypeScript

Add one Specmatic-backed test for TypeScript computed and internal fields. Use
one computed field and one internal field. Create and read one entity.

Suggested test file: `tests/e2e/state-fields-typescript.e2e-test.ts`.

Pass conditions:

- The computed field is returned with the correct value.
- The internal field is not returned in the public response.
- The admin state contains the internal field when the contract exposes it.
- The request goes through `app.stubUrl`.

Size: 6 hours.

### [x] E2E-015b — TypeScript state validation

Source: TypeScript

Add one Specmatic-backed test for a TypeScript state validation function. Send
one valid request and one request that creates invalid state.

Suggested test file: `tests/e2e/state-validation-typescript.e2e-test.ts`.

Pass conditions:

- The valid request returns the expected state.
- The invalid state returns the documented error.
- The invalid request does not add an event.
- Both requests go through `app.stubUrl`.

Size: 6 hours.

### [x] E2E-016 — TypeScript non-strict schema mode

Source: TypeScript

Add one Specmatic-backed boot and request test for `.strictSchema(false)`.
Use a computed field with incomplete dependencies.

Suggested test file: `tests/e2e/strict-schema-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript runtime boots without a strict-schema error.
- The request succeeds through Specmatic.
- The computed value follows the documented non-strict behavior.
- The boot diagnostic contains the warning, if the contract defines one.

Size: 6 hours.

### [x] E2E-017 — TypeScript control defaults

Source: TypeScript

Add one Specmatic-backed test for `controlDefaults`. Configure one default
control from each of two control groups. Send a request without headers.

Suggested test file: `tests/e2e/control-defaults-typescript.e2e-test.ts`.

Pass conditions:

- The default controls apply without request headers.
- The default controls do not apply after a reset when removed.
- The response, event log, and state prove the controls worked.
- A request-local header can override a default where the contract allows it.

Size: 6 hours.

### [x] E2E-018 — TypeScript custom authorization callback

Source: TypeScript

Add one Specmatic-backed test for a TypeScript `authorize` callback. Send one
allowed request and one denied request.

Suggested test file: `tests/e2e/authorization-typescript.e2e-test.ts`.

Pass conditions:

- The callback receives the expected request and scope data.
- The allowed request commits one event.
- The denied request returns the documented status.
- The denied request does not change state or the event log.

Size: 6 hours.

### [x] E2E-019 — TypeScript lifecycle hooks

Source: TypeScript

Add one Specmatic-backed lifecycle test for boot, request, reset, and shutdown
hooks. Record the hook order in a test-safe store.

Suggested test file: `tests/e2e/lifecycle-typescript.e2e-test.ts`.

Pass conditions:

- The TypeScript hooks run in the documented order.
- The business request still goes through Specmatic.
- Reset runs the reset hook once.
- Shutdown runs the shutdown hook once.

Size: 6 hours.

### [x] E2E-020 — TypeScript programmatic configuration without a YAML carrier

Source: TypeScript

Add one full-stack test that supplies the top-level runtime configuration from
TypeScript or a programmatic boot input. Do not use a `potemkin-typescript.yml`
file to supply the top-level configuration.

Suggested test file: `tests/e2e/programmatic-typescript-config.e2e-test.ts`.

Pass conditions:

- The test starts Specmatic and the plugin.
- The runtime receives the TypeScript configuration directly.
- A business request goes through `app.stubUrl`.
- The response and state are correct.

Size: 6 hours.

### [x] E2E-021 — TypeScript source reload

Source: TypeScript

Add one Specmatic-backed reload test. Change a scanned `.ts` source file while
the runtime is running. Trigger or wait for reload, then send a new request.

Suggested test file: `tests/e2e/typescript-source-reload.e2e-test.ts`.

Pass conditions:

- The first request proves the old TypeScript source is active.
- The `.ts` file changes during the test.
- The new request proves that the new source is active.
- Old state is cleared or replayed according to the documented reload rule.
- The Specmatic JVM remains the same during reload.

Size: 6 hours.

## YAML purity and error tests

### [x] E2E-022 — YAML-only request validation

Source: YAML

Add one Specmatic-backed validation test with a YAML-only configuration. Do
not scan any TypeScript support file. Send one invalid request and one valid
request.

Suggested test file: `tests/e2e/yaml-only-validation.e2e-test.ts`.

Pass conditions:

- The configuration has no TypeScript scan section.
- The invalid request returns the documented contract error.
- The invalid request adds no event.
- The valid request succeeds through Specmatic.

Size: 6 hours.

### [x] E2E-023 — YAML declaration boot failure before traffic

Source: YAML

Add one boot-level E2E test for an invalid YAML reference. Start Specmatic and
attempt to start Potemkin with the invalid YAML. Verify that the runtime does
not accept business traffic.

Suggested test file: `tests/e2e/yaml-boot-errors.e2e-test.ts`.

Pass conditions:

- The YAML contains one unknown event or boundary reference.
- Potemkin reports the documented boot error code.
- No partial runtime starts.
- The test does not use a skipped test or a fake parser result.

Size: 6 hours.

### [x] E2E-024 — TypeScript factory boot failure before traffic

Source: TypeScript

Add one boot-level E2E test for an invalid TypeScript factory. Use one missing
registration or duplicate factory name. Verify the documented diagnostic.

Suggested test file: `tests/e2e/typescript-boot-errors.e2e-test.ts`.

Pass conditions:

- The failing factory is loaded through the real scanner.
- Potemkin reports the documented error code.
- No partial runtime accepts a business request.
- The test uses the real configured loader, not a mocked loader.

Size: 6 hours.

## Follow-up engineering tasks

The following task was added after the 32-item E2E coverage audit. It is an
operational reliability improvement, not an additional audit item.

### [x] OTEL-001 — Non-blocking, recoverable OTEL file writer

Replace synchronous per-record OTEL file writes with a bounded ring buffer and
a dedicated worker thread. The producer path must remain low-latency: enqueue
records without waiting for disk I/O, and have the worker append newline-
delimited records in chunks rather than issuing one file operation per record.
The worker must automatically restart and recover if it crashes, preserving
ordering and making the configured backpressure/drop behavior observable.

Pass conditions:

- Request handling never waits for an individual OTEL file write.
- The worker uses append-mode writes and flushes batches from the ring buffer.
- A worker crash is detected, the worker restarts automatically, and queued
  records continue to drain without bringing down the runtime.
- Shutdown drains the buffer according to the configured delivery policy.
- Tests cover ordering, batching, backpressure/drop metrics, crash recovery,
  and request latency while the writer is busy.

Suggested evidence: `src/observability/` plus focused unit/runtime tests for
the writer and its worker lifecycle.

Implemented in `src/observability/otelFileWriter.ts` and integrated into the
E2E OTLP collector persistence path. Focused tests cover ordered batching,
bounded backpressure/drop reporting, worker crash recovery, and producer
latency while the worker is busy.

Size: 6 hours.

## Completion check

When all items are complete:

1. Run `pnpm run test:e2e`.
2. Run `node scripts/check-no-skipped-tests.mjs`.
3. Confirm that every new business request uses `app.stubUrl`.
4. Confirm that every new fixture has YAML and TypeScript coverage where the
   item requires both sources.
5. Update the parity and feature-completeness documents with the new test
   paths and the final passing test count.
