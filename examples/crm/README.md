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

```sh
# Boot the engine + HTTP gateway on :3001 (no Java required)
npm run start:example
# then: curl -s -XPOST localhost:3001/leads -d '{"companyName":"Acme",...}'
```

## Where the tests live

The CRM simulation is the system-under-test for a large share of the suite:

- **Engine-only** (no Java): `tests/e2e/*` engine suites and many
  `tests/integration/*` tests boot this example via the fixture loader
  (`resolveFixtureDir('crm')` → this directory) and assert behaviour + state
  through the admin endpoints.
- **Full Specmatic stack** (needs Java 17+): the Java-gated `tests/e2e/*`
  suites boot a real Specmatic JVM with the Kotlin plugin pointed at this
  contract and drive requests through the complete wire.

See the sibling [`examples/stripe`](../stripe) for a payments-domain example.
