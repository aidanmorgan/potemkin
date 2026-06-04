# CRM example — "The Nuisance Bureau"

A complete, stateful CRM simulation built entirely from Potemkin's YAML DSL and
an OpenAPI contract. It models five interacting boundaries — **Lead, Campaign,
Agent, Call, Opportunity** — with the full lifecycle of each (creation, state
transitions, cross-boundary dispatch, a conversion saga, derived projections,
reactions, computed totals, and audit fields).

This is the canonical worked example: nearly every feature in the
[DSL reference](../../docs/dsl.md) and the [cookbook](../../README.md) is
exercised here, and most of the engine's integration and end-to-end tests run
against this simulation.

## Layout

```
examples/crm/
  potemkin.yaml          # entry point: points at specmatic.yaml + globs dsl/**
  specmatic.yaml         # Specmatic config (contract + stub settings)
  openapi/
    nuisance-bureau.yaml # the API contract the simulation implements
  dsl/                   # one YAML file per boundary (+ sub-path action files)
  scripts/               # scanned @Script TypeScript (e.g. lead scoring)
  dictionary.yaml        # schema-inference dictionary for response defaults
  run-crm-sim.ts         # runnable entry point (boots engine + gateway)
```

## Run it

Potemkin runs **as a Specmatic extension** — a simulation is launched by starting
the Specmatic stub with the plugin, which enforces the OpenAPI contract and
forwards stateful paths to the engine. `start:example` boots that full stack
(engine + Specmatic stub + plugin) and prints the stub URL to hit.

```sh
cd plugin && ./gradlew shadowJar && cd ..   # build the plugin JAR (Java 17+)
npm run start:example                        # boots Specmatic + plugin + engine
# then drive requests at the printed STUB URL (Specmatic-validated):
#   curl -s -XPOST <stubUrl>/leads -H 'Content-Type: application/json' \
#        -d '{"companyName":"Acme","contactName":"A","phone":"+61...","email":"a@x","source":"WEBSITE"}'
```

> The engine also exposes an Express gateway directly (`bootSystem` +
> `createGateway`), but that is an internal framework-test convenience — Potemkin
> is not meant to be used standalone, only as a Specmatic plugin.

## Consumer-side testing (how to use Potemkin + Specmatic)

The example's own tests under `examples/crm/tests/` are written from the
**consumer side** — they play a service that integrates with the CRM API. They
drive the **real Specmatic stub** (Specmatic enforces the OpenAPI contract; the
plugin forwards stateful paths to the engine) and force the API into known states
**through the stub**, so a downstream integrator can write reliable,
contract-driven integration tests against a stateful test double.

State is forced through the stub via four mechanisms:

- **Declarative seeding** — `initialization:` blocks pre-load known entities
  (e.g. the seeded leads) so a test starts from a fixed, deterministic state.
- **Fault injection** — `fault_rules` / `X-Potemkin-*` chaos headers force
  declines / 5xx / latency to exercise the consumer's error handling.
- **Idempotency retries** — the `Idempotency-Key` header proves a retry is safe
  (cached replay, no duplicate side effects).
- **Clock + reset** — `X-Potemkin-Clock-Offset` and a reset-through-stub between
  tests give deterministic, isolated runs.

The harness lives in [`examples/_harness`](../_harness): `startExampleStack({
exampleName: 'crm' })` boots the engine + Specmatic stub + plugin and exposes the
stub URL; `ConsumerClient` is the thin client the tests use.

```sh
cd plugin && ./gradlew shadowJar && cd ..   # build the plugin JAR (Java 17+)
npm run test:examples                        # e2e-tier; NOT part of `npm test`
npm run lint:sim -- examples/crm             # lint the simulation, no servers
```

See the sibling [`examples/stripe`](../stripe) for a payments-domain example with
a state machine and reaction-materialised resources.
