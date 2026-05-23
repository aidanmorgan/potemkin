# BDD Tests — Specmatic Stateful Simulation Engine

## Overview

Gherkin/Cucumber scenarios proving every numbered requirement in
`requirements.md` and `REQUIREMENTS_ADDENDUM.md`.

## Running

```bash
# BDD only
npm run test:bdd

# All tests (jest + bdd)
npm run test:all
```

## Layout

```
tests/bdd/
  features/          # *.feature files (one per requirement group)
  steps/             # TypeScript step definitions
  support/
    world.ts         # SimWorld class — shared state across steps
    hooks.ts         # Before/After lifecycle hooks
```

## Adding scenarios

1. Place a `.feature` file in `features/` (see `REQUIREMENTS_TRACEABILITY.md`).
2. Implement step definitions in `steps/` using `Given/When/Then` from
   `@cucumber/cucumber`.
3. Access `this` as `SimWorld` for typed access to `bootedSystem`,
   `lastResponse`, and `ctx`.

## Traceability

See `REQUIREMENTS_TRACEABILITY.md` at the repo root for the full mapping of
requirement numbers to feature files and scenario names.
