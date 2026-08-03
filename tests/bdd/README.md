# BDD Tests — Specmatic Stateful Simulation Engine

## Overview

Gherkin/Cucumber scenarios proving the requirements in `requirements.md`.

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

1. Place a `.feature` file in `features/` and update the traceability map in
   `tests/bdd/steps/traceability.steps.ts`.
2. Implement step definitions in `steps/` using `Given/When/Then` from
   `@cucumber/cucumber`.
3. Access `this` as `SimWorld` for typed access to `bootedSystem`,
   `lastResponse`, and `ctx`.

## Traceability

The traceability step definitions contain the full mapping of requirement
numbers to feature files and scenario names.
