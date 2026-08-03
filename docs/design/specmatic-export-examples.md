# Specmatic example export

Status: implemented for deterministic baseline and state-machine snapshots (2026-08-01).

Potemkin exports contract-shaped Specmatic externalized examples from the live Node runtime. The
exporter boots the configured YAML runtime, drives requests through the in-process runtime gateway,
and serialises the resulting request/response pairs. Reducers, transitions, response transforms,
identity generators, and side effects therefore use the same path as the running simulator.

## Usage

```sh
pnpm run export:examples -- examples/crm
pnpm run export:examples -- examples/crm --check
pnpm run export:examples -- examples/stripe
pnpm run export:examples -- examples/stripe --check
```

The command accepts an example directory or its `potemkin.yml` file. It discovers the OpenAPI
contract under the example's `openapi/` directory and writes JSON files beside that contract in a
`*_examples/` directory. `--check` generates into a temporary directory and fails when the checked-in
corpus differs.

## Export layers

The generated corpus contains:

- Tier 1 baseline by-id and collection responses from the configured seed data.
- Tier 2 state-machine snapshots, with a distinct contract-valid identity for each representative
  state. Each snapshot is produced from a fresh engine baseline, so examples can coexist on a plain
  stub without sharing mutable state.
- Transition side effects materialised by the live engine, such as Stripe Charges created while a
  PaymentIntent transitions.
- Tier 3 declared 404 and reachable pre-seeded-state 422 request/response pins.

The exporter validates every response against the configured OpenAPI contract before writing it.
Identity allocation uses each runtime boundary's own generator and deterministic injected host
services, so repeated exports produce the same paths and bodies. Coverage warnings identify guarded
or branch-specific states that the default export walk cannot reach.

## Declared error examples

Tier 3 adds only error responses that the matched operation declares. A declared 404 is exported
against the fixed, contract-valid sentinel ID `00000000-0000-7000-8000-000000000404`, which the
runtime never seeds; this covers GET and state-changing operations such as PATCH and DELETE. A
declared 422 is exported only after the live engine has restored a distinct Tier-2 response snapshot
as a pre-seeded entity and the operation actually returns 422. Request bodies are retained in the
exported request pin where the operation declares one, while transport headers are left to
Specmatic's contract handling except for required authored headers. Unreachable guards and
operations without a target entity produce coverage warnings and are skipped; no response is
fabricated and no undeclared status is emitted.

## Explicit branch and saga drives

Boundary files may opt into an `export:` block when the default state-machine walk cannot express a
branch or a cross-boundary workflow:

```yaml
export:
  states:
    - name: WON
      steps:
        - operationId: createOpportunity
          body: { value: 25000 }
        - operationId: advanceOpportunity
          body: { probability: 90 }
        - operationId: closeOpportunity
          body: { outcome: WON }
    - name: conversion
      saga: LeadConversionSaga
      steps:
        - operationId: createLead
          body: { companyName: Example, contactName: Contact }
        - operationId: convertLead
          body: { value: 30000 }
```

Each state owns a fresh live drive. Direct plans start with the collection creation operation and
rebase the created entity through the boundary's identity generator before replaying the remaining
steps. A `saga` plan names a saga from the global runtime catalogue; its steps are the trigger
requests, and the exporter snapshots the saga's terminal entity plus materialised side effects.
`$targetId` in a declared body resolves to the current drive's entity ID. A boundary with an explicit
plan is excluded from the default walk, so its branch-specific coverage warning is replaced by the
declared plan's result.

Declared-error examples are intentionally separate from the current baseline and transition corpus.
The plain Specmatic proof includes their concrete request bodies and error responses.

## Independent Specmatic proof

`tests/e2e/plain-specmatic-examples.e2e-test.ts` starts the Specmatic JVM with only the contract and
the exported examples. It does not load the Potemkin plugin or start a Potemkin engine. The test
requests every generated example, including request bodies for Tier-3 mutations, and compares the
returned status and body with the exported response.

Run it with:

```sh
pnpm run test:e2e -- --runTestsByPath tests/e2e/plain-specmatic-examples.e2e-test.ts
```

The full example verification gate is:

```sh
pnpm run verify:examples
```
