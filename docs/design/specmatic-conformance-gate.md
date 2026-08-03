# Specmatic conformance gate

Status: implemented in the real Specmatic JVM path (2026-08-02).

The conformance gate starts the example's real Potemkin runtime and Specmatic
stub, then starts a separate Specmatic test JVM. Requests therefore travel
through the consumer path:

```text
Specmatic test JVM -> Specmatic stub -> Potemkin plugin -> Potemkin runtime
```

The gate has two explicit inputs:

- The negative layer restricts generated contract-invalid requests to the
  declared 400 slice.
- The positive layer passes the exported `<spec>_examples/` directory through
  Specmatic's `--examples` option. The runtime harness seeds the exported
  successful by-id snapshots as canonical runtime events, so Tier-2 state
  examples exercise normal live reads rather than a response stub.

The fixture Layer-B verifier remains separate from production corpus wiring.
It uses an isolated contract copy and pinned local examples, runs collection and
by-id cases twice, and checks deterministic JUnit identities, statuses, and
success outcomes.

Tier-3 declared errors are positive examples, not allowlist exceptions. The
exported corpus contains reachable contract-declared 404 and 422 examples,
including request bodies where applicable. The CRM Layer-C allowlist is empty;
new stateful divergences must be fixed or represented by a contract-declared
exported example and are rejected by the allowlist staleness guard otherwise.

Useful checks:

```sh
pnpm run test:conformance:crm:positive
pnpm run test:conformance -- --example crm --layer positive \
  --filter "METHOD='GET' && PATH='/leads/{id}'"
pnpm run test:conformance -- --example crm --layer positive \
  --filter "STATUS='404'" --max-combinations 1
pnpm run test:conformance -- --example crm --layer positive \
  --filter "STATUS='422'" --max-combinations 1
pnpm run test:conformance -- --example stripe --layer negative
```

The Stripe engine and Specmatic stub continue to use the vendored official
Stripe contract. The pinned Specmatic test JVM cannot parse that 7 MB document
because of its 3,145,728-code-point parser limit, so the blocking Stripe Layer-A
command selects the source-controlled `examples/stripe/conformance/layer-a.yaml`
slice. That slice contains the request-validation and 400-response surfaces for
the five simulated collection mutations plus collection query validation. It is
an explicit test contract, not a runtime or compatibility contract; the engine
still validates and serves requests from the official document.

The unfiltered positive command intentionally includes Specmatic's generated
positive permutations in addition to the externalized corpus. Route- and
status-scoped runs are the bounded corpus/conformance checks; generated
mutation coverage belongs to the stateful Layer-C work and must not be hidden
by a broad allowlist.
